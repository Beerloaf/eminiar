import { spawn as nodeSpawn } from "node:child_process";
import { loadConfig } from "../config.js";
import { getContext } from "../context.js";
import type { StorageAdapter } from "../storage/adapter.js";
import { getStorage } from "../storage/index.js";
import { createDecisionClient, type DecisionClientDeps } from "./client.js";
import { decisionFeatureActive } from "./config.js";
import { loadFeature } from "./registry.js";
import { DECISION_FEATURES, type DecisionJob } from "./types.js";

/**
 * The detached feature job (docs/design/jev-integration-options.md): `em-hook --decision` with the job
 * JSON on stdin. A hook hands the network call here and answers at once. The job never carries a
 * key or a config: the child reloads the config, re-checks that the feature is still on, and
 * resolves the key itself. Text exists only in the pipe and the request, never on disk.
 */

type SpawnFn = typeof nodeSpawn;

export interface DecisionSpawnDeps {
  spawn?: SpawnFn;
  execPath?: string;
  /** The hook script (default process.argv[1], i.e. dist/hook.js inside a hook). */
  script?: string;
  env?: NodeJS.ProcessEnv;
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

export interface DecisionRunDeps {
  db?: StorageAdapter;
  env?: NodeJS.ProcessEnv;
  fetch?: DecisionClientDeps["fetch"];
  now?: () => number;
  log?: (line: string) => void;
}

export interface DecisionRunResult {
  ok: boolean;
  /** Why nothing ran (bad job, off, no module, no runJob). */
  reason?: string;
}

/** The child entry. Never throws. */
export async function runDecisionJob(
  raw: string,
  deps: DecisionRunDeps = {},
): Promise<DecisionRunResult> {
  const log = deps.log ?? (() => {});
  try {
    const job = parseDecisionJob(raw);
    if (!job) return { ok: false, reason: "invalid job" };
    // The job outlives the config it was queued with: re-read it, and re-check the gate.
    const cfg = loadConfig(job.projectRoot).adjudicator;
    if (!decisionFeatureActive(cfg, job.feature, deps.env ?? process.env))
      return { ok: false, reason: "off" };
    const mod = await loadFeature(job.feature);
    if (!mod?.runJob) return { ok: false, reason: "no job handler" };
    const db = deps.db ?? getStorage(getContext(job.projectRoot), { vectors: false });
    const clientDeps: DecisionClientDeps = { config: cfg, db, context: "job", log };
    if (deps.env) clientDeps.env = deps.env;
    if (deps.fetch) clientDeps.fetch = deps.fetch;
    if (deps.now) clientDeps.now = deps.now;
    await mod.runJob(job, createDecisionClient(job.feature, clientDeps), db);
    return { ok: true };
  } catch (err) {
    log(`jev: job failed: ${(err as Error)?.message ?? String(err)}`);
    return { ok: false, reason: "error" };
  }
}
