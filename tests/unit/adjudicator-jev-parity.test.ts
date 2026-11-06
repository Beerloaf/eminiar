/**
 * jev-impact.ts keeps small copies of helpers that live in modules the dashboard bundle cannot
 * import (heuristic, learn, savings, engine). These tests pin each copy to its original so the
 * two cannot drift apart, and run a property test of the heuristic-alone reconstruction against
 * the real blend().
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BLEND_DEFAULTS, type BlendWeights, blend } from "../../src/adjudicator/blend.js";
import { surfaceBudget } from "../../src/adjudicator/engine.js";
import { effortFor, tableConfidence } from "../../src/adjudicator/heuristic.js";
import {
  ADVISE_ACTIONS,
  advisedPickOf,
  counterfactual,
  DEFAULT_APPLY_BOUNDS,
  effortOf,
  feedbackKind,
  impactReport,
  JEV_ROWS_MAX,
  type JevConfig,
  jevImpact,
  LOW_CONFIDENCE_DEFAULT,
  PROVIDER_STATUS_CLASS,
  rangedOf,
  statusClass,
} from "../../src/adjudicator/jev-impact.js";
import { feedbackOf } from "../../src/adjudicator/learn.js";
import {
  ADVISED_PICK_FIELD,
  advisedPick,
  allRows,
  RANGED_FLAG,
} from "../../src/adjudicator/savings.js";
import {
  type AdjudicationRow,
  type Dist,
  type ProviderAnswer,
  type ScoreSet,
  type ScoreTable,
  TIERS,
  type Tier,
} from "../../src/adjudicator/types.js";
import { ConfigSchema } from "../../src/config.js";
import type { StorageAdapter } from "../../src/storage/adapter.js";
import { ADVISE_ACTIONS as STORE_ADVISE_ACTIONS } from "../../src/storage/dispatch.js";
import { CHART_ROWS_MAX } from "../../src/ui/adjudicator-api.js";

const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);

// --- effortFor ---------------------------------------------------------------------------

describe("effortOf mirrors heuristic.effortFor", () => {
  it("agrees across the whole range and on every boundary", () => {
    const points = new Set<number>([1.5, 2.5, 3.5, 3.75, 1.4999, 2.4999, 3.4999, 3.7499, 3.7501]);
    for (let c = -1; c <= 5; c += 0.05) points.add(Math.round(c * 100) / 100);
    for (const c of points) expect(effortOf(c), String(c)).toBe(effortFor(c));
  });
});

// --- tableConfidence -----------------------------------------------------------------------

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function tableOf(dimension: ScoreTable["dimension"], probs: Record<string, number>): ScoreTable {
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

function randomProbs(rand: () => number, options: readonly string[]): Record<string, number> {
  const raw = options.map(() => 0.02 + rand());
  const sum = raw.reduce((n, x) => n + x, 0);
  return Object.fromEntries(options.map((o, i) => [o, (raw[i] ?? 0) / sum]));
}

describe("the confidence in counterfactual mirrors heuristic.tableConfidence", () => {
  it("is the same number for a table with no provider, boosts or bias", () => {
    const rand = rng(11);
    for (let i = 0; i < 100; i++) {
      const t = tableOf("tier", randomProbs(rand, ["haiku", "sonnet", "opus"]));
      const cf = counterfactual(t, 0, {}, { lowConfidence: 0.55 });
      expect(cf?.confidence).toBeCloseTo(tableConfidence(t.entries), 10);
    }
  });
});

// --- feedbackOf -------------------------------------------------------------------------------

describe("feedbackKind mirrors learn.feedbackOf", () => {
  const sources = [
    "feedback:good",
    "feedback:too_small",
    "feedback:too_big",
    "feedback:bogus",
    "feedback:",
    "feedback:constructor",
    "feedback:__proto__",
    "feedback:toString",
    "feedback",
    "reconcile",
    "usage",
    "",
    null,
    undefined,
  ];
  const outcomes = ["pending", "success", "failure", "abandoned", "n/a"] as const;

  it("gives the same label for every source and outcome", () => {
    for (const outcomeSource of sources)
      for (const outcome of outcomes) {
        const row = { outcome, outcomeSource: outcomeSource ?? null };
        expect(feedbackKind(row), `${outcomeSource}/${outcome}`).toBe(feedbackOf(row));
      }
  });
});

// --- advisedPick / ranged ------------------------------------------------------------------------

describe("advisedPickOf and rangedOf mirror savings.advisedPick and the ranged flag", () => {
  const scoresVariants: Array<string | null | undefined> = [
    ...TIERS.map((t) => JSON.stringify({ [ADVISED_PICK_FIELD]: t })),
    JSON.stringify({ [ADVISED_PICK_FIELD]: "gpt-5" }),
    JSON.stringify({ [ADVISED_PICK_FIELD]: 3 }),
    JSON.stringify({ [ADVISED_PICK_FIELD]: null }),
    JSON.stringify({ [ADVISED_PICK_FIELD]: ["opus"] }),
    JSON.stringify({ other: "opus" }),
    JSON.stringify(["opus"]),
    JSON.stringify("opus"),
    "null",
    "{not json",
    "",
    null,
    undefined,
  ];

  it("reads the same tier from the same scores", () => {
    for (const scores of scoresVariants)
      expect(advisedPickOf({ scores: scores ?? null }), String(scores)).toBe(
        advisedPick({ scores: scores ?? null }),
      );
  });

  it("uses the scores keys savings.ts writes", () => {
    const scores = JSON.stringify({ [ADVISED_PICK_FIELD]: "opus", [RANGED_FLAG]: true });
    expect(advisedPickOf({ scores })).toBe("opus");
    expect(rangedOf({ scores })).toBe(true);
    expect(rangedOf({ scores: JSON.stringify({ [RANGED_FLAG]: "true" }) })).toBe(false);
    expect(rangedOf({ scores: JSON.stringify({ [RANGED_FLAG]: false }) })).toBe(false);
    expect(rangedOf({ scores: null })).toBe(false);
    expect(rangedOf({ scores: "{not json" })).toBe(false);
  });
});

// --- surfaceBudget -------------------------------------------------------------------------------

describe("the budgets in the report mirror engine.surfaceBudget for a remote provider", () => {
  const defaults = ConfigSchema.parse({}).adjudicator;
  const custom = ConfigSchema.parse({
    adjudicator: { timeouts: { promptMs: 1111, agentMs: 2222, planMs: 3333 } },
  }).adjudicator;

  it("reports the same milliseconds per surface", () => {
    for (const cfg of [defaults, custom]) {
      const r = impactReport([], [], {}, { config: cfg, now: NOW });
      expect(r.cost.budgetMs).toEqual({
        prompt: surfaceBudget(cfg, "prompt"),
        agent: surfaceBudget(cfg, "agent"),
        plan: surfaceBudget(cfg, "plan"),
      });
    }
    expect(surfaceBudget(custom, "agent")).toBe(2222);
  });
});

// --- allRows ---------------------------------------------------------------------------------------

function row(id: number): AdjudicationRow {
  return {
    id,
    ts: NOW - id,
    surface: "agent",
    inputHash: "h",
    provider: "typesafe",
    source: "fallback",
    providerStatus: "skipped",
    outcome: "pending",
    final: false,
  };
}

/** A store-shaped list(): pages of `limit` rows, `total` of the whole set; records every call. */
function pagedStore(n: number) {
  const rows = Array.from({ length: n }, (_, i) => row(i + 1));
  const calls: Array<Record<string, unknown>> = [];
  const adjudicator = {
    list(filter: Record<string, unknown> = {}) {
      calls.push(filter);
      const limit = (filter.limit as number | undefined) ?? 50;
      const offset = (filter.offset as number | undefined) ?? 0;
      return { rows: rows.slice(offset, offset + limit), total: rows.length };
    },
    get: () => undefined,
    providerState: () => undefined,
  };
  return { calls, adjudicator, apiCallsLatestTs: () => undefined };
}

