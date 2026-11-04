import { describe, expect, it } from "vitest";
import { blend, formatAdvice, providerAlpha } from "../../src/adjudicator/blend.js";
import { EVAL_SET } from "../../src/adjudicator/data/evalset.js";
import { extractFeatures, extractIntents } from "../../src/adjudicator/features.js";
import {
  complexityBucket,
  DEFAULT_FEATURE_WEIGHTS,
  effortFor,
  scoreHeuristic,
  scoreTier,
} from "../../src/adjudicator/heuristic.js";
import type { ProviderAnswer, ScoreSet, ScoreTable } from "../../src/adjudicator/types.js";

const score = (text: string, hints?: Parameters<typeof extractFeatures>[1]) =>
  scoreHeuristic(extractFeatures(text, hints));
const sum = (t: ScoreTable) => t.entries.reduce((n, e) => n + e.score, 0);
const get = (t: ScoreTable, o: string) => t.entries.find((e) => e.option === o)?.score ?? 0;

describe("extractFeatures", () => {
  it("counts words, lines, paths, symbols, code blocks and stack traces", () => {
    const f = extractFeatures(
      "why does `loadConfig` fail in src/config.ts?\n```\nTypeError: x\n    at loadConfig (src/config.ts:12:3)\n```",
    );
    expect(f.lines).toBe(5);
    expect(f.paths).toBe(2);
    expect(f.symbols).toBeGreaterThanOrEqual(1);
    expect(f.codeBlock).toBe(true);
    expect(f.stackTrace).toBe(true);
    expect(f.intents.debug).toBeGreaterThan(0);
  });

  it("finds camelCase, PascalCase and snake_case symbols but not plain words", () => {
    expect(extractFeatures("rename fooBar, StorageAdapter and api_calls").symbols).toBe(3);
    expect(extractFeatures("Fix the README heading").symbols).toBe(0);
  });

  it("lets a multiword phrase mask the stems inside it", () => {
    const i = extractIntents("what would break if I change the interface");
    expect(i.impact).toBe(1);
    expect(i.lookup).toBeUndefined();
    const t = extractIntents("write unit tests for the parser");
    expect(t.test).toBe(1);
  });

  it("weights a stem fully at the lead and less elsewhere", () => {
    expect(extractIntents("refactor the parser").refactor).toBe(1);
    expect(extractIntents("the parser needs a refactor").refactor).toBeCloseTo(0.7);
    expect(extractIntents("please refactor the parser").refactor).toBe(1);
  });

  it("reads past tense as description, not a request", () => {
    expect(extractIntents("why was the flag added").implement).toBeUndefined();
  });

  it("treats writing docs as a small edit and reading them as docs", () => {
    expect(extractIntents("update the docs to mention the key").edit_small).toBe(1);
    expect(extractIntents("update the docs to mention the key").docs).toBeUndefined();
    expect(extractIntents("fetch the docs for zod").docs).toBe(1);
  });

  it("flags chat only when nothing else fired", () => {
    expect(extractFeatures("thanks!").chat).toBe(true);
    expect(extractFeatures("ok now refactor the parser").chat).toBe(false);
    expect(extractFeatures("hi").intents.chat).toBe(1);
  });

  it("scores scope and risk on 0..1", () => {
    const f = extractFeatures("migrate auth across the whole codebase in production");
    expect(f.scope).toBe(1);
    expect(f.risk).toBe(1);
    expect(extractFeatures("rename x").scope).toBe(0);
    expect(extractFeatures("list all files").scope).toBe(0.5);
  });

  it("carries the slash flag, the classify label and task hints", () => {
    expect(extractFeatures("/compact").slash).toBe(true);
    expect(extractFeatures("let's go with sqlite for this").classify).toBe("decision");
    expect(extractFeatures("x", { role: "coder", files: 5 }).task).toEqual({
      role: "coder",
      files: 5,
      deps: 0,
    });
    expect(extractFeatures("x").task).toBeUndefined();
  });

  it("handles empty input", () => {
    const f = extractFeatures("   ");
    expect(f.words).toBe(0);
    expect(f.lines).toBe(0);
    const s = scoreHeuristic(f);
    expect(sum(s.tier)).toBeCloseTo(1);
    expect(s.role.choice).toBe("none");
  });
});

