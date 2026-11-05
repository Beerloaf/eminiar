/**
 * Jev impact report (src/adjudicator/jev-impact.ts; design: blackboard design-jev 1..3).
 *
 * Rows are built with the real blend() and engine.verdictColumns, so the stored blend tables are
 * exactly what the engine writes; the report must recover the heuristic-alone pick from them.
 * No network and no model: everything is seeded into an in-memory-style SQLite file or a stub db.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BLEND_DEFAULTS, type BlendWeights, blend } from "../../src/adjudicator/blend.js";
import { verdictColumns } from "../../src/adjudicator/engine.js";
import { tableConfidence } from "../../src/adjudicator/heuristic.js";
import {
  CONF_BAND,
  type Counterfactual,
  counterfactual,
  DEFAULT_APPLY_BOUNDS,
  decisionRowOf,
  EVIDENCE_ROWS_MAX,
  effectivePick,
  evidenceOf,
  impactReport,
  JEV_CLASSES,
  JEV_ROWS_MAX,
  JEV_SCORE_FIX_TS,
  type JevConfig,
  jevImpact,
  LOW_CONFIDENCE_DEFAULT,
  MIN_COMPARED,
  MIN_EVIDENCE,
  MIN_UNITS,
  PARENT_FETCH_MAX,
  ranAdvice,
  repriceByRatio,
  scoreScaleFixed,
  statusClass,
  UNCERTAIN_MARGIN,
  unitOf,
  VERDICT_RULE,
  verdictOf,
  verdictScope,
  viewOf,
  WILSON_Z,
  wilson,
} from "../../src/adjudicator/jev-impact.js";
import type {
  AdjudicationRow,
  Dist,
  ProviderAnswer,
  ProviderStatus,
  ScoreSet,
  ScoreTable,
  Tier,
} from "../../src/adjudicator/types.js";
import { SqliteAdapter } from "../../src/storage/sqlite/adapter.js";
import type { AdjudicationInput } from "../../src/storage/types.js";
import { kpiRows } from "../../src/ui/web/views/jev-helpers.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
const SINCE = NOW - 30 * DAY;
/** After the Jev score-scale fix (JEV_SCORE_FIX_TS), so complexity and effort count. */
const POST = NOW - DAY;
const PRE_FIX = Date.UTC(2026, 10, 5, 9, 0, 0);
const TIERS3: readonly Tier[] = ["haiku", "sonnet", "opus"];

const CFG: JevConfig = {
  tiers: TIERS3,
  weights: { lowConfidence: 0.55 },
  apply: {},
  timeouts: { promptMs: 1500, agentMs: 3000, planMs: 4000 },
};

// --- builders ----------------------------------------------------------------------------

type Probs = Record<string, number>;

function tableOf(dimension: ScoreTable["dimension"], probs: Probs): ScoreTable {
  const entries = Object.entries(probs)
    .map(([option, score]) => ({ option, score, reasons: [] }))
    .sort((a, b) => b.score - a.score);
  return {
    dimension,
    entries,
    choice: entries[0]?.option ?? "none",
    confidence: tableConfidence(entries),
  };
}

const ROLE_H: Probs = { coder: 0.7, architect: 0.2, none: 0.1 };
const TOOL_H: Probs = { em_symbols: 0.4, em_swarm: 0.3, none: 0.3 };

function hset(tier: Probs, o: { complexity?: number; role?: Probs; tool?: Probs } = {}): ScoreSet {
  const complexity = o.complexity ?? 1;
  return {
    complexity,
    complexityReasons: [],
    tool: tableOf("tool", o.tool ?? TOOL_H),
    tier: tableOf("tier", tier),
    role: tableOf("role", o.role ?? ROLE_H),
    effort: "low",
  };
}

const dist = (probs: Probs, confidence = 0.7): Dist => ({ probs, confidence, calibrated: true });

interface Jev {
  tier?: Probs;
  tierConf?: number;
  role?: Probs;
  complexity?: { value: number; confidence: number };
  risky?: number;
  needsPlan?: number;
}

function answer(j: Jev): ProviderAnswer {
  const a: ProviderAnswer = { key: "k" };
  if (j.tier) a.tier = dist(j.tier, j.tierConf ?? 0.7);
  if (j.role) a.role = dist(j.role);
  if (j.complexity) a.complexity = j.complexity;
  if (j.risky !== undefined) a.risky = j.risky;
  if (j.needsPlan !== undefined) a.needsPlan = j.needsPlan;
  return a;
}

/** The columns the engine would store for h blended with Jev's answer. */
function stored(
  h: ScoreSet,
  j: Jev | undefined,
  o: { bias?: Record<string, number>; weights?: BlendWeights; units?: boolean } = {},
): AdjudicationInput {
  const v = blend(h, j ? answer(j) : undefined, o.bias ?? {}, o.weights ?? {}, {
    key: "k",
    provider: "typesafe",
    tiers: TIERS3,
  });
  v.heuristicComplexity = h.complexity;
  const cols = verdictColumns(v, o.units ? { units: { statements: 2 } as never } : {});
  return {
    surface: "prompt",
    inputHash: "h",
    ...cols,
  } as AdjudicationInput;
}

/** Jev's pick relative to the heuristic's, both on the 3-tier ladder (all at α 0.7). */
const KINDS = {
  /** heuristic sonnet, Jev sonnet. */
  agree: () => stored(hset({ sonnet: 0.8, haiku: 0.15, opus: 0.05 }), { tier: { sonnet: 1 } }),
  /** heuristic haiku, Jev sonnet: final sonnet (up one). */
  up1: () => stored(hset({ haiku: 0.8, sonnet: 0.15, opus: 0.05 }), { tier: { sonnet: 1 } }),
  /** heuristic haiku, Jev opus: final opus (up two). */
  up2: () => stored(hset({ haiku: 0.8, sonnet: 0.15, opus: 0.05 }), { tier: { opus: 1 } }),
  /** heuristic opus, Jev sonnet: final sonnet (down one). */
  down: () => stored(hset({ opus: 0.8, sonnet: 0.15, haiku: 0.05 }), { tier: { sonnet: 1 } }),
  /** a near tie in the heuristic's own table: the reconstruction cannot tell the pick. */
  uncertain: () => stored(hset({ haiku: 0.5, sonnet: 0.49, opus: 0.01 }), { tier: { sonnet: 1 } }),
  /** Jev disagreed (sonnet) but weakly (α 0.2): the heuristic's haiku won. */
  overruled: () =>
    stored(hset({ haiku: 0.9, sonnet: 0.05, opus: 0.05 }), { tier: { sonnet: 1 }, tierConf: 0.2 }),
} satisfies Record<string, () => AdjudicationInput>;
type Kind = keyof typeof KINDS;

function parseScores(cols: AdjudicationInput): Record<string, unknown> {
  return JSON.parse(cols.scores as string) as Record<string, unknown>;
}

function patchScores(cols: AdjudicationInput, patch: Record<string, unknown>): AdjudicationInput {
  return { ...cols, scores: JSON.stringify({ ...parseScores(cols), ...patch }) };
}

/** An applied Jev row (blend, inline) of the given kind. */
function applied(kind: Kind, over: Partial<AdjudicationInput> = {}): AdjudicationInput {
  return {
    ...KINDS[kind](),
    ts: POST,
    provider: "typesafe",
    providerModel: "jev-1.14.0",
    providerStatus: "ok",
    source: "blend",
    latencyMs: 300,
    providerLatencyMs: 280,
    costUsd: 0.001,
    ...over,
  };
}

/** A row the provider did not answer: the heuristic's own tables, source and status as given. */
function fallbackRow(status: ProviderStatus, over: Partial<AdjudicationInput> = {}) {
  const h = hset({ sonnet: 0.8, haiku: 0.15, opus: 0.05 });
  const cols = stored(h, undefined);
  const heuristic = status === "skipped" || status === "n/a" || status === "ok";
  return {
    ...cols,
    ts: POST,
    provider: "typesafe",
    providerStatus: status,
    source: heuristic ? "heuristic" : "fallback",
    latencyMs: 4,
    providerLatencyMs: status === "timeout" ? 1500 : null,
    costUsd: null,
    providerModel: null,
    ...over,
  } as AdjudicationInput;
}

/** A dispatch (agent row outside a swarm) with a labelled outcome. */
const labelled = {
  help_up: { outcome: "failure", outcomeSource: "feedback:too_small" },
  hurt_up: { outcome: "success", outcomeSource: "feedback:too_big" },
  good: { outcome: "success", outcomeSource: "feedback:good" },
  success: { outcome: "success", outcomeSource: "reconcile" },
  failure: { outcome: "failure", outcomeSource: "reconcile" },
} as const;

let sessionSeq = 0;

/**
 * A dispatch whose advice the hook applied, in a session of its own (so its evidence counts as
 * independent, review-jev2 J4); `over` can name the action, the session or a swarm run.
 */
function dispatch(
  kind: Kind,
  label?: keyof typeof labelled,
  over: Partial<AdjudicationInput> = {},
): AdjudicationInput {
  return applied(kind, {
    surface: "agent",
    role: "coder",
    final: true,
    action: "applied",
    sessionId: `S${++sessionSeq}`,
    ...(label ? labelled[label] : {}),
    ...over,
  });
}

// --- the db ------------------------------------------------------------------------------

let db: SqliteAdapter;

beforeEach(() => {
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-jev-home-"));
  const root = mkdtempSync(join(tmpdir(), "em-jev-"));
  db = new SqliteAdapter(join(root, "db.sqlite"), { vectors: false });
});

afterEach(() => {
  db.close();
  delete process.env.EMINIAR_HOME;
});

const put = (row: AdjudicationInput): number => db.adjudicator.insert(row);
const putAll = (rows: AdjudicationInput[]): number[] => rows.map(put);
/** `n` agreeing dispatches: certain plan/agent decisions that fill MIN_COMPARED (J4). */
const fill = (n: number): void => {
  for (let i = 0; i < n; i++) put(dispatch("agree"));
};
const report = (window: Parameters<typeof jevImpact>[1] = { since: SINCE }, over = {}) =>
  jevImpact(db, window, { config: CFG, now: NOW, ...over });

// --- aggregation on a seeded db ------------------------------------------------------------

