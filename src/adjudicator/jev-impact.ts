/**
 * Jev impact (design: blackboard design-jev 1..3, memory adjudicator/jev-impact-design): what
 * TypeSafe Jev changed on top of the heuristic, and whether those changes helped, from the rows
 * the adjudicator already records. Read-only, no new columns, no prompt text.
 *
 * - Heuristic-alone counterfactual: each stored blend table is unmixed (blend.ts mixTable run
 *   backwards): h_o = (score_o·total − provider_o − boosts_o − bias_o)/(1−α), with
 *   total = 1 + Σ(boosts + bias). Bias is added back, the table renormalised and, for the tier,
 *   rounded up one step under weights.lowConfidence: blend(h, undefined, bias). The stored
 *   reasons are rounded to 0.01, so a counterfactual whose top-two margin is under
 *   UNCERTAIN_MARGIN (or whose confidence is within CONF_BAND of lowConfidence) is uncertain and
 *   never counted as a change. Jev's own pick is argmax provider_o/α.
 * - Deferred (async prompt) rows: source blend and provider latency above the row's latency; the
 *   user saw the heuristic's advice, so they only feed "would have changed".
 * - Agent rows take their plan row's verdict (hooks.ts onPreAgent copies it), so the plan row is
 *   the decision row when parentId is set, the tiers match, and the plan row is a typesafe
 *   decision inside the same window (decisionRowOf); otherwise the agent row stands alone.
 * - Outcomes are attributed on dispatches (src/storage/dispatch.ts) through the effective model
 *   the advice named (effectivePick), and the verdict is a Wilson 90% interval on help ÷ (help +
 *   hurt) (verdictOf). A label counts for or against Jev only on a dispatch that ran the tier the
 *   advice named (ranAdvice): learn.ts feedbackLesson teaches feedback to the tier that actually
 *   ran, so feedback on a dispatch that ignored the advice, or got none to apply, judges another
 *   model, and the dispatch is counted in outcomes.excluded.notRun (review-jev2 J1). A reconcile
 *   outcome counts only once it is final (J2); a dispatch whose outcome may still change is
 *   counted in outcomes.excluded.notFinal.
 * - The minimums guard the dispatch evidence (J4): the compared minimum counts only certain plan
 *   and agent decisions Jev answered inline (prompt and cache decisions never carry outcomes),
 *   and the labelled outcomes must come from MIN_UNITS distinct swarm runs or sessions.
 * - The apply bounds a dispatch ran under are not stored, so today's are never used to clamp the
 *   heuristic's tier (J3): a dispatch whose answer depends on bounds that today's config or the
 *   defaults would apply is left out (outcomes.excluded.bounds).
 *
 * Imports are limited to modules the web bundle's type check accepts (types.ts, dispatch.ts,
 * pricing.ts), so the dashboard can import these types: the small helpers below mirror
 * heuristic.ts (tableConfidence, effortFor, DEFAULT_TIERS), learn.ts (feedbackOf), savings.ts
 * (advisedPick, RANGED_FLAG, allRows) and engine.ts (surfaceBudget, non-local), and the db and
 * config are taken structurally (StorageAdapter and AdjudicatorConfig satisfy them).
 */

import { dispatchFilter, keptModel, tierOf } from "../storage/dispatch.js";
import { type ModelPrice, type PricingOverrides, resolvePrice } from "../usage/pricing.js";
import {
  type AdjudicationRow,
  EFFORTS,
  type Effort,
  type ProviderStatus,
  type Reason,
  type ScoreEntry,
  type ScoreTable,
  type Surface,
  TIERS,
  type Tier,
} from "./types.js";

// --- constants ---------------------------------------------------------------------------

/** Counterfactual top-two margin under which a reconstructed pick is uncertain (±0.017 rounding). */
export const UNCERTAIN_MARGIN = 0.03;
/** A tier counterfactual whose confidence is this close to lowConfidence is uncertain. */
export const CONF_BAND = 0.015;
/** Rounding slack (stored reasons are rounded to 0.01) before a clamped entry counts as unknown. */
const CLAMP_SLACK = 0.01;
/** At or above this provider weight the heuristic cannot be recovered from the blend. */
export const ALPHA_MAX = 0.95;
/** Labelled outcomes on decisions Jev changed before the verdict can leave "not enough data". */
export const MIN_EVIDENCE = 10;
/**
 * Certain plan/agent decisions Jev answered inline before the verdict can leave "not enough
 * data". Prompt and cache decisions never carry outcomes, so they do not fill it (review-jev2 J4).
 */
export const MIN_COMPARED = 30;
/**
 * Distinct swarm runs or sessions the labelled outcomes must come from (review-jev2 J4): the
 * rows of one run share its brief, its coordinator and the worker's own "done", so they are not
 * independent and one run must not reach a verdict alone.
 */
export const MIN_UNITS = 3;
/** z of the two-sided 90% Wilson interval. */
export const WILSON_Z = 1.645;
/** Rows read per report (the dashboard's CHART_ROWS_MAX). */
export const JEV_ROWS_MAX = 20_000;
/** Parent rows outside the window fetched one by one, at most. */
export const PARENT_FETCH_MAX = 500;
/** Newest evidence rows returned. */
export const EVIDENCE_ROWS_MAX = 20;
/**
 * Commit 2b76617 (Jev complexity read on the rubric's 0..4 levels, not 0..1). Rows written
 * before it carry a wrong blended complexity, so they are left out of the complexity and effort
 * deltas (counted as excludedBeforeFix); see scoreScaleFixed.
 *
 * Limitation: no row field records the fix. The fix did not bump SCORER_VERSION (rows before
 * and after it store version "1"), providerModel names Jev's own model, which a client-side
 * parser fix does not change, and the scores JSON has no marker. So for version "1" rows this
 * is the commit's author time: a row written after it by a build without the fix (not yet
 * rebuilt or updated) is read as fixed, and a row from a build that had the fix before this
 * time would be left out.
 */
export const JEV_SCORE_FIX_TS = Date.parse("2026-11-05T11:03:47Z");
/** The SCORER_VERSION every row before and right after the score-scale fix stores. */
const SCORE_FIX_VERSION = 1;
/**
 * Default lowConfidence (blend.ts BLEND_DEFAULTS) when the config gives none; a copy, because
 * the web bundle cannot import blend.ts. adjudicator-jev-impact.test.ts pins it to the blend
 * module's and the config schema's defaults.
 */
export const LOW_CONFIDENCE_DEFAULT = 0.55;
/**
 * The config schema's apply bounds (config.ts apply.floor/ceiling defaults). A dispatch's bounds
 * are not stored, so a heuristic tier these or today's bounds would clamp makes the effective
 * pick unknown (effectivePick "bounds").
 */
export const DEFAULT_APPLY_BOUNDS: Readonly<{ floor: Tier; ceiling: Tier }> = Object.freeze({
  floor: "haiku",
  ceiling: "opus",
});
/** blend.ts ladderOf's fallback (heuristic.ts DEFAULT_TIERS). */
const DEFAULT_LADDER: readonly Tier[] = ["haiku", "sonnet", "opus"];
/** Scores-JSON keys written by the dispatch hook (savings.ts ADVISED_PICK_FIELD, RANGED_FLAG). */
const ADVISED_PICK_FIELD = "advisedPick";
const RANGED_FLAG = "ranged";
/**
 * Actions that make a dispatch part of the follow rate: a copy of the store summary's
 * ADVISE_ACTIONS (src/storage/sqlite/adjudicator.ts, which the web bundle cannot import);
 * adjudicator-jev-parity.test.ts pins the two together.
 */
export const ADVISE_ACTIONS: ReadonlySet<string> = new Set(["advised", "followed", "ignored"]);
/** Prices count as proportional when every component is within 1% of the input ratio. */
const PRICE_TOLERANCE = 0.01;

export const VERDICT_RULE =
  "helping when the 90% lower bound of help ÷ (help + hurt) over dispatches Jev changed is above 50%, with ≥ 10 labelled outcomes from ≥ 3 distinct swarm runs or sessions and ≥ 30 compared plan or agent decisions Jev answered inline (uncertain near-ties, prompts and cache hits left out); hindering when the upper bound is below 50%. Only a dispatch that ran the tier the advice named counts, and only once its outcome is final. A dispatch Jev moved down counts as help when the cheaper model finished the work and as hurt when it failed; a dispatch Jev moved up counts only through feedback (good, too small, too big), because finishing on the bigger model cannot show the smaller one would have failed. Feedback counts in both directions.";