describe("scoreHeuristic", () => {
  const all: Array<[string, ScoreSet]> = EVAL_SET.map((it) => [it.text, score(it.text)]);

  it("makes every table sum to 1 and sorts it", () => {
    for (const [, s] of all)
      for (const t of [s.tier, s.tool, s.role]) {
        expect(sum(t)).toBeCloseTo(1, 9);
        expect(t.choice).toBe(t.entries[0]?.option);
        for (let i = 1; i < t.entries.length; i++)
          expect(t.entries[i - 1]!.score).toBeGreaterThanOrEqual(t.entries[i]!.score);
        expect(t.confidence).toBeGreaterThanOrEqual(0.5);
        expect(t.confidence).toBeLessThanOrEqual(1);
      }
  });

  it("gives every non-zero term a reason", () => {
    for (const [, s] of all) {
      const total = s.complexityReasons.reduce((n, r) => n + r.weight, 0);
      expect(s.complexity).toBeCloseTo(Math.min(4, Math.max(0, total)), 1);
      for (const r of s.complexityReasons) expect(r.weight).not.toBe(0);
      for (const t of [s.tier, s.tool, s.role])
        for (const e of t.entries) if (e.score > 0) expect(e.reasons.length).toBeGreaterThan(0);
    }
  });

  it("keeps complexity on 0..4 and buckets it", () => {
    for (const [, s] of all) {
      expect(s.complexity).toBeGreaterThanOrEqual(0);
      expect(s.complexity).toBeLessThanOrEqual(4);
    }
    expect(complexityBucket(3.6)).toBe(4);
    expect(complexityBucket(-1)).toBe(0);
  });

  it("maps complexity to effort", () => {
    expect([1.49, 1.5, 2.49, 2.5, 3.49, 3.5].map(effortFor)).toEqual([
      "low",
      "medium",
      "medium",
      "high",
      "high",
      "xhigh",
    ]);
  });

  it("orders tiers by complexity and lets risk and chat move them", () => {
    const ladder = ["haiku", "sonnet", "opus"] as const;
    const centers = { haiku: 0.6, sonnet: 2, opus: 3.4 };
    expect(scoreTier(0.5, { risk: 0, chat: false }, ladder, centers).choice).toBe("haiku");
    expect(scoreTier(2.1, { risk: 0, chat: false }, ladder, centers).choice).toBe("sonnet");
    expect(scoreTier(3.9, { risk: 0, chat: false }, ladder, centers).choice).toBe("opus");
    const calm = scoreTier(1.2, { risk: 0, chat: false }, ladder, centers);
    const risky = scoreTier(1.2, { risk: 1, chat: false }, ladder, centers);
    expect(get(risky, "sonnet")).toBeGreaterThan(get(calm, "sonnet"));
    expect(
      risky.entries.find((e) => e.option === "sonnet")?.reasons.some((r) => r.feature === "risk"),
    ).toBe(true);
    const chat = scoreTier(1.4, { risk: 0, chat: true }, ladder, centers);
    expect(chat.choice).toBe("haiku");
  });

  it("places an unconfigured tier (fable) above opus on the ladder", () => {
    const s = scoreHeuristic(
      extractFeatures("design a new architecture for the whole platform"),
      {},
      {
        tiers: ["haiku", "sonnet", "opus", "fable"],
      },
    );
    expect(s.tier.entries.map((e) => e.option).sort()).toEqual([
      "fable",
      "haiku",
      "opus",
      "sonnet",
    ]);
    expect(s.complexity).toBe(4);
    expect(["opus", "fable"]).toContain(s.tier.choice);
  });

  it("honours weight overrides", () => {
    const f = extractFeatures("design the cache subsystem");
    const base = scoreHeuristic(f).complexity;
    expect(scoreHeuristic(f, { features: { design: 0 } }).complexity).toBeLessThan(base);
    const shifted = scoreHeuristic(extractFeatures("add a flag"), {
      tierCenters: { haiku: 1.5, sonnet: 3, opus: 4 },
    });
    expect(shifted.tier.choice).toBe("haiku");
    expect(DEFAULT_FEATURE_WEIGHTS.design).toBe(2.4);
  });

  it("halves scope for read-only requests", () => {
    const read = score("search the whole codebase for session ids");
    const write = score("rename session ids across the whole codebase");
    expect(read.complexityReasons.find((r) => r.feature === "scope")?.weight).toBe(0.6);
    expect(write.complexityReasons.find((r) => r.feature === "scope")?.weight).toBe(1.2);
  });

  it("adds task-hint terms", () => {
    const s = score("wire the store", { files: 5, deps: 2 });
    expect(s.complexityReasons.map((r) => r.feature)).toEqual(
      expect.arrayContaining(["taskFiles", "taskDeps"]),
    );
  });

  it("maps intents to tools, writing tests to Edit and running them to em_execute", () => {
    expect(score("what would break if I change the Store interface").tool.choice).toBe(
      "em_graph_impact",
    );
    expect(score("git blame for the parser").tool.choice).toBe("em_history");
    expect(score("write unit tests for the parser").tool.choice).toBe("Edit");
    expect(score("run the test suite").tool.choice).toBe("em_execute");
    expect(score("commit these changes").tool.choice).toBe("Bash");
    expect(score("hi").tool.choice).toBe("none");
    expect(score("design an event-sourced subsystem across all services").tool.choice).toBe(
      "Agent",
    );
  });

  it("limits tools to the registered ones", () => {
    const s = scoreHeuristic(
      extractFeatures("what would break if I change Store"),
      {},
      {
        tools: ["em_search", "Edit"],
      },
    );
    expect(s.tool.entries.map((e) => e.option).sort()).toEqual(["Edit", "em_search"]);
    expect(sum(s.tool)).toBeCloseTo(1);
  });

  it("scores custom swarm roles by their descriptions and the task role", () => {
    const roles = [
      { name: "sleuth", description: "debug crashes and find why things fail" },
      { name: "scribe", description: "write and update the docs" },
    ];
    const s = scoreHeuristic(
      extractFeatures("debug why the worker crashes on start"),
      {},
      { roles },
    );
    expect(s.role.entries.map((e) => e.option).sort()).toEqual(["scribe", "sleuth"]);
    expect(s.role.choice).toBe("sleuth");
    const hinted = scoreHeuristic(
      extractFeatures("look at this", { role: "scribe" }),
      {},
      { roles },
    );
    expect(hinted.role.choice).toBe("scribe");
  });

  it("sends rewrites big enough to delegate (c ≥ 3.5) to an architect", () => {
    const big = score("migrate the auth subsystem across the whole codebase");
    expect(big.complexity).toBeGreaterThanOrEqual(3.5);
    expect(big.role.choice).toBe("architect");
    expect(big.tool.choice).toBe("Agent");
    expect(score("refactor the parser").role.choice).toBe("coder");
  });

  it("is pure: the same input gives the same output", () => {
    expect(score("refactor the hooks dispatcher")).toEqual(score("refactor the hooks dispatcher"));
  });
});

