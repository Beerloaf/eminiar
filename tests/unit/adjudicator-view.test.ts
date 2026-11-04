import { describe, expect, it } from "vitest";
import { blend } from "../../src/adjudicator/blend.js";
import { extractFeatures } from "../../src/adjudicator/features.js";
import { scoreHeuristic } from "../../src/adjudicator/heuristic.js";
import type { Dist, ScoreTable } from "../../src/adjudicator/types.js";
import {
  actionInfo,
  breakerInfo,
  complexityBreakdown,
  complexityLabel,
  countTicks,
  decisionParams,
  evalFacts,
  evalTable,
  featureFacts,
  heat,
  matrixGrid,
  ms,
  PARTS,
  pageLabel,
  rate,
  savingsNote,
  signed,
  splitTable,
  statusTone,
  topIntents,
  topReasons,
  tryItReason,
  usageGapNote,
} from "../../src/ui/web/views/adjudicator-helpers.js";

const h = scoreHeuristic(
  extractFeatures("refactor the session store in src/storage/sqlite/adjudicator.ts and add tests"),
);
const dist = (probs: Record<string, number>, confidence = 0.9): Dist => ({
  probs,
  confidence,
  calibrated: true,
});
const sumParts = (e: { parts: Record<string, number> }) =>
  PARTS.reduce((n, p) => n + (e.parts[p] ?? 0), 0);

describe("splitTable", () => {
  it("is all heuristic when no provider took part", () => {
    const t = splitTable(h.tier, 0);
    expect(t.choice).toBe(h.tier.choice);
    expect(t.alpha).toBe(0);
    expect(t.providerShare).toBe(0);
    for (const e of t.entries) {
      expect(e.parts.provider).toBe(0);
      expect(e.parts.learned).toBe(0);
      expect(e.parts.heuristic).toBeCloseTo(e.score, 6);
    }
  });

  it("splits a blended table into heuristic and provider parts that sum to the score", () => {
    const v = blend(
      h,
      { key: "k", tier: dist({ haiku: 0, sonnet: 0.2, opus: 0.8 }) },
      {},
      {},
      { key: "k", provider: "typesafe" },
    );
    const a = v.alpha.tier ?? 0;
    expect(a).toBeGreaterThan(0);
    const t = splitTable(v.tier, a);
    for (const e of t.entries) {
      expect(sumParts(e)).toBeCloseTo(e.score, 6);
      // heuristic part = (1 − α) × the heuristic's own score (no boosts or bias here)
      const hs = h.tier.entries.find((x) => x.option === e.option)?.score ?? 0;
      expect(e.parts.heuristic).toBeCloseTo((1 - a) * hs, 1);
    }
    const opus = t.entries.find((e) => e.option === "opus")!;
    expect(opus.parts.provider).toBeGreaterThan(0);
    expect(t.providerShare).toBeGreaterThan(0);
    expect(t.providerShare).toBeLessThanOrEqual(1);
  });

  it("counts learned bias and boosts as their own part", () => {
    const v = blend(h, undefined, { "tier:opus": 0.2 }, {}, { key: "k", provider: "heuristic" });
    const t = splitTable(v.tier, 0);
    const opus = t.entries.find((e) => e.option === "opus")!;
    expect(opus.parts.learned).toBeGreaterThan(0);
    expect(opus.parts.provider).toBe(0);
    for (const e of t.entries) expect(sumParts(e)).toBeCloseTo(e.score, 6);
  });

  it("names the winner and runner-up and the margin between them", () => {
    const table: ScoreTable = {
      dimension: "role",
      choice: "coder",
      confidence: 0.6,
      entries: [
        { option: "tester", score: 0.2, reasons: [] },
        { option: "coder", score: 0.7, reasons: [] },
        { option: "none", score: 0.1, reasons: [] },
      ],
    };
    const t = splitTable(table);
    expect(t.entries.map((e) => e.option)).toEqual(["coder", "tester", "none"]);
    expect(t.runnerUp).toBe("tester");
    expect(t.margin).toBeCloseTo(0.5);
    expect(t.entries[0]!.chosen).toBe(true);
    expect(t.entries[1]!.runnerUp).toBe(true);
    expect(t.roundedUp).toBe(false);
  });

  it("flags a tier rounded up for low confidence (choice is not the top score)", () => {
    const table: ScoreTable = {
      dimension: "tier",
      choice: "sonnet",
      confidence: 0.3,
      entries: [
        { option: "haiku", score: 0.45, reasons: [] },
        { option: "sonnet", score: 0.4, reasons: [] },
        { option: "opus", score: 0.15, reasons: [] },
      ],
    };
    const t = splitTable(table);
    expect(t.roundedUp).toBe(true);
    expect(t.choice).toBe("sonnet");
    expect(t.runnerUp).toBe("haiku");
    expect(t.margin).toBeCloseTo(-0.05);
  });

  it("survives an empty table", () => {
    const t = splitTable({ dimension: "tool", choice: "none", confidence: 0, entries: [] });
    expect(t.entries).toEqual([]);
    expect(t.runnerUp).toBeNull();
    expect(t.margin).toBeNull();
  });
});

