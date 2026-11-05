import { loadConfig } from "../config.js";
import { getContext } from "../context.js";
import type { StorageAdapter } from "../storage/adapter.js";
import { getStorage } from "../storage/index.js";
import { createDecisionClient, type DecisionClientDeps } from "./client.js";
import { decisionFeatureActive } from "./config.js";
import { parseDecisionJob, releaseJobSlot } from "./job.js";
import { loadFeature } from "./registry.js";
import type { DecisionJob } from "./types.js";

/**
 * The child side of a detached feature job (`em-hook --decision`, src/hook.ts). Kept apart from
 * ./job.ts, which the MCP server reaches (the swarm judge spawns jobs): this file uses the lazy
 * ./registry.ts, and the single-file server bundle must not contain any dynamic import() of an
 * internal module (tsup.config.ts, scripts/check-bundle.mjs). Only the hook loads it.
 */

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
  let held: DecisionJob | undefined;
  let heldDb = deps.db;
  try {
    const job = parseDecisionJob(raw);
    if (!job) return { ok: false, reason: "invalid job" };
    held = job;
    // The job outlives the config it was queued with: re-read it, and re-check the gate.
    const cfg = loadConfig(job.projectRoot).adjudicator;
    if (!decisionFeatureActive(cfg, job.feature, deps.env ?? process.env))
      return { ok: false, reason: "off" };
    const mod = await loadFeature(job.feature);
    if (!mod?.runJob) return { ok: false, reason: "no job handler" };
    const db = deps.db ?? getStorage(getContext(job.projectRoot), { vectors: false });
    heldDb = db;
    const clientDeps: DecisionClientDeps = { config: cfg, db, context: "job", log };
    if (deps.env) clientDeps.env = deps.env;
    if (deps.fetch) clientDeps.fetch = deps.fetch;
    if (deps.now) clientDeps.now = deps.now;
    await mod.runJob(job, createDecisionClient(job.feature, clientDeps), db);
    return { ok: true };
  } catch (err) {
    log(`jev: job failed: ${(err as Error)?.message ?? String(err)}`);
    return { ok: false, reason: "error" };
  } finally {
    // The hook's in-flight lock goes on every path, including "off".
    if (held) {
      try {
        releaseJobSlot(
          heldDb ?? getStorage(getContext(held.projectRoot), { vectors: false }),
          held,
        );
      } catch {
        // the lock expires on its own
      }
    }
  }
}
