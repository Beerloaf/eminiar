/**
 * Pure helpers for the Adjudicator view (no Preact, no DOM) so the node test suite can cover
 * them: chart palettes, the heuristic/provider split of a blended score table, winner and
 * runner-up, the tier × model matrix, labels for actions, outcomes and breaker states, and a
 * generic flattening of the eval report.
 */
// Types come from the node side's pure declarations, not from ../api.ts: the node test suite
// compiles this file and api.ts needs the DOM.
import type {
  Features as AdjFeatures,
  Reason as AdjReason,
  ScoreEntry as AdjScoreEntry,
  ScoreTable as AdjScoreTable,
  AdjudicationRow,
} from "../../../adjudicator/types.js";

/** One day of the overview chart (mirrors DayBucket in src/ui/adjudicator-api.ts). */
export interface AdjDayBucket {
  day: string;
  heuristic: number;
  blend: number;
  cache: number;
  fallback: number;
  total: number;
}
type Params = Record<string, string | number>;
type AdjDecisionRow = Omit<AdjudicationRow, "scores">;

// --- palettes -------------------------------------------------------------------------

/** Verdict sources in stacking order (bottom to top). */
export const SOURCES = ["heuristic", "blend", "cache", "fallback"] as const;
export type SourceId = (typeof SOURCES)[number];

/**
 * One hue per source, the same in both themes (like KIND_COLORS): blue, violet, teal and
 * amber stay apart under the common colour-vision deficiencies, and every swatch sits next to
 * its label, so colour is never the only signal.
 */
export const SOURCE_COLORS: Record<SourceId, string> = {
  heuristic: "#2563eb",
  blend: "#7c3aed",
  cache: "#0d9488",
  fallback: "#d97706",
};
export const SOURCE_HELP: Record<SourceId, string> = {
  heuristic: "local heuristic only",
  blend: "heuristic blended with the provider",
  cache: "reused an earlier verdict for the same text",
  fallback: "provider failed or was skipped; heuristic used",
};

/** The three parts of a blended score, as stacked bar segments. */
export const PARTS = ["heuristic", "provider", "learned"] as const;
export type Part = (typeof PARTS)[number];
export const PART_COLORS: Record<Part, string> = {
  heuristic: "#2563eb",
  provider: "#7c3aed",
  learned: "#d97706",
};
export const PART_HELP: Record<Part, string> = {
  heuristic: "local features (words, intents, paths, risk …) scored on this machine",
  provider: "the provider's probability × α (its weight in the blend)",
  learned: "learned bias from past outcomes, plus provider risk / plan boosts",
};

// --- numbers --------------------------------------------------------------------------

export const COMPLEXITY_LABELS = ["trivial", "simple", "moderate", "complex", "very complex"];

/** 0..4 (continuous) → its bucket's name. */
export function complexityLabel(c: number | null | undefined): string {
  if (typeof c !== "number" || !Number.isFinite(c)) return "n/a";
  return COMPLEXITY_LABELS[Math.max(0, Math.min(4, Math.round(c)))]!;
}

/** A rate 0..1 as a whole percent; "—" when there is no denominator. */
export function rate(x: number | null | undefined): string {
  return typeof x === "number" && Number.isFinite(x) ? `${Math.round(x * 100)}%` : "—";
}

/** Milliseconds: "—", "840 ms", "1.2 s". */
export function ms(x: number | null | undefined): string {
  if (typeof x !== "number" || !Number.isFinite(x)) return "—";
  if (x < 1000) return `${Math.round(x)} ms`;
  return `${(x / 1000).toFixed(x < 10_000 ? 1 : 0)} s`;
}

export const r2 = (x: number): number => Math.round(x * 100) / 100;

/** A signed weight: "+0.42", "−0.10". */
export function signed(x: number): string {
  const v = r2(x);
  return v > 0 ? `+${v.toFixed(2)}` : v < 0 ? `−${Math.abs(v).toFixed(2)}` : "0.00";
}

// --- score tables ---------------------------------------------------------------------