describe("complexity", () => {
  it("separates the provider's pull from the heuristic terms", () => {
    const b = complexityBreakdown(2.5, [
      { feature: "words", weight: 0.4, note: "" },
      { feature: "provider", weight: 0.5, note: "typesafe says 3" },
      { feature: "intent.refactor", weight: 1.1, note: "" },
    ]);
    expect(b.provider).toBeCloseTo(0.5);
    expect(b.heuristic).toBeCloseTo(2);
    expect(b.terms.map((r) => r.feature)).toEqual(["intent.refactor", "words"]);
    expect(b.providerNote).toBe("typesafe says 3");
  });

  it("labels buckets and handles missing values", () => {
    expect(complexityLabel(0.2)).toBe("trivial");
    expect(complexityLabel(3.6)).toBe("very complex");
    expect(complexityLabel(9)).toBe("very complex");
    expect(complexityLabel(null)).toBe("n/a");
  });

  it("orders reasons by absolute weight", () => {
    const r = topReasons(
      [
        { feature: "a", weight: 0.1, note: "" },
        { feature: "b", weight: -0.5, note: "" },
        { feature: "c", weight: 0.3, note: "" },
      ],
      2,
    );
    expect(r.map((x) => x.feature)).toEqual(["b", "c"]);
  });
});

describe("matrix", () => {
  it("orders axes by tier ladder, merges duplicates and counts agreement", () => {
    const g = matrixGrid([
      { suggested: "opus", actual: "sonnet", n: 2 },
      { suggested: "haiku", actual: "haiku", n: 3 },
      { suggested: "sonnet", actual: "sonnet", n: 4 },
      { suggested: "sonnet", actual: "sonnet", n: 1 },
      { suggested: "haiku", actual: "claude-x-unknown", n: 1 },
    ]);
    expect(g.rows).toEqual(["haiku", "sonnet", "opus"]);
    expect(g.cols).toEqual(["haiku", "sonnet", "claude-x-unknown"]);
    expect(g.cell("sonnet", "sonnet")).toBe(5);
    expect(g.cell("opus", "haiku")).toBe(0);
    expect(g.max).toBe(5);
    expect(g.total).toBe(11);
    expect(g.agree).toBe(8);
  });

  it("heat is 0 for empty cells and grows with the count", () => {
    expect(heat(0, 5)).toBe(0);
    expect(heat(1, 0)).toBe(0);
    expect(heat(5, 5)).toBeCloseTo(0.9);
    expect(heat(1, 5)).toBeLessThan(heat(4, 5));
  });

  it("count ticks end at or above the max", () => {
    expect(countTicks(0)).toEqual([0, 1]);
    expect(countTicks(7)).toEqual([0, 4, 8]);
    expect(countTicks(10)).toEqual([0, 5, 10]);
  });
});

describe("call log", () => {
  it("builds decision params without empty filters", () => {
    expect(decisionParams({ since: "30d", surface: "agent" }, 50, 100)).toEqual({
      limit: 50,
      offset: 100,
      since: "30d",
      surface: "agent",
    });
    expect(decisionParams({ since: "all", outcome: "" }, 50, 0)).toEqual({ limit: 50, offset: 0 });
  });

  it("labels pages", () => {
    expect(pageLabel(0, 50, 312)).toBe("1–50 of 312");
    expect(pageLabel(300, 12, 312)).toBe("301–312 of 312");
    expect(pageLabel(0, 0, 0)).toBe("0 of 0");
  });

  it("explains each row's savings", () => {
    const base = {
      surface: "agent" as const,
      action: "followed" as const,
      savingsUsd: 0.12,
      baselineCostUsd: 0.2,
      actualCostUsd: 0.08,
      outcome: "success" as const,
      final: true,
    };
    expect(savingsNote(base)).toMatch(/baseline/);
    expect(savingsNote({ ...base, surface: "prompt" })).toMatch(/potential/);
    expect(savingsNote({ ...base, action: "ignored" })).toMatch(/no credit/);
    expect(savingsNote({ ...base, savingsUsd: null, final: false })).toMatch(/not reconciled/);
    expect(savingsNote({ ...base, savingsUsd: -0.3, outcome: "failure" })).toMatch(/redo/);
  });
});