describe("eval set acceptance (§7.8)", () => {
  // Majority baselines from research-local-3: tier haiku 0.475, complexity "0" 0.30.
  const rows = EVAL_SET.map((it) => {
    const h = score(it.text);
    const v = blend(h, undefined, {}, {}, { key: "k", provider: "heuristic" });
    return { it, h, v };
  });
  const rate = (pred: (r: (typeof rows)[number]) => boolean) =>
    rows.filter(pred).length / rows.length;

  it("has the 40 labelled items", () => {
    expect(EVAL_SET).toHaveLength(40);
    expect(new Set(EVAL_SET.map((i) => i.text)).size).toBe(40);
  });

  it("beats the majority class on tier and complexity, and is within ±1 on ≥ 80%", () => {
    const tier = rate((r) => r.h.tier.choice === r.it.tier);
    const shipped = rate((r) => r.v.tier.choice === r.it.tier);
    const exact = rate((r) => complexityBucket(r.h.complexity) === r.it.complexity);
    const within = rate((r) => Math.abs(complexityBucket(r.h.complexity) - r.it.complexity) <= 1);
    expect(tier).toBeGreaterThan(0.475);
    expect(shipped).toBeGreaterThan(0.475);
    expect(exact).toBeGreaterThan(0.3);
    expect(within).toBeGreaterThanOrEqual(0.8);
  });

  it("scores an item in under 2 ms at p95", () => {
    const times: number[] = [];
    for (let rep = 0; rep < 5; rep++)
      for (const it of EVAL_SET) {
        const t0 = performance.now();
        const v = blend(score(it.text), undefined, {}, {}, { key: "k", provider: "heuristic" });
        formatAdvice(v);
        times.push(performance.now() - t0);
      }
    times.sort((a, b) => a - b);
    expect(times[Math.floor(times.length * 0.95)]).toBeLessThan(2);
  });
});