export const JEV_ASSUMPTIONS: readonly string[] = Object.freeze([
  "The heuristic's pick is reconstructed from the stored blend table (rounded to 0.01); near-ties within 0.03 are left out as uncertain.",
  "The low-confidence round-up of the reconstructed tier uses the current adjudicator.tiers and weights.lowConfidence.",
  "The apply bounds a dispatch ran under are not stored: a dispatch whose heuristic tier today's or the default apply.floor/ceiling would clamp is left out as unknown, and any other is assumed to have run inside its bounds (bounds narrowed then and widened since are not seen).",
  "Async prompt rows (Jev's answer arrived after the heuristic's advice) count only as 'would have changed', never for outcomes.",
  "Token counts would have been the same on the heuristic's tier; smaller models can need more turns.",
  "List prices; a dispatch is repriced only when both models' prices are proportional (within 1%) on input, output and cache tokens.",
  "An upgrade's avoided failure is not credited: it cannot be observed.",
  "Jev's own spend is subtracted from the net.",
]);

// --- structural inputs -------------------------------------------------------------------

/** The store calls the report needs; a StorageAdapter satisfies it. */
export interface JevDb {
  adjudicator: {
    list(filter?: {
      since?: number | undefined;
      provider?: string | undefined;
      limit?: number | undefined;
      offset?: number | undefined;
    }): { rows: AdjudicationRow[]; total: number };
    get(id: number): AdjudicationRow | undefined;
    providerState(provider: string): { state: string } | undefined;
  };
  apiCallsLatestTs(): number | undefined;
}

/** The config the report reads; an AdjudicatorConfig satisfies it. */
export interface JevConfig {
  tiers?: readonly Tier[] | undefined;
  weights?: { lowConfidence?: number | undefined } | undefined;
  apply?: { floor?: Tier | undefined; ceiling?: Tier | undefined } | undefined;
  timeouts?: { promptMs: number; agentMs: number; planMs: number } | undefined;
}

export interface JevWindow {
  /** Epoch ms, inclusive; undefined = all rows. */
  since?: number | undefined;
  /** Only rows of this surface (dispatch counting still sees every row). */
  surface?: Surface | undefined;
}

export interface JevReportOptions {
  config: JevConfig;
  pricing?: PricingOverrides | undefined;
  now?: number | undefined;
  /** Whether any api_calls exist (db.apiCallsLatestTs() !== undefined). */
  usageAvailable?: boolean | undefined;
  /** The row list hit JEV_ROWS_MAX. */
  capped?: boolean | undefined;
  /** Why the configured provider falls back on every call (no_key | no_consent), if it does. */
  degraded?: string | null | undefined;
  /** typesafe's stored breaker state; null when never called. */
  breakerState?: string | null | undefined;
}

// --- result types ------------------------------------------------------------------------

export type JevClass = "applied" | "cache" | "deferred" | "skipped" | "guard" | "error" | "config";
export const JEV_CLASSES: readonly JevClass[] = [
  "applied",
  "cache",
  "deferred",
  "skipped",
  "guard",
  "error",
  "config",
];

export interface JevCounts {
  compared: number;
  agree: number;
  up: number;
  down: number;
}

export interface JevTransition {
  from: string;
  to: string;
  n: number;
}

export interface JevTierInfluence extends JevCounts {
  uncertain: number;
  /** Jev disagreed with the heuristic and the blend kept the heuristic's tier. */
  jevOverruled: number;
  bySurface: Record<string, JevCounts>;
  /** Keyed by the decision's final role. */
  byRole: Record<string, JevCounts>;
  /** Heuristic tier → final tier, diagonal included, uncertain rows left out. */
  transitions: JevTransition[];
  roundUps: {
    /** The final tier was rounded up for low confidence. */
    final: number;
    /** The heuristic alone would have rounded up. */
    counterfactual: number;
    /** Rounded up only because blending made a near-tie (the hinder signal). */
    blendInduced: number;
  };
  /** Deferred (async) decisions: Jev's answer arrived after the heuristic's advice was shown. */
  wouldHaveChanged: { compared: number; changed: number };
}

export interface JevDimInfluence {
  compared: number;
  agree: number;
  changed: number;
  uncertain: number;
  /** Changes only. */
  transitions: JevTransition[];
}

export interface JevFeedbackCounts {
  good: number;
  too_small: number;
  too_big: number;
}

export interface JevSplit {
  dispatches: number;
  followed: number;
  followDenom: number;
  followRate: number | null;
  final: number;
  success: number;
  failure: number;
  successRate: number | null;
  feedback: JevFeedbackCounts;
}

export type JevEvidenceKind = "help" | "hurt" | "neutral";

export interface JevEvidenceRow {
  id: number;
  ts: number;
  surface: Surface;
  kind: JevEvidenceKind;
  /** e.g. too_small_after_up, success_after_down. */
  code: string;
  /** The heuristic's effective tier. */
  from: Tier;
  /** The effective tier with Jev. */
  to: Tier;
}

export interface JevLatency {
  n: number;
  p50: number | null;
  p95: number | null;
}

export type JevVerdictLabel = "helping" | "hindering" | "not enough data";

export interface JevVerdict {
  label: JevVerdictLabel;
  rule: string;
  help: number;
  hurt: number;
  n: number;
  /**
   * Certain plan/agent decisions Jev answered inline (uncertain near-ties, prompt and cache
   * decisions left out): what MIN_COMPARED is checked against.
   */
  compared: number;
  /** Distinct swarm runs or sessions behind the help and hurt rows (MIN_UNITS). */
  units: number;
  /** Dispatches whose effective model Jev changed (influence.effective.changed). */
  changed: number;
  /**
   * Upgrade evidence: `counted` = feedback after Jev moved up (in help/hurt); `notCounted` =
   * upgrades with only a reconcile outcome (finished or failed), which say nothing either way.
   */
  upgrades: { counted: number; notCounted: number };
  minEvidence: number;
  minCompared: number;
  minUnits: number;
  /** Wilson 90% bounds of help ÷ n; null when n = 0. */
  low: number | null;
  high: number | null;
  reasons: string[];
  warnings: string[];
}

export interface JevImpactReport {
  since: number | null;
  now: number;
  surface: Surface | null;
  sample: {
    rows: number;
    decisions: number;
    jevApplied: number;
    cache: number;
    deferred: number;
    fallback: number;
    /** Compared or deferred decisions whose tier reconstruction is uncertain. */
    uncertain: number;
    /** Jev-informed decisions whose scores could not be unmixed. */
    unreconstructable: number;
    capped: boolean;
    /** Plan/agent decisions scored per statement (scores.units) vs as one text. */
    eras: { units: number; wholeText: number };
    /** Provider model → decisions. */
    models: Record<string, number>;
  };
  coverage: {
    byClass: Record<JevClass, number>;
    byStatus: Record<string, number>;
    attempts: number;
    errors: number;
    failureRate: number | null;
  };
  influence: {
    tier: JevTierInfluence;
    role: JevDimInfluence;
    /** Jev moves tools only through the needs-plan boost (or weights.features.toolProvider). */
    tool: JevDimInfluence;
    effort: { compared: number; up: number; down: number };
    complexity: {
      n: number;
      meanDelta: number | null;
      meanAbsDelta: number | null;
      excludedBeforeFix: number;
    };
    effective: { dispatches: number; changed: number; unchanged: number; unknown: number };
  };
  outcomes: {
    changed: JevSplit;
    unchanged: JevSplit;
    /** Dispatches left out of attribution, by reason. */
    excluded: {
      kept: number;
      deferred: number;
      notJev: number;
      unreconstructable: number;
      uncertain: number;
      unknown: number;
      /**
       * Dispatches whose outcome and feedback are left out of the evidence because they did not
       * run the tier the advice named (ignored, advised with no model passed, kept at the
       * agent's own model): a label on them judges the model that ran (review-jev2 J1). Unlike
       * the others they stay in the follow rate, the feedback counts and the dispatch totals.
       */
      notRun: number;
      /**
       * Dispatches that ran the advised tier whose outcome is not final yet (reconcile may still
       * change it): left out of the evidence and the success figures, kept in the dispatch
       * totals (review-jev2 J2).
       */
      notFinal: number;
      /**
       * Dispatches whose effective pick depends on apply bounds that are not stored and that
       * today's config or the defaults would apply (review-jev2 J3). Not in `unknown`; both
       * are in influence.effective.unknown.
       */
      bounds: number;
    };
    evidence: { help: number; hurt: number; neutral: number; rows: JevEvidenceRow[] };
  };
  cost: {
    spendUsd: number;
    calls: number;
    usdPerCall: number | null;
    providerLatency: JevLatency;
    /** latency_ms of applied decisions: the wait the user saw. */
    inline: JevLatency;
    /** latency_ms of skipped/cache rows on the same surfaces. */
    heuristicInline: JevLatency;
    deferred: number;
    timeouts: number;
    budgetMs: { prompt: number | null; agent: number | null; plan: number | null };
  };
  savings: {
    usageAvailable: boolean;
    repriced: number;
    unpriced: number;
    /** Σ positive deltas: Jev moved down and the cheaper model was used. */
    downSavedUsd: number;
    /** Σ |negative deltas|: Jev moved up and the dearer model was used. */
    upCostUsd: number;
    deltaUsd: number;
    /** deltaUsd − cost.spendUsd. */
    netUsd: number;
    assumptions: string[];
  };
  verdict: JevVerdict;
}

