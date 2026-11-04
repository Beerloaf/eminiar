/**
 * Which adjudication rows count as dispatches, and which of those ran on a model the advice did
 * not name. The store's summary (src/storage/sqlite/adjudicator.ts) and the savings report
 * (src/adjudicator/savings.ts, which re-exports these) both count with these helpers, so the
 * dashboard's "advice followed" label and its matrix panel cannot disagree (#44, #81).
 *
 * Pure: no runtime imports, so the storage layer can use it without importing adjudicator modules.
 */

import type { AdjudicationRow, Tier } from "../adjudicator/types.js";

/** The tier a model id belongs to ("claude-opus-5-5[1m]" → "opus"); undefined when none. */
export function tierOf(model: string | null | undefined): Tier | undefined {
  const id = String(model ?? "").toLowerCase();
  if (!id) return undefined;
  if (id.includes("haiku")) return "haiku";
  if (id.includes("sonnet")) return "sonnet";
  if (id.includes("opus")) return "opus";
  if (id.includes("fable") || id.includes("mythos")) return "fable";
  return undefined;
}

/**
 * Why the advice named no model for a dispatch (docs/adjudicator.md "What the advice tells you to
 * pass"), from the flag onPreAgent and plan advice store in the row's scores JSON:
 *   pin    `pinDeferred`: the agent's model pin was kept (pinned, or unknown) under
 *          apply.respectFrontmatter
 *   force  `forced`: CLAUDE_CODE_SUBAGENT_MODEL_FORCE is on, so Claude Code sets the model
 *   fork   `fork`: a fork runs on the main session's model
 * Reconcile neither detects a follow nor credits savings for such a row, and the follow rate and
 * the suggested-tier matrix leave it out.
 */
export type KeptModel = "pin" | "force" | "fork";

/** The scores JSON key of each KeptModel. */
export const KEPT_MODEL_FLAG: Readonly<Record<KeptModel, string>> = Object.freeze({
  pin: "pinDeferred",
  force: "forced",
  fork: "fork",
});

/** The KeptModel flag stored in the row's scores JSON, if any. */
export function keptModel(row: Pick<AdjudicationRow, "scores">): KeptModel | undefined {
  if (!row.scores) return undefined;
  try {
    const s: unknown = JSON.parse(row.scores);
    if (!s || typeof s !== "object" || Array.isArray(s)) return undefined;
    const o = s as Record<string, unknown>;
    for (const k of Object.keys(KEPT_MODEL_FLAG) as KeptModel[])
      if (o[KEPT_MODEL_FLAG[k]] === true) return k;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * A row whose advice kept the agent's pin and that ran on it: no model was passed, and the model
 * that ran is the pinned one (or cannot be compared: an unknown pin, no usage yet).
 */
export function keptPin(
  row: Pick<AdjudicationRow, "scores" | "modelRequested" | "actualModel">,
): boolean {
  if (keptModel(row) !== "pin" || row.modelRequested) return false;
  let pinModel: unknown;
  try {
    pinModel = (JSON.parse(row.scores as string) as { pin?: { model?: unknown } })?.pin?.model;
  } catch {
    return false;
  }
  const want = typeof pinModel === "string" ? (tierOf(pinModel) ?? pinModel) : undefined;
  const ran = row.actualModel ? (tierOf(row.actualModel) ?? row.actualModel) : undefined;
  return !want || !ran || want === ran;
}

/**
 * The KeptModel a dispatch counts under (the savings report's keptModel): it ran (reconcile
 * recorded its actual model) on a model Claude Code chose, so it is neither an agreement nor a
 * disagreement with the advice. A kept-pin row counts only when it really ran on the pin
 * (keptPin); otherwise it is an ordinary dispatch. undefined for every other row.
 */
export function keptDispatch(
  row: Pick<AdjudicationRow, "scores" | "modelRequested" | "actualModel">,
): KeptModel | undefined {
  if (!row.actualModel) return undefined;
  const kept = keptModel(row);
  return kept && (kept !== "pin" || keptPin(row)) ? kept : undefined;
}

type DispatchKey = Pick<AdjudicationRow, "surface" | "runId" | "taskId">;

const taskKey = (r: DispatchKey) => `${r.runId}#${r.taskId}`;

/**
 * A predicate selecting the rows of `rows` that are dispatches, each counted once. A swarm task
 * has a plan row and, once dispatched, an agent row; reconcile gives both the worker's calls.
 * Count the task by its agent row(s), by its plan row only when no agent row in `rows` tracks
 * the task. Agent rows outside a swarm (and forks) count as themselves; prompt, mcp and other
 * rows are not dispatches. Agent rows follow their plan row, so a plan row inside a `since`
 * window has its agent rows inside it too.
 */
export function dispatchFilter<T extends DispatchKey>(rows: readonly T[]): (r: T) => boolean {
  const dispatched = new Set(
    rows
      .filter((r) => r.surface === "agent" && r.runId && typeof r.taskId === "number")
      .map(taskKey),
  );
  return (r) => r.surface === "agent" || (r.surface === "plan" && !dispatched.has(taskKey(r)));
}
