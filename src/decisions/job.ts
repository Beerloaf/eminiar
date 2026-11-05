import { spawn as nodeSpawn } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
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
  /**
   * The running installation, as a module URL (default this module's own import.meta.url, i.e.
   * a file in the plugin's dist/). The spawned script is always the hook.js next to it; there is
   * no way to name the script, and no environment variable (EMINIAR_PLUGIN_ROOT, process.argv)
   * is consulted. Tests point it at a fixture directory.
   */
  moduleUrl?: string;
  /** The working directory a planted script is refused under (default process.cwd()). */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/** A lock that outlives a crashed job by at most this long. */
const JOB_LOCK_TTL_MS = 30_000;
/** Jobs in flight: per session (or swarm run), and in all. */
const MAX_JOBS_PER_SCOPE = 2;
const MAX_JOBS_RUNNING = 4;
/** A provider that said "unsupported" is not asked again by a hook for this long. */
const UNSUPPORTED_RETRY_MS = 3_600_000;

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
    if (db.decisions.hasUnsupported(feature, r.provider, now - UNSUPPORTED_RETRY_MS)) return false;
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
    return db.decisions.claimJob({
      feature: job.feature,
      scope: jobScope(job),
      now,
      ttlMs: JOB_LOCK_TTL_MS,
      perScope: MAX_JOBS_PER_SCOPE,
      maxRunning: MAX_JOBS_RUNNING,
    });
  } catch {
    return false;
  }
}

export function releaseJobSlot(
  db: StorageAdapter,
  job: Pick<DecisionJob, "feature" | "sessionId" | "payload">,
): void {
  try {
    db.decisions.releaseJob(job.feature, jobScope(job));
  } catch {
    // the lock expires on its own
  }
}

const HOOK_NAME = /^hook\.(?:js|mjs|cjs)$/;

/** True when `p` is `root` or lies under it (both already resolved). */
function within(p: string, root: string): boolean {
  const rel = relative(root, p);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * The hook entry of the running installation: the real path of the hook.js next to this module
 * (the bundle is flat, so server.js, cli.js, hook.js and the hook-*.js chunks share dist/).
 * Derived from the module's own location only: never from EMINIAR_PLUGIN_ROOT, which a cloned
 * repo's .claude/settings.json `env` block can set, and never from process.argv[1]. Undefined
 * when there is no such regular file (a symlinked hook.js is refused), e.g. when running from src/.
 */
export function trustedHookScript(moduleUrl: string = import.meta.url): string | undefined {
  try {
    const moduleFile = realpathSync(fileURLToPath(moduleUrl));
    const candidate = join(dirname(moduleFile), "hook.js");
    if (!lstatSync(candidate).isFile()) return undefined;
    return realpathSync(candidate) === candidate ? candidate : undefined;
  } catch {
    return undefined;
  }
}

export interface HookScriptCheck {
  moduleUrl?: string | undefined;
  /** Roots a planted script may sit in: the job's project root and the working directory. */
  projectRoot?: string | undefined;
  cwd?: string | undefined;
}

/**
 * Only the running installation's hook entry understands `--decision`, and only it may be
 * spawned. A script is accepted when it is the absolute, already-canonical path that
 * trustedHookScript() returns: any other file named hook.js (one under the project, a relative
 * path, a symlink, even one to the real hook, the MCP server's dist/server.js, a test runner) is
 * refused. A
 * script under the project root or the working directory is refused too, unless the running
 * module itself lives there (then the project already supplies the running code, e.g. Claude
 * Code started in $HOME or the plugin developed in place, and refusing would protect nothing).
 */
export function isHookScript(script: string, check: HookScriptCheck = {}): boolean {
  try {
    if (typeof script !== "string" || !isAbsolute(script)) return false;
    if (!HOOK_NAME.test(basename(script))) return false;
    const expected = trustedHookScript(check.moduleUrl);
    // The path itself must be the canonical one: a symlink (or a path through a symlinked
    // directory) to the real hook is refused too, not only one that resolves elsewhere.
    if (!expected || script !== expected || realpathSync(script) !== expected) return false;
    const moduleFile = realpathSync(fileURLToPath(check.moduleUrl ?? import.meta.url));
    for (const root of [check.projectRoot, check.cwd ?? process.cwd()]) {
      if (!root || !isAbsolute(root)) continue;
      let real: string;
      try {
        real = realpathSync(root);
      } catch {
        continue;
      }
      if (within(expected, real) && !within(moduleFile, real)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Start the detached child and write the job to its stdin. Never throws; false when it could not.
 * The script is always the running installation's hook.js (trustedHookScript), never a caller-
 * or environment-supplied path.
 */
export function spawnDecisionJob(job: DecisionJob, deps: DecisionSpawnDeps = {}): boolean {
  try {
    const script = trustedHookScript(deps.moduleUrl);
    if (
      !script ||
      !isHookScript(script, {
        moduleUrl: deps.moduleUrl,
        projectRoot: job.projectRoot,
        cwd: deps.cwd,
      })
    )
      return false;
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