/** What the route adds about the provider; the dashboard's ProviderHealth satisfies `health`. */
export interface JevProviderSummary {
  configured: string;
  effective: string;
  degraded: string | null;
  model: string | null;
  health: {
    state: string | null;
    failures: number;
    latency: JevLatency;
  } | null;
}

export type JevImpactPayload<P extends JevProviderSummary = JevProviderSummary> = {
  active: true;
  provider: P;
} & JevImpactReport;

export interface JevImpactInactive {
  active: false;
  reason: "disabled" | "provider";
  provider: string;
  now: number;
}

// --- small mirrors -----------------------------------------------------------------------

const tierRank = (t: string | null | undefined): number => TIERS.indexOf(t as Tier);
const isTier = (t: unknown): t is Tier => typeof t === "string" && tierRank(t) >= 0;
const effortRank = (e: string | null | undefined): number => EFFORTS.indexOf(e as Effort);
const sign = (n: number): -1 | 0 | 1 => (n > 0 ? 1 : n < 0 ? -1 : 0);

/** heuristic.ts tableConfidence: 0.5 + (top − second)/2. */
function confidenceOf(scores: readonly number[]): number {
  return 0.5 + ((scores[0] ?? 0) - (scores[1] ?? 0)) / 2;
}

/** heuristic.ts effortFor. */
export function effortOf(c: number): Effort {
  if (c < 1.5) return "low";
  if (c < 2.5) return "medium";
  if (c < 3.5) return "high";
  if (c < 3.75) return "xhigh";
  return "max";
}

export type JevFeedback = keyof JevFeedbackCounts;

/** learn.ts feedbackOf: the em_adjudicate feedback label of a row, if any. */
export function feedbackKind(
  row: Pick<AdjudicationRow, "outcome" | "outcomeSource">,
): JevFeedback | undefined {
  const src = row.outcomeSource ?? "";
  if (src.startsWith("feedback:")) {
    const k = src.slice("feedback:".length);
    return k === "good" || k === "too_small" || k === "too_big" ? k : undefined;
  }
  if (src === "feedback")
    return row.outcome === "failure" ? "too_small" : row.outcome === "success" ? "good" : undefined;
  return undefined;
}

/**
 * Parsed scores per row object, keyed weakly so nothing outlives the rows. The source string is
 * kept beside the result, so a row whose scores were replaced is parsed again. One report reads
 * a dispatch's scores up to six times (viewOf, advisedPickOf and rangedOf on the row and on its
 * decision row); this keeps it to one JSON.parse per row (design-jev-2 H, review-jev F7).
 */
const parsedScores = new WeakMap<
  object,
  { src: string; value: Record<string, unknown> | undefined }
>();

/** A row's scores JSON as a record, or undefined. */
function scoresOf(row: Pick<AdjudicationRow, "scores">): Record<string, unknown> | undefined {
  const src = row.scores;
  if (!src) return undefined;
  const hit = parsedScores.get(row);
  if (hit && hit.src === src) return hit.value;
  let value: Record<string, unknown> | undefined;
  try {
    const o: unknown = JSON.parse(src);
    value =
      o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>) : undefined;
  } catch {
    value = undefined;
  }
  parsedScores.set(row, { src, value });
  return value;
}

function isTable(v: unknown): v is ScoreTable {
  if (!v || typeof v !== "object") return false;
  const t = v as Partial<ScoreTable>;
  return (
    typeof t.choice === "string" &&
    Array.isArray(t.entries) &&
    t.entries.length > 0 &&
    t.entries.every(
      (e: ScoreEntry) =>
        e &&
        typeof e.option === "string" &&
        typeof e.score === "number" &&
        Number.isFinite(e.score) &&
        Array.isArray(e.reasons),
    )
  );
}

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

function pct(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] ?? null;
}

function latencyOf(values: readonly number[]): JevLatency {
  return { n: values.length, p50: pct(values, 0.5), p95: pct(values, 0.95) };
}

// --- counterfactual ----------------------------------------------------------------------

export interface Counterfactual {
  /** The heuristic-alone pick, after the tier round-up. */
  choice: string;
  /** The top option before any round-up. */
  top: string;
  confidence: number;
  /** Top-two score margin of the reconstructed table. */
  margin: number;
  /** The heuristic alone would have rounded the tier up. */
  roundedUp: boolean;
  uncertain: boolean;
  /** Jev's own top option (argmax provider_o/α); undefined when Jev did not weigh in. */
  jev?: string;
}

export interface TierRoundUp {
  /** The configured ladder, smallest first. */
  tiers?: readonly Tier[] | undefined;
  lowConfidence: number;
}

const sumReasons = (reasons: readonly Reason[], features: ReadonlySet<string>): number =>
  reasons.reduce(
    (n, r) => (features.has(r.feature) && Number.isFinite(r.weight) ? n + r.weight : n),
    0,
  );

const PROVIDER = new Set(["provider"]);
const BOOSTS = new Set(["risky", "needsPlan"]);
const BIAS = new Set(["bias"]);

/** blend.ts ladderOf: the configured tiers present in the table, else TIERS order, else the default. */
function ladderOf(options: readonly string[], tiers?: readonly Tier[]): string[] {
  const present = new Set(options);
  const base: readonly string[] = tiers?.length ? tiers : TIERS;
  const ladder = base.filter((t) => present.has(t));
  return ladder.length ? ladder : [...DEFAULT_LADDER];
}

/**
 * The heuristic-alone table behind a stored blended table (see the header), or undefined when
 * it cannot be recovered (α ≥ ALPHA_MAX, a non-positive total). `alpha` is the stored effective
 * weight of the dimension (0 when absent), `bias` the stored flat bias map; `tier` turns on the
 * low-confidence round-up and its uncertainty band.
 */