describe("jevImpact: a seeded mix of prompt decisions", () => {
  beforeEach(() => {
    putAll([
      ...Array.from({ length: 3 }, () => applied("agree")),
      applied("overruled"),
      applied("up1"),
      applied("up1"),
      applied("down"),
      applied("uncertain"),
      // cache: no provider call, still Jev-informed (the cache stores blended verdicts).
      applied("up1", { source: "cache", latencyMs: 2, providerLatencyMs: null, costUsd: null }),
      // deferred (async prompt): the heuristic's advice was shown, Jev's answer came later.
      applied("up2", { latencyMs: 5, providerLatencyMs: 685, costUsd: 0.002 }),
      fallbackRow("skipped"),
      fallbackRow("breaker_open"),
      fallbackRow("timeout", { costUsd: null }),
      fallbackRow("no_key"),
    ]);
    // Rows the report must never read.
    put(applied("up1", { surface: "test" }));
    put(applied("up1", { provider: "heuristic" }));
    put(applied("up1", { ts: SINCE - DAY }));
  });

  it("counts the sample and splits it into classes", () => {
    const r = report();
    expect(r.sample).toMatchObject({
      rows: 14,
      decisions: 14,
      jevApplied: 8,
      cache: 1,
      deferred: 1,
      fallback: 4,
      uncertain: 1,
      unreconstructable: 0,
      capped: false,
      eras: { units: 0, wholeText: 0 },
      models: { "jev-1.14.0": 10 },
    });
    expect(r.coverage.byClass).toEqual({
      applied: 8,
      cache: 1,
      deferred: 1,
      skipped: 1,
      guard: 1,
      error: 1,
      config: 1,
    });
    expect(Object.keys(r.coverage.byClass)).toEqual([...JEV_CLASSES]);
    expect(r.coverage.byStatus).toEqual({
      ok: 10,
      skipped: 1,
      breaker_open: 1,
      timeout: 1,
      no_key: 1,
    });
  });

  it("counts Jev changed vs agreed; uncertain rows are not changes; deferred rows are not compared", () => {
    const t = report().influence.tier;
    // 8 applied + 1 cache = 9 compared; deferred (up2) is not among them.
    expect(t.compared).toBe(9);
    expect(t.agree).toBe(4); // 3 agree + the overruled one
    expect(t.up).toBe(3); // 2 applied + 1 cache
    expect(t.down).toBe(1);
    expect(t.uncertain).toBe(1);
    expect(t.agree + t.up + t.down + t.uncertain).toBe(t.compared);
    expect(t.jevOverruled).toBe(1);
    expect(t.transitions).toEqual([
      { from: "haiku", to: "sonnet", n: 3 },
      { from: "sonnet", to: "sonnet", n: 3 },
      { from: "haiku", to: "haiku", n: 1 },
      { from: "opus", to: "sonnet", n: 1 },
    ]);
    expect(t.bySurface.prompt).toEqual({ compared: 8, agree: 4, up: 3, down: 1 });
    expect(t.byRole.coder).toEqual({ compared: 8, agree: 4, up: 3, down: 1 });
    // Deferred decisions only feed "would have changed".
    expect(t.wouldHaveChanged).toEqual({ compared: 1, changed: 1 });
    expect(t.roundUps.final).toBe(0);
    expect(t.roundUps.blendInduced).toBe(0);
  });

  it("agree is the transition diagonal", () => {
    const t = report().influence.tier;
    const diagonal = t.transitions.filter((x) => x.from === x.to).reduce((n, x) => n + x.n, 0);
    expect(diagonal).toBe(t.agree);
  });

  it("role and tool agree when Jev gave no role or tool (tools never move without a boost)", () => {
    const { role, tool } = report().influence;
    expect(role).toEqual({ compared: 9, agree: 9, changed: 0, uncertain: 0, transitions: [] });
    expect(tool).toEqual({ compared: 9, agree: 9, changed: 0, uncertain: 0, transitions: [] });
  });

  it("totals spend, calls and the latency percentiles per class", () => {
    const c = report().cost;
    expect(c.calls).toBe(9);
    expect(c.spendUsd).toBeCloseTo(0.01, 6);
    expect(c.usdPerCall).toBeCloseTo(0.01 / 9, 6);
    // provider latency: 8 applied (280), the deferred one (685) and the timed-out call (1500).
    expect(c.providerLatency).toEqual({ n: 10, p50: 280, p95: 1500 });
    // inline: only applied rows (the user waited for these).
    expect(c.inline).toEqual({ n: 8, p50: 300, p95: 300 });
    // heuristic-only on the same surface: the skipped row (4 ms) and the cache row (2 ms).
    expect(c.heuristicInline).toEqual({ n: 2, p50: 2, p95: 4 });
    expect(c.deferred).toBe(1);
    expect(c.timeouts).toBe(1);
    expect(c.budgetMs).toEqual({ prompt: 1500, agent: 3000, plan: 4000 });
  });

  it("attempts are applied + deferred + error calls; failure rate is errors over attempts", () => {
    const c = report().coverage;
    expect(c.attempts).toBe(10);
    expect(c.errors).toBe(1);
    expect(c.failureRate).toBeCloseTo(0.1, 10);
  });

  it("is not enough data (prompt decisions never fill the compared minimum) and says why", () => {
    const r = report();
    const v = r.verdict;
    expect(v.label).toBe("not enough data");
    // 9 compared, the uncertain near-tie left out of the minimum (review-jev F4).
    expect(r.influence.tier).toMatchObject({ compared: 9, uncertain: 1 });
    // 8 certain compared, all prompts: none can carry an outcome (review-jev2 J4).
    expect(v.compared).toBe(0);
    expect(v.n).toBe(0);
    expect(v.low).toBeNull();
    expect(v.high).toBeNull();
    expect(v.rule).toBe(VERDICT_RULE);
    expect(v.reasons.join(" | ")).toContain(
      `0 compared plan or agent decisions (prompts and cache hits not counted); need ${MIN_COMPARED}`,
    );
    expect(v.reasons.join(" | ")).toContain(`need ${MIN_EVIDENCE}`);
  });

  it("warns about deferred rows and missing usage, and never uses a warning to change the label", () => {
    const v = report().verdict;
    expect(v.warnings.some((w) => /1 prompt decisions? used the heuristic/.test(w))).toBe(true);
    expect(v.warnings).toContain("no usage data: savings cannot be repriced");
    expect(report().savings.usageAvailable).toBe(false);
    expect(v.label).toBe("not enough data");
  });

  it("narrows to one surface and reports the window it read", () => {
    const r = report({ since: SINCE, surface: "agent" });
    expect(r.surface).toBe("agent");
    expect(r.sample.rows).toBe(0);
    expect(report({ since: SINCE }).since).toBe(SINCE);
    expect(report({}).since).toBeNull();
    // without a window the row before SINCE comes back too
    expect(report({}).sample.rows).toBe(15);
  });

  it("reads the stored breaker state when none is given", () => {
    db.adjudicator.saveProviderState("typesafe", { state: "open", failures: 5, retryAt: NOW + 1 });
    expect(report().verdict.warnings).toContain("Jev's breaker is open");
    // an explicit state wins over the stored one
    expect(report({ since: SINCE }, { breakerState: "closed" }).verdict.warnings).not.toContain(
      "Jev's breaker is open",
    );
  });

  it("warns when the provider is degraded and says which way", () => {
    const w = report({ since: SINCE }, { degraded: "no_key" }).verdict.warnings;
    expect(w.some((x) => x.includes("degraded (no_key)"))).toBe(true);
  });
});

describe("jevImpact: deferred (async) prompt rows", () => {
  it("never count as outcomes, whatever their surface or label", () => {
    // A deferred row is source blend with provider latency above its own latency.
    putAll([
      dispatch("up1", "help_up", { latencyMs: 5, providerLatencyMs: 685 }),
      dispatch("up1", "help_up", { latencyMs: 5, providerLatencyMs: 685 }),
    ]);
    const r = report();
    expect(r.coverage.byClass.deferred).toBe(2);
    expect(r.influence.tier.compared).toBe(0);
    expect(r.influence.effective.dispatches).toBe(0);
    expect(r.outcomes.changed.dispatches).toBe(0);
    expect(r.outcomes.evidence).toMatchObject({ help: 0, hurt: 0, neutral: 0, rows: [] });
    expect(r.outcomes.excluded.deferred).toBe(2);
  });

  it("is inferred from provider latency above the row's latency, equal is inline", () => {
    putAll([
      applied("up1", { latencyMs: 400, providerLatencyMs: 399 }),
      applied("up1", { latencyMs: 400, providerLatencyMs: 400 }),
      applied("up1", { latencyMs: 400, providerLatencyMs: 401 }),
    ]);
    const r = report();
    expect(r.coverage.byClass).toMatchObject({ applied: 2, deferred: 1 });
  });
});

describe("jevImpact: unreconstructable rows", () => {
  it("counts rows with missing, malformed or too-heavy scores and leaves them out of the matrix", () => {
    const base = applied("up1");
    putAll([
      { ...base, scores: null },
      { ...base, scores: "{not json" },
      { ...base, scores: "[1,2,3]" },
      // alpha at or above ALPHA_MAX cannot be unmixed
      patchScores(base, { alpha: { tier: 0.97 } }),
    ]);
    const r = report();
    expect(r.sample.unreconstructable).toBe(4);
    expect(r.influence.tier.compared).toBe(0);
    expect(r.influence.tier.up).toBe(0);
    expect(r.coverage.byClass.applied).toBe(4);
  });
});

describe("jevImpact: negative bias clamps a score to zero", () => {
  it("marks the row uncertain instead of guessing the heuristic's pick", () => {
    // haiku at 0.6 less a learned bias of 0.9 is clamped to 0 by mixTable.
    const h = hset({ haiku: 0.6, sonnet: 0.3, opus: 0.1 });
    const cols = stored(h, { tier: { sonnet: 1 } }, { bias: { "tier:haiku": -0.9 } });
    const scores = parseScores(cols) as { tier: ScoreTable };
    expect(scores.tier.entries.find((e) => e.option === "haiku")?.score).toBe(0);
    put({ ...cols, ts: POST, provider: "typesafe", source: "blend", providerStatus: "ok" });
    const r = report();
    expect(r.influence.tier.uncertain).toBe(1);
    expect(r.influence.tier.up + r.influence.tier.down + r.influence.tier.agree).toBe(0);
    expect(r.sample.uncertain).toBe(1);
    expect(r.influence.tier.transitions).toEqual([]);
  });

  it("a plain zero in the heuristic (no bias) is a certain reconstruction", () => {
    // An option the heuristic scored 0 is a real zero: the reconstruction is certain.
    const h = hset({ haiku: 1, sonnet: 0, opus: 0 });
    const cols = stored(h, { tier: { haiku: 1 } });
    put({ ...cols, ts: POST, provider: "typesafe", source: "blend", providerStatus: "ok" });
    const r = report();
    expect(r.influence.tier).toMatchObject({ compared: 1, agree: 1, uncertain: 0 });
  });

  it("counterfactual: clamped entries take no part in the total", () => {
    const h = hset({ haiku: 0.6, sonnet: 0.3, opus: 0.1 });
    const v = blend(h, undefined, { "tier:haiku": -0.9 }, {}, { key: "k", provider: "typesafe" });
    const cf = counterfactual(v.tier, 0, v.bias, { tiers: TIERS3, lowConfidence: 0.55 });
    expect(cf).toBeDefined();
    expect(cf?.uncertain).toBe(true);
  });
});

describe("tier / role / tool influence via Jev's answer", () => {
  it("counts a role move and a tool move through the needs-plan boost", () => {
    const h = hset({ sonnet: 0.8, haiku: 0.15, opus: 0.05 });
    // Jev gives the role to architect (α 0.7) and flags a plan (boosts em_swarm and architect).
    put({
      ...stored(h, { tier: { sonnet: 1 }, role: { architect: 1 }, needsPlan: 0.9 }),
      ts: POST,
      provider: "typesafe",
      source: "blend",
      providerStatus: "ok",
      providerModel: "jev-1.14.0",
    });
    const r = report();
    expect(r.influence.role).toMatchObject({ compared: 1, agree: 0, changed: 1, uncertain: 0 });
    expect(r.influence.role.transitions).toEqual([{ from: "coder", to: "architect", n: 1 }]);
    expect(r.influence.tool).toMatchObject({ compared: 1, agree: 0, changed: 1 });
    expect(r.influence.tool.transitions).toEqual([{ from: "em_symbols", to: "em_swarm", n: 1 }]);
    expect(r.influence.tier.agree).toBe(1);
  });

  it("counts a changed tier once per decision on a role-keyed tally", () => {
    put(applied("up1", { role: "architect" }));
    put(applied("up1", { role: "coder" }));
    const r = report();
    expect(r.influence.tier.byRole.architect).toEqual({ compared: 1, agree: 0, up: 1, down: 0 });
    expect(r.influence.tier.byRole.coder).toEqual({ compared: 1, agree: 0, up: 1, down: 0 });
  });
});

describe("complexity and effort deltas", () => {
  const withComplexity = (value: number, confidence: number, over = {}) => ({
    ...stored(hset({ sonnet: 0.8, haiku: 0.15, opus: 0.05 }, { complexity: 1 }), {
      tier: { sonnet: 1 },
      complexity: { value, confidence },
    }),
    ts: POST,
    provider: "typesafe" as const,
    source: "blend" as const,
    providerStatus: "ok" as const,
    latencyMs: 300,
    providerLatencyMs: 280,
    ...over,
  });

  it("measures Jev's blended complexity against the heuristic's and the effort step", () => {
    // α 0.7: 0.3·1 + 0.7·3 = 2.4 (medium vs low: effort up); α 0.5 at 0: 0.5 (low: unchanged).
    putAll([withComplexity(3, 0.8), withComplexity(0, 0.5)]);
    const c = report().influence;
    expect(c.complexity.n).toBe(2);
    expect(c.complexity.meanDelta).toBeCloseTo((1.4 + -0.5) / 2, 6);
    expect(c.complexity.meanAbsDelta).toBeCloseTo((1.4 + 0.5) / 2, 6);
    expect(c.complexity.excludedBeforeFix).toBe(0);
    expect(c.effort).toEqual({ compared: 2, up: 1, down: 0 });
  });

  it("leaves rows before the Jev score-scale fix out of both deltas and counts them", () => {
    expect(PRE_FIX).toBeLessThan(JEV_SCORE_FIX_TS);
    put(withComplexity(3, 0.8, { ts: PRE_FIX }));
    put(withComplexity(3, 0.8, { ts: JEV_SCORE_FIX_TS }));
    const c = report({}).influence;
    expect(c.complexity.n).toBe(1);
    expect(c.complexity.excludedBeforeFix).toBe(1);
    expect(c.effort.compared).toBe(1);
  });

  it("has no mean when nothing is scored", () => {
    put(applied("agree", { scores: null }));
    const c = report().influence.complexity;
    expect(c).toMatchObject({ n: 0, meanDelta: null, meanAbsDelta: null });
  });
});