describe("blend", () => {
  const h = score("add retries with backoff to the model download");
  const dist = (probs: Record<string, number>, confidence: number, calibrated: boolean) => ({
    probs,
    confidence,
    calibrated,
  });
  const answer = (over: Partial<ProviderAnswer> = {}): ProviderAnswer => ({
    key: "k",
    complexity: { value: 4, confidence: 0.95 },
    tier: dist({ haiku: 0, sonnet: 0, opus: 1 }, 0.95, true),
    role: dist({ architect: 1 }, 0.95, true),
    tool: dist({ Agent: 1 }, 0.95, true),
    ...over,
  });

  it("is the heuristic, untouched, without an answer", () => {
    const v = blend(h, undefined, {}, {}, { key: "k", provider: "typesafe" });
    expect(v.source).toBe("heuristic");
    expect(v.providerStatus).toBe("n/a");
    expect(v.alpha).toEqual({});
    expect(v.complexity).toBe(h.complexity);
    expect(v.role).toEqual(h.role);
  });

  it("caps α per provider: providerMax for typesafe, embeddingMax for embedding", () => {
    expect(providerAlpha("typesafe", answer())).toEqual({ complexity: 0.7, tier: 0.7, role: 0.7 });
    expect(providerAlpha("typesafe", answer(), { providerMax: 0.5 }).tier).toBe(0.5);
    const e = providerAlpha("embedding", answer());
    expect(e).toEqual({ complexity: 0.4, tier: 0.4 });
    expect(providerAlpha("heuristic", answer())).toEqual({});
    const low = providerAlpha("typesafe", answer({ tier: dist({ opus: 1 }, 0.3, true) }));
    expect(low.tier).toBe(0.3);
  });

  it("discounts self-reported confidence by selfReportScale", () => {
    const a = answer({
      complexity: { value: 4, confidence: 0.9 },
      tier: dist({ opus: 1 }, 0.9, false),
      role: dist({ architect: 1 }, 0.9, false),
    });
    const al = providerAlpha("openai-compatible", a);
    expect(al.tier).toBeCloseTo(0.54);
    expect(al.role).toBeCloseTo(0.54);
    expect(al.complexity).toBeCloseTo(0.54);
    expect(providerAlpha("openai-compatible", a, { selfReportScale: 1 }).tier).toBe(0.7);
  });

  it("leaves tools to the heuristic unless toolProvider > 0", () => {
    expect(providerAlpha("typesafe", answer()).tool).toBeUndefined();
    expect(providerAlpha("typesafe", answer(), { features: { toolProvider: 0.2 } }).tool).toBe(0.2);
    const v = blend(h, answer(), {}, {}, { key: "k", provider: "typesafe" });
    expect(v.tool).toEqual(h.tool);
  });

  it("mixes tables and complexity with α and keeps tables summing to 1", () => {
    const v = blend(h, answer(), {}, {}, { key: "k", provider: "typesafe" });
    expect(v.source).toBe("blend");
    expect(v.complexity).toBeCloseTo(0.3 * h.complexity + 0.7 * 4);
    expect(get(v.tier, "opus")).toBeCloseTo(0.3 * get(h.tier, "opus") + 0.7);
    expect(v.tier.choice).toBe("opus");
    expect(v.role.choice).toBe("architect");
    expect(v.effort).toBe("high"); // c = 0.3·1.32 + 0.7·4 = 3.2
    for (const t of [v.tier, v.role, v.tool]) expect(sum(t)).toBeCloseTo(1, 9);
    expect(v.complexityReasons.some((r) => r.feature === "provider")).toBe(true);
    expect(v.tier.entries[0]?.reasons.some((r) => r.feature === "provider")).toBe(true);
  });

  it("drops provider options outside the table", () => {
    const v = blend(
      h,
      answer({ tier: dist({ fable: 1 }, 0.9, true) }),
      {},
      {},
      {
        key: "k",
        provider: "typesafe",
      },
    );
    expect(v.tier.entries.map((e) => e.option)).not.toContain("fable");
    expect(v.alpha.tier).toBeUndefined();
    expect(sum(v.tier)).toBeCloseTo(1);
  });

  it("adds the learned bias, clamps at 0 and renormalises", () => {
    const v = blend(
      h,
      undefined,
      { "role:coder": -5, "role:tester": 0.3 },
      {},
      { key: "k", provider: "heuristic" },
    );
    expect(get(v.role, "coder")).toBe(0);
    expect(sum(v.role)).toBeCloseTo(1, 9);
    expect(v.role.choice).toBe("tester");
    expect(v.role.entries[0]?.reasons.some((r) => r.feature === "bias")).toBe(true);
    expect(v.bias).toEqual({ "role:coder": -5, "role:tester": 0.3 });
  });

  it("falls back to the heuristic table when a bias zeroes everything", () => {
    const bias = Object.fromEntries(h.tier.entries.map((e) => [`tier:${e.option}`, -9]));
    const v = blend(h, undefined, bias, {}, { key: "k", provider: "heuristic" });
    expect(sum(v.tier)).toBeCloseTo(1);
  });

  it("rounds a low-confidence tier up one step, with a reason", () => {
    // c = 1.3 sits between the haiku (0.6) and sonnet (2.0) centres.
    const mid = {
      ...h,
      complexity: 1.3,
      tier: scoreTier(1.3, { risk: 0, chat: false }, ["haiku", "sonnet", "opus"], {
        haiku: 0.6,
        sonnet: 2,
        opus: 3.4,
      }),
    };
    expect(mid.tier.confidence).toBeLessThan(0.55);
    const v = blend(mid, undefined, {}, {}, { key: "k", provider: "heuristic" });
    const at = ["haiku", "sonnet", "opus"].indexOf(mid.tier.choice);
    expect(v.tier.choice).toBe(["haiku", "sonnet", "opus"][at + 1]);
    expect(
      v.tier.entries
        .find((e) => e.option === v.tier.choice)
        ?.reasons.some((r) => r.note === "low confidence → rounded up"),
    ).toBe(true);
    const sure = blend(
      mid,
      undefined,
      {},
      { lowConfidence: 0 },
      { key: "k", provider: "heuristic" },
    );
    expect(sure.tier.choice).toBe(mid.tier.choice);
  });

  it("never rounds above the top of the ladder", () => {
    const top = { ...h, tier: { ...h.tier, choice: "opus", confidence: 0.5 } };
    expect(
      blend(
        top,
        undefined,
        {},
        {},
        { key: "k", provider: "heuristic", tiers: ["haiku", "sonnet", "opus"] },
      ).tier.choice,
    ).toBe("opus");
  });

  it("applies Jev noul answers: risky lifts tiers ≥ sonnet, needsPlan lifts em_swarm and architect", () => {
    const quiet = score("rename foo to bar");
    const base = blend(quiet, { key: "k" }, {}, {}, { key: "k", provider: "typesafe" });
    const risky = blend(
      quiet,
      { key: "k", risky: 0.9, needsPlan: 0.9 },
      {},
      {},
      { key: "k", provider: "typesafe" },
    );
    expect(get(risky.tier, "sonnet")).toBeGreaterThan(get(base.tier, "sonnet"));
    expect(get(risky.tier, "opus")).toBeGreaterThan(get(base.tier, "opus"));
    expect(get(risky.tool, "em_swarm")).toBeGreaterThan(get(base.tool, "em_swarm"));
    expect(get(risky.role, "architect")).toBeGreaterThan(get(base.role, "architect"));
    expect(
      risky.tier.entries
        .find((e) => e.option === "opus")
        ?.reasons.some((r) => r.feature === "risky"),
    ).toBe(true);
    expect(
      risky.role.entries
        .find((e) => e.option === "architect")
        ?.reasons.some((r) => r.feature === "needsPlan"),
    ).toBe(true);
    const mild = blend(
      quiet,
      { key: "k", risky: 0.6, needsPlan: 0.7 },
      {},
      {},
      { key: "k", provider: "typesafe" },
    );
    expect(mild.tier).toEqual(base.tier);
    expect(mild.role).toEqual(base.role);
  });

  it("carries the verdict metadata", () => {
    const v = blend(
      h,
      answer(),
      {},
      {},
      {
        key: "abc",
        provider: "typesafe",
        providerStatus: "ok",
        latencyMs: 12,
        providerLatencyMs: 9,
        usage: { inTok: 10, outTok: 0, costUsd: 0.000001 },
      },
    );
    expect(v).toMatchObject({
      key: "abc",
      provider: "typesafe",
      latencyMs: 12,
      providerLatencyMs: 9,
      version: "1",
    });
    expect(v.usage?.inTok).toBe(10);
  });
});

describe("formatAdvice", () => {
  it("stays within 220 chars on every surface", () => {
    const long = `${"refactor ".repeat(50)} across the whole codebase`;
    for (const text of [...EVAL_SET.map((i) => i.text), long])
      for (const surface of ["prompt", "agent", "plan"] as const) {
        const line = formatAdvice(blend(score(text), undefined), surface);
        expect(line.length).toBeLessThanOrEqual(220);
        expect(line).toMatch(/^eminiar adjudicator: complexity \d\/4/);
        expect(line).not.toContain("\n");
      }
  });

  it("names the intent, the tools and the delegate tier", () => {
    const line = formatAdvice(blend(score("what does the loadConfig function return"), undefined));
    expect(line).toBe(
      "eminiar adjudicator: complexity 0/4 (lookup) · start with em_symbols → em_search · if you delegate: haiku, role explorer",
    );
    expect(formatAdvice(blend(score("thanks"), undefined))).toContain("no tool needed");
    expect(formatAdvice(blend(score("refactor the parser"), undefined), "agent")).toMatch(
      /→ \w+ \(effort \w+\), role coder$/,
    );
  });
});