export function counterfactual(
  table: ScoreTable,
  alpha: number,
  bias: Readonly<Record<string, number>> = {},
  tier?: TierRoundUp,
): Counterfactual | undefined {
  const a = Number.isFinite(alpha) && alpha > 0 ? alpha : 0;
  if (a >= ALPHA_MAX) return undefined;
  const parts = table.entries.map((e) => {
    const key = `${table.dimension}:${e.option}`;
    const stored = num(bias[key]);
    return {
      option: e.option,
      score: e.score,
      provider: sumReasons(e.reasons, PROVIDER),
      boosts: sumReasons(e.reasons, BOOSTS),
      bias: stored ?? sumReasons(e.reasons, BIAS),
    };
  });
  // mixTable clamps each blended score at 0 before renormalising, so an entry stored at 0 says
  // only that (1−α)h + provider + boosts + bias ≤ 0. The total therefore comes from the entries
  // above 0, with Σh = 1 and the clamped entries' h taken as 0; it equals 1 + Σ(boosts + bias)
  // when nothing was clamped. A clamped entry whose h could still be above 0 (a negative bias
  // pushed it under) makes the reconstruction uncertain.
  const live = parts.filter((p) => p.score > 0);
  const total = 1 - a + live.reduce((n, p) => n + p.provider + p.boosts + p.bias, 0);
  if (!(total > 0)) return undefined;
  let clampedUnknown = false;
  const raw = parts.map((p) => {
    if (!(p.score > 0)) {
      if ((-p.provider - p.boosts - p.bias) / (1 - a) > CLAMP_SLACK) clampedUnknown = true;
      return { option: p.option, s: Math.max(0, p.bias) };
    }
    const h = (p.score * total - p.provider - p.boosts - p.bias) / (1 - a);
    return { option: p.option, s: Math.max(0, Math.max(0, h) + p.bias) };
  });
  const sum = raw.reduce((n, r) => n + r.s, 0);
  if (!(sum > 0)) return undefined;
  const sorted = raw.map((r) => ({ option: r.option, s: r.s / sum })).sort((x, y) => y.s - x.s);
  const top = sorted[0]?.option ?? table.choice;
  const scores = sorted.map((r) => r.s);
  const margin = (scores[0] ?? 0) - (scores[1] ?? 0);
  const confidence = confidenceOf(scores);
  let choice = top;
  let roundedUp = false;
  let uncertain = clampedUnknown || margin < UNCERTAIN_MARGIN;
  if (tier) {
    if (Math.abs(confidence - tier.lowConfidence) < CONF_BAND) uncertain = true;
    if (confidence < tier.lowConfidence) {
      const ladder = ladderOf(
        sorted.map((r) => r.option),
        tier.tiers,
      );
      const at = ladder.indexOf(top);
      const up = at >= 0 && at < ladder.length - 1 ? ladder[at + 1] : undefined;
      if (up) {
        choice = up;
        roundedUp = true;
      }
    }
  }
  const out: Counterfactual = { choice, top, confidence, margin, roundedUp, uncertain };
  if (a > 0) {
    let best: { option: string; p: number } | undefined;
    for (const p of parts)
      if (p.provider > 0 && (!best || p.provider > best.p))
        best = { option: p.option, p: p.provider };
    if (best) out.jev = best.option;
  }
  return out;
}

// --- classification ----------------------------------------------------------------------

export type JevFallbackClass = "skipped" | "guard" | "error" | "config";

/**
 * The fallback class of every provider status. A Record over ProviderStatus, so a status added
 * to the union fails the type check here until it is classed (review-jev F10), and
 * adjudicator-jev-parity.test.ts checks the keys against the union in types.ts.
 */
export const PROVIDER_STATUS_CLASS: Readonly<Record<ProviderStatus, JevFallbackClass>> =
  Object.freeze({
    ok: "skipped",
    skipped: "skipped",
    "n/a": "skipped",
    breaker_open: "guard",
    slow_guard: "guard",
    over_budget: "guard",
    auth_failed: "guard",
    timeout: "error",
    http_error: "error",
    rate_limited: "error",
    invalid: "error",
    no_key: "config",
    no_consent: "config",
  });

/**
 * The fallback class of a provider status. A value outside ProviderStatus (an empty or missing
 * status, or one written by a newer build) reads as skipped.
 */
export function statusClass(status: ProviderStatus | string | null | undefined): JevFallbackClass {
  const s = String(status ?? "");
  return Object.hasOwn(PROVIDER_STATUS_CLASS, s)
    ? PROVIDER_STATUS_CLASS[s as ProviderStatus]
    : "skipped";
}

/** An async prompt row rewritten to blend after the heuristic's advice was shown. */
export function isDeferred(
  row: Pick<AdjudicationRow, "source" | "latencyMs" | "providerLatencyMs">,
): boolean {
  return (
    row.source === "blend" &&
    typeof row.providerLatencyMs === "number" &&
    typeof row.latencyMs === "number" &&
    row.providerLatencyMs > row.latencyMs
  );
}

/** The row's own class (not inherited from a parent). */
export function classOf(
  row: Pick<AdjudicationRow, "source" | "providerStatus" | "latencyMs" | "providerLatencyMs">,
): JevClass {
  if (row.source === "blend") return isDeferred(row) ? "deferred" : "applied";
  if (row.source === "cache") return "cache";
  return statusClass(row.providerStatus);
}

/** Jev's answer shaped this verdict (or would have, for deferred rows). */
const jevInformed = (c: JevClass) => c === "applied" || c === "cache" || c === "deferred";
/** Compared: Jev's answer shaped the advice the user saw. */
const compared = (c: JevClass) => c === "applied" || c === "cache";

export interface JevDimView {
  final: string;
  cf: string;
  uncertain: boolean;
  jev?: string;
}

export interface JevTierView extends JevDimView {
  finalRoundedUp: boolean;
  cfRoundedUp: boolean;
}

/** One decision as the report sees it. No text, only ids, options and numbers. */
export interface JevDecisionView {
  id: number;
  ts: number;
  surface: Surface;
  cls: JevClass;
  /** The scores were present and parsed. */
  scored: boolean;
  tier?: JevTierView;
  role?: JevDimView;
  tool?: JevDimView;
  /** sign(rank(final tier) − rank(heuristic tier)); 0 when uncertain or unknown. */
  dir: -1 | 0 | 1;
  complexity?: { final: number; heuristic: number };
  effort?: { final: string; heuristic: Effort };
  /** Scored per statement (scores.units). */
  units: boolean;
  /** The row's complexity is on the fixed 0..4 scale (scoreScaleFixed). */
  scaleFixed: boolean;
  model: string | null;
  finalRole: string;
}

/**
 * Whether a row's blended complexity is on the fixed scale (commit 2b76617, JEV_SCORE_FIX_TS).
 * A stored scorer version above the one the fix shipped with can only come from a later build,
 * so it wins over the time; a version "1" row (every row today) falls back to the commit time,
 * with the limitation JEV_SCORE_FIX_TS describes.
 */
export function scoreScaleFixed(row: Pick<AdjudicationRow, "ts" | "version">): boolean {
  const v = Number(row.version);
  if (Number.isFinite(v) && v > SCORE_FIX_VERSION) return true;
  return row.ts >= JEV_SCORE_FIX_TS;
}

/**
 * The row whose verdict `row` carries: its parent when set, of the same tier, a typesafe
 * decision (provider typesafe, or unset in a pure call) that is not a test row, and not older
 * than the window's `since`. A parent that fails any of these is another provider's, or another
 * period's, so the row stands as its own decision.
 */
export function decisionRowOf(
  row: AdjudicationRow,
  parent: AdjudicationRow | undefined,
  since?: number,
): AdjudicationRow {
  return row.parentId != null &&
    parent &&
    parent.id === row.parentId &&
    parent.tier === row.tier &&
    parent.surface !== "test" &&
    (parent.provider == null || parent.provider === "typesafe") &&
    (since === undefined || parent.ts >= since)
    ? parent
    : row;
}

/** Reads a decision row: its class, the final and heuristic-alone picks per dimension. */
export function viewOf(row: AdjudicationRow, cfg: JevConfig): JevDecisionView {
  const cls = classOf(row);
  const s = scoresOf(row);
  const view: JevDecisionView = {
    id: row.id,
    ts: row.ts,
    surface: row.surface,
    cls,
    scored: s !== undefined,
    dir: 0,
    units: !!s?.units,
    scaleFixed: scoreScaleFixed(row),
    model: row.providerModel ?? null,
    finalRole: row.role ?? "none",
  };
  if (!s) return view;
  const alpha = (s.alpha && typeof s.alpha === "object" ? s.alpha : {}) as Record<string, unknown>;
  const biasRaw = (s.bias && typeof s.bias === "object" ? s.bias : {}) as Record<string, unknown>;
  const bias: Record<string, number> = {};
  for (const [k, v] of Object.entries(biasRaw)) {
    const n = num(v);
    if (n !== undefined) bias[k] = n;
  }
  const lowConfidence = num(cfg.weights?.lowConfidence) ?? LOW_CONFIDENCE_DEFAULT;

  if (isTable(s.tier)) {
    const t = s.tier;
    const cf = counterfactual(t, num(alpha.tier) ?? 0, bias, { tiers: cfg.tiers, lowConfidence });
    if (cf) {
      const chosen = t.entries.find((e) => e.option === t.choice);
      view.tier = {
        final: t.choice,
        cf: cf.choice,
        uncertain: cf.uncertain,
        finalRoundedUp: !!chosen?.reasons.some((r) => r.feature === "lowConfidence"),
        cfRoundedUp: cf.roundedUp,
        ...(cf.jev !== undefined ? { jev: cf.jev } : {}),
      };
      if (!cf.uncertain) view.dir = sign(tierRank(t.choice) - tierRank(cf.choice));
    }
  }
  for (const dim of ["role", "tool"] as const) {
    const t = s[dim];
    if (!isTable(t)) continue;
    const cf = counterfactual(t, num(alpha[dim]) ?? 0, bias);
    if (cf)
      view[dim] = {
        final: t.choice,
        cf: cf.choice,
        uncertain: cf.uncertain,
        ...(cf.jev !== undefined ? { jev: cf.jev } : {}),
      };
  }
  const hc = num(s.heuristicComplexity);
  const fc = num(row.complexity) ?? num(s.complexity);
  if (hc !== undefined && fc !== undefined) view.complexity = { final: fc, heuristic: hc };
  const fe = row.effort ?? (typeof s.effort === "string" ? s.effort : undefined);
  if (hc !== undefined && fe && effortRank(fe) >= 0)
    view.effort = { final: fe, heuristic: effortOf(hc) };
  return view;
}