describe("usageGapNote", () => {
  it("says nothing when API calls are recorded, whatever the figures", () => {
    expect(usageGapNote({ usageAvailable: true, realisedUsd: 0, creditedRows: 0 })).toBeNull();
    expect(usageGapNote({ usageAvailable: true, realisedUsd: 7.79, creditedRows: 4 })).toBeNull();
  });

  it("does not call figures empty when dispatches were priced earlier", () => {
    const n = usageGapNote({ usageAvailable: false, realisedUsd: 7.79, creditedRows: 4 });
    expect(n?.label).toMatch(/new dispatches and potential savings are not priced/);
    expect(n?.label).not.toMatch(/empty/);
    expect(n?.help).toMatch(/realised and net still include/);
  });

  it("counts a redo penalty alone as priced", () => {
    const n = usageGapNote({ usageAvailable: false, realisedUsd: -0.4, creditedRows: 0 });
    expect(n?.label).toMatch(/not priced/);
  });

  it("says savings cannot be priced when nothing was", () => {
    const n = usageGapNote({ usageAvailable: false, realisedUsd: 0, creditedRows: 0 });
    expect(n?.label).toBe("no API calls recorded: savings cannot be priced");
    expect(n?.help).toMatch(/config\.usage\.enabled/);
  });
});

describe("labels", () => {
  it("formats rates, latency and signed weights", () => {
    expect(rate(null)).toBe("—");
    expect(rate(0.456)).toBe("46%");
    expect(ms(undefined)).toBe("—");
    expect(ms(840.4)).toBe("840 ms");
    expect(ms(1250)).toBe("1.3 s");
    expect(signed(0.424)).toBe("+0.42");
    expect(signed(-0.1)).toBe("−0.10");
    expect(signed(0)).toBe("0.00");
  });

  it("maps actions, breaker states, statuses and try-it reasons", () => {
    expect(actionInfo("followed").tone).toBe("ok");
    expect(actionInfo("ignored").tone).toBe("warn");
    expect(actionInfo(null).label).toBe("none");
    expect(actionInfo("brand_new").label).toBe("brand_new");
    expect(breakerInfo(null).label).toBe("not called yet");
    expect(breakerInfo("open").tone).toBe("bad");
    expect(breakerInfo("auth_failed").label).toBe("auth failed");
    expect(breakerInfo("weird_state").label).toBe("weird state");
    expect(statusTone("ok")).toBe("ok");
    expect(statusTone("timeout")).toBe("bad");
    expect(statusTone("over_budget")).toBe("warn");
    expect(statusTone("n/a")).toBe("muted");
    expect(tryItReason("no_consent")).toMatch(/consent/);
    expect(tryItReason("something_else")).toBe("something else");
  });
});

describe("features", () => {
  it("lists the strongest intents and the set facts", () => {
    const f = extractFeatures(
      "debug the crash in src/a.ts\n```\nTypeError: x\n    at f (a.ts:1:1)\n```",
    );
    const intents = topIntents(f, 3);
    expect(intents.length).toBeLessThanOrEqual(3);
    for (let i = 1; i < intents.length; i++)
      expect(intents[i - 1]![1]).toBeGreaterThanOrEqual(intents[i]![1]);
    const facts = Object.fromEntries(featureFacts(f));
    expect(Number(facts.paths)).toBeGreaterThanOrEqual(1);
    expect(facts["code block"]).toBe("yes");
    expect(featureFacts(undefined)).toEqual([]);
  });
});

describe("eval report", () => {
  it("flattens the first array of rows one level deep", () => {
    const report = {
      verdict: "typesafe beats heuristic-only on tier+complexity: yes",
      items: 40,
      rows: [
        { name: "heuristic", tier: { accuracy: 0.7, mae: 0.55 }, latency: { p50: 1 } },
        { name: "typesafe", tier: { accuracy: 0.8 }, valid: true },
      ],
    };
    const t = evalTable(report)!;
    expect(t.columns).toEqual(["name", "tier.accuracy", "tier.mae", "latency.p50", "valid"]);
    expect(t.rows[0]!["tier.accuracy"]).toBe("0.700");
    expect(t.rows[1]!.valid).toBe("yes");
    expect(Object.fromEntries(evalFacts(report))).toEqual({
      verdict: report.verdict,
      items: "40",
    });
  });

  it("returns null without a report or rows", () => {
    expect(evalTable(null)).toBeNull();
    expect(evalTable({ verdict: "x" })).toBeNull();
    expect(evalFacts(undefined)).toEqual([]);
  });
});
