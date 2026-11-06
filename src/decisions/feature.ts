import type { ProjectContext } from "../context.js";
import type { HookInput } from "../hooks/types.js";
import type { StorageAdapter } from "../storage/adapter.js";
import type { DecisionClient, DecisionJob, RecallRerank } from "./types.js";

/** What a feature module gets in a hook. The client is in context "hook": cached() only, no I/O. */
export interface HookSeam {
  ctx: ProjectContext;
  db: StorageAdapter;
  sessionId: string;
  client: DecisionClient;
  /** Start the detached job with `payload`; at most one spawn per event (false when refused). */
  spawn(payload: unknown): boolean;
}

/**
 * One feature, loaded lazily through the registry (src/decisions/registry.ts). The foundation wires the
 * hook call sites; each feature file implements only the parts it needs. All hooks are sync and
 * make no network call. Shadow means record only: output byte-identical to the off path.
 */
export interface DecisionFeatureModule {
  /** Bump when the question wording changes: it is part of the cache key. */
  questionVersion: number;
  /** A: the rerank seam for recallForText ("prompt") or recallForError ("error"). */
  recallRerank?(seam: HookSeam, path: "prompt" | "error"): RecallRerank | undefined;
  /** C: the payload to spawn for this PreToolUse, or undefined. */
  preToolUse?(seam: HookSeam, input: HookInput): unknown | undefined;
  /** D: the payload to spawn after the snapshot was written. */
  preCompact?(seam: HookSeam, x: { sessionId: string; snapshotId: number }): unknown | undefined;
  /** Child side of a spawned job (`em-hook --decision`); never throws. */
  runJob?(job: DecisionJob, client: DecisionClient, db: StorageAdapter): Promise<void>;
}