// --- effective pick ----------------------------------------------------------------------

/** The tier a dispatch's advice named (scores.advisedPick), if stored. */
export function advisedPickOf(row: Pick<AdjudicationRow, "scores">): Tier | undefined {
  const p = scoresOf(row)?.[ADVISED_PICK_FIELD];
  return isTier(p) ? p : undefined;
}

/** The dispatch went to a role with a model range (scores.ranged). */
export function rangedOf(row: Pick<AdjudicationRow, "scores">): boolean {
  return scoresOf(row)?.[RANGED_FLAG] === true;
}

function clampTier(t: Tier, floor?: Tier, ceiling?: Tier): Tier {
  let r = tierRank(t);
  if (floor && r < tierRank(floor)) r = tierRank(floor);
  if (ceiling && r > tierRank(ceiling)) r = tierRank(ceiling);
  return TIERS[r] ?? t;
}

export type ApplyBounds = { floor?: Tier | undefined; ceiling?: Tier | undefined };

export interface EffectiveInput {
  /** The verdict's raw tier. */
  raw: string | null | undefined;
  /** The tier the advice named, after the apply bounds or a role's range. */
  pick: Tier | undefined;
  /** The heuristic-alone tier. */
  cf: string | null | undefined;
  ranged: boolean;
  /** The apply bounds the dispatch ran under, when known (no row stores them today). */
  bounds?: ApplyBounds | undefined;
  /**
   * Bounds that may have applied when `bounds` is not known (the report passes today's config
   * and DEFAULT_APPLY_BOUNDS): an answer any of them would move is "bounds", never guessed.
   */
  possible?: readonly ApplyBounds[] | undefined;
}

const clampedBy = (t: Tier, b: ApplyBounds): boolean => clampTier(t, b.floor, b.ceiling) !== t;

/**
 * The effective tier with Jev and without it (design-jev A5). The pick's bounds are not stored,
 * so they are inferred from raw vs pick; when the counterfactual falls on the side the inference
 * cannot see, the answer is "unknown". Where the answer rests on bounds the inference cannot
 * see (raw equals the pick, or no pick is stored) and `bounds` is not given, a heuristic tier
 * that any `possible` bounds would clamp is "bounds" (review-jev2 J3): today's config is not the
 * one the dispatch ran under, so clamping with it would be a guess.
 */
export function effectivePick(i: EffectiveInput): { final: Tier; cf: Tier } | "unknown" | "bounds" {
  if (!isTier(i.raw) || !isTier(i.cf)) return "unknown";
  const rawT = i.raw;
  const cfT = i.cf;
  const floor = i.bounds?.floor;
  const ceiling = i.bounds?.ceiling;
  const unsure = (...ts: Tier[]): boolean =>
    !i.bounds && (i.possible ?? []).some((b) => ts.some((t) => clampedBy(t, b)));
  if (!i.pick) {
    if (unsure(rawT, cfT)) return "bounds";
    return { final: clampTier(rawT, floor, ceiling), cf: clampTier(cfT, floor, ceiling) };
  }
  const raw = tierRank(rawT);
  const pick = tierRank(i.pick);
  const cf = tierRank(cfT);
  if (raw < pick) return cf <= pick ? { final: i.pick, cf: i.pick } : "unknown";
  if (raw > pick) return cf >= pick ? { final: i.pick, cf: i.pick } : "unknown";
  if (cf === raw) return { final: i.pick, cf: i.pick };
  if (i.ranged) return "unknown";
  if (unsure(cfT)) return "bounds";
  return { final: i.pick, cf: clampTier(cfT, floor, ceiling) };
}

// --- evidence and verdict ----------------------------------------------------------------

/**
 * Whether a dispatch ran the tier its advice named (`final`, the effective tier with Jev). The
 * model that really ran wins (reconcile's actual model); until usage names one, a dispatch whose
 * model the hook set (applied) or the coordinator followed counts as run, and an advised one
 * counts when the model the coordinator passed is that tier. An ignored dispatch, an advised one
 * that passed no model (the baseline ran) and a respected one (the agent kept its own) did not.
 */
export function ranAdvice(
  row: Pick<AdjudicationRow, "action" | "actualModel" | "modelRequested">,
  final: Tier,
): boolean {
  const ran = tierOf(row.actualModel);
  if (ran) return ran === final;
  if (row.action === "applied" || row.action === "followed") return true;
  return tierOf(row.modelRequested) === final;
}

/**
 * What one labelled outcome on a dispatch Jev changed says (design-jev-2 E). `dir` is the
 * direction of Jev's move on effective tiers (+1 up, −1 down). Feedback beats the reconcile
 * outcome; undefined when the row has no usable label. `ran` is false for a dispatch that did
 * not run the tier the advice named (ranAdvice): nothing counts then, feedback included,
 * because learn.ts feedbackLesson applies a label to the tier that actually ran, so it judges
 * that model, not Jev's (review-jev2 J1). A reconcile outcome counts only on a final row
 * (`final` false: reconcile may still change it, J2); feedback rows are always final. A row
 * without `final` is read as final.
 */
export function evidenceOf(
  row: Pick<AdjudicationRow, "outcome" | "outcomeSource"> & { final?: boolean | undefined },
  dir: -1 | 1,
  ran = true,
): { kind: JevEvidenceKind; code: string } | undefined {
  if (!ran) return undefined;
  const way = dir > 0 ? "up" : "down";
  const fb = feedbackKind(row);
  if (fb) {
    const kind: JevEvidenceKind =
      fb === "good"
        ? "help"
        : fb === "too_small"
          ? dir > 0
            ? "help"
            : "hurt"
          : dir > 0
            ? "hurt"
            : "help";
    return { kind, code: `${fb}_after_${way}` };
  }
  if (row.final === false) return undefined;
  if (row.outcome === "success")
    return { kind: dir > 0 ? "neutral" : "help", code: `success_after_${way}` };
  if (row.outcome === "failure")
    return { kind: dir > 0 ? "neutral" : "hurt", code: `failure_after_${way}` };
  return undefined;
}

/** Wilson score interval of k successes in n at `z`; null bounds for n = 0. */
export function wilson(
  k: number,
  n: number,
  z = WILSON_Z,
): { low: number | null; high: number | null } {
  if (!(n > 0)) return { low: null, high: null };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, center - half), high: Math.min(1, center + half) };
}

const pctText = (x: number) => `${Math.round(x * 100)}%`;

/**
 * What the verdict's evidence covers (review-jev F2): how many of the changed dispatches carry a
 * counted label, and the upgrades left out because only feedback can judge them. Null when there
 * is nothing to add (no changed dispatches and no upgrades).
 */
export function verdictScope(e: {
  n: number;
  changed: number;
  upgrades: { counted: number; notCounted: number };
}): string | null {
  const { counted, notCounted } = e.upgrades;
  if (!e.changed && !counted && !notCounted) return null;
  const head = `${e.n} of ${e.changed} dispatches Jev changed have a counted label`;
  if (!counted && !notCounted) return head;
  return `${head}; upgrades count only through feedback: ${counted} counted, ${notCounted} that only finished or failed not counted`;
}