const EXTRA_FEATURES = new Set(["bias", "risky", "needsPlan"]);
const sumWeights = (reasons: readonly AdjReason[], pick: (f: string) => boolean): number =>
  reasons.reduce((n, r) => (pick(r.feature) ? n + (Number(r.weight) || 0) : n), 0);

export interface SplitEntry extends AdjScoreEntry {
  /** Parts of `score` (they sum to it): heuristic, provider, learned. */
  parts: Record<Part, number>;
  chosen: boolean;
  runnerUp: boolean;
}
export interface SplitTable {
  dimension: string;
  entries: SplitEntry[];
  choice: string;
  runnerUp: string | null;
  /** choice score − runner-up score, 0..1. */
  margin: number | null;
  confidence: number;
  /** The tier was rounded up one step for low confidence (the choice is not the top score). */
  roundedUp: boolean;
  /** α actually applied to this table; 0 = heuristic only. */
  alpha: number;
  /** Share of the chosen option's score that came from the provider. */
  providerShare: number;
}

/**
 * Split each entry's blended score into what the heuristic, the provider and learning
 * contributed. blend.mixTable computes s = (1−α)·h + α·p + boosts + bias and divides by the
 * sum over the table, and records α·p as a `provider` reason and each boost or bias as its
 * own reason. Heuristic scores and provider probabilities each sum to 1, so the divisor is
 * 1 + Σ(boosts + bias); the heuristic part is what is left. Reason weights are rounded to two
 * places, so the split is approximate (and clamped to the entry's score).
 */
export function splitTable(table: AdjScoreTable, alpha = 0): SplitTable {
  const entries = table.entries ?? [];
  const extras = entries.reduce(
    (n, e) => n + sumWeights(e.reasons ?? [], (f) => EXTRA_FEATURES.has(f)),
    0,
  );
  const total = Math.max(1e-9, 1 + extras);
  const sorted = [...entries].sort((a, b) => b.score - a.score);
  const choice = table.choice ?? sorted[0]?.option ?? "";
  const runner = sorted.find((e) => e.option !== choice) ?? null;
  const out: SplitEntry[] = sorted.map((e) => {
    const reasons = e.reasons ?? [];
    const raw = Math.max(0, e.score) * total;
    const provider = Math.max(
      0,
      Math.min(
        raw,
        sumWeights(reasons, (f) => f === "provider"),
      ),
    );
    const learned = Math.max(
      0,
      Math.min(
        raw - provider,
        sumWeights(reasons, (f) => EXTRA_FEATURES.has(f)),
      ),
    );
    const heuristic = Math.max(0, raw - provider - learned);
    const k = raw > 0 ? e.score / raw : 0;
    return {
      ...e,
      reasons,
      parts: { heuristic: heuristic * k, provider: provider * k, learned: learned * k },
      chosen: e.option === choice,
      runnerUp: runner !== null && e.option === runner.option,
    };
  });
  const chosen = out.find((e) => e.chosen);
  return {
    dimension: table.dimension,
    entries: out,
    choice,
    runnerUp: runner?.option ?? null,
    margin: chosen && runner ? chosen.score - runner.score : null,
    confidence: table.confidence ?? 0,
    roundedUp: !!sorted[0] && sorted[0].option !== choice,
    alpha,
    providerShare: chosen && chosen.score > 0 ? chosen.parts.provider / chosen.score : 0,
  };
}

/** Reasons ordered by absolute weight, biggest first (provider and bias included). */
export function topReasons(reasons: readonly AdjReason[] | undefined, n = Infinity): AdjReason[] {
  return [...(reasons ?? [])].sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight)).slice(0, n);
}

export interface ComplexityBreakdown {
  value: number;
  /** What the heuristic said before the provider was blended in. */
  heuristic: number;
  /** The provider's pull (blended − heuristic); 0 when it did not take part. */
  provider: number;
  /** Heuristic terms, biggest |weight| first. */
  terms: AdjReason[];
  providerNote: string | null;
}