describe("agent rows join their parent plan row", () => {
  const swarm = { runId: "R1", taskId: 1 };

  it("takes the plan row's verdict and counts the decision once, the outcome on the agent row", () => {
    const planId = put(applied("up1", { surface: "plan", ...swarm }));
    // The agent row copies the plan's tier but its own tables are the heuristic's (it would agree).
    put({
      ...KINDS.agree(),
      surface: "agent",
      ts: POST,
      tier: "sonnet",
      role: "coder",
      parentId: planId,
      provider: "typesafe",
      source: "fallback",
      providerStatus: "skipped",
      latencyMs: 3,
      action: "applied",
      final: true,
      ...swarm,
      ...labelled.help_up,
    });
    const r = report();
    expect(r.sample.rows).toBe(2);
    expect(r.sample.decisions).toBe(1);
    expect(r.coverage.byClass).toMatchObject({ applied: 1, skipped: 0 });
    expect(r.influence.tier).toMatchObject({ compared: 1, up: 1, agree: 0 });
    // The task is one dispatch (its agent row), labelled "too small after Jev moved it up".
    expect(r.influence.effective).toMatchObject({ dispatches: 1, changed: 1, unchanged: 0 });
    expect(r.outcomes.evidence).toMatchObject({ help: 1, hurt: 0 });
    expect(r.outcomes.evidence.rows[0]).toMatchObject({
      surface: "agent",
      kind: "help",
      code: "too_small_after_up",
      from: "haiku",
      to: "sonnet",
    });
  });

  it("falls back to the agent row's own scores when the parent is missing", () => {
    put({
      ...KINDS.agree(),
      surface: "agent",
      ts: POST,
      tier: "sonnet",
      parentId: 99_999,
      provider: "typesafe",
      source: "fallback",
      providerStatus: "skipped",
    });
    const r = report();
    expect(r.sample.decisions).toBe(1);
    expect(r.coverage.byClass.skipped).toBe(1);
    expect(r.influence.tier.compared).toBe(0);
  });

  it("does not inherit when the parent's tier differs from the agent's", () => {
    const planId = put(applied("up1", { surface: "plan", ...swarm }));
    put({
      ...KINDS.agree(),
      surface: "agent",
      ts: POST,
      tier: "opus", // the plan said sonnet
      parentId: planId,
      provider: "typesafe",
      source: "fallback",
      providerStatus: "skipped",
      ...swarm,
    });
    const r = report();
    expect(r.sample.decisions).toBe(2);
    expect(r.influence.tier.up).toBe(1); // the plan row itself
  });

  it("does not credit a plan row from before the window: the agent row stands alone", () => {
    const planId = put(applied("up1", { surface: "plan", ts: SINCE - 10 * DAY, ...swarm }));
    put({
      ...KINDS.agree(),
      surface: "agent",
      ts: POST,
      tier: "sonnet",
      parentId: planId,
      provider: "typesafe",
      source: "fallback",
      providerStatus: "skipped",
      ...swarm,
    });
    const r = report();
    expect(r.sample.rows).toBe(1);
    expect(r.influence.tier.up).toBe(0);
    expect(r.sample.decisions).toBe(1);
    expect(r.sample.jevApplied).toBe(0);
    expect(r.outcomes.excluded.notJev).toBe(1);
    expect(r.cost.spendUsd).toBe(0);
  });

  it("an agent row of a narrowed surface still reads its plan row's decision", () => {
    const planId = put(applied("up1", { surface: "plan", ...swarm }));
    put({
      ...KINDS.agree(),
      surface: "agent",
      ts: POST,
      tier: "sonnet",
      parentId: planId,
      provider: "typesafe",
      source: "fallback",
      providerStatus: "skipped",
      ...swarm,
    });
    const r = report({ since: SINCE, surface: "agent" });
    expect(r.sample.rows).toBe(1);
    expect(r.influence.tier.up).toBe(1);
  });

  it("decisionRowOf prefers the parent only for a matching id and tier", () => {
    const row = { id: 5, parentId: 3, tier: "sonnet" } as AdjudicationRow;
    const parent = { id: 3, tier: "sonnet" } as AdjudicationRow;
    expect(decisionRowOf(row, parent)).toBe(parent);
    expect(decisionRowOf(row, { ...parent, tier: "opus" })).toBe(row);
    expect(decisionRowOf(row, { ...parent, id: 4 })).toBe(row);
    expect(decisionRowOf(row, undefined)).toBe(row);
    expect(decisionRowOf({ ...row, parentId: null }, parent)).toEqual({ ...row, parentId: null });
  });

  it("decisionRowOf takes a parent only when it is a typesafe decision inside the window", () => {
    const row = { id: 5, parentId: 3, tier: "sonnet" } as AdjudicationRow;
    const parent = { id: 3, tier: "sonnet", ts: 1000 } as AdjudicationRow;
    expect(decisionRowOf(row, { ...parent, provider: "typesafe" }, 500)).toMatchObject({ id: 3 });
    expect(decisionRowOf(row, parent, 500)).toMatchObject({ id: 3 }); // provider unset: pure path
    expect(decisionRowOf(row, parent, 1000)).toMatchObject({ id: 3 }); // the window start counts
    expect(decisionRowOf(row, parent, 1001)).toBe(row);
    expect(decisionRowOf(row, { ...parent, provider: "openai-compatible" }, 500)).toBe(row);
    expect(decisionRowOf(row, { ...parent, provider: "typesafe", surface: "test" }, 500)).toBe(row);
  });

  it("does not credit an openai-compatible plan row from 40 days ago (F5)", () => {
    for (let t = 1; t <= 3; t++) {
      const swarm2 = { runId: "R5", taskId: t };
      const planId = put(
        applied("down", {
          surface: "plan",
          provider: "openai-compatible",
          providerModel: "gpt-x",
          costUsd: 0.05,
          ts: NOW - 40 * DAY,
          ...swarm2,
        }),
      );
      put({
        ...KINDS.agree(),
        surface: "agent",
        ts: POST,
        tier: "sonnet",
        parentId: planId,
        provider: "typesafe",
        source: "fallback",
        providerStatus: "skipped",
        action: "applied",
        final: true,
        ...labelled.success,
        ...swarm2,
      });
    }
    const r = report();
    expect(r.sample.rows).toBe(3);
    expect(r.influence.tier.down).toBe(0);
    expect(r.sample.jevApplied).toBe(0);
    expect(r.sample.models).toEqual({});
    expect(r.cost.spendUsd).toBe(0);
    expect(r.cost.calls).toBe(0);
    expect(r.outcomes.evidence).toMatchObject({ help: 0, hurt: 0 });
    expect(r.outcomes.excluded.notJev).toBe(3);
  });

  it("does not credit a same-provider plan row older than the window either", () => {
    const planId = put(
      applied("down", { surface: "plan", ts: SINCE - DAY, costUsd: 0.05, ...swarm }),
    );
    put({
      ...KINDS.agree(),
      surface: "agent",
      ts: POST,
      tier: "sonnet",
      parentId: planId,
      provider: "typesafe",
      source: "fallback",
      providerStatus: "skipped",
      ...swarm,
    });
    const r = report();
    expect(r.influence.tier.down).toBe(0);
    expect(r.cost.spendUsd).toBe(0);
    expect(r.sample.decisions).toBe(1);
  });
});

describe("parent fetches", () => {
  it("looks up at most PARENT_FETCH_MAX distinct parents when the read was capped", () => {
    expect(PARENT_FETCH_MAX).toBe(500);
    // A capped read (JEV_ROWS_MAX rows) can leave out an in-window parent older than the rows.
    const rows = Array.from({ length: JEV_ROWS_MAX }, (_, i) =>
      agentRow(i + 1, i < 600 ? { parentId: 100_000 + i } : {}),
    );
    const gets: number[] = [];
    const stub = stubDb(rows, {
      get: (id) => {
        gets.push(id);
        return undefined;
      },
    });
    const r = jevImpact(stub, {}, { config: CFG, now: NOW });
    expect(r.sample.capped).toBe(true);
    expect(gets).toHaveLength(500);
    expect(new Set(gets).size).toBe(500);
  });

  it("makes no lookups when the read was not capped: every in-window parent is in the rows", () => {
    const rows = Array.from({ length: 600 }, (_, i) => agentRow(i + 1, { parentId: 10_000 + i }));
    const gets: number[] = [];
    const stub = stubDb(rows, {
      get: (id) => {
        gets.push(id);
        return undefined;
      },
    });
    expect(jevImpact(stub, {}, { config: CFG, now: NOW }).sample.capped).toBe(false);
    expect(gets).toHaveLength(0);
  });

  it("an out-of-window parent on the seeded db changes nothing whether fetched or not", () => {
    // The plan row is older than the window: decisionRowOf rejects it, so skipping the fetch is
    // the same report (#189 F5).
    const planId = put(applied("down", { surface: "plan", ts: SINCE - DAY }));
    put({
      ...KINDS.agree(),
      surface: "agent",
      ts: POST,
      tier: "sonnet",
      parentId: planId,
      provider: "typesafe",
      source: "fallback",
      providerStatus: "skipped",
    });
    const plan = db.adjudicator.get(planId) as AdjudicationRow;
    const rows = db.adjudicator.list({ provider: "typesafe", since: SINCE, limit: 500 }).rows;
    const withParent = impactReport(rows, [plan], { since: SINCE }, { config: CFG, now: NOW });
    const without = impactReport(rows, [], { since: SINCE }, { config: CFG, now: NOW });
    expect(withParent).toEqual(without);
    expect(report().influence.tier.down).toBe(0);
  });
});

// --- verdict ---------------------------------------------------------------------------------

describe("verdictOf and the Wilson 90% bounds", () => {
  // The textbook Wilson score interval, kept independent of the module.
  const ref = (k: number, n: number) => {
    const z = 1.645;
    const p = k / n;
    const d = 1 + (z * z) / n;
    const c = (p + (z * z) / (2 * n)) / d;
    const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
    return { low: c - h, high: c + h };
  };

  it("uses z = 1.645 and matches the textbook interval", () => {
    expect(WILSON_Z).toBe(1.645);
    for (const [k, n] of [
      [9, 10],
      [7, 10],
      [2, 12],
      [50, 100],
      [0, 10],
      [10, 10],
    ] as const) {
      const w = wilson(k, n);
      expect(w.low).toBeCloseTo(ref(k, n).low, 10);
      expect(w.high).toBeCloseTo(Math.min(1, ref(k, n).high), 10);
    }
    expect(wilson(0, 0)).toEqual({ low: null, high: null });
    const all = wilson(10, 10);
    expect(all.high).toBeLessThanOrEqual(1);
    expect(wilson(0, 10).low).toBeGreaterThanOrEqual(0);
  });

  it("9 of 10 is helping (lower bound ≈ 0.65, above 0.5)", () => {
    const v = verdictOf({ help: 9, hurt: 1, compared: 30, units: 3 });
    expect(v.label).toBe("helping");
    expect(v.n).toBe(10);
    expect(v.low).toBeCloseTo(0.652, 2);
    expect(v.high).toBeCloseTo(0.977, 2);
    expect(v.reasons[0]).toContain("9 of 10");
    expect(v.reasons[0]).toContain("65%");
  });

  it("7 of 10 is not enough data: the evidence is split", () => {
    const v = verdictOf({ help: 7, hurt: 3, compared: 30, units: 3 });
    expect(v.label).toBe("not enough data");
    expect(v.low).toBeCloseTo(0.44, 2);
    expect(v.reasons).toEqual(["evidence is split (7 help vs 3 hurt)"]);
  });

  it("2 of 12 is hindering (upper bound ≈ 0.40, below 0.5)", () => {
    const v = verdictOf({ help: 2, hurt: 10, compared: 30, units: 3 });
    expect(v.label).toBe("hindering");
    expect(v.high).toBeCloseTo(0.4, 2);
    expect(v.reasons[0]).toContain("10 of 12");
  });

  it("fewer than 10 labelled outcomes is not enough data, however lopsided", () => {
    const v = verdictOf({ help: 9, hurt: 0, compared: 100, units: 9 });
    expect(v.label).toBe("not enough data");
    expect(v.reasons).toEqual([
      `9 labelled outcomes on decisions Jev changed; need ${MIN_EVIDENCE}`,
    ]);
    expect(verdictOf({ help: 0, hurt: 9, compared: 100, units: 9 }).label).toBe("not enough data");
  });

  it("fewer than 30 compared decisions is not enough data, however lopsided", () => {
    const v = verdictOf({ help: 20, hurt: 0, compared: 29, units: 20 });
    expect(v.label).toBe("not enough data");
    expect(v.reasons).toEqual([
      `29 compared plan or agent decisions (prompts and cache hits not counted); need ${MIN_COMPARED}`,
    ]);
    // exactly at the minimums the evidence decides
    expect(verdictOf({ help: 10, hurt: 0, compared: 30, units: 3 }).label).toBe("helping");
    expect(verdictOf({ help: 0, hurt: 10, compared: 30, units: 3 }).label).toBe("hindering");
  });

  it("states both shortfalls when both apply", () => {
    const v = verdictOf({ help: 0, hurt: 0, compared: 3 });
    expect(v.reasons).toHaveLength(3);
    expect(v.minEvidence).toBe(MIN_EVIDENCE);
    expect(v.minCompared).toBe(MIN_COMPARED);
    expect(v.minUnits).toBe(MIN_UNITS);
  });

  it("warnings are passed through and never change the label", () => {
    const warned = verdictOf({ help: 9, hurt: 1, compared: 30, units: 3 }, [
      "Jev failed 50% of calls",
    ]);
    expect(warned.label).toBe("helping");
    expect(warned.warnings).toEqual(["Jev failed 50% of calls"]);
  });

  it("the rule sentence states the bound, the minimums and the hindering side", () => {
    expect(VERDICT_RULE).toContain("90% lower bound");
    expect(VERDICT_RULE).toContain("above 50%");
    expect(VERDICT_RULE).toContain("≥ 10 labelled outcomes");
    expect(VERDICT_RULE).toContain("≥ 30 compared plan or agent decisions");
    expect(VERDICT_RULE).toContain("≥ 3 distinct swarm runs or sessions");
    expect(VERDICT_RULE).toContain("upper bound");
  });
});

