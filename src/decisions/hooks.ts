import type { ProjectContext } from "../context.js";
import type { HookInput } from "../hooks/types.js";
import type { StorageAdapter } from "../storage/adapter.js";
import { createDecisionClient } from "./client.js";
import { decisionFeatureActive } from "./config.js";
import type { HookSeam } from "./feature.js";
import { claimJobSlot, providerAllowsJob, releaseJobSlot, spawnDecisionJob } from "./job.js";
import { loadFeature } from "./registry.js";
import { DECISION_FEATURES, type DecisionFeature, type RecallRerank } from "./types.js";

/**
 * The only Jev module the hooks import, and only after `cfg.enabled && featuresWanted(cfg)`.
 * Hooks never make a network call: a feature may read the cache, peek the database, record a
 * shadow row, drain the outbox and start ONE detached job per event. A feature that throws is
 * caught here, so the hook's own result never depends on Jev.
 */

/** Active features that implement `hook`, with a seam each; one spawn per event across them. */
async function seams(
  ctx: ProjectContext,
  db: StorageAdapter,
  sessionId: string,
  hook: "recallRerank" | "preToolUse" | "preCompact",
) {
  const cfg = ctx.config.adjudicator;
  const out: Array<{
    f: DecisionFeature;
    mod: NonNullable<Awaited<ReturnType<typeof loadFeature>>>;
    seam: HookSeam;
  }> = [];
  let spawned = false;
  for (const f of DECISION_FEATURES) {
    if (!decisionFeatureActive(cfg, f)) continue;
    const mod = await loadFeature(f);
    if (!mod?.[hook]) continue;
    const seam: HookSeam = {
      ctx,
      db,
      sessionId,
      client: createDecisionClient(f, { config: cfg, db, context: "hook" }),
      spawn: (payload) => {
        if (spawned) return false;
        // Cheap local checks first; a down, capped or unsupported provider spawns nothing.
        if (!providerAllowsJob(cfg, db, f)) return false;
        const job = { v: 1 as const, feature: f, projectRoot: ctx.root, sessionId, payload };
        if (!claimJobSlot(db, job)) return false;
        spawned = spawnDecisionJob(job);
        if (!spawned) releaseJobSlot(db, job);
        return spawned;
      },
    };
    out.push({ f, mod, seam });
  }
  return out;
}

/** The rerank seams for recallForText ("prompt") and recallForError ("error"). */
export async function decisionPromptSeams(
  ctx: ProjectContext,
  db: StorageAdapter,
  sessionId: string,
): Promise<{ prompt?: RecallRerank; error?: RecallRerank }> {
  const out: { prompt?: RecallRerank; error?: RecallRerank } = {};
  try {
    for (const { mod, seam } of await seams(ctx, db, sessionId, "recallRerank")) {
      const prompt = mod.recallRerank?.(seam, "prompt");
      const error = mod.recallRerank?.(seam, "error");
      if (prompt && !out.prompt) out.prompt = prompt;
      if (error && !out.error) out.error = error;
    }
  } catch {
    // Jev is optional
  }
  return out;
}

/** PreToolUse: lets a feature queue a job for this tool call. Never changes the hook's output. */
export async function decisionPreToolUse(
  ctx: ProjectContext,
  db: StorageAdapter,
  input: HookInput,
  sessionId: string,
): Promise<void> {
  try {
    for (const { mod, seam } of await seams(ctx, db, sessionId, "preToolUse")) {
      const payload = mod.preToolUse?.(seam, input);
      if (payload !== undefined) seam.spawn(payload);
    }
  } catch {
    // Jev is optional
  }
}

/** PostToolUse and UserPromptSubmit: the undelivered advice notes of this session (once each). */
export function decisionDrainNotes(
  db: StorageAdapter,
  sessionId: string,
  now = Date.now(),
): string | undefined {
  try {
    const notes = db.decisions.claimNotes(sessionId, now);
    if (!notes.length) return undefined;
    return notes.map((n) => n.note).join("\n");
  } catch {
    return undefined;
  }
}

/** PreCompact: after the snapshot was written, lets a feature queue a job for it. */
export async function decisionPreCompact(
  ctx: ProjectContext,
  db: StorageAdapter,
  sessionId: string,
  snapshotId: number,
): Promise<void> {
  try {
    for (const { mod, seam } of await seams(ctx, db, sessionId, "preCompact")) {
      const payload = mod.preCompact?.(seam, { sessionId, snapshotId });
      if (payload !== undefined) seam.spawn(payload);
    }
  } catch {
    // Jev is optional
  }
}