export function complexityBreakdown(
  value: number,
  reasons: readonly AdjReason[] | undefined,
): ComplexityBreakdown {
  const all = reasons ?? [];
  const prov = all.filter((r) => r.feature === "provider");
  const provider = sumWeights(prov, () => true);
  return {
    value,
    heuristic: value - provider,
    provider,
    terms: topReasons(all.filter((r) => r.feature !== "provider")),
    providerNote: prov[0]?.note ?? null,
  };
}

/** "intent.debug" → "intent: debug"; other feature ids pass through. */
export function featureLabel(f: string): string {
  return f.startsWith("intent.") ? `intent: ${f.slice(7)}` : f;
}

// --- labels ---------------------------------------------------------------------------

export type Tone = "ok" | "warn" | "bad" | "muted" | "accent";

export const ACTION_INFO: Record<string, { label: string; tone: Tone; help: string }> = {
  advised: {
    label: "advised",
    tone: "accent",
    help: "advice was given; whether it was taken is not known yet",
  },
  followed: { label: "followed", tone: "ok", help: "the advice was taken (advise mode)" },
  applied: {
    label: "applied",
    tone: "ok",
    help: "the adjudicator set the model itself (apply mode)",
  },
  respected: {
    label: "respected",
    tone: "muted",
    help: "apply mode left an explicitly pinned model alone",
  },
  ignored: { label: "ignored", tone: "warn", help: "a different choice was made than advised" },
  none: { label: "none", tone: "muted", help: "nothing to advise on (e.g. too short or chat)" },
};
export const actionInfo = (a: string | null | undefined) =>
  ACTION_INFO[a ?? "none"] ?? { label: a ?? "—", tone: "muted" as Tone, help: "" };

export const OUTCOME_INFO: Record<string, { tone: Tone; help: string }> = {
  pending: { tone: "muted", help: "the work has not finished yet" },
  success: { tone: "ok", help: "the work finished and was not redone" },
  failure: { tone: "bad", help: "the work failed or had to be redone" },
  abandoned: { tone: "warn", help: "the session ended before the work finished" },
  "n/a": { tone: "muted", help: "no outcome is tracked for this surface" },
};
export const outcomeTone = (o: string | null | undefined): Tone =>
  OUTCOME_INFO[o ?? ""]?.tone ?? "muted";

export function statusTone(s: string | null | undefined): Tone {
  if (!s || s === "n/a" || s === "skipped") return "muted";
  if (s === "ok") return "ok";
  if (s === "slow_guard" || s === "over_budget" || s === "breaker_open" || s === "rate_limited")
    return "warn";
  return "bad";
}

/** Breaker state → tone and a plain-words label (unknown states pass through). */
export function breakerInfo(state: string | null | undefined): {
  label: string;
  tone: Tone;
  help: string;
} {
  switch (state) {
    case null:
    case undefined:
      return {
        label: "not called yet",
        tone: "muted",
        help: "no call has been made to this provider",
      };
    case "closed":
      return { label: "healthy", tone: "ok", help: "breaker closed: calls go through" };
    case "half_open":
      return {
        label: "probing",
        tone: "warn",
        help: "breaker half-open: the next call is a probe",
      };
    case "open":
      return {
        label: "paused",
        tone: "bad",
        help: "breaker open: calls skip the provider until the retry time",
      };
    case "slow":
      return { label: "slow", tone: "warn", help: "recent calls ran past the latency budget" };
    case "auth_failed":
      return { label: "auth failed", tone: "bad", help: "the provider rejected the key" };
    default:
      return { label: state.replace(/_/g, " "), tone: "warn", help: `breaker state ${state}` };
  }
}

export const TRY_IT_REASONS: Record<string, string> = {
  used: "heuristic blended with the provider",
  disabled: "the adjudicator is off: heuristic only",
  not_requested: "heuristic only (provider not requested)",
  heuristic_configured: "heuristic only: no provider is configured",
  no_key: "heuristic only: the provider has no key",
  no_consent: "heuristic only: remote consent has not been given",
  hook_context: "heuristic only in this context",
  misconfigured: "heuristic only: the provider is misconfigured",
};
export const tryItReason = (r: string): string => TRY_IT_REASONS[r] ?? r.replace(/_/g, " ");

