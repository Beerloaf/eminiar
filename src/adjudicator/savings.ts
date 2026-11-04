/**
 * Adjudicator savings (docs/design/adjudicator.md §13): the baseline model a dispatch would
 * have run on without the adjudicator, repricing the same token vector at that model through
 * src/usage/pricing.ts, and the savings summary the CLI, em_adjudicate stats and the dashboard
 * show.
 *
 * Every figure here rests on the assumptions in SAVINGS_ASSUMPTIONS; the summary returns them
 * with the numbers so no surface shows a savings figure without them.
 */

import type { StorageAdapter } from "../storage/adapter.js";
import type { AdjudicationListFilter, ApiCallRow } from "../storage/types.js";
import {
  costOfCall,
  type ModelPrice,
  type PricingOverrides,
  resolvePrice,
} from "../usage/pricing.js";
import { FALLBACK_MODEL } from "../usage/savings.js";
import { type AdjudicationRow, TIERS, type Tier } from "./types.js";

export { FALLBACK_MODEL };

export const SAVINGS_ASSUMPTIONS: readonly string[] = Object.freeze([
  "Token counts would have been the same on the baseline model. Smaller models can need more turns, so compare tokens per successful task by tier.",
  "List prices, with cache pricing unchanged.",
  "Credit only for dispatches that were followed or applied; a failed attempt that was redone is charged its full cost.",
  "The adjudicator's own provider spend is subtracted.",
  "No credit for tool advice: em_stats already counts context kept out by em_* tools. Only the tool-advice follow rate is reported.",
  "Main-session advice yields potential savings only and is never added to net: the counterfactual cannot be observed.",
]);

/** Main-thread lookback when resolving the session model at a dispatch. */
const SESSION_LOOKBACK_MS = 12 * 60 * 60 * 1000;

// --- tiers ---------------------------------------------------------------------------

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

/** Position on the haiku < sonnet < opus < fable ladder; −1 when unknown. */
export function tierRank(tier: string | null | undefined): number {
  return TIERS.indexOf(tier as Tier);
}

// --- baseline ------------------------------------------------------------------------

/** A frontmatter / role model counts as pinned unless it is absent or "inherit". */
export function isPinned(model: string | null | undefined): model is string {
  const m = String(model ?? "").trim();
  return m !== "" && m.toLowerCase() !== "inherit";
}

export interface BaselineQuery {
  /** The role's or agent's frontmatter model, when known. */
  pinned?: string | null | undefined;
  sessionId?: string | null | undefined;
  /** Epoch ms of the dispatch. */
  ts: number;
  /** Already-loaded calls of the session (any order), to skip the query. */
  calls?: readonly ApiCallRow[] | undefined;
}

export interface Baseline {
  model: string;
  source: "pinned" | "session" | "fallback";
}

/**
 * What would have run without the adjudicator, in order: the pinned frontmatter model, the
 * main-session model at `ts` (the latest main-thread api_calls row before it), usage's
 * fallback model.
 */
export function resolveBaseline(db: StorageAdapter | undefined, q: BaselineQuery): Baseline {
  if (isPinned(q.pinned)) return { model: q.pinned.trim(), source: "pinned" };
  if (q.sessionId) {
    const calls =
      q.calls ??
      (db
        ? db.apiCalls({
            sessionId: q.sessionId,
            since: q.ts - SESSION_LOOKBACK_MS,
            until: q.ts,
            sidechain: false,
          })
        : []);
    let best: ApiCallRow | undefined;
    for (const c of calls) {
      if (c.sidechain || c.session_id !== q.sessionId || c.ts >= q.ts || !c.model) continue;
      if (c.model.startsWith("<")) continue; // "<synthetic>" placeholders
      if (!best || c.ts >= best.ts) best = c;
    }
    if (best) return { model: best.model, source: "session" };
  }
  return { model: FALLBACK_MODEL, source: "fallback" };
}

// --- repricing -----------------------------------------------------------------------

/** input + output + cache writes + cache reads of the calls. */
export function totalTokens(calls: readonly ApiCallRow[]): number {
  let n = 0;
  for (const c of calls)
    n +=
      (c.input_tokens || 0) +
      (c.output_tokens || 0) +
      (c.cache_create_5m || 0) +
      (c.cache_create_1h || 0) +
      (c.cache_read || 0);
  return n;
}

/** The model with the most calls (ties: the later one); undefined for no calls. */
export function dominantModel(calls: readonly ApiCallRow[]): string | undefined {
  const counts = new Map<string, number>();
  let best: string | undefined;
  let bestN = 0;
  for (const c of calls) {
    if (!c.model || c.model.startsWith("<")) continue;
    const n = (counts.get(c.model) ?? 0) + 1;
    counts.set(c.model, n);
    if (n >= bestN) {
      best = c.model;
      bestN = n;
    }
  }
  return best;
}