describe("the three verdict states, end to end on a seeded db", () => {
  /** `agree` unchanged prompt decisions, plus changed dispatches labelled by `labels`. */
  function seedVerdict(
    agree: number,
    changed: Array<{ kind: Kind; label: keyof typeof labelled; n: number }>,
  ) {
    fill(agree);
    for (const c of changed) for (let i = 0; i < c.n; i++) put(dispatch(c.kind, c.label));
  }

  it("helping: 9 of 10 labelled outcomes on decisions Jev moved up went its way", () => {
    seedVerdict(20, [
      { kind: "up1", label: "help_up", n: 9 },
      { kind: "up1", label: "hurt_up", n: 1 },
    ]);
    const v = report().verdict;
    expect(v).toMatchObject({ label: "helping", help: 9, hurt: 1, n: 10, compared: 30 });
    expect(v.low).toBeCloseTo(0.652, 2);
  });

  it("not enough data: 7 of 10 is split", () => {
    seedVerdict(20, [
      { kind: "up1", label: "help_up", n: 7 },
      { kind: "up1", label: "hurt_up", n: 3 },
    ]);
    const v = report().verdict;
    expect(v).toMatchObject({ label: "not enough data", help: 7, hurt: 3 });
    expect(v.reasons[0]).toContain("split");
  });

  it("hindering: moving down was marked too small ten times in twelve", () => {
    // down moves: too_small hurt, too_big help
    fill(20);
    for (let i = 0; i < 10; i++)
      put(dispatch("down", undefined, { outcome: "failure", outcomeSource: "feedback:too_small" }));
    for (let i = 0; i < 2; i++)
      put(dispatch("down", undefined, { outcome: "success", outcomeSource: "feedback:too_big" }));
    const v = report().verdict;
    expect(v).toMatchObject({ label: "hindering", help: 2, hurt: 10, n: 12 });
    expect(v.high).toBeCloseTo(0.4, 2);
  });

  it("agreeing decisions give no evidence however many are labelled", () => {
    for (let i = 0; i < 40; i++) put(dispatch("agree", "good"));
    const r = report();
    expect(r.influence.tier.agree).toBe(40);
    expect(r.outcomes.evidence).toMatchObject({ help: 0, hurt: 0, neutral: 0 });
    expect(r.outcomes.unchanged.dispatches).toBe(40);
    expect(r.outcomes.changed.dispatches).toBe(0);
    expect(r.verdict.label).toBe("not enough data");
  });
});

describe("evidenceOf: every cell of the table", () => {
  const row = (outcome: AdjudicationRow["outcome"], outcomeSource: string | null = null) => ({
    outcome,
    outcomeSource,
  });

  it("feedback decides, in both directions", () => {
    expect(evidenceOf(row("failure", "feedback:too_small"), 1)).toEqual({
      kind: "help",
      code: "too_small_after_up",
    });
    expect(evidenceOf(row("failure", "feedback:too_small"), -1)).toEqual({
      kind: "hurt",
      code: "too_small_after_down",
    });
    expect(evidenceOf(row("success", "feedback:too_big"), 1)).toEqual({
      kind: "hurt",
      code: "too_big_after_up",
    });
    expect(evidenceOf(row("success", "feedback:too_big"), -1)).toEqual({
      kind: "help",
      code: "too_big_after_down",
    });
    expect(evidenceOf(row("success", "feedback:good"), 1)).toEqual({
      kind: "help",
      code: "good_after_up",
    });
    expect(evidenceOf(row("success", "feedback:good"), -1)).toEqual({
      kind: "help",
      code: "good_after_down",
    });
  });

  it("feedback beats the reconcile outcome", () => {
    // outcome says failure, but the user said "too big" after a move down: help
    expect(evidenceOf(row("failure", "feedback:too_big"), -1)?.kind).toBe("help");
  });

  it("a bare legacy 'feedback' source maps by the outcome", () => {
    expect(evidenceOf(row("failure", "feedback"), 1)).toEqual({
      kind: "help",
      code: "too_small_after_up",
    });
    expect(evidenceOf(row("success", "feedback"), -1)).toEqual({
      kind: "help",
      code: "good_after_down",
    });
  });

  it("reconcile outcomes: a cheaper model that worked helps, one that failed hurts, bigger is neutral", () => {
    expect(evidenceOf(row("success", "reconcile"), -1)).toEqual({
      kind: "help",
      code: "success_after_down",
    });
    expect(evidenceOf(row("failure", "reconcile"), -1)).toEqual({
      kind: "hurt",
      code: "failure_after_down",
    });
    expect(evidenceOf(row("success", "reconcile"), 1)).toEqual({
      kind: "neutral",
      code: "success_after_up",
    });
    expect(evidenceOf(row("failure", "reconcile"), 1)).toEqual({
      kind: "neutral",
      code: "failure_after_up",
    });
  });

  it("pending, abandoned and n/a outcomes give no evidence", () => {
    for (const o of ["pending", "abandoned", "n/a"] as const)
      for (const d of [-1, 1] as const) expect(evidenceOf(row(o, null), d)).toBeUndefined();
  });

  it("an unknown feedback label is ignored, then the outcome decides", () => {
    expect(evidenceOf(row("success", "feedback:bogus"), -1)).toEqual({
      kind: "help",
      code: "success_after_down",
    });
    expect(evidenceOf(row("pending", "feedback:bogus"), -1)).toBeUndefined();
  });

  it("a dispatch that did not run the advice gives no evidence, feedback included (J1)", () => {
    expect(evidenceOf(row("success", "reconcile"), -1, false)).toBeUndefined();
    expect(evidenceOf(row("failure", "swarm"), 1, false)).toBeUndefined();
    // learn.ts teaches a label to the tier that ran: it judges that model, not Jev's.
    for (const fb of ["good", "too_small", "too_big"])
      for (const dir of [-1, 1] as const)
        expect(evidenceOf(row("success", `feedback:${fb}`), dir, false)).toBeUndefined();
  });

  it("a reconcile outcome counts only on a final row; feedback is final by nature (J2)", () => {
    const notFinal = (outcome: AdjudicationRow["outcome"], src: string) => ({
      ...row(outcome, src),
      final: false,
    });
    expect(evidenceOf(notFinal("success", "swarm"), -1)).toBeUndefined();
    expect(evidenceOf(notFinal("failure", "reconcile"), -1)).toBeUndefined();
    expect(evidenceOf({ ...row("success", "swarm"), final: true }, -1)).toEqual({
      kind: "help",
      code: "success_after_down",
    });
    expect(evidenceOf(notFinal("success", "feedback:too_big"), -1)).toEqual({
      kind: "help",
      code: "too_big_after_down",
    });
  });

  it("neutral outcomes after a move up are counted separately and do not enter the verdict n", () => {
    for (let i = 0; i < 4; i++) put(dispatch("up1", "success", { action: "applied" }));
    const r = report();
    expect(r.outcomes.evidence).toMatchObject({ help: 0, hurt: 0, neutral: 4 });
    expect(r.verdict.n).toBe(0);
    expect(r.outcomes.evidence.rows.map((e) => e.code)).toEqual(Array(4).fill("success_after_up"));
  });

  it("returns the newest evidence first, capped", () => {
    expect(EVIDENCE_ROWS_MAX).toBe(20);
    const ids: number[] = [];
    for (let i = 0; i < 25; i++)
      ids.push(put(dispatch("up1", "help_up", { ts: POST - (25 - i) * 1000 })));
    const rows = report().outcomes.evidence.rows;
    expect(rows).toHaveLength(20);
    expect(rows[0]?.id).toBe(ids[24]);
    expect(rows.map((e) => e.ts)).toEqual([...rows.map((e) => e.ts)].sort((a, b) => b - a));
    // the counts still cover all 25
    expect(report().outcomes.evidence.help).toBe(25);
  });
});

describe("attribution of dispatches", () => {
  it("counts follow rate, success and feedback separately for changed and unchanged", () => {
    putAll([
      dispatch("up1", "success", { action: "followed" }),
      dispatch("up1", "failure", { action: "ignored" }),
      dispatch("agree", "good", { action: "followed" }),
      dispatch("agree", "success", { action: "followed" }),
      dispatch("agree", "success", { action: "applied" }), // not an advise-mode action
      dispatch("down", "hurt_up", { action: "advised", final: false, outcome: "pending" }),
    ]);
    const o = report().outcomes;
    expect(o.changed).toMatchObject({
      dispatches: 3,
      followed: 1,
      followDenom: 3,
      // the ignored dispatch ran something else: its failure says nothing about Jev's tier
      final: 1,
      success: 1,
      failure: 0,
      successRate: 1,
    });
    expect(o.excluded.notRun).toBe(2); // the ignored one and the advised one with no model
    expect(o.changed.followRate).toBeCloseTo(1 / 3, 10);
    expect(o.unchanged).toMatchObject({
      dispatches: 3,
      followed: 2,
      followDenom: 2,
      followRate: 1,
      final: 3,
      success: 3,
      failure: 0,
      successRate: 1,
    });
    expect(o.unchanged.feedback).toEqual({ good: 1, too_small: 0, too_big: 0 });
  });

  it("matches the store summary's follow rate on the same rows", () => {
    for (const action of ["followed", "followed", "followed", "ignored", "ignored"] as const)
      put(dispatch("agree", undefined, { action }));
    for (const action of ["advised", "advised", "applied", "applied", "respected", "none"] as const)
      put(dispatch("agree", undefined, { action }));
    const split = report().outcomes.unchanged;
    const follow = db.adjudicator.summary(SINCE).rates.follow;
    expect(follow).not.toBeNull();
    expect(split.followRate).toBeCloseTo(follow as number, 10);
    expect(split.followDenom).toBe(7);
  });

  it("leaves out kept-model dispatches, fallback rows and rows with no usable scores, with counts", () => {
    putAll([
      dispatch("up1", "help_up", {
        scores: JSON.stringify({ ...parseScores(KINDS.up1()), forced: true }),
      }),
      dispatch("up1", "help_up", {
        scores: JSON.stringify({ ...parseScores(KINDS.up1()), fork: true }),
      }),
      dispatch("uncertain", "help_up"),
      dispatch("up1", "help_up", { scores: null }),
      { ...fallbackRow("breaker_open"), surface: "agent", final: true, ...labelled.help_up },
    ]);
    const o = report().outcomes;
    expect(o.excluded).toMatchObject({
      kept: 2,
      uncertain: 1,
      unreconstructable: 1,
      notJev: 1,
    });
    expect(o.changed.dispatches + o.unchanged.dispatches).toBe(0);
    expect(o.evidence.rows).toEqual([]);
  });

  it("prompt rows are never dispatches", () => {
    for (let i = 0; i < 5; i++) put(applied("up1", { ...labelled.help_up, final: true }));
    const r = report();
    expect(r.influence.tier.up).toBe(5);
    expect(r.influence.effective.dispatches).toBe(0);
    expect(r.outcomes.evidence.help).toBe(0);
  });

  it("a swarm task counts once, by its agent row", () => {
    const runs = { runId: "R", taskId: 7 };
    put(applied("up1", { surface: "plan", ...runs }));
    put(dispatch("up1", "help_up", runs));
    const r = report();
    expect(r.influence.effective.dispatches).toBe(1);
    expect(r.sample.decisions).toBe(2);
  });
});