describe("the row loader mirrors savings.allRows", () => {
  it("makes the same list calls for the same filter, across several pages", () => {
    for (const n of [0, 1, 499, 500, 501, 1_234]) {
      const a = pagedStore(n);
      const b = pagedStore(n);
      const fromAll = allRows(a as unknown as StorageAdapter, { since: 42, provider: "typesafe" });
      const r = jevImpact(
        b,
        { since: 42 },
        { config: ConfigSchema.parse({}).adjudicator, now: NOW },
      );
      expect(b.calls, `n=${n}`).toEqual(a.calls);
      expect(r.sample.rows, `n=${n}`).toBe(fromAll.length);
    }
  });

  it("makes the same calls for no window", () => {
    const a = pagedStore(700);
    const b = pagedStore(700);
    allRows(a as unknown as StorageAdapter, { provider: "typesafe" });
    jevImpact(b, {}, { config: ConfigSchema.parse({}).adjudicator, now: NOW });
    expect(b.calls).toEqual(a.calls);
  });

  it("stops at the same row cap as the dashboard's charts", () => {
    expect(JEV_ROWS_MAX).toBe(CHART_ROWS_MAX);
    const a = pagedStore(JEV_ROWS_MAX + 600);
    const b = pagedStore(JEV_ROWS_MAX + 600);
    const fromAll = allRows(
      a as unknown as StorageAdapter,
      { provider: "typesafe" },
      CHART_ROWS_MAX,
    );
    const r = jevImpact(b, {}, { config: ConfigSchema.parse({}).adjudicator, now: NOW });
    expect(fromAll).toHaveLength(JEV_ROWS_MAX);
    expect(r.sample.rows).toBe(JEV_ROWS_MAX);
    expect(b.calls.length).toBe(a.calls.length);
  });
});