/** The verdict label from the evidence counts (design-jev-2 F). Warnings never change it. */
export function verdictOf(
  e: {
    help: number;
    hurt: number;
    /** Certain plan/agent decisions Jev answered inline. */
    compared: number;
    /** Distinct swarm runs or sessions behind help + hurt; 0 when omitted. */
    units?: number | undefined;
    changed?: number | undefined;
    upgrades?: { counted: number; notCounted: number } | undefined;
  },
  warnings: readonly string[] = [],
): JevVerdict {
  const n = e.help + e.hurt;
  const { low, high } = wilson(e.help, n);
  const changed = e.changed ?? 0;
  const units = e.units ?? 0;
  const upgrades = { counted: e.upgrades?.counted ?? 0, notCounted: e.upgrades?.notCounted ?? 0 };
  const base = {
    rule: VERDICT_RULE,
    help: e.help,
    hurt: e.hurt,
    n,
    compared: e.compared,
    units,
    changed,
    upgrades,
    minEvidence: MIN_EVIDENCE,
    minCompared: MIN_COMPARED,
    minUnits: MIN_UNITS,
    low,
    high,
    warnings: [...warnings],
  };
  // The scope line goes after the label's own reasons, so reasons[0] stays the deciding one.
  const scope = verdictScope({ n, changed, upgrades });
  const withScope = (rs: string[]): string[] => (scope ? [...rs, scope] : rs);
  const reasons: string[] = [];
  if (e.compared < MIN_COMPARED)
    reasons.push(
      `${e.compared} compared plan or agent decisions (prompts and cache hits not counted); need ${MIN_COMPARED}`,
    );
  if (n < MIN_EVIDENCE)
    reasons.push(`${n} labelled outcomes on decisions Jev changed; need ${MIN_EVIDENCE}`);
  if (units < MIN_UNITS)
    reasons.push(
      `labelled outcomes come from ${units} distinct swarm runs or sessions; need ${MIN_UNITS}`,
    );
  if (reasons.length) return { ...base, label: "not enough data", reasons: withScope(reasons) };
  if (low !== null && low > 0.5)
    return {
      ...base,
      label: "helping",
      reasons: withScope([
        `${e.help} of ${n} labelled outcomes on decisions Jev changed went its way, from ${units} swarm runs or sessions (90% lower bound ${pctText(low)})`,
      ]),
    };
  if (high !== null && high < 0.5)
    return {
      ...base,
      label: "hindering",
      reasons: withScope([
        `${e.hurt} of ${n} labelled outcomes on decisions Jev changed went against it, from ${units} swarm runs or sessions (90% upper bound of help ${pctText(high)})`,
      ]),
    };
  return {
    ...base,
    label: "not enough data",
    reasons: withScope([`evidence is split (${e.help} help vs ${e.hurt} hurt)`]),
  };
}

// --- savings -----------------------------------------------------------------------------

/**
 * `actual`'s cost repriced at `target` by the input-price ratio; null when either model has no
 * price or the two prices are not proportional within PRICE_TOLERANCE on every component.
 */
export function repriceByRatio(
  actualCostUsd: number,
  actualModel: string,
  target: string,
  pricing?: PricingOverrides,
): number | null {
  const pa = resolvePrice(actualModel, pricing);
  const pt = resolvePrice(target, pricing);
  if (!pa || !pt || !(pa.input > 0)) return null;
  const ratio = pt.input / pa.input;
  const keys: Array<keyof ModelPrice> = ["output", "cacheWrite5m", "cacheWrite1h", "cacheRead"];
  for (const k of keys) {
    const a = num(pa[k]);
    const t = num(pt[k]);
    if (a === undefined || t === undefined) return null;
    if (Math.abs(t - ratio * a) > PRICE_TOLERANCE * Math.max(t, ratio * a, 1e-12)) return null;
  }
  return actualCostUsd * ratio;
}

// --- report ------------------------------------------------------------------------------

const zeroCounts = (): JevCounts => ({ compared: 0, agree: 0, up: 0, down: 0 });
const zeroSplit = (): JevSplit => ({
  dispatches: 0,
  followed: 0,
  followDenom: 0,
  followRate: null,
  final: 0,
  success: 0,
  failure: 0,
  successRate: null,
  feedback: { good: 0, too_small: 0, too_big: 0 },
});
const zeroDim = (): JevDimInfluence => ({
  compared: 0,
  agree: 0,
  changed: 0,
  uncertain: 0,
  transitions: [],
});

function bump(rec: Record<string, number>, key: string, by = 1): void {
  rec[key] = (rec[key] ?? 0) + by;
}

function addTransition(m: Map<string, JevTransition>, from: string, to: string): void {
  const k = `${from}\u0000${to}`;
  const t = m.get(k);
  if (t) t.n++;
  else m.set(k, { from, to, n: 1 });
}

const sortedTransitions = (m: Map<string, JevTransition>): JevTransition[] =>
  [...m.values()].sort(
    (a, b) => b.n - a.n || a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
  );

function bucket(rec: Record<string, JevCounts>, key: string): JevCounts {
  const c = rec[key] ?? zeroCounts();
  rec[key] = c;
  return c;
}

function countDir(c: JevCounts, dir: number): void {
  c.compared++;
  if (dir > 0) c.up++;
  else if (dir < 0) c.down++;
  else c.agree++;
}

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * The independent unit a dispatch's evidence belongs to (review-jev2 J4): its swarm run, else its
 * session, read from the row and then its decision row; rows that name neither share one unit.
 */
export function unitOf(
  row: Pick<AdjudicationRow, "runId" | "sessionId">,
  decision?: Pick<AdjudicationRow, "runId" | "sessionId"> | undefined,
): string {
  const run = row.runId || decision?.runId;
  if (run) return `run:${run}`;
  const session = row.sessionId || decision?.sessionId;
  return session ? `session:${session}` : "unknown";
}

/**
 * The Jev impact report over `rows` (typesafe rows, any order) and the parent rows outside them
 * (`parents`, by id). Pure: no store, no clock unless `opts.now` is missing.
 */