/**
 * What the calls cost as they ran: each call priced at its own model (overrides honoured),
 * falling back to the cost stored at ingest. null when some call cannot be priced at all.
 */
export function actualCost(
  calls: readonly ApiCallRow[],
  overrides?: PricingOverrides,
): number | null {
  let total = 0;
  for (const c of calls) {
    const p = resolvePrice(c.model, overrides);
    if (p) total += costOfCall(c, p).total;
    else if (typeof c.cost_usd === "number" && c.priced) total += c.cost_usd;
    else return null;
  }
  return total;
}

/** The same token vectors repriced at `model`; null when the model has no price. */
export function repriceAt(
  calls: readonly ApiCallRow[],
  model: string,
  overrides?: PricingOverrides,
): number | null {
  const p: ModelPrice | undefined = resolvePrice(model, overrides);
  if (!p) return null;
  let total = 0;
  for (const c of calls) total += costOfCall(c, p).total;
  return total;
}

// --- prompt windows ------------------------------------------------------------------

/**
 * Assign each main-thread call to the prompt row it follows: the latest prompt row of the
 * same session with ts ≤ the call's ts. Calls before a session's first prompt row, sidechain
 * calls and calls of sessions without a prompt row are dropped. Returns calls per row id.
 */
export function promptWindows(
  prompts: ReadonlyArray<Pick<AdjudicationRow, "id" | "ts" | "sessionId">>,
  calls: readonly ApiCallRow[],
): Map<number, ApiCallRow[]> {
  const bySession = new Map<string, Array<Pick<AdjudicationRow, "id" | "ts">>>();
  for (const p of prompts) {
    if (!p.sessionId) continue;
    const list = bySession.get(p.sessionId);
    if (list) list.push(p);
    else bySession.set(p.sessionId, [p]);
  }
  for (const list of bySession.values()) list.sort((a, b) => a.ts - b.ts || a.id - b.id);
  const out = new Map<number, ApiCallRow[]>();
  for (const p of prompts) out.set(p.id, []);
  for (const c of calls) {
    if (c.sidechain) continue;
    const list = bySession.get(c.session_id);
    if (!list) continue;
    // Binary search for the last prompt with ts <= c.ts.
    let lo = 0;
    let hi = list.length - 1;
    let at = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((list[mid] as { ts: number }).ts <= c.ts) {
        at = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (at < 0) continue;
    out.get((list[at] as { id: number }).id)?.push(c);
  }
  return out;
}

// --- listing helper ------------------------------------------------------------------

/** Every row matching the filter (paged through the store's 500-row limit), oldest first. */
export function allRows(
  db: StorageAdapter,
  filter: Omit<AdjudicationListFilter, "limit" | "offset"> = {},
  max = 20_000,
): AdjudicationRow[] {
  const out: AdjudicationRow[] = [];
  for (let offset = 0; offset < max; offset += 500) {
    const { rows, total } = db.adjudicator.list({ ...filter, limit: 500, offset });
    out.push(...rows);
    if (!rows.length || offset + rows.length >= total) break;
  }
  return out.sort((a, b) => a.ts - b.ts || a.id - b.id);
}

// --- summary -------------------------------------------------------------------------

export interface TierTokens {
  /** Successful tasks whose actual model is this tier: agent rows, or plan rows of tasks without one. */
  tasks: number;
  tokens: number;
  costUsd: number;
  tokensPerTask: number | null;
}

export interface SavingsReport {
  since: number | null;
  /** Whether any api_calls exist; without usage ingestion actual/baseline figures stay null. */
  usageAvailable: boolean;
  /** Σ savings_usd as reconcile credited it (followed / applied rows, redo penalties included). */
  realisedUsd: number;
  /** The negative part of realisedUsd: failed attempts that were redone. */
  redoPenaltyUsd: number;
  creditedRows: number;
  /** Main-session advice: never part of net. */
  potentialUsd: number;
  potentialRows: number;
  /** Σ cost_usd of the adjudicator's own calls, every surface. */
  spendUsd: number;
  /** realisedUsd − spendUsd. */
  netUsd: number;
  tokensPerSuccessByTier: Partial<Record<Tier, TierTokens>>;
  /**
   * Suggested tier × the tier (or model) that actually ran: one count per agent dispatch, plus
   * plan rows of swarm tasks no agent row tracks (each task counted once).
   */
  matrix: Array<{ suggested: string; actual: string; n: number }>;
  assumptions: string[];
}

export interface SavingsReportOptions {
  since?: number | undefined;
  pricing?: PricingOverrides | undefined;
}

const CREDITED = new Set(["applied", "followed"]);

const taskKey = (r: Pick<AdjudicationRow, "runId" | "taskId">) => `${r.runId}#${r.taskId}`;

/**
 * Realised, potential, spend and net for rows since `since`. Run reconcile first so the
 * per-row figures are current; potential savings are repriced here from the prompt windows.
 */
export function savingsReport(db: StorageAdapter, opts: SavingsReportOptions = {}): SavingsReport {
  const since = opts.since;
  const rows = allRows(db, since === undefined ? {} : { since });
  const usageAvailable = db.apiCallsLatestTs() !== undefined;

  let realisedUsd = 0;
  let redoPenaltyUsd = 0;
  let creditedRows = 0;
  let spendUsd = 0;
  const byTier: Partial<Record<Tier, TierTokens>> = {};
  const matrix = new Map<string, { suggested: string; actual: string; n: number }>();
  // A swarm task has a plan row and, once dispatched, an agent row; reconcile gives both the
  // worker's calls. Count the task once: by its agent row(s), by the plan row only when no
  // agent row tracks the task (the rule reconcile teaches by). Agent rows follow their plan
  // row, so a plan row inside `since` has its agent rows inside it too.
  const dispatched = new Set(
    rows
      .filter((r) => r.surface === "agent" && r.runId && typeof r.taskId === "number")
      .map(taskKey),
  );
  const counts = (r: AdjudicationRow) =>
    r.surface === "agent" || (r.surface === "plan" && !dispatched.has(taskKey(r)));

  for (const r of rows) {
    if (typeof r.costUsd === "number") spendUsd += r.costUsd;
    if (typeof r.savingsUsd === "number" && r.savingsUsd !== 0) {
      realisedUsd += r.savingsUsd;
      if (r.savingsUsd < 0 && r.outcome === "failure") redoPenaltyUsd += r.savingsUsd;
      if (CREDITED.has(r.action ?? "")) creditedRows++;
    }
    if (counts(r) && r.tier && r.actualModel) {
      const actual = tierOf(r.actualModel) ?? r.actualModel;
      const k = `${r.tier}\u0000${actual}`;
      const m = matrix.get(k);
      if (m) m.n++;
      else matrix.set(k, { suggested: r.tier, actual, n: 1 });
    }
    if (counts(r) && r.outcome === "success") {
      const t = tierOf(r.actualModel);
      if (t && typeof r.actualTokens === "number") {
        const e = byTier[t] ?? { tasks: 0, tokens: 0, costUsd: 0, tokensPerTask: null };
        byTier[t] = e;
        e.tasks++;
        e.tokens += r.actualTokens;
        e.costUsd += r.actualCostUsd ?? 0;
        e.tokensPerTask = Math.round(e.tokens / e.tasks);
      }
    }
  }

  // Potential savings: prompts whose advised tier is below the tier that actually ran.
  let potentialUsd = 0;
  let potentialRows = 0;
  const prompts = rows.filter((r) => r.surface === "prompt" && r.sessionId && r.tier);
  if (usageAvailable && prompts.length) {
    const sessions = new Set(prompts.map((p) => p.sessionId as string));
    const from = Math.min(...prompts.map((p) => p.ts));
    const calls: ApiCallRow[] = [];
    for (const s of sessions)
      calls.push(...db.apiCalls({ sessionId: s, since: from, sidechain: false }));
    // Windows need every prompt row of those sessions, not only the advised ones.
    const allPrompts = rows.filter((r) => r.surface === "prompt" && r.sessionId);
    const windows = promptWindows(allPrompts, calls);
    for (const p of prompts) {
      const w = windows.get(p.id) ?? [];
      if (!w.length) continue;
      const ran = tierOf(dominantModel(w));
      if (tierRank(p.tier) < 0 || tierRank(ran) < 0 || tierRank(p.tier) >= tierRank(ran)) continue;
      const actual = actualCost(w, opts.pricing);
      const advised = repriceAt(w, p.tier as string, opts.pricing);
      if (actual === null || advised === null || actual <= advised) continue;
      potentialUsd += actual - advised;
      potentialRows++;
    }
  }

  const assumptions = [...SAVINGS_ASSUMPTIONS];
  if (!usageAvailable)
    assumptions.push(
      "No API calls are recorded (usage ingestion off or not run yet): new dispatches get no actual or baseline cost and potential savings stay $0; realised savings only count dispatches priced earlier.",
    );

  return {
    since: since ?? null,
    usageAvailable,
    realisedUsd,
    redoPenaltyUsd,
    creditedRows,
    potentialUsd,
    potentialRows,
    spendUsd,
    netUsd: realisedUsd - spendUsd,
    tokensPerSuccessByTier: byTier,
    matrix: [...matrix.values()].sort((a, b) => b.n - a.n),
    assumptions,
  };
}