export const DEGRADED_HELP: Record<string, string> = {
  no_key: "no key found: run `eminiar adjudicator key set` or set keyEnv",
  no_consent: "remote consent not given: run `eminiar adjudicator consent`",
  misconfigured: "the provider settings are incomplete",
  hook_context: "remote providers are not called from hooks",
};

// --- charts ---------------------------------------------------------------------------

/** The tallest day, at least 1. */
export function dayMax(rows: readonly AdjDayBucket[]): number {
  return Math.max(1, ...rows.map((r) => r.total));
}

/** "nice" axis ticks for a count axis: 0, max/2, max rounded up to an integer step. */
export function countTicks(max: number): number[] {
  const top = Math.max(1, Math.ceil(max));
  if (top <= 2) return [0, top];
  const half = Math.ceil(top / 2);
  return [0, half, half * 2];
}

/** Tier order for the matrix axes; unknown values follow, alphabetically. */
const TIER_ORDER = ["haiku", "sonnet", "opus", "fable"];
function tierSort(a: string, b: string): number {
  const ia = TIER_ORDER.indexOf(a);
  const ib = TIER_ORDER.indexOf(b);
  if (ia >= 0 && ib >= 0) return ia - ib;
  if (ia >= 0) return -1;
  if (ib >= 0) return 1;
  return a.localeCompare(b);
}

export interface MatrixGrid {
  rows: string[];
  cols: string[];
  cell: (row: string, col: string) => number;
  max: number;
  total: number;
  /** Rows where the actual tier is the suggested one. */
  agree: number;
}

/** suggested tier × actual tier (or model) counts, axes in ladder order. */
export function matrixGrid(
  m: ReadonlyArray<{ suggested: string; actual: string; n: number }>,
): MatrixGrid {
  const counts = new Map<string, number>();
  const rows = new Set<string>();
  const cols = new Set<string>();
  let max = 0;
  let total = 0;
  let agree = 0;
  for (const c of m) {
    const k = `${c.suggested}\u0000${c.actual}`;
    const n = (counts.get(k) ?? 0) + c.n;
    counts.set(k, n);
    rows.add(c.suggested);
    cols.add(c.actual);
    max = Math.max(max, n);
    total += c.n;
    if (c.suggested === c.actual) agree += c.n;
  }
  return {
    rows: [...rows].sort(tierSort),
    cols: [...cols].sort(tierSort),
    cell: (r, c) => counts.get(`${r}\u0000${c}`) ?? 0,
    max,
    total,
    agree,
  };
}

/** Cell fill strength 0.08..0.9 (0 for an empty cell); text flips to white past 0.55. */
export function heat(n: number, max: number): number {
  if (!(n > 0) || !(max > 0)) return 0;
  return 0.08 + 0.82 * (n / max);
}

// --- call log -------------------------------------------------------------------------

export interface LogFilters {
  surface?: string | undefined;
  provider?: string | undefined;
  outcome?: string | undefined;
  since?: string | undefined;
}

/** Query params for GET /api/adjudicator/decisions ("" and undefined dropped). */
export function decisionParams(f: LogFilters, limit: number, offset: number): Params {
  const p: Params = { limit, offset };
  if (f.since && f.since !== "all") p.since = f.since;
  if (f.surface) p.surface = f.surface;
  if (f.provider) p.provider = f.provider;
  if (f.outcome) p.outcome = f.outcome;
  return p;
}

/** "1–50 of 312"; "0 of 0". */
export function pageLabel(offset: number, rows: number, total: number): string {
  if (!total || !rows) return `0 of ${total}`;
  return `${offset + 1}–${offset + rows} of ${total}`;
}

/**
 * What a row's savings figure means, in words. Main-session (prompt) advice is never
 * credited: its counterfactual cannot be observed.
 */