export function impactReport(
  rows: readonly AdjudicationRow[],
  parents: ReadonlyMap<number, AdjudicationRow> | readonly AdjudicationRow[],
  window: JevWindow,
  opts: JevReportOptions,
): JevImpactReport {
  const cfg = opts.config;
  const now = opts.now ?? Date.now();
  const since = window.since;
  const all = rows.filter(
    (r) =>
      r.surface !== "test" &&
      (r.provider == null || r.provider === "typesafe") &&
      (since === undefined || r.ts >= since),
  );
  const parentMap: ReadonlyMap<number, AdjudicationRow> =
    parents instanceof Map
      ? parents
      : new Map((parents as readonly AdjudicationRow[]).map((p) => [p.id, p]));
  const byId = new Map(all.map((r) => [r.id, r]));
  const isDispatch = dispatchFilter(all);
  const scope = window.surface ? all.filter((r) => r.surface === window.surface) : all;

  // Decisions, each once.
  const views = new Map<number, JevDecisionView>();
  const decisionRows = new Map<number, AdjudicationRow>();
  const decisionOf = (r: AdjudicationRow): JevDecisionView => {
    const pid = r.parentId;
    const parent = pid != null ? (byId.get(pid) ?? parentMap.get(pid)) : undefined;
    const d = decisionRowOf(r, parent, since);
    let v = views.get(d.id);
    if (!v) {
      v = viewOf(d, cfg);
      views.set(d.id, v);
      decisionRows.set(d.id, d);
    }
    return v;
  };
  const rowDecision = new Map<number, JevDecisionView>();
  for (const r of scope) rowDecision.set(r.id, decisionOf(r));
  const decisions = [...views.values()];

  // Sample and coverage.
  const byClass = Object.fromEntries(JEV_CLASSES.map((c) => [c, 0])) as Record<JevClass, number>;
  const byStatus: Record<string, number> = {};
  const models: Record<string, number> = {};
  const eras = { units: 0, wholeText: 0 };
  let uncertainN = 0;
  let unreconstructable = 0;
  for (const d of decisions) {
    byClass[d.cls]++;
    const row = decisionRows.get(d.id);
    bump(byStatus, String(row?.providerStatus ?? "n/a"));
    if (d.model) bump(models, d.model);
    if (!jevInformed(d.cls)) continue;
    if (!d.tier) unreconstructable++;
    else if (d.tier.uncertain) uncertainN++;
    if (d.surface === "plan" || d.surface === "agent") {
      if (d.units) eras.units++;
      else eras.wholeText++;
    }
  }
  const attempts = byClass.applied + byClass.deferred + byClass.error;
  const failureRate = attempts ? byClass.error / attempts : null;

  // Influence.
  const tier: JevTierInfluence = {
    ...zeroCounts(),
    uncertain: 0,
    jevOverruled: 0,
    bySurface: {},
    byRole: {},
    transitions: [],
    roundUps: { final: 0, counterfactual: 0, blendInduced: 0 },
    wouldHaveChanged: { compared: 0, changed: 0 },
  };
  const tierT = new Map<string, JevTransition>();
  const dims = { role: zeroDim(), tool: zeroDim() };
  const dimT = { role: new Map<string, JevTransition>(), tool: new Map<string, JevTransition>() };
  const effort = { compared: 0, up: 0, down: 0 };
  let dispatchCompared = 0;
  let cN = 0;
  let cSum = 0;
  let cAbs = 0;
  let excludedBeforeFix = 0;
  for (const d of decisions) {
    if (d.cls === "deferred" && d.tier && !d.tier.uncertain) {
      tier.wouldHaveChanged.compared++;
      if (d.tier.final !== d.tier.cf) tier.wouldHaveChanged.changed++;
    }
    if (!compared(d.cls)) continue;
    const t = d.tier;
    if (t) {
      if (t.finalRoundedUp) tier.roundUps.final++;
      // The heuristic's own round-up is only known on a certain reconstruction. A blend-induced
      // round-up must also have moved the tier above the heuristic's: a round-up that lands on
      // the heuristic's own tier only undid Jev's move (review-jev F3), and one that lands on
      // (or under) Jev's own pick is Jev getting its way, not an overshoot (review-jev2 J5).
      if (!t.uncertain && t.cfRoundedUp) tier.roundUps.counterfactual++;
      if (
        !t.uncertain &&
        t.finalRoundedUp &&
        !t.cfRoundedUp &&
        tierRank(t.final) > tierRank(t.cf) &&
        (t.jev === undefined || tierRank(t.final) > tierRank(t.jev))
      )
        tier.roundUps.blendInduced++;
      if (t.uncertain) {
        tier.compared++;
        tier.uncertain++;
      } else {
        // The compared minimum counts only decisions that can carry an outcome (J4).
        if (d.cls === "applied" && (d.surface === "plan" || d.surface === "agent"))
          dispatchCompared++;
        countDir(tier, d.dir);
        countDir(bucket(tier.bySurface, d.surface), d.dir);
        countDir(bucket(tier.byRole, d.finalRole), d.dir);
        addTransition(tierT, t.cf, t.final);
        if (t.jev !== undefined && t.jev !== t.cf && t.final === t.cf) tier.jevOverruled++;
      }
    }
    for (const dim of ["role", "tool"] as const) {
      const v = d[dim];
      if (!v) continue;
      const out = dims[dim];
      out.compared++;
      if (v.uncertain) out.uncertain++;
      else if (v.final === v.cf) out.agree++;
      else {
        out.changed++;
        addTransition(dimT[dim], v.cf, v.final);
      }
    }
    const beforeFix = !d.scaleFixed;
    if ((d.complexity || d.effort) && beforeFix) excludedBeforeFix++;
    if (d.complexity && !beforeFix) {
      const delta = d.complexity.final - d.complexity.heuristic;
      cN++;
      cSum += delta;
      cAbs += Math.abs(delta);
    }
    if (d.effort && !beforeFix) {
      effort.compared++;
      const e = sign(effortRank(d.effort.final) - effortRank(d.effort.heuristic));
      if (e > 0) effort.up++;
      else if (e < 0) effort.down++;
    }
  }
  tier.transitions = sortedTransitions(tierT);
  dims.role.transitions = sortedTransitions(dimT.role);
  dims.tool.transitions = sortedTransitions(dimT.tool);

  // Outcomes on dispatches.
  const changed = zeroSplit();
  const unchanged = zeroSplit();
  const excluded = {
    kept: 0,
    deferred: 0,
    notJev: 0,
    unreconstructable: 0,
    uncertain: 0,
    unknown: 0,
    notRun: 0,
    notFinal: 0,
    bounds: 0,
  };
  const effective = { dispatches: 0, changed: 0, unchanged: 0, unknown: 0 };
  const evidence = { help: 0, hurt: 0, neutral: 0, rows: [] as JevEvidenceRow[] };
  const upgrades = { counted: 0, notCounted: 0 };
  const savings = { repriced: 0, unpriced: 0, downSavedUsd: 0, upCostUsd: 0, deltaUsd: 0 };
  // The bounds each dispatch ran under are not stored; today's and the defaults only mark the
  // dispatches whose answer they could change (review-jev2 J3).
  const possible: ApplyBounds[] = [
    { floor: cfg.apply?.floor, ceiling: cfg.apply?.ceiling },
    DEFAULT_APPLY_BOUNDS,
  ];
  // Distinct swarm runs or sessions behind the help and hurt rows (J4); rows that name neither
  // share one unit, so they cannot pass for independent evidence.
  const units = new Set<string>();
  for (const r of scope) {
    if (!isDispatch(r)) continue;
    if (keptModel(r) !== undefined) {
      excluded.kept++;
      continue;
    }
    const d = rowDecision.get(r.id);
    if (!d) continue;
    if (d.cls === "deferred") {
      excluded.deferred++;
      continue;
    }
    if (!compared(d.cls)) {
      excluded.notJev++;
      continue;
    }
    if (!d.tier) {
      excluded.unreconstructable++;
      continue;
    }
    if (d.tier.uncertain) {
      excluded.uncertain++;
      continue;
    }
    const decisionRow = decisionRows.get(d.id);
    const pick = advisedPickOf(r) ?? (decisionRow ? advisedPickOf(decisionRow) : undefined);
    const eff = effectivePick({
      raw: d.tier.final,
      pick,
      cf: d.tier.cf,
      ranged: rangedOf(r) || (decisionRow ? rangedOf(decisionRow) : false),
      possible,
    });
    if (eff === "unknown" || eff === "bounds") {
      excluded[eff]++;
      effective.unknown++;
      continue;
    }
    effective.dispatches++;
    const isChanged = eff.final !== eff.cf;
    if (isChanged) effective.changed++;
    else effective.unchanged++;
    const split = isChanged ? changed : unchanged;
    split.dispatches++;
    if (typeof r.action === "string" && ADVISE_ACTIONS.has(r.action)) {
      split.followDenom++;
      if (r.action === "followed") split.followed++;
    }
    // An outcome or a label speaks for Jev's tier only when that tier ran (J1), and a
    // reconcile outcome only once it is final (J2).
    const ran = ranAdvice(r, eff.final);
    if (!ran) excluded.notRun++;
    else if (!r.final) excluded.notFinal++;
    if (r.final && ran) {
      split.final++;
      if (r.outcome === "success") split.success++;
      else if (r.outcome === "failure") split.failure++;
    }
    const fb = feedbackKind(r);
    if (fb) split.feedback[fb]++;
    if (!isChanged) continue;
    const dir = sign(tierRank(eff.final) - tierRank(eff.cf));
    if (dir === 0) continue;
    const ev = evidenceOf(r, dir, ran);
    if (ev) {
      evidence[ev.kind]++;
      if (ev.kind !== "neutral") units.add(unitOf(r, decisionRow));
      if (dir > 0) {
        if (ev.kind === "neutral") upgrades.notCounted++;
        else upgrades.counted++;
      }
      evidence.rows.push({
        id: r.id,
        ts: r.ts,
        surface: r.surface,
        kind: ev.kind,
        code: ev.code,
        from: eff.cf,
        to: eff.final,
      });
    }
    if (
      typeof r.savingsUsd === "number" &&
      typeof r.actualCostUsd === "number" &&
      typeof r.actualModel === "string" &&
      r.actualModel
    ) {
      const atCf = repriceByRatio(r.actualCostUsd, r.actualModel, eff.cf, opts.pricing);
      if (atCf === null) savings.unpriced++;
      else {
        savings.repriced++;
        const delta = atCf - r.actualCostUsd;
        savings.deltaUsd += delta;
        if (delta >= 0) savings.downSavedUsd += delta;
        else savings.upCostUsd += -delta;
      }
    }
  }
  for (const s of [changed, unchanged]) {
    s.followRate = s.followDenom ? s.followed / s.followDenom : null;
    s.successRate = s.success + s.failure ? s.success / (s.success + s.failure) : null;
  }
  evidence.rows.sort((a, b) => b.ts - a.ts || b.id - a.id);
  evidence.rows = evidence.rows.slice(0, EVIDENCE_ROWS_MAX);

  // Cost and latency.
  let spendUsd = 0;
  let calls = 0;
  const providerLat: number[] = [];
  const inlineLat: number[] = [];
  const appliedSurfaces = new Set<string>();
  let timeouts = 0;
  for (const d of decisions) {
    const row = decisionRows.get(d.id);
    if (!row) continue;
    if (typeof row.costUsd === "number" && Number.isFinite(row.costUsd)) {
      spendUsd += row.costUsd;
      calls++;
    }
    if (row.providerStatus === "timeout") timeouts++;
    if (
      (d.cls === "applied" || d.cls === "deferred" || d.cls === "error") &&
      typeof row.providerLatencyMs === "number"
    )
      providerLat.push(row.providerLatencyMs);
    if (d.cls === "applied" && typeof row.latencyMs === "number") {
      inlineLat.push(row.latencyMs);
      appliedSurfaces.add(row.surface);
    }
  }
  const heuristicLat: number[] = [];
  for (const r of scope) {
    const own = classOf(r);
    if (
      (own === "skipped" || own === "cache") &&
      appliedSurfaces.has(r.surface) &&
      typeof r.latencyMs === "number"
    )
      heuristicLat.push(r.latencyMs);
  }
  const t = cfg.timeouts;
  const usageAvailable = opts.usageAvailable ?? false;
  const assumptions = [...JEV_ASSUMPTIONS];
  if (!usageAvailable)
    assumptions.push(
      "No API calls are recorded (usage ingestion off or not run yet): dispatches have no actual cost, so nothing is repriced.",
    );
  const netUsd = savings.deltaUsd - spendUsd;

  // Verdict.
  // Uncertain near-ties are compared but say nothing about a change (review-jev F4): the
  // round-up warning's share is over certain compared decisions. The compared minimum counts
  // only certain plan/agent decisions Jev answered inline (dispatchCompared, review-jev2 J4).
  const comparedN = tier.compared - tier.uncertain;
  const warnings: string[] = [];
  if (failureRate !== null && failureRate > 0.2 && attempts >= 20)
    warnings.push(`Jev failed ${pctText(failureRate)} of calls; the heuristic answered`);
  if (opts.degraded)
    warnings.push(`Jev is configured but degraded (${opts.degraded}): every call falls back`);
  if (
    tier.roundUps.blendInduced >= 3 &&
    comparedN > 0 &&
    tier.roundUps.blendInduced >= 0.1 * comparedN
  )
    warnings.push(
      `blending created ${tier.roundUps.blendInduced} near-ties that rounded the tier up`,
    );
  if (usageAvailable && savings.repriced > 0 && netUsd < 0)
    warnings.push("Jev's tier changes saved less than Jev cost");
  if (opts.breakerState && opts.breakerState !== "closed")
    warnings.push(`Jev's breaker is ${opts.breakerState}`);
  if (byClass.deferred > 0)
    warnings.push(
      `${byClass.deferred} prompt decisions used the heuristic's advice; Jev's answer arrived after it (async mode)`,
    );
  if (eras.units > 0 && eras.wholeText > 0)
    warnings.push("briefs scored as one text and per statement are mixed in this range");
  if (!usageAvailable) warnings.push("no usage data: savings cannot be repriced");
  if (opts.capped) warnings.push(`only the first ${JEV_ROWS_MAX} rows were read`);

  return {
    since: since ?? null,
    now,
    surface: window.surface ?? null,
    sample: {
      rows: scope.length,
      decisions: decisions.length,
      jevApplied: byClass.applied,
      cache: byClass.cache,
      deferred: byClass.deferred,
      fallback: byClass.skipped + byClass.guard + byClass.error + byClass.config,
      uncertain: uncertainN,
      unreconstructable,
      capped: opts.capped ?? false,
      eras,
      models,
    },
    coverage: { byClass, byStatus, attempts, errors: byClass.error, failureRate },
    influence: {
      tier,
      role: dims.role,
      tool: dims.tool,
      effort,
      complexity: {
        n: cN,
        meanDelta: cN ? cSum / cN : null,
        meanAbsDelta: cN ? cAbs / cN : null,
        excludedBeforeFix,
      },
      effective,
    },
    outcomes: { changed, unchanged, excluded, evidence },
    cost: {
      spendUsd: r6(spendUsd),
      calls,
      usdPerCall: calls ? r6(spendUsd / calls) : null,
      providerLatency: latencyOf(providerLat),
      inline: latencyOf(inlineLat),
      heuristicInline: latencyOf(heuristicLat),
      deferred: byClass.deferred,
      timeouts,
      // engine.ts surfaceBudget for a remote provider.
      budgetMs: { prompt: t?.promptMs ?? null, agent: t?.agentMs ?? null, plan: t?.planMs ?? null },
    },
    savings: {
      usageAvailable,
      repriced: savings.repriced,
      unpriced: savings.unpriced,
      downSavedUsd: r6(savings.downSavedUsd),
      upCostUsd: r6(savings.upCostUsd),
      deltaUsd: r6(savings.deltaUsd),
      netUsd: r6(netUsd),
      assumptions,
    },
    verdict: verdictOf(
      {
        help: evidence.help,
        hurt: evidence.hurt,
        compared: dispatchCompared,
        units: units.size,
        changed: effective.changed,
        upgrades,
      },
      warnings,
    ),
  };
}