describe("outcomes count only for dispatches that ran Jev's tier (F1)", () => {
  /** 10 dispatches Jev moved opus -> sonnet, plus 20 agreeing prompts to reach MIN_COMPARED. */
  function seedDown(n: number, over: Partial<AdjudicationInput>, label: keyof typeof labelled) {
    fill(20);
    for (let i = 0; i < n; i++) put(dispatch("down", label, over));
  }
  const ranOpus = { actualModel: "claude-opus-4-1", modelRequested: "opus" };

  it("ignored advice: a success on opus is no help, the verdict is not 'helping'", () => {
    seedDown(10, { action: "ignored", ...ranOpus }, "success");
    const r = report();
    expect(r.outcomes.evidence).toMatchObject({ help: 0, hurt: 0, neutral: 0 });
    expect(r.outcomes.evidence.rows).toEqual([]);
    expect(r.verdict.label).toBe("not enough data");
    expect(r.verdict.n).toBe(0);
    expect(r.outcomes.excluded.notRun).toBe(10);
    // the follow rate still sees them: nobody followed
    expect(r.outcomes.changed).toMatchObject({
      dispatches: 10,
      followDenom: 10,
      followed: 0,
      followRate: 0,
      final: 0,
      success: 0,
      successRate: null,
    });
  });

  it("ignored advice: a failure on opus is no hurt, the verdict is not 'hindering'", () => {
    seedDown(12, { action: "ignored", ...ranOpus }, "failure");
    const r = report();
    expect(r.outcomes.evidence).toMatchObject({ help: 0, hurt: 0 });
    expect(r.verdict.label).toBe("not enough data");
    expect(r.outcomes.changed.failure).toBe(0);
  });

  it("advised with no model passed (the baseline ran) is left out too", () => {
    seedDown(
      10,
      {
        action: "advised",
        modelRequested: null,
        baselineModel: "claude-opus-4-1",
        actualModel: "claude-opus-4-1",
      },
      "success",
    );
    const r = report();
    expect(r.outcomes.evidence).toMatchObject({ help: 0, hurt: 0 });
    expect(r.verdict.label).toBe("not enough data");
    expect(r.outcomes.excluded.notRun).toBe(10);
  });

  it("applied advice that ran the advised tier still gives 'helping' by the Wilson rule", () => {
    seedDown(10, { action: "applied", actualModel: "claude-sonnet-4-5" }, "success");
    const r = report();
    expect(r.outcomes.evidence).toMatchObject({ help: 10, hurt: 0 });
    expect(r.outcomes.evidence.rows[0]?.code).toBe("success_after_down");
    expect(r.verdict).toMatchObject({ label: "helping", help: 10, hurt: 0, n: 10, compared: 30 });
    expect(r.outcomes.excluded.notRun).toBe(0);
    expect(r.outcomes.changed).toMatchObject({ final: 10, success: 10, successRate: 1 });
  });

  it("applied advice that ran the advised tier and failed gives 'hindering'", () => {
    seedDown(12, { action: "applied", actualModel: "claude-sonnet-4-5" }, "failure");
    const r = report();
    expect(r.outcomes.evidence).toMatchObject({ help: 0, hurt: 12 });
    expect(r.verdict).toMatchObject({ label: "hindering", help: 0, hurt: 12 });
  });

  it("a followed dispatch counts, and so does an advised one that passed the advised model", () => {
    seedDown(
      5,
      { action: "followed", modelRequested: "sonnet", actualModel: "claude-sonnet-4-5" },
      "success",
    );
    for (let i = 0; i < 5; i++)
      put(dispatch("down", "success", { action: "advised", modelRequested: "sonnet" })); // no usage yet
    const r = report();
    expect(r.outcomes.evidence.help).toBe(10);
    expect(r.verdict.label).toBe("helping");
    expect(r.outcomes.excluded.notRun).toBe(0);
  });

  it("a dispatch that ran a different tier than the advice is left out, applied or not", () => {
    seedDown(10, { action: "applied", actualModel: "claude-opus-4-1" }, "success"); // overridden
    const r = report();
    expect(r.outcomes.evidence).toMatchObject({ help: 0, hurt: 0 });
    expect(r.outcomes.excluded.notRun).toBe(10);
    expect(r.verdict.label).toBe("not enough data");
  });

  it("mixed: only the dispatches that ran the advice enter the evidence", () => {
    fill(20);
    for (let i = 0; i < 9; i++)
      put(dispatch("down", "success", { action: "applied", actualModel: "claude-sonnet-4-5" }));
    for (let i = 0; i < 30; i++)
      put(dispatch("down", "failure", { action: "ignored", ...ranOpus }));
    const r = report();
    expect(r.outcomes.evidence).toMatchObject({ help: 9, hurt: 0 });
    expect(r.verdict.n).toBe(9);
    expect(r.verdict.label).toBe("not enough data"); // 9 < MIN_EVIDENCE
    expect(r.outcomes.excluded.notRun).toBe(30);
    expect(r.outcomes.changed.dispatches).toBe(39);
  });

  it("feedback on a dispatch that ran something else does not count either (review-jev2 J1)", () => {
    // too_big on opus after Jev moved opus -> sonnet: the label judges opus (learn.ts teaches it
    // to the tier that ran), not Jev's sonnet.
    seedDown(10, { action: "ignored", ...ranOpus }, "success");
    for (let i = 0; i < 10; i++)
      put(
        dispatch("down", undefined, {
          action: "ignored",
          ...ranOpus,
          outcome: "success",
          outcomeSource: "feedback:too_big",
        }),
      );
    const r = report();
    expect(r.outcomes.evidence).toMatchObject({ help: 0, hurt: 0, neutral: 0 });
    expect(r.outcomes.evidence.rows).toEqual([]);
    expect(r.outcomes.excluded.notRun).toBe(20);
    expect(r.verdict.label).toBe("not enough data");
    // the labels still show in the split's feedback counts
    expect(r.outcomes.changed.feedback.too_big).toBe(10);
  });

  it("works the same for a swarm task: the agent row's action decides", () => {
    fill(20);
    for (let t = 1; t <= 10; t++) {
      const swarm = { runId: "R9", taskId: t };
      const planId = put(applied("down", { surface: "plan", ...swarm }));
      put({
        ...KINDS.agree(),
        surface: "agent",
        ts: POST,
        tier: "sonnet",
        parentId: planId,
        provider: "typesafe",
        source: "fallback",
        providerStatus: "skipped",
        action: "ignored",
        modelRequested: "opus",
        actualModel: "claude-opus-4-1",
        final: true,
        ...labelled.success,
        ...swarm,
      });
    }
    const r = report();
    expect(r.influence.tier.down).toBe(10);
    expect(r.outcomes.evidence.help).toBe(0);
    expect(r.verdict.label).toBe("not enough data");
  });
});

describe("ranAdvice", () => {
  const a = (o: Partial<AdjudicationRow>) => ranAdvice(o as AdjudicationRow, "sonnet");
  it("the model that really ran wins over the action", () => {
    expect(a({ action: "ignored", actualModel: "claude-sonnet-4-5" })).toBe(true);
    expect(a({ action: "applied", actualModel: "claude-opus-4-1" })).toBe(false);
    expect(
      a({ action: "advised", modelRequested: "opus", actualModel: "claude-sonnet-4-5[1m]" }),
    ).toBe(true);
  });
  it("without a known model: applied and followed ran, the rest ran only when they passed the tier", () => {
    expect(a({ action: "applied" })).toBe(true);
    expect(a({ action: "followed" })).toBe(true);
    expect(a({ action: "advised" })).toBe(false);
    expect(a({ action: "advised", modelRequested: "claude-sonnet-4-5" })).toBe(true);
    expect(a({ action: "ignored", modelRequested: "opus" })).toBe(false);
    expect(a({ action: "respected" })).toBe(false);
    expect(a({ action: "none" })).toBe(false);
    expect(a({})).toBe(false);
  });
  it("an unrecognised actual model falls back to the action", () => {
    expect(a({ action: "applied", actualModel: "gpt-x" })).toBe(true);
    expect(a({ action: "advised", actualModel: "gpt-x" })).toBe(false);
  });
});

describe("effective model (advisedPick and the apply bounds)", () => {
  const advised = (pick: string, ranged = false) =>
    JSON.stringify({
      ...parseScores(KINDS.up1()),
      advisedPick: pick,
      ...(ranged ? { ranged: true } : {}),
    });

  it("a pick above both the verdict and the heuristic leaves Jev's move with no effect", () => {
    // advice named sonnet = the verdict (Jev), heuristic haiku: a real effective change
    put(dispatch("up1", "help_up", { scores: advised("sonnet") }));
    // advice named opus (a floor above both): raw < pick and cf <= pick, so both end on opus
    put(dispatch("up1", "help_up", { scores: advised("opus") }));
    const r = report();
    expect(r.influence.effective).toMatchObject({ dispatches: 2, changed: 1, unchanged: 1 });
  });

  it("a ranged dispatch whose heuristic pick falls outside the range is unknown, not guessed", () => {
    put(dispatch("up1", "help_up", { scores: advised("sonnet", true) }));
    const r = report();
    expect(r.influence.effective).toMatchObject({ dispatches: 0, unknown: 1 });
    expect(r.outcomes.excluded.unknown).toBe(1);
    expect(r.outcomes.evidence.help).toBe(0);
  });

  it("does not clamp with today's apply bounds when no pick is stored: such a row is left out (J3)", () => {
    put(dispatch("up1", "help_up"));
    const r = report({ since: SINCE }, { config: { ...CFG, apply: { floor: "sonnet" } } });
    // today's floor sonnet would lift the heuristic's haiku; the bounds it ran under are unknown
    expect(r.influence.effective).toMatchObject({ dispatches: 0, unknown: 1 });
    expect(r.outcomes.excluded).toMatchObject({ bounds: 1, unknown: 0 });
    expect(r.outcomes.evidence.help).toBe(0);
    expect(r.influence.tier.up).toBe(1);
    // bounds that would clamp neither tier: read as unclamped
    const open = report({ since: SINCE }, { config: { ...CFG, apply: {} } });
    expect(open.influence.effective).toMatchObject({ dispatches: 1, changed: 1, unknown: 0 });
  });
});

describe("effectivePick: every branch", () => {
  const bounds = { floor: "sonnet", ceiling: "sonnet" } as const;

  it("is unknown for a tier it cannot rank", () => {
    expect(effectivePick({ raw: null, pick: undefined, cf: "haiku", ranged: false })).toBe(
      "unknown",
    );
    expect(effectivePick({ raw: "opus", pick: undefined, cf: "gpt", ranged: false })).toBe(
      "unknown",
    );
    expect(effectivePick({ raw: undefined, pick: "opus", cf: undefined, ranged: false })).toBe(
      "unknown",
    );
  });

  it("without a stored pick both tiers are clamped to the apply bounds", () => {
    expect(
      effectivePick({ raw: "opus", pick: undefined, cf: "haiku", ranged: false, bounds }),
    ).toEqual({
      final: "sonnet",
      cf: "sonnet",
    });
    expect(effectivePick({ raw: "opus", pick: undefined, cf: "haiku", ranged: false })).toEqual({
      final: "opus",
      cf: "haiku",
    });
  });

  it("raw below the pick (a floor lifted it): a heuristic at or below the pick lands on the pick", () => {
    expect(effectivePick({ raw: "haiku", pick: "sonnet", cf: "haiku", ranged: false })).toEqual({
      final: "sonnet",
      cf: "sonnet",
    });
    expect(effectivePick({ raw: "haiku", pick: "sonnet", cf: "sonnet", ranged: false })).toEqual({
      final: "sonnet",
      cf: "sonnet",
    });
    // above the pick the floor says nothing about it
    expect(effectivePick({ raw: "haiku", pick: "sonnet", cf: "opus", ranged: false })).toBe(
      "unknown",
    );
  });

  it("raw above the pick (a ceiling held it): a heuristic at or above the pick lands on the pick", () => {
    expect(effectivePick({ raw: "opus", pick: "sonnet", cf: "opus", ranged: false })).toEqual({
      final: "sonnet",
      cf: "sonnet",
    });
    expect(effectivePick({ raw: "opus", pick: "sonnet", cf: "sonnet", ranged: false })).toEqual({
      final: "sonnet",
      cf: "sonnet",
    });
    expect(effectivePick({ raw: "opus", pick: "sonnet", cf: "haiku", ranged: false })).toBe(
      "unknown",
    );
  });

  it("raw equal to the pick: the same heuristic is the same pick", () => {
    expect(effectivePick({ raw: "sonnet", pick: "sonnet", cf: "sonnet", ranged: true })).toEqual({
      final: "sonnet",
      cf: "sonnet",
    });
  });

  it("raw equal to the pick and a different heuristic: bounds decide, a range cannot be inferred", () => {
    expect(effectivePick({ raw: "sonnet", pick: "sonnet", cf: "haiku", ranged: false })).toEqual({
      final: "sonnet",
      cf: "haiku",
    });
    expect(
      effectivePick({
        raw: "sonnet",
        pick: "sonnet",
        cf: "haiku",
        ranged: false,
        bounds: { floor: "sonnet" },
      }),
    ).toEqual({ final: "sonnet", cf: "sonnet" });
    expect(effectivePick({ raw: "sonnet", pick: "sonnet", cf: "haiku", ranged: true })).toBe(
      "unknown",
    );
  });
});

// --- counterfactual -------------------------------------------------------------------------

describe("counterfactual", () => {
  const lowConfidence = 0.55;
  const tier = { tiers: TIERS3, lowConfidence };

  it("recovers the heuristic's table from a blend", () => {
    const h = hset({ haiku: 0.8, sonnet: 0.15, opus: 0.05 });
    const v = blend(h, answer({ tier: { sonnet: 1 } }), {}, {}, { key: "k", provider: "typesafe" });
    const cf = counterfactual(v.tier, v.alpha.tier ?? 0, v.bias, tier) as Counterfactual;
    expect(v.tier.choice).toBe("sonnet");
    expect(cf.choice).toBe("haiku");
    expect(cf.top).toBe("haiku");
    expect(cf.jev).toBe("sonnet");
    expect(cf.margin).toBeCloseTo(0.65, 1);
    expect(cf.uncertain).toBe(false);
    expect(cf.roundedUp).toBe(false);
  });

  it("is undefined when the provider carried the blend (α at or above 0.95)", () => {
    const t = tableOf("tier", { haiku: 0.5, sonnet: 0.5 });
    expect(counterfactual(t, 0.95)).toBeUndefined();
    expect(counterfactual(t, 1)).toBeUndefined();
    expect(counterfactual(t, 0.949)).toBeDefined();
  });

  it("treats a non-finite or negative α as 0", () => {
    const t = tableOf("tier", { haiku: 0.8, sonnet: 0.2 });
    for (const a of [Number.NaN, -1, Number.POSITIVE_INFINITY])
      expect(counterfactual(t, a)?.choice, String(a)).toBe("haiku");
  });

  it("flags a top-two margin under 0.03 as uncertain, at 0.03 and above it is not", () => {
    expect(UNCERTAIN_MARGIN).toBe(0.03);
    const near = counterfactual(tableOf("role", { coder: 0.51, architect: 0.49 }), 0);
    expect(near?.uncertain).toBe(true);
    expect(near?.margin).toBeCloseTo(0.02, 10);
    const clear = counterfactual(tableOf("role", { coder: 0.53, architect: 0.47 }), 0);
    expect(clear?.margin).toBeCloseTo(0.06, 10);
    expect(clear?.uncertain).toBe(false);
  });

  it("a tier confidence within the band of lowConfidence is uncertain; outside it is not", () => {
    expect(CONF_BAND).toBe(0.015);
    // margin 0.10 gives confidence 0.55 exactly: the round-up could go either way
    const edge = counterfactual(tableOf("tier", { haiku: 0.55, sonnet: 0.45 }), 0, {}, tier);
    expect(edge?.uncertain).toBe(true);
    // margin 0.14 gives 0.57, 0.02 away: certain, not rounded up
    const above = counterfactual(tableOf("tier", { haiku: 0.57, sonnet: 0.43 }), 0, {}, tier);
    expect(above?.confidence).toBeCloseTo(0.57, 10);
    expect(above?.uncertain).toBe(false);
    expect(above?.roundedUp).toBe(false);
    // margin 0.06 gives 0.53, 0.02 under: certain and rounded up one step
    const below = counterfactual(tableOf("tier", { haiku: 0.53, sonnet: 0.47 }), 0, {}, tier);
    expect(below?.uncertain).toBe(false);
    expect(below?.roundedUp).toBe(true);
    expect(below?.choice).toBe("sonnet");
    expect(below?.top).toBe("haiku");
  });

  it("the band only applies to the tier: role and tool have no round-up", () => {
    const role = counterfactual(tableOf("role", { coder: 0.55, architect: 0.45 }), 0);
    expect(role?.uncertain).toBe(false);
    expect(role?.roundedUp).toBe(false);
  });

  it("does not round up past the top of the ladder or off the ladder", () => {
    const top = counterfactual(tableOf("tier", { opus: 0.52, sonnet: 0.48 }), 0, {}, tier);
    expect(top?.roundedUp).toBe(false);
    expect(top?.choice).toBe("opus");
    const offLadder = counterfactual(tableOf("tier", { x: 0.52, y: 0.48 }), 0, {}, tier);
    expect(offLadder?.choice).toBe("x");
  });

  it("follows the configured ladder when rounding up", () => {
    const t = tableOf("tier", { haiku: 0.52, opus: 0.48 });
    const cf = counterfactual(t, 0, {}, { tiers: ["haiku", "opus"], lowConfidence });
    expect(cf?.choice).toBe("opus");
  });
});

