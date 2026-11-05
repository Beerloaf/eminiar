import { spawn as nodeSpawn } from "node:child_process";
import { authLockout, overBudget } from "../adjudicator/breaker.js";
import { currentKeyFingerprint, resolveAdjudicator } from "../adjudicator/config.js";
import type { AdjudicatorConfig } from "../config.js";
import type { StorageAdapter } from "../storage/adapter.js";
import { decisionFeatureConfig } from "./config.js";
import { DECISION_FEATURES, type DecisionFeature, type DecisionJob } from "./types.js";

/**
 * The detached feature job (docs/design/jev-integration-options.md): `em-hook --decision` with the job
 * JSON on stdin. A hook hands the network call here and answers at once. The job never carries a
 * key or a config: the child reloads the config, re-checks that the feature is still on, and
 * resolves the key itself. Text exists only in the pipe and the request, never on disk.
 * This file is the spawning side, which the MCP server also reaches (the swarm judge); the child
 * side is ./run-job.ts, loaded only by the hook, because it uses the lazy ./registry.ts.
 */

type SpawnFn = typeof nodeSpawn;

export interface DecisionSpawnDeps {
  spawn?: SpawnFn;
  execPath?: string;
  /** The hook script (default process.argv[1], i.e. dist/hook.js inside a hook). */
  script?: string;
  env?: NodeJS.ProcessEnv;
}

/** A lock that outlives a crashed job by at most this long. */
const JOB_LOCK_TTL_MS = 30_000;
/** Jobs in flight: per session (or swarm run), and in all. */
const MAX_JOBS_PER_SCOPE = 2;
const MAX_JOBS_RUNNING = 4;
/** A provider that said "unsupported" is not asked again by a hook for this long. */
const UNSUPPORTED_RETRY_MS = 3_600_000;

/** The job-lock and peek methods of the sqlite decision store (optional on other stores). */
interface JobGateStore {
  claimJob?(o: {
    feature: DecisionFeature;
    scope: string;
    now: number;
    ttlMs: number;
    perScope: number;
    maxRunning: number;
  }): boolean;
  releaseJob?(feature: DecisionFeature, scope: string): void;
  hasUnsupported?(feature: DecisionFeature, provider: string, since: number): boolean;
}
const gateStore = (db: StorageAdapter) => db.decisions as unknown as JobGateStore;

/** The in-flight scope of a job: the swarm run for the swarm judge, else the session. */
export function jobScope(job: Pick<DecisionJob, "feature" | "sessionId" | "payload">): string {
  const run = (job.payload as { run?: unknown } | undefined)?.run;
  if (job.feature === "swarm" && typeof run === "string") return `run:${run}`;
  return job.sessionId ?? "-";
}

/**
 * The hook's cheap, read-only check (one or two SELECTs, no network, no git): could a detached
 * job for `feature` make a call right now, and is one worth starting? False for a provider with
 * no embedder in a job (embedding), the heuristic, an open/half-open/slow breaker, a locked-out
 * key, an exhausted budget, a reached feature cap, or a provider that recently said "unsupported".
 * Any error means no spawn.
 */
export function providerAllowsJob(
  cfg: AdjudicatorConfig,
  db: StorageAdapter,
  feature: DecisionFeature,
  now = Date.now(),
  env?: NodeJS.ProcessEnv,
): boolean {
  try {
    const r = resolveAdjudicator(cfg, env ? { context: "server", env } : { context: "server" });
    // A job has no embedder, so the embedding provider could only answer "unsupported".
    if (r.provider === "heuristic" || r.provider === "embedding") return false;
    const cap = decisionFeatureConfig(cfg, feature).maxCallsPerDay;
    if (cap > 0 && db.decisions.callsToday(feature, now) >= cap) return false;
    if (gateStore(db).hasUnsupported?.(feature, r.provider, now - UNSUPPORTED_RETRY_MS))
      return false;
    const s = db.adjudicator.providerState(r.provider);
    const future = s?.retryAt !== null && s?.retryAt !== undefined && now < s.retryAt;
    if (s?.state === "auth_failed")
      return !authLockout(s, now, currentKeyFingerprint(r, env))?.locked;
    if ((s?.state === "open" || s?.state === "half_open" || s?.state === "slow") && future)
      return false;
    return !(r.remote && overBudget(s, cfg, now));
  } catch {
    return false;
  }
}

/** Claim a slot for one job (per scope and global); false means one is already in flight. */
export function claimJobSlot(
  db: StorageAdapter,
  job: Pick<DecisionJob, "feature" | "sessionId" | "payload">,
  now = Date.now(),
): boolean {
  try {
    return (
      gateStore(db).claimJob?.({
        feature: job.feature,
        scope: jobScope(job),
        now,
        ttlMs: JOB_LOCK_TTL_MS,
        perScope: MAX_JOBS_PER_SCOPE,
        maxRunning: MAX_JOBS_RUNNING,
      }) ?? true
    );
  } catch {
    return false;
  }
}

export function releaseJobSlot(
  db: StorageAdapter,
  job: Pick<DecisionJob, "feature" | "sessionId" | "payload">,
): void {
  try {
    gateStore(db).releaseJob?.(job.feature, jobScope(job));
  } catch {
    // the lock expires on its own
  }
}

/** Start the detached child and write the job to its stdin. Never throws; false when it could not. */
export function spawnDecisionJob(job: DecisionJob, deps: DecisionSpawnDeps = {}): boolean {
  try {
    const script = deps.script ?? process.argv[1];
    if (!script) return false;
    const child = (deps.spawn ?? nodeSpawn)(
      deps.execPath ?? process.execPath,
      [script, "--decision"],
      {
        detached: true,
        stdio: ["pipe", "ignore", "ignore"],
        shell: false,
        windowsHide: true,
        env: deps.env ?? process.env,
      },
    );
    child.on("error", () => {});
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify(job));
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** Parse and sanity-check the job JSON; undefined when it is not a job. */
export function parseDecisionJob(raw: string): DecisionJob | undefined {
  try {
    const j = JSON.parse(raw) as Partial<DecisionJob>;
    if (
      j?.v !== 1 ||
      typeof j.projectRoot !== "string" ||
      !DECISION_FEATURES.includes(j.feature as never) ||
      (j.sessionId !== undefined && typeof j.sessionId !== "string")
    )
      return undefined;
    return j as DecisionJob;
  } catch {
    return undefined;
  }
}