// --- the default ladder and lowConfidence ---------------------------------------------------------

describe("defaults mirror blend.ts", () => {
  it("LOW_CONFIDENCE_DEFAULT is blend's default and the config schema's (review-jev2 J9)", () => {
    expect(LOW_CONFIDENCE_DEFAULT).toBe(BLEND_DEFAULTS.lowConfidence);
    expect(LOW_CONFIDENCE_DEFAULT).toBe(ConfigSchema.parse({}).adjudicator.weights.lowConfidence);
  });

  it("DEFAULT_APPLY_BOUNDS are the config schema's apply.floor and apply.ceiling", () => {
    const apply = ConfigSchema.parse({}).adjudicator.apply;
    expect(DEFAULT_APPLY_BOUNDS).toEqual({ floor: apply.floor, ceiling: apply.ceiling });
  });

  it("the default lowConfidence is blend's", () => {
    // A tier table with confidence just under blend's default rounds up; the report must agree
    // with a config that names the same value.
    const t = tableOf("tier", { haiku: 0.53, sonnet: 0.47 });
    const a = counterfactual(t, 0, {}, { lowConfidence: BLEND_DEFAULTS.lowConfidence });
    expect(a?.roundedUp).toBe(true);
  });

  it("a table with no known tiers climbs the default ladder like blend does (no step)", () => {
    const h: ScoreSet = {
      complexity: 1,
      complexityReasons: [],
      tool: tableOf("tool", { none: 1 }),
      tier: tableOf("tier", { x: 0.52, y: 0.48 }),
      role: tableOf("role", { none: 1 }),
      effort: "low",
    };
    const v = blend(h, undefined, {}, {}, { key: "k", provider: "heuristic" });
    const cf = counterfactual(h.tier, 0, {}, { lowConfidence: 0.55 });
    expect(cf?.choice).toBe(v.tier.choice);
  });
});

// --- property: the reconstruction against the real blend ------------------------------------------

describe("counterfactual reproduces blend(h, undefined, bias) from blend(h, jev, bias)", () => {
  const LADDERS: Array<readonly Tier[] | undefined> = [
    undefined,
    ["haiku", "sonnet", "opus"],
    ["haiku", "sonnet", "opus", "fable"],
  ];

  function scenario(seed: number) {
    const rand = rng(seed);
    const ladder = LADDERS[Math.floor(rand() * LADDERS.length)];
    const tierOpts: readonly string[] = ladder ?? ["haiku", "sonnet", "opus"];
    const roleOpts = ["coder", "architect", "reviewer", "none"];
    const toolOpts = ["em_symbols", "em_swarm", "Edit", "none"];
    const h: ScoreSet = {
      complexity: rand() * 4,
      complexityReasons: [],
      tier: tableOf("tier", randomProbs(rand, tierOpts)),
      role: tableOf("role", randomProbs(rand, roleOpts)),
      tool: tableOf("tool", randomProbs(rand, toolOpts)),
      effort: "low",
    };
    const dist = (opts: readonly string[]): Dist => ({
      probs: randomProbs(rand, opts),
      confidence: 0.2 + 0.8 * rand(),
      calibrated: true,
    });
    const ans: ProviderAnswer = { key: "k", tier: dist(tierOpts), role: dist(roleOpts) };
    if (rand() < 0.3) ans.risky = 0.8;
    if (rand() < 0.3) ans.needsPlan = 0.9;
    const bias: Record<string, number> = {};
    for (const o of tierOpts) if (rand() < 0.3) bias[`tier:${o}`] = (rand() - 0.5) * 0.4;
    for (const o of roleOpts) if (rand() < 0.3) bias[`role:${o}`] = (rand() - 0.5) * 0.4;
    const weights: BlendWeights = rand() < 0.3 ? { lowConfidence: 0.6 } : {};
    const lowConfidence = weights.lowConfidence ?? BLEND_DEFAULTS.lowConfidence;
    const opts = ladder ? ({ key: "k", tiers: ladder } as const) : ({ key: "k" } as const);
    const withJev = blend(h, ans, bias, weights, { ...opts, provider: "typesafe" });
    const alone = blend(h, undefined, bias, weights, { ...opts, provider: "heuristic" });
    return { withJev, alone, ladder, lowConfidence, h };
  }

  it("matches on tier, role and tool whenever the reconstruction is certain", () => {
    const certain = { tier: 0, role: 0, tool: 0 };
    const total = 600;
    for (let seed = 1; seed <= total; seed++) {
      const { withJev, alone, ladder, lowConfidence } = scenario(seed);
      const tier = counterfactual(withJev.tier, withJev.alpha.tier ?? 0, withJev.bias, {
        tiers: ladder,
        lowConfidence,
      });
      const role = counterfactual(withJev.role, withJev.alpha.role ?? 0, withJev.bias);
      const tool = counterfactual(withJev.tool, withJev.alpha.tool ?? 0, withJev.bias);
      if (tier && !tier.uncertain) {
        certain.tier++;
        expect(tier.choice, `tier seed ${seed}`).toBe(alone.tier.choice);
      }
      if (role && !role.uncertain) {
        certain.role++;
        expect(role.choice, `role seed ${seed}`).toBe(alone.role.choice);
      }
      if (tool && !tool.uncertain) {
        certain.tool++;
        expect(tool.choice, `tool seed ${seed}`).toBe(alone.tool.choice);
      }
    }
    // the property is not vacuous: most scenarios are certain
    expect(certain.tier).toBeGreaterThan(total * 0.5);
    expect(certain.role).toBeGreaterThan(total * 0.5);
    expect(certain.tool).toBeGreaterThan(total * 0.5);
  });

  it("flags every reconstruction whose top two scores are within the margin", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const { withJev, ladder, lowConfidence } = scenario(seed);
      const cf = counterfactual(withJev.tier, withJev.alpha.tier ?? 0, withJev.bias, {
        tiers: ladder,
        lowConfidence,
      });
      if (cf && cf.margin < 0.03) expect(cf.uncertain, `seed ${seed}`).toBe(true);
    }
  });

  it("recovers Jev's own pick as the option with the largest provider term", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const { withJev } = scenario(seed);
      const a = withJev.alpha.tier ?? 0;
      const cf = counterfactual(withJev.tier, a, withJev.bias);
      if (!cf || a === 0) continue;
      const best = withJev.tier.entries
        .map((e) => ({
          o: e.option,
          p: e.reasons.filter((r) => r.feature === "provider").reduce((n, r) => n + r.weight, 0),
        }))
        .sort((x, y) => y.p - x.p)[0];
      if (best && best.p > 0) expect(cf.jev, `seed ${seed}`).toBe(best.o);
    }
  });
});