// --- classification --------------------------------------------------------------------------

describe("statusClass: the fallback taxonomy for every provider status", () => {
  const table: Array<[ProviderStatus, string]> = [
    ["ok", "skipped"],
    ["skipped", "skipped"],
    ["n/a", "skipped"],
    ["breaker_open", "guard"],
    ["slow_guard", "guard"],
    ["over_budget", "guard"],
    ["auth_failed", "guard"],
    ["timeout", "error"],
    ["http_error", "error"],
    ["rate_limited", "error"],
    ["invalid", "error"],
    ["no_key", "config"],
    ["no_consent", "config"],
  ];

  it("maps all 13 statuses", () => {
    expect(table).toHaveLength(13);
    for (const [status, cls] of table) expect(statusClass(status), status).toBe(cls);
  });

  it("maps unknown, empty and missing values to skipped", () => {
    for (const s of ["", "future_state", null, undefined] as const)
      expect(statusClass(s as never)).toBe("skipped");
  });

  it("tags every fallback status on a seeded db as the class counted", () => {
    for (const [status] of table) put(fallbackRow(status));
    const by = report().coverage.byClass;
    expect(by).toMatchObject({ skipped: 3, guard: 4, error: 4, config: 2 });
    expect(by.applied + by.cache + by.deferred).toBe(0);
  });
});

describe("viewOf", () => {
  const rowOf = (cols: AdjudicationInput, over: Partial<AdjudicationRow> = {}): AdjudicationRow =>
    ({
      id: 1,
      ts: POST,
      outcome: "pending",
      final: false,
      provider: "typesafe",
      ...cols,
      ...over,
    }) as AdjudicationRow;

  it("reads class, final and heuristic-alone picks, and no text", () => {
    const v = viewOf(rowOf(applied("down")), CFG);
    expect(v).toMatchObject({
      cls: "applied",
      scored: true,
      dir: -1,
      model: "jev-1.14.0",
      tier: { final: "sonnet", cf: "opus", uncertain: false, jev: "sonnet" },
    });
    expect(Object.keys(v)).not.toContain("inputHead");
  });

  it("uses the default lowConfidence (the blend default) when the config has none", () => {
    // a heuristic table whose confidence is just under the default 0.55 is rounded up
    const rowWithRoundUp = rowOf(
      stored(hset({ haiku: 0.53, sonnet: 0.47 }), { tier: { haiku: 1 }, tierConf: 0.2 }),
    );
    const withDefault = viewOf(rowWithRoundUp, { tiers: TIERS3 });
    const explicit = viewOf(rowWithRoundUp, {
      tiers: TIERS3,
      weights: { lowConfidence: BLEND_DEFAULTS.lowConfidence },
    });
    expect(withDefault.tier).toEqual(explicit.tier);
    expect(withDefault.tier?.cfRoundedUp).toBe(true);
    // the copy is blend's real default, not a number written into this test (review-jev2 J9)
    expect(LOW_CONFIDENCE_DEFAULT).toBe(BLEND_DEFAULTS.lowConfidence);
  });

  it("marks eras: scored per statement (units) vs as one text", () => {
    const units = patchScores(applied("agree", { surface: "plan" }), { units: { statements: 2 } });
    put(units);
    put(applied("agree", { surface: "plan" }));
    put(applied("agree", { surface: "agent" }));
    put(applied("agree", { surface: "prompt" })); // prompt rows have no era
    expect(report().sample.eras).toEqual({ units: 1, wholeText: 2 });
    expect(report().verdict.warnings.some((w) => w.includes("mixed"))).toBe(true);
  });
});

// --- blend-induced round-ups ------------------------------------------------------------------

describe("a blend that makes a near tie and rounds the tier up (row-189 type)", () => {
  // Heuristic: haiku 0.95. Jev: sonnet at α 0.5. The blend is 0.475 vs 0.520: a near tie whose
  // confidence is under lowConfidence, so the tier goes up to opus: two steps from the heuristic.
  const row189 = () =>
    stored(hset({ haiku: 0.95, sonnet: 0.04, opus: 0.01 }), { tier: { sonnet: 1 }, tierConf: 0.5 });

  it("is a two-step move up, counted as a blend-induced round-up", () => {
    const cols = row189();
    expect(cols.tier).toBe("opus");
    put({ ...cols, ts: POST, provider: "typesafe", source: "blend", providerStatus: "ok" });
    const t = report().influence.tier;
    expect(t.up).toBe(1);
    expect(t.transitions).toEqual([{ from: "haiku", to: "opus", n: 1 }]);
    expect(t.roundUps).toEqual({ final: 1, counterfactual: 0, blendInduced: 1 });
  });

  it("warns once at least 3 such rows are 10% or more of the compared decisions", () => {
    for (let i = 0; i < 3; i++)
      put({ ...row189(), ts: POST, provider: "typesafe", source: "blend", providerStatus: "ok" });
    for (let i = 0; i < 27; i++) put(applied("agree"));
    const w = report().verdict.warnings;
    expect(w.some((x) => x.includes("3 near-ties that rounded the tier up"))).toBe(true);
    // 3 of 33 compared is under 10%: no warning
    for (let i = 0; i < 3; i++) put(applied("agree"));
    expect(report().verdict.warnings.some((x) => x.includes("near-ties"))).toBe(false);
  });
});

// --- the failure warning --------------------------------------------------------------------

describe("failure-rate warning", () => {
  it("needs both a rate over 20% and at least 20 attempts", () => {
    for (let i = 0; i < 4; i++) put(fallbackRow("timeout"));
    for (let i = 0; i < 15; i++) put(applied("agree"));
    // 4 of 19 attempts
    expect(report().verdict.warnings.some((w) => w.startsWith("Jev failed"))).toBe(false);
    for (let i = 0; i < 1; i++) put(fallbackRow("timeout"));
    // 5 of 20 = 25%
    const r = report();
    expect(r.coverage.attempts).toBe(20);
    expect(r.verdict.warnings).toContain("Jev failed 25% of calls; the heuristic answered");
  });
});

// --- savings --------------------------------------------------------------------------------

describe("repriceByRatio", () => {
  const pricing = {
    small: { input: 1, output: 5, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1 },
    mid: { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 },
    // a cache read price that is not proportional to the others
    odd: { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.25 },
  };

  it("scales by the input price ratio when every component is proportional", () => {
    expect(repriceByRatio(0.18, "x-mid-1", "small", pricing)).toBeCloseTo(0.06, 10);
    expect(repriceByRatio(0.06, "x-small-1", "mid", pricing)).toBeCloseTo(0.18, 10);
    expect(repriceByRatio(1, "x-mid-1", "mid", pricing)).toBeCloseTo(1, 10);
  });

  it("is null when prices are not proportional within 1%", () => {
    expect(repriceByRatio(1, "x-mid-1", "odd", pricing)).toBeNull();
    expect(repriceByRatio(1, "x-odd-1", "small", pricing)).toBeNull();
  });

  it("is null when either model has no price", () => {
    expect(repriceByRatio(1, "totally-unknown-model", "small", pricing)).toBeNull();
    expect(repriceByRatio(1, "x-mid-1", "unknown", pricing)).toBeNull();
  });

  it("tolerates a component that is off by less than 1%", () => {
    const near = {
      ...pricing,
      mid: { ...pricing.mid, cacheRead: 0.3 * 1.005 },
    };
    expect(repriceByRatio(1, "x-mid-1", "small", near)).not.toBeNull();
    const far = { ...pricing, mid: { ...pricing.mid, cacheRead: 0.3 * 1.05 } };
    expect(repriceByRatio(1, "x-mid-1", "small", far)).toBeNull();
  });
});