export function savingsNote(
  row: Pick<
    AdjDecisionRow,
    "surface" | "action" | "savingsUsd" | "baselineCostUsd" | "actualCostUsd" | "outcome" | "final"
  >,
): string {
  if (row.surface === "prompt")
    return "main-session advice: potential savings only, never added to net";
  if (row.surface === "test") return "try-it runs are not counted";
  if (row.action !== "followed" && row.action !== "applied")
    return "no credit: the advice was not followed or applied";
  if (row.savingsUsd === null || row.savingsUsd === undefined)
    return row.final
      ? "no usage data to price this dispatch (usage ingest off?)"
      : "not reconciled yet: waits for the dispatch to finish";
  if (row.outcome === "failure" && row.savingsUsd < 0)
    return "redo penalty: the attempt failed and its full cost is charged";
  return "baseline model cost − actual cost at list prices, same tokens";
}

// --- features -------------------------------------------------------------------------

/** Intents above `min`, strongest first. */
export function topIntents(f: AdjFeatures | undefined, n = 5, min = 0.05): Array<[string, number]> {
  const out = Object.entries(f?.intents ?? {}).filter(
    (e): e is [string, number] => typeof e[1] === "number" && e[1] >= min,
  );
  return out.sort((a, b) => b[1] - a[1]).slice(0, n);
}

/** The features worth showing as chips: counts that are non-zero and flags that are set. */
export function featureFacts(f: AdjFeatures | undefined): Array<[string, string]> {
  if (!f) return [];
  const out: Array<[string, string]> = [];
  const num = (k: string, v: number | undefined) => {
    if (typeof v === "number" && v > 0) out.push([k, String(Math.round(v * 100) / 100)]);
  };
  num("words", f.words);
  num("lines", f.lines);
  num("paths", f.paths);
  num("symbols", f.symbols);
  if (typeof f.scope === "number") out.push(["scope", f.scope.toFixed(2)]);
  if (typeof f.risk === "number") out.push(["risk", f.risk.toFixed(2)]);
  if (f.codeBlock) out.push(["code block", "yes"]);
  if (f.stackTrace) out.push(["stack trace", "yes"]);
  if (f.chat) out.push(["chat", "yes"]);
  if (f.slash) out.push(["slash command", "yes"]);
  if (f.classify) out.push(["classified", f.classify]);
  if (f.task) {
    if (f.task.role) out.push(["task role", f.task.role]);
    out.push(["task files", String(f.task.files)]);
    out.push(["task deps", String(f.task.deps)]);
  }
  return out;
}

// --- eval report ----------------------------------------------------------------------

export interface EvalTable {
  columns: string[];
  rows: Array<Record<string, string>>;
}

const fmtCell = (v: unknown): string => {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number")
    return Number.isInteger(v) ? String(v) : Math.abs(v) <= 1 ? v.toFixed(3) : v.toFixed(1);
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
};

/** Flatten one level of nesting: {tier: {acc: 0.8}} → {"tier.acc": "0.800"}. */
function flatRow(o: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
        if (v2 && typeof v2 === "object") continue;
        out[`${k}.${k2}`] = fmtCell(v2);
      }
    } else if (!Array.isArray(v)) out[k] = fmtCell(v);
  }
  return out;
}

/**
 * The first array of objects in the report (rows / results / providers …) as a table. The
 * report's shape belongs to the eval harness, so this reads it generically.
 */
export function evalTable(report: Record<string, unknown> | null | undefined): EvalTable | null {
  if (!report) return null;
  const keys = ["rows", "results", "providers", "candidates"];
  const arr =
    keys.map((k) => report[k]).find((v) => Array.isArray(v) && v.length) ??
    Object.values(report).find(
      (v) => Array.isArray(v) && v.length && v.every((x) => x && typeof x === "object"),
    );
  if (!Array.isArray(arr)) return null;
  const rows = arr
    .filter((x) => x && typeof x === "object")
    .map((x) => flatRow(x as Record<string, unknown>));
  const columns: string[] = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!columns.includes(k)) columns.push(k);
  return { columns, rows };
}

/** Scalar facts of the report (verdict line, when it ran, item count …). */
export function evalFacts(
  report: Record<string, unknown> | null | undefined,
): Array<[string, string]> {
  if (!report) return [];
  return Object.entries(report)
    .filter(([, v]) => v === null || typeof v !== "object")
    .map(([k, v]) => [k, fmtCell(v)]);
}