// --- loader ------------------------------------------------------------------------------

/** typesafe rows since `since`, oldest first, paged through the store's 500-row limit (savings.ts allRows). */
function typesafeRows(db: JevDb, since: number | undefined, max: number): AdjudicationRow[] {
  const out: AdjudicationRow[] = [];
  for (let offset = 0; offset < max; offset += 500) {
    const filter = {
      provider: "typesafe",
      limit: 500,
      offset,
      ...(since === undefined ? {} : { since }),
    };
    const { rows, total } = db.adjudicator.list(filter);
    out.push(...rows);
    if (!rows.length || offset + rows.length >= total) break;
  }
  return out.sort((a, b) => a.ts - b.ts || a.id - b.id);
}

export interface JevLoadOptions extends Omit<JevReportOptions, "usageAvailable" | "capped"> {
  /** Overrides the stored breaker state (default: db.adjudicator.providerState("typesafe")). */
  breakerState?: string | null | undefined;
}

/**
 * The report for the window, read from the store: typesafe rows (surface test left out), the
 * plan rows their agent rows inherit from, whether usage is recorded and the breaker state.
 * Reads only; never reconciles.
 *
 * Parents are fetched only when the read hit JEV_ROWS_MAX (at most PARENT_FETCH_MAX lookups).
 * Otherwise every typesafe row in the window is already in `rows`, so a parent missing from them
 * is another provider's or older than the window, and decisionRowOf would reject it anyway; the
 * store lists newest first, so only a capped read can leave out an in-window parent.
 */
export function jevImpact(db: JevDb, window: JevWindow, opts: JevLoadOptions): JevImpactReport {
  const rows = typesafeRows(db, window.since, JEV_ROWS_MAX);
  const capped = rows.length >= JEV_ROWS_MAX;
  const have = new Set(rows.map((r) => r.id));
  const parents = new Map<number, AdjudicationRow>();
  const tried = new Set<number>();
  for (const r of capped ? rows : []) {
    const pid = r.parentId;
    if (pid == null || have.has(pid) || tried.has(pid)) continue;
    if (tried.size >= PARENT_FETCH_MAX) break;
    tried.add(pid);
    const p = db.adjudicator.get(pid);
    if (p) parents.set(p.id, p);
  }
  const breakerState =
    opts.breakerState !== undefined
      ? opts.breakerState
      : (db.adjudicator.providerState("typesafe")?.state ?? null);
  return impactReport(rows, parents, window, {
    ...opts,
    breakerState,
    usageAvailable: db.apiCallsLatestTs() !== undefined,
    capped,
  });
}