describe("savings: what Jev's tier changes cost or saved", () => {
  const pricing = {
    haiku: { input: 1, output: 5, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1 },
    sonnet: { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 },
    opus: { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  };
  const credited = (kind: Kind, model: string, cost: number, over = {}) =>
    dispatch(kind, "success", {
      actualModel: model,
      actualCostUsd: cost,
      savingsUsd: 0.01,
      ...over,
    });
  const run = (rows: AdjudicationInput[], usage = true) => {
    rows.forEach(put);
    return jevImpact(
      { adjudicator: db.adjudicator, apiCallsLatestTs: () => (usage ? NOW : undefined) },
      { since: SINCE },
      { config: CFG, now: NOW, pricing },
    );
  };

  it("a move down that ran on the cheaper model saved the difference; a move up cost it", () => {
    // down: heuristic opus, Jev sonnet: ran on sonnet for 0.18; on opus it would cost 0.30
    // up: heuristic haiku, Jev sonnet: ran on sonnet for 0.18; on haiku it would cost 0.06
    const r = run([
      credited("down", "claude-sonnet-x", 0.18),
      credited("up1", "claude-sonnet-x", 0.18),
    ]);
    const s = r.savings;
    expect(s.usageAvailable).toBe(true);
    expect(s.repriced).toBe(2);
    expect(s.unpriced).toBe(0);
    expect(s.downSavedUsd).toBeCloseTo(0.12, 6);
    expect(s.upCostUsd).toBeCloseTo(0.12, 6);
    expect(s.deltaUsd).toBeCloseTo(0, 6);
    // net subtracts Jev's own spend (0.001 per applied row)
    expect(s.netUsd).toBeCloseTo(0 - 0.002, 6);
  });

  it("a net below zero is a warning, and only when something was repriced", () => {
    const worse = run([credited("up1", "claude-sonnet-x", 0.18)]);
    expect(worse.savings.deltaUsd).toBeCloseTo(-0.12, 6);
    expect(worse.verdict.warnings).toContain("Jev's tier changes saved less than Jev cost");
  });

  it("is unpriced when the prices are not proportional or the model is unknown", () => {
    const r = run([
      credited("down", "mystery-model", 0.18),
      credited("down", "claude-sonnet-x", 0.18),
    ]);
    expect(r.savings.unpriced).toBe(1);
    expect(r.savings.repriced).toBe(1);
  });

  it("only credited dispatches with a cost and a model are repriced", () => {
    const r = run([
      dispatch("down", "success", { actualModel: "claude-sonnet-x", actualCostUsd: 0.18 }), // no savings credit
      dispatch("down", "success", { savingsUsd: 0.01 }), // no cost, no model
    ]);
    expect(r.savings.repriced + r.savings.unpriced).toBe(0);
    expect(r.savings.netUsd).toBeCloseTo(-0.002, 6);
    expect(r.verdict.warnings).not.toContain("Jev's tier changes saved less than Jev cost");
  });

  it("without usage nothing is repriced and the assumptions say so", () => {
    const r = run([credited("down", "claude-sonnet-x", 0.18)], false);
    expect(r.savings.usageAvailable).toBe(false);
    expect(r.savings.assumptions.some((a) => a.includes("No API calls are recorded"))).toBe(true);
    expect(r.verdict.warnings).toContain("no usage data: savings cannot be repriced");
  });
});

// --- a stub db: paging, cap, fail-soft ----------------------------------------------------------

function agentRow(id: number, over: Partial<AdjudicationRow> = {}): AdjudicationRow {
  return {
    id,
    ts: POST + id,
    surface: "agent",
    inputHash: "h",
    provider: "typesafe",
    source: "fallback",
    providerStatus: "skipped",
    outcome: "pending",
    final: false,
    ...over,
  } as AdjudicationRow;
}

interface StubOpts {
  get?: (id: number) => AdjudicationRow | undefined;
  list?: (filter: Record<string, unknown>) => void;
  state?: { state: string };
}

/** A JevDb over fixed rows with the store's paging (limit/offset over oldest-or-newest order). */
function stubDb(rows: AdjudicationRow[], o: StubOpts = {}) {
  return {
    adjudicator: {
      list: (filter: Record<string, unknown> = {}) => {
        o.list?.(filter);
        const limit = (filter.limit as number | undefined) ?? 50;
        const offset = (filter.offset as number | undefined) ?? 0;
        return { rows: rows.slice(offset, offset + limit), total: rows.length };
      },
      get: (id: number) => o.get?.(id),
      providerState: () => o.state,
    },
    apiCallsLatestTs: () => undefined,
  };
}

describe("reading limits", () => {
  it("pages through the store 500 rows at a time and caps at JEV_ROWS_MAX", () => {
    expect(JEV_ROWS_MAX).toBe(20_000);
    const rows = Array.from({ length: 20_300 }, (_, i) => agentRow(i + 1));
    const seen: Array<Record<string, unknown>> = [];
    const r = jevImpact(stubDb(rows, { list: (f) => seen.push(f) }), {}, { config: CFG, now: NOW });
    expect(seen).toHaveLength(40);
    expect(seen.every((f) => f.limit === 500 && f.provider === "typesafe")).toBe(true);
    expect(seen.map((f) => f.offset)).toEqual(Array.from({ length: 40 }, (_, i) => i * 500));
    expect(r.sample.capped).toBe(true);
    expect(r.sample.rows).toBe(20_000);
    expect(r.verdict.warnings).toContain("only the first 20000 rows were read");
  });

  it("stops at the last page and does not flag a short read as capped", () => {
    const rows = Array.from({ length: 1_203 }, (_, i) => agentRow(i + 1));
    const seen: unknown[] = [];
    const r = jevImpact(stubDb(rows, { list: (f) => seen.push(f) }), {}, { config: CFG, now: NOW });
    expect(seen).toHaveLength(3);
    expect(r.sample.rows).toBe(1_203);
    expect(r.sample.capped).toBe(false);
  });

  it("passes the window's since to the store and omits it for all", () => {
    const seen: Array<Record<string, unknown>> = [];
    const d = stubDb([], { list: (f) => seen.push(f) });
    jevImpact(d, { since: 123 }, { config: CFG, now: NOW });
    jevImpact(d, {}, { config: CFG, now: NOW });
    expect(seen[0]?.since).toBe(123);
    expect(seen[1]).not.toHaveProperty("since");
  });

  it("reports an empty database as an empty, valid report", () => {
    const r = report();
    expect(r.sample.rows).toBe(0);
    expect(r.influence.tier).toMatchObject({ compared: 0, agree: 0, up: 0, down: 0 });
    expect(r.coverage.failureRate).toBeNull();
    expect(r.cost).toMatchObject({ spendUsd: 0, calls: 0, usdPerCall: null });
    expect(r.cost.providerLatency).toEqual({ n: 0, p50: null, p95: null });
    expect(r.verdict.label).toBe("not enough data");
    expect(r.now).toBe(NOW);
  });

  it("aggregates thousands of rows well inside a generous bound", () => {
    const rows = Array.from({ length: 5_000 }, (_, i) =>
      agentRow(i + 1, { surface: i % 2 ? "agent" : "prompt" }),
    );
    const t0 = performance.now();
    const r = impactReport(rows, [], {}, { config: CFG, now: NOW });
    expect(r.sample.rows).toBe(5_000);
    expect(performance.now() - t0).toBeLessThan(2_000);
  });
});

describe("impactReport input handling", () => {
  it("takes parents as an array or a map and applies the since window to rows", () => {
    const parent = {
      ...agentRow(1, { surface: "plan", tier: "sonnet" }),
      ...applied("up1", { surface: "plan" }),
      id: 1,
    } as AdjudicationRow;
    const child = agentRow(2, { parentId: 1, tier: "sonnet" });
    const asArray = impactReport([child], [parent], {}, { config: CFG, now: NOW });
    const asMap = impactReport([child], new Map([[1, parent]]), {}, { config: CFG, now: NOW });
    expect(asArray.influence.tier.up).toBe(1);
    expect(asMap).toEqual(asArray);
    const windowed = impactReport(
      [child],
      [parent],
      { since: child.ts + 1 },
      { config: CFG, now: NOW },
    );
    expect(windowed.sample.rows).toBe(0);
  });

  it("ignores test rows and other providers", () => {
    const rows = [
      agentRow(1, { surface: "test" }),
      agentRow(2, { provider: "heuristic" }),
      agentRow(3),
    ];
    expect(impactReport(rows, [], {}, { config: CFG, now: NOW }).sample.rows).toBe(1);
  });
});

// --- review-jev F2, F3, F4, F7, F9 regressions ---------------------------------------------------

describe("the verdict states what its evidence covers (review-jev F2)", () => {
  it("10 successful downgrades and 40 successful upgrades: the 40 are named, not hidden", () => {
    for (let i = 0; i < 10; i++) put(dispatch("down", "success", { action: "applied" }));
    for (let i = 0; i < 40; i++) put(dispatch("up1", "success", { action: "applied" }));
    const r = report();
    const v = r.verdict;
    expect(r.outcomes.evidence).toMatchObject({ help: 10, hurt: 0, neutral: 40 });
    // An upgrade that finished cannot show the smaller tier would have failed: still helping on
    // the downgrades, but the line says the upgrades were not counted and why.
    expect(v.label).toBe("helping");
    expect(v.changed).toBe(50);
    expect(v.upgrades).toEqual({ counted: 0, notCounted: 40 });
    const text = v.reasons.join(" | ");
    expect(text).toContain("10 of 50 dispatches Jev changed have a counted label");
    expect(text).toContain("upgrades count only through feedback");
    expect(text).toContain("40 that only finished or failed not counted");
    // reasons[0] is still the deciding sentence
    expect(v.reasons[0]).toContain("10 of 10 labelled outcomes");
  });

  it("feedback on an upgrade counts, and is reported as counted", () => {
    fill(20);
    for (let i = 0; i < 9; i++) put(dispatch("up1", "help_up", { action: "applied" }));
    put(dispatch("up1", "hurt_up", { action: "applied" }));
    put(dispatch("up1", "success", { action: "applied" }));
    const v = report().verdict;
    expect(v.upgrades).toEqual({ counted: 10, notCounted: 1 });
    expect(v.n).toBe(10);
    expect(v.reasons.join(" | ")).toContain("10 counted, 1 that only finished or failed");
  });

  it("the rule sentence says how each direction is judged", () => {
    expect(VERDICT_RULE).toContain("moved down counts as help when the cheaper model finished");
    expect(VERDICT_RULE).toContain("moved up counts only through feedback");
  });

  it("verdictScope is null with nothing changed, and plain without upgrades", () => {
    expect(verdictScope({ n: 0, changed: 0, upgrades: { counted: 0, notCounted: 0 } })).toBeNull();
    expect(verdictScope({ n: 3, changed: 7, upgrades: { counted: 0, notCounted: 0 } })).toBe(
      "3 of 7 dispatches Jev changed have a counted label",
    );
    // verdictOf without the scope inputs keeps the old reasons exactly
    expect(verdictOf({ help: 9, hurt: 0, compared: 100, units: 3 }).reasons).toHaveLength(1);
  });
});

describe("round-up counts only on certain reconstructions that moved the tier (review-jev F3)", () => {
  const blendRow = (cols: AdjudicationInput) => ({
    ...cols,
    ts: POST,
    provider: "typesafe" as const,
    source: "blend" as const,
    providerStatus: "ok" as const,
  });

  it("a round-up that lands back on the heuristic's tier is not blend-induced (rows 236/249)", () => {
    // Heuristic opus 0.6 (confident); Jev sonnet at α 0.24 makes a near tie on sonnet, which
    // rounds up to opus: the heuristic's own pick.
    const cols = stored(hset({ opus: 0.6, sonnet: 0.35, haiku: 0.05 }), {
      tier: { sonnet: 1 },
      tierConf: 0.24,
    });
    expect(cols.tier).toBe("opus");
    put(blendRow(cols));
    const t = report().influence.tier;
    expect(t.uncertain).toBe(0);
    expect(t.agree).toBe(1);
    expect(t.roundUps).toEqual({ final: 1, counterfactual: 0, blendInduced: 0 });
  });

  it("an uncertain reconstruction counts in neither the blend-induced nor the heuristic round-ups", () => {
    // review-jev p2: the heuristic alone rounds up (true confidence 0.549) but the reconstruction
    // reads 0.552, inside CONF_BAND, so it is uncertain and must not be called blend-induced.
    const h = hset({
      haiku: 0.3471693992614746,
      sonnet: 0.4455795347473668,
      opus: 0.2072510659911586,
    });
    const cols = stored(h, {
      tier: { haiku: 0.5770994866759188, sonnet: 0.33160450819185755, opus: 0.09129600513222359 },
      tierConf: 0.3904333233833313,
    });
    put(blendRow(cols));
    const t = report().influence.tier;
    expect(t.uncertain).toBe(1);
    expect(t.roundUps).toEqual({ final: 1, counterfactual: 0, blendInduced: 0 });
    // the heuristic alone really does round up here
    const alone = blend(h, undefined, {}, {}, { key: "k", provider: "typesafe", tiers: TIERS3 });
    const chosen = alone.tier.entries.find((e) => e.option === alone.tier.choice);
    expect(chosen?.reasons.some((x) => x.feature === "lowConfidence")).toBe(true);
  });

  it("an uncertain row whose heuristic would round up is left out of the counterfactual count", () => {
    // haiku 0.5 / sonnet 0.49: a near tie in the heuristic's own table.
    const cols = KINDS.uncertain();
    put(blendRow(cols));
    const t = report().influence.tier;
    expect(t.uncertain).toBe(1);
    expect(t.roundUps.counterfactual).toBe(0);
  });

  it("the hinder warning ignores such rows", () => {
    for (let i = 0; i < 5; i++)
      put(
        blendRow(
          stored(hset({ opus: 0.6, sonnet: 0.35, haiku: 0.05 }), {
            tier: { sonnet: 1 },
            tierConf: 0.24,
          }),
        ),
      );
    expect(report().verdict.warnings.some((w) => w.includes("near-ties"))).toBe(false);
  });
});

describe("uncertain rows do not fill the compared minimum (review-jev F4)", () => {
  it("20 uncertain near-ties and 10 labelled changes are not enough data", () => {
    for (let i = 0; i < 20; i++) put(applied("uncertain"));
    for (let i = 0; i < 10; i++) put(dispatch("up1", "help_up", { action: "applied" }));
    const r = report();
    expect(r.influence.tier).toMatchObject({ compared: 30, uncertain: 20, up: 10 });
    expect(r.verdict.compared).toBe(10);
    expect(r.verdict.n).toBe(10);
    expect(r.verdict.label).toBe("not enough data");
    expect(r.verdict.reasons[0]).toBe(
      `10 compared plan or agent decisions (prompts and cache hits not counted); need ${MIN_COMPARED}`,
    );
    // with 20 certain agreements instead, the same evidence decides
    fill(20);
    expect(report().verdict.label).toBe("helping");
  });

  it("the Jev calls tile counts calls that did not answer (10 answered + 90 timeouts)", () => {
    for (let i = 0; i < 10; i++) put(applied("agree"));
    for (let i = 0; i < 90; i++) put(fallbackRow("timeout"));
    const r = report();
    expect(r.coverage).toMatchObject({ attempts: 100, errors: 90, failureRate: 0.9 });
    expect(r.cost.calls).toBe(10);
    const tile = kpiRows(r, "closed")[2];
    expect(tile?.value).toBe("100");
    expect(tile?.sub).toContain("10 answered");
    expect(tile?.sub).toContain("failure 90%");
  });
});

describe("the score-scale cutoff (review-jev F9)", () => {
  it("reads a stored scorer version above 1 as fixed, whatever the time", () => {
    expect(scoreScaleFixed({ ts: PRE_FIX, version: "2" })).toBe(true);
    expect(scoreScaleFixed({ ts: PRE_FIX, version: "1" })).toBe(false);
    expect(scoreScaleFixed({ ts: PRE_FIX, version: null })).toBe(false);
    expect(scoreScaleFixed({ ts: PRE_FIX, version: "bogus" })).toBe(false);
    expect(scoreScaleFixed({ ts: JEV_SCORE_FIX_TS, version: "1" })).toBe(true);
    expect(scoreScaleFixed({ ts: JEV_SCORE_FIX_TS - 1 })).toBe(false);
  });

  it("keeps an early row of a later scorer version in the complexity and effort deltas", () => {
    const cols = stored(hset({ sonnet: 0.8, haiku: 0.15, opus: 0.05 }, { complexity: 1 }), {
      tier: { sonnet: 1 },
      complexity: { value: 3, confidence: 0.8 },
    });
    const base = {
      ...cols,
      provider: "typesafe" as const,
      source: "blend" as const,
      providerStatus: "ok" as const,
    };
    put({ ...base, ts: PRE_FIX, version: "2" });
    put({ ...base, ts: PRE_FIX, version: "1" });
    const c = report({}).influence;
    expect(c.complexity.n).toBe(1);
    expect(c.complexity.excludedBeforeFix).toBe(1);
    expect(c.effort.compared).toBe(1);
  });
});

describe("each row's scores JSON is parsed once per report (review-jev F7)", () => {
  it("a swarm task (plan row + agent dispatch) parses each row at most once in the report", () => {
    const rows: AdjudicationRow[] = [];
    const tasks = 50;
    for (let i = 0; i < tasks; i++) {
      const plan = {
        ...applied("down", { surface: "plan", runId: "R", taskId: i }),
        id: 2 * i + 1,
      } as AdjudicationRow;
      rows.push(plan, {
        ...agentRow(2 * i + 2, {
          parentId: plan.id,
          tier: plan.tier ?? null,
          runId: "R",
          taskId: i,
        }),
        action: "applied",
        scores: JSON.stringify({ advisedPick: plan.tier }),
      } as AdjudicationRow);
    }
    const spy = vi.spyOn(JSON, "parse");
    try {
      const r = impactReport(rows, [], {}, { config: CFG, now: NOW });
      expect(r.influence.effective.dispatches).toBe(tasks);
      // One parse per row here, plus at most one per dispatch in storage/dispatch.ts (keptModel).
      // Before the memo it was three per plan row and two per agent row.
      expect(spy.mock.calls.length).toBeLessThanOrEqual(rows.length + tasks);
    } finally {
      spy.mockRestore();
    }
  });

  it("re-parses a row whose scores were replaced", () => {
    const row = { ...applied("down"), id: 1 } as AdjudicationRow;
    expect(viewOf(row, CFG).tier?.final).toBe("sonnet");
    row.scores = applied("up2").scores ?? null;
    expect(viewOf(row, CFG).tier?.final).toBe("opus");
  });
});

// --- review-jev2 J1-J6 regressions ---------------------------------------------------------------

describe("feedback on a dispatch that did not run Jev's tier counts neither way (review-jev2 J1)", () => {
  // 20 agreeing dispatches + 10 Jev changed, each in its own session, so only J1 decides.
  const ranOpus = { modelRequested: "opus", actualModel: "claude-opus-4-1" };
  const cases: Array<[string, Kind, Partial<AdjudicationInput>]> = [
    [
      "A1: Jev moved opus -> sonnet, ignored, opus ran, good",
      "down",
      { action: "ignored", ...ranOpus, outcome: "success", outcomeSource: "feedback:good" },
    ],
    [
      "A2: Jev moved haiku -> sonnet, ignored, opus ran, too big",
      "up1",
      { action: "ignored", ...ranOpus, outcome: "success", outcomeSource: "feedback:too_big" },
    ],
    [
      "A3: Jev moved opus -> sonnet, ignored, haiku ran, too small",
      "down",
      {
        action: "ignored",
        modelRequested: "haiku",
        actualModel: "claude-haiku-4-5",
        outcome: "failure",
        outcomeSource: "feedback:too_small",
      },
    ],
    [
      "A4: advise mode, no model passed, the baseline opus ran, good",
      "down",
      {
        action: "advised",
        modelRequested: null,
        baselineModel: "claude-opus-4-1",
        actualModel: "claude-opus-4-1",
        outcome: "success",
        outcomeSource: "feedback:good",
      },
    ],
  ];
  for (const [name, kind, over] of cases)
    it(name, () => {
      fill(20);
      for (let i = 0; i < 10; i++) put(dispatch(kind, undefined, over));
      const r = report();
      expect(r.outcomes.evidence).toMatchObject({ help: 0, hurt: 0, neutral: 0 });
      expect(r.outcomes.excluded.notRun).toBe(10);
      expect(r.verdict.label).toBe("not enough data");
      expect(r.verdict.upgrades).toEqual({ counted: 0, notCounted: 0 });
    });

  it("the same feedback on a dispatch that ran Jev's tier still counts", () => {
    fill(20);
    for (let i = 0; i < 10; i++)
      put(
        dispatch("down", undefined, {
          action: "followed",
          modelRequested: "sonnet",
          actualModel: "claude-sonnet-4-5",
          outcome: "success",
          outcomeSource: "feedback:good",
        }),
      );
    const r = report();
    expect(r.outcomes.evidence).toMatchObject({ help: 10, hurt: 0 });
    expect(r.verdict.label).toBe("helping");
  });
});

describe("only final reconcile outcomes are evidence (review-jev2 J2)", () => {
  it("10 applied downgrades whose success is not final yet give no evidence and are counted apart", () => {
    fill(20);
    for (let i = 0; i < 10; i++)
      put(
        dispatch("down", undefined, {
          actualModel: "claude-sonnet-4-5",
          outcome: "success",
          outcomeSource: "swarm",
          final: false,
        }),
      );
    const r = report();
    expect(r.outcomes.evidence).toMatchObject({ help: 0, hurt: 0, neutral: 0 });
    expect(r.outcomes.excluded.notFinal).toBe(10);
    expect(r.outcomes.excluded.notRun).toBe(0);
    expect(r.outcomes.changed).toMatchObject({ dispatches: 10, final: 0, success: 0 });
    expect(r.verdict.label).toBe("not enough data");
  });

  it("the same rows once final decide the verdict", () => {
    fill(20);
    for (let i = 0; i < 10; i++)
      put(
        dispatch("down", undefined, {
          actualModel: "claude-sonnet-4-5",
          outcome: "success",
          outcomeSource: "swarm",
          final: true,
        }),
      );
    const r = report();
    expect(r.outcomes.evidence.help).toBe(10);
    expect(r.outcomes.excluded.notFinal).toBe(0);
    expect(r.verdict.label).toBe("helping");
  });

  it("a non-final row that did not run the advice counts as not run, not twice", () => {
    put(
      dispatch("down", "success", {
        action: "ignored",
        modelRequested: "opus",
        actualModel: "claude-opus-4-1",
        final: false,
      }),
    );
    expect(report().outcomes.excluded).toMatchObject({ notRun: 1, notFinal: 0 });
  });
});

describe("today's apply bounds never clamp the heuristic's tier (review-jev2 J3)", () => {
  const advisedScores = (pick: Tier): string =>
    patchScores(KINDS.down(), { advisedPick: pick }).scores as string;

  it("a dispatch whose pick equals the verdict and today's ceiling would clamp the heuristic is left out", () => {
    // raw sonnet = pick sonnet, heuristic opus: whether a ceiling sonnet held then is not stored
    for (let i = 0; i < 10; i++)
      put(
        dispatch("down", "success", {
          scores: advisedScores("sonnet"),
          actualModel: "claude-sonnet-4-5",
        }),
      );
    const r = report({ since: SINCE }, { config: { ...CFG, apply: { ceiling: "sonnet" } } });
    expect(r.influence.effective).toMatchObject({ dispatches: 0, changed: 0, unknown: 10 });
    expect(r.outcomes.excluded).toMatchObject({ bounds: 10, unknown: 0 });
    expect(r.outcomes.unchanged.dispatches).toBe(0);
  });

  it("the default ceiling (opus) marks a heuristic fable the same way", () => {
    expect(
      effectivePick({
        raw: "opus",
        pick: "opus",
        cf: "fable",
        ranged: false,
        possible: [{}, DEFAULT_APPLY_BOUNDS],
      }),
    ).toBe("bounds");
  });

  it("effectivePick clamps with bounds only when they are known", () => {
    const i = { raw: "sonnet", pick: "sonnet" as Tier, cf: "opus", ranged: false };
    expect(effectivePick({ ...i, possible: [{ ceiling: "sonnet" }] })).toBe("bounds");
    expect(effectivePick({ ...i, bounds: { ceiling: "sonnet" } })).toEqual({
      final: "sonnet",
      cf: "sonnet",
    });
    expect(effectivePick({ ...i, possible: [{}, DEFAULT_APPLY_BOUNDS] })).toEqual({
      final: "sonnet",
      cf: "opus",
    });
    // no pick stored: a raw tier the bounds would move is just as unknown
    expect(
      effectivePick({
        raw: "fable",
        pick: undefined,
        cf: "opus",
        ranged: false,
        possible: [DEFAULT_APPLY_BOUNDS],
      }),
    ).toBe("bounds");
  });

  it("the assumption is stated", () => {
    expect(report().savings.assumptions.join(" ")).toContain(
      "apply bounds a dispatch ran under are not stored",
    );
  });
});

describe("the minimums guard the dispatch evidence (review-jev2 J4)", () => {
  /** A swarm task: a Jev plan row and its agent dispatch, in run `run`. */
  function task(kind: Kind, run: string, t: number, agent: Partial<AdjudicationInput> = {}) {
    const swarm = { runId: run, taskId: t };
    const planId = put(applied(kind, { surface: "plan", ...swarm, sessionId: `coord-${run}` }));
    const plan = db.adjudicator.get(planId) as AdjudicationRow;
    put({
      ...KINDS.agree(),
      surface: "agent",
      ts: POST,
      tier: plan.tier ?? null,
      role: "coder",
      parentId: planId,
      provider: "typesafe",
      source: "fallback",
      providerStatus: "skipped",
      action: "applied",
      final: true,
      ...swarm,
      sessionId: `worker-${run}-${t}`,
      ...agent,
    });
  }
  const success = {
    actualModel: "claude-sonnet-4-5",
    outcome: "success",
    outcomeSource: "swarm",
  } as const;

  it("20 agreeing prompts do not fill the compared minimum", () => {
    for (let i = 0; i < 20; i++) put(applied("agree"));
    for (let i = 0; i < 10; i++)
      put(dispatch("down", "success", { actualModel: "claude-sonnet-4-5" }));
    const v = report().verdict;
    expect(v).toMatchObject({ help: 10, n: 10, compared: 10, units: 10 });
    expect(v.label).toBe("not enough data");
    expect(v.reasons[0]).toContain("10 compared plan or agent decisions");
  });

  it("cache hits do not fill it either", () => {
    for (let i = 0; i < 20; i++)
      put(dispatch("agree", undefined, { source: "cache", latencyMs: 2, providerLatencyMs: null }));
    for (let i = 0; i < 10; i++)
      put(dispatch("down", "success", { actualModel: "claude-sonnet-4-5" }));
    const r = report();
    expect(r.influence.tier.compared).toBe(30);
    expect(r.verdict.compared).toBe(10);
    expect(r.verdict.label).toBe("not enough data");
  });

  it("one swarm run alone cannot reach 'helping', however many tasks it has", () => {
    for (let t = 1; t <= 20; t++) task("agree", "R1", t);
    for (let t = 21; t <= 32; t++) task("down", "R1", t, success);
    const v = report().verdict;
    expect(v).toMatchObject({ help: 12, hurt: 0, compared: 32, units: 1 });
    expect(v.label).toBe("not enough data");
    expect(v.reasons).toContain(
      `labelled outcomes come from 1 distinct swarm runs or sessions; need ${MIN_UNITS}`,
    );
  });

  it("the same evidence spread over three runs decides", () => {
    for (let t = 1; t <= 20; t++) task("agree", "R1", t);
    for (let t = 21; t <= 32; t++) task("down", `R${(t % 3) + 1}`, t, success);
    const v = report().verdict;
    expect(v).toMatchObject({ help: 12, units: 3 });
    expect(v.label).toBe("helping");
    expect(v.reasons[0]).toContain("from 3 swarm runs or sessions");
  });

  it("dispatches that name no run and no session share one unit", () => {
    fill(20);
    for (let i = 0; i < 12; i++)
      put(dispatch("down", "success", { actualModel: "claude-sonnet-4-5", sessionId: null }));
    const v = report().verdict;
    expect(v.units).toBe(1);
    expect(v.label).toBe("not enough data");
  });

  it("unitOf: the run wins over the session, the decision row fills in, neither is one unit", () => {
    expect(unitOf({ runId: "R", sessionId: "S" })).toBe("run:R");
    expect(unitOf({ sessionId: "S" })).toBe("session:S");
    expect(unitOf({ sessionId: "S" }, { runId: "P" })).toBe("run:P");
    expect(unitOf({}, { sessionId: "T" })).toBe("session:T");
    expect(unitOf({ runId: null, sessionId: null })).toBe("unknown");
  });
});

describe("a round-up that lands on Jev's own pick is not blend-induced (review-jev2 J5)", () => {
  it("heuristic sonnet, Jev opus at low confidence, final opus via the round-up: no warning", () => {
    const cols = () =>
      stored(hset({ sonnet: 0.7, opus: 0.28, haiku: 0.02 }), {
        tier: { opus: 1 },
        tierConf: 0.25,
      });
    const probe = cols();
    expect(probe.tier).toBe("opus");
    for (let i = 0; i < 3; i++) put(applied("agree", { ...cols() }));
    for (let i = 0; i < 27; i++) put(applied("agree"));
    const r = report();
    const v = viewOf(rowOfInput(probe), CFG);
    expect(v.tier).toMatchObject({
      final: "opus",
      cf: "sonnet",
      jev: "opus",
      finalRoundedUp: true,
    });
    expect(r.influence.tier.roundUps).toMatchObject({ final: 3, blendInduced: 0 });
    expect(r.verdict.warnings.some((w) => w.includes("near-ties"))).toBe(false);
  });
});

function rowOfInput(cols: AdjudicationInput): AdjudicationRow {
  return { id: 1, ts: POST, outcome: "pending", final: false, ...cols } as AdjudicationRow;
}