// --- the report never reads configs the schema would reject ---------------------------------------

describe("JevConfig is satisfied by the real adjudicator config", () => {
  it("accepts ConfigSchema's defaults", () => {
    const cfg: JevConfig = ConfigSchema.parse({}).adjudicator;
    expect(impactReport([], [], {}, { config: cfg, now: NOW }).sample.rows).toBe(0);
  });
});

// --- source-level copies: ADVISE_ACTIONS and the provider status list (review-jev F10) ----------

const SRC = join(__dirname, "../../src");
const source = (rel: string): string => readFileSync(join(SRC, rel), "utf8");

/** The string members of `export type <name> = "a" | "b" ...;` in a source file. */
function unionMembers(text: string, name: string): string[] {
  const m = new RegExp(`export type ${name}\\s*=([^;]+);`).exec(text);
  if (!m?.[1]) throw new Error(`type ${name} not found`);
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1] as string);
}

describe("ADVISE_ACTIONS is the store summary's", () => {
  it("is the one Set in storage/dispatch.ts (no copy left in the store)", () => {
    expect(ADVISE_ACTIONS).toBe(STORE_ADVISE_ACTIONS);
    expect(source("storage/sqlite/adjudicator.ts")).not.toMatch(/ADVISE_ACTIONS = new Set/);
  });

  it("names only real AdjudicationAction values", () => {
    const actions = unionMembers(source("adjudicator/types.ts"), "AdjudicationAction");
    expect(actions.length).toBeGreaterThan(3);
    for (const a of ADVISE_ACTIONS) expect(actions, a).toContain(a);
  });
});

describe("statusClass covers the real provider status list", () => {
  const statuses = unionMembers(source("adjudicator/types.ts"), "ProviderStatus");

  it("classes exactly the ProviderStatus union of types.ts, no status left to the default", () => {
    expect(statuses.length).toBeGreaterThanOrEqual(13);
    expect(Object.keys(PROVIDER_STATUS_CLASS).sort()).toEqual([...statuses].sort());
  });

  it("maps each status through the table, not the unknown-value fallback", () => {
    for (const st of statuses) {
      const cls = (PROVIDER_STATUS_CLASS as Record<string, string>)[st];
      expect(cls, st).toBeDefined();
      expect(statusClass(st), st).toBe(cls);
    }
    // only by-design skips are "skipped"
    expect(statuses.filter((st) => statusClass(st) === "skipped").sort()).toEqual([
      "n/a",
      "ok",
      "skipped",
    ]);
  });
});
