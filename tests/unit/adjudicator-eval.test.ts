import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EVAL_SET } from "../../src/adjudicator/data/evalset.js";
import { EXEMPLARS } from "../../src/adjudicator/data/exemplars.js";
import {
  EVAL_META_KEY,
  type EvalCandidate,
  EvalFixtureError,
  type EvalReport,
  type EvalRow,
  evalSetHash,
  formatEvalReport,
  loadFixture,
  mergeEvalItems,
  parseFixture,
  resolveEvalCandidates,
  runEval,
  saveEvalReport,
} from "../../src/adjudicator/eval.js";
import { type Embedder, embeddingFactory } from "../../src/adjudicator/providers/embedding.js";
import { registerProvider, resetProviders } from "../../src/adjudicator/providers/index.js";
import type {
  AdjudicationRequest,
  AdjudicatorProvider,
  ProviderResult,
} from "../../src/adjudicator/types.js";
import { type AdjudicatorConfig, ConfigSchema } from "../../src/config.js";
import { HELDOUT_SET } from "../fixtures/adjudicator-heldout.js";
import { HELDOUT_SET_2 } from "../fixtures/adjudicator-heldout-2.js";

const adj = (over: Record<string, unknown> = {}): AdjudicatorConfig =>
  ConfigSchema.parse({ adjudicator: { ...over } }).adjudicator;

const row = (r: EvalReport, name: string): EvalRow => {
  const x = r.rows.find((y) => y.name === name);
  if (!x) throw new Error(`no row ${name}: ${r.rows.map((y) => y.name).join(", ")}`);
  return x;
};

/** Every tier prediction is exactly one of correct, under or over. */
function assertTierPartition(x: EvalRow) {
  const t = x.tier;
  if (!t) return;
  expect(t.correct + t.under.correct + t.over.correct).toBe(t.n);
  const confusion = Object.values(t.confusion).reduce(
    (n, r) => n + Object.values(r).reduce((a, b) => a + b, 0),
    0,
  );
  expect(confusion).toBe(t.n);
}

const DIMS = 128;
const tokens = (s: string) => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
/** Deterministic bag-of-words embedder: no model download, works offline in CI. */
function stubEmbedder(): Embedder {
  return {
    model: "stub/bow",
    async embed(texts) {
      return texts.map((t) => {
        const v = new Float32Array(DIMS);
        for (const w of tokens(t)) {
          let h = 2166136261;
          for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w.charCodeAt(i), 16777619);
          const at = (h >>> 0) % DIMS;
          v[at] = (v[at] ?? 0) + 1;
        }
        const n = Math.hypot(...v) || 1;
        return v.map((x) => x / n);
      });
    },
  };
}

/** A hand-written provider: answers `tier` for every item it is asked, optionally hanging or skipping. */
function fakeProvider(
  o: {
    remote?: boolean;
    tier?: (r: AdjudicationRequest) => string;
    hangOn?: (reqs: readonly AdjudicationRequest[]) => boolean;
    skip?: (r: AdjudicationRequest) => boolean;
    costUsd?: number | null;
  } = {},
): AdjudicatorProvider & { calls: number } {
  const p = {
    id: "openai-compatible" as const,
    remote: o.remote ?? true,
    dims: ["complexity", "tier", "role"] as AdjudicatorProvider["dims"],
    calls: 0,
    async probe() {
      return { ok: true, latencyMs: 0, detail: "fake" };
    },
    async adjudicate(reqs: AdjudicationRequest[], opts: { signal: AbortSignal }) {
      p.calls++;
      if (o.hangOn?.(reqs))
        await new Promise((res) => opts.signal.addEventListener("abort", () => res(undefined)));
      const answers = reqs
        .filter((r) => !o.skip?.(r))
        .map((r) => ({
          key: r.key,
          complexity: { value: 2, confidence: 0.9 },
          tier: {
            probs: { [o.tier?.(r) ?? "sonnet"]: 1 },
            confidence: 0.9,
            calibrated: false,
          },
          role: { probs: { coder: 1 }, confidence: 0.5, calibrated: false },
        }));
      const res: ProviderResult = {
        answers,
        usage: {
          inTok: 100 * reqs.length,
          outTok: 10 * reqs.length,
          costUsd: o.costUsd === undefined ? 0.001 : o.costUsd,
        },
        latencyMs: 1,
        model: "fake-1",
      };
      return res;
    },
  };
  return p;
}

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "em-adj-eval-"));
  process.env.EMINIAR_HOME = home;
  resetProviders();
});
afterEach(() => {
  delete process.env.EMINIAR_HOME;
  resetProviders();
});

describe("eval set and fixtures", () => {
  it("the built-in set is disjoint from the embedding exemplars", () => {
    const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
    const ex = new Set(EXEMPLARS.map((e) => norm(e.text)));
    expect(EVAL_SET.filter((i) => ex.has(norm(i.text)))).toEqual([]);
  });

  it("parses arrays and {items}, and rejects bad items with the index", () => {
    const one = { text: "x y", tool: "Edit", tier: "haiku", role: "coder", complexity: 0 };
    expect(parseFixture([one])).toEqual([one]);
    expect(parseFixture({ items: [{ ...one, extra: 1 }] })).toEqual([one]);
    expect(() => parseFixture({ nope: 1 })).toThrow(EvalFixtureError);
    expect(() => parseFixture([])).toThrow(/no items/);
    expect(() => parseFixture([one, { ...one, tier: "huge" }], "f.json")).toThrow(
      /f\.json: item 1 tier/,
    );
    expect(() => parseFixture([{ ...one, complexity: 5 }])).toThrow(/complexity/);
    expect(() => parseFixture([{ ...one, complexity: 1.5 }])).toThrow(/complexity/);
  });

  it("merge appends new items and relabels same-text items; replace uses the fixture alone", () => {
    const relabel = { ...(EVAL_SET[0] as (typeof EVAL_SET)[number]), tier: "opus" as const };
    const extra = [relabel, ...HELDOUT_SET.slice(0, 3)];
    const merged = mergeEvalItems(EVAL_SET, extra, "merge");
    expect(merged).toHaveLength(EVAL_SET.length + 3);
    expect(merged[0]?.tier).toBe("opus");
    expect(mergeEvalItems(EVAL_SET, HELDOUT_SET, "replace")).toEqual([...HELDOUT_SET]);
    expect(evalSetHash(merged)).not.toBe(evalSetHash(EVAL_SET));
    expect(evalSetHash([...EVAL_SET])).toBe(evalSetHash(EVAL_SET));
  });

  it("loads a JSON fixture and a TS module fixture (the held-out set)", async () => {
    const p = join(home, "set.json");
    writeFileSync(p, JSON.stringify({ items: HELDOUT_SET.slice(0, 5) }));
    expect(await loadFixture(p)).toEqual(HELDOUT_SET.slice(0, 5));
    const bad = join(home, "bad.json");
    writeFileSync(bad, "{nope");
    await expect(loadFixture(bad)).rejects.toThrow(/bad\.json: not valid JSON/);
    await expect(loadFixture(join(home, "missing.json"))).rejects.toThrow(EvalFixtureError);
    const mod = resolve(__dirname, "../fixtures/adjudicator-heldout-2.ts");
    expect(await loadFixture(mod)).toEqual([...HELDOUT_SET_2]);
  });

  it("never bundles the held-out fixtures (eval.ts reads fixtures at run time only)", () => {
    const src = readFileSync(resolve(__dirname, "../../src/adjudicator/eval.ts"), "utf8");
    expect(src).not.toMatch(/from ["'][^"']*tests\//);
    expect(src).not.toMatch(/heldout/i);
  });
});

describe("heuristic rows", () => {
  it("reports majority, raw heuristic and shipped heuristic with consistent counts", async () => {
    const r = await runEval({ config: adj(), now: () => 123 });
    expect(r.rows.map((x) => x.name)).toEqual([
      "majority",
      "heuristic (raw)",
      "heuristic (shipped)",
    ]);
    expect(r.set).toMatchObject({ source: "builtin", items: 40 });
    expect(r.ts).toBe(123);

    const maj = row(r, "majority");
    // Majority baselines documented in data/evalset.ts.
    expect(maj.labels).toMatchObject({ tier: "haiku", complexity: 0, role: "coder", tool: "Edit" });
    expect(maj.tier).toMatchObject({ n: 40, correct: 19 });
    expect(maj.complexity?.exact).toMatchObject({ n: 40, correct: 12 });
    expect(maj.role).toMatchObject({ n: 40, correct: 12 });
    expect(maj.tool).toMatchObject({ n: 40, correct: 9 });
    // Predicting the smallest tier can only under-tier.
    expect(maj.tier?.over.correct).toBe(0);
    expect(maj.tier?.under.correct).toBe(21);

    const raw = row(r, "heuristic (raw)");
    const ship = row(r, "heuristic (shipped)");
    for (const x of r.rows) assertTierPartition(x);
    // The round-up only ever moves tiers up: shipped never under-tiers more than raw.
    expect(ship.tier?.under.correct ?? 0).toBeLessThanOrEqual(raw.tier?.under.correct ?? 0);
    expect(ship.tier?.over.correct ?? 0).toBeGreaterThanOrEqual(raw.tier?.over.correct ?? 0);
    // The heuristic beats the majority class on tier and complexity ±1 on its tuning set.
    expect(raw.tier?.rate ?? 0).toBeGreaterThan(maj.tier?.rate ?? 1);
    expect(raw.complexity?.within1.rate ?? 0).toBeGreaterThan(maj.complexity?.within1.rate ?? 1);
    expect(raw.tier?.calibration?.high.n ?? 0).toBeGreaterThanOrEqual(0);
    expect((raw.tier?.calibration?.high.n ?? 0) + (raw.tier?.calibration?.low.n ?? 0)).toBe(40);
    expect(raw.ops?.latencyMs.samples).toBe(40);
    expect(r.verdicts).toEqual([]);
    expect(formatEvalReport(r)).toContain("no candidate provider ran: heuristic only");
  });

  it("evaluates a fixture by merge or replace (held-out sets)", async () => {
    const replaced = await runEval({
      config: adj(),
      fixture: { items: HELDOUT_SET, mode: "replace", name: "/x/y/heldout.json" },
    });
    expect(replaced.set).toMatchObject({
      source: "fixture",
      items: HELDOUT_SET.length,
      fixture: "heldout.json",
      mode: "replace",
    });
    expect(row(replaced, "heuristic (raw)").tier?.n).toBe(HELDOUT_SET.length);

    const merged = await runEval({
      config: adj(),
      fixture: { items: HELDOUT_SET_2, mode: "merge" },
    });
    expect(merged.set.source).toBe("builtin+fixture");
    expect(merged.set.items).toBe(EVAL_SET.length + HELDOUT_SET_2.length);
    for (const x of merged.rows) assertTierPartition(x);
  });
});

describe("provider rows", () => {
  it("runs a stubbed embedding provider offline: raw tier+complexity only, blended on every item", async () => {
    registerProvider(
      "embedding",
      embeddingFactory({ getEmbedder: async () => stubEmbedder(), cacheDir: home }),
    );
    const config = adj({ provider: "embedding", embedding: { minSimilarity: 0.2 } });
    const { candidates, skipped } = resolveEvalCandidates(config, ["heuristic", "embedding"], {
      env: {},
    });
    expect(skipped).toEqual([]);
    expect(candidates.map((c) => c.id)).toEqual(["embedding"]);

    const r = await runEval({ config, candidates, budgetMs: 5000, repeat: 2 });
    const raw = r.rows.find((x) => x.kind === "provider-raw") as EvalRow;
    const bl = r.rows.find((x) => x.kind === "provider-blended") as EvalRow;
    expect(raw.name).toBe("embedding (raw)");
    expect(raw.role).toBeNull();
    expect(raw.tool).toBeNull();
    expect(raw.tier?.n).toBeGreaterThan(0);
    expect(raw.tier?.calibration).toBeDefined();
    expect(bl.n).toBe(80);
    expect(bl.tier?.n).toBe(80);
    expect(bl.role?.n).toBe(80);
    for (const x of r.rows) assertTierPartition(x);
    const ops = bl.ops;
    expect(ops?.calls).toBe(8);
    expect(ops?.items).toBe(80);
    expect(ops?.answered).toBe(raw.tier?.n);
    expect(ops?.latencyMs.samples).toBe(8);
    expect(ops?.usdPer1k).toBe(0);
    expect(ops?.timeoutRate).toBe(0);
    expect(r.verdicts).toHaveLength(1);
    expect(r.verdicts[0]?.line).toMatch(
      /^embedding beats heuristic-only on tier\+complexity: (yes|no) \(Δ tier [+-]\d+\.\d pp, Δ complexity ±1 [+-]\d+\.\d pp\)$/,
    );
  });

  it("skips a remote provider without consent or key, and runs it (mocked fetch) with both", async () => {
    expect(
      resolveEvalCandidates(adj({ provider: "openai-compatible" }), ["openai-compatible"], {
        env: { GROQ_API_KEY: "gsk_test" },
      }).skipped[0],
    ).toMatchObject({
      provider: "openai-compatible",
      reason: expect.stringMatching(/accept-remote/),
    });
    expect(
      resolveEvalCandidates(adj({ remoteConsent: true }), ["openai-compatible"], { env: {} })
        .skipped,
    ).toHaveLength(1);

    const bodies: unknown[] = [];
    const fetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as {
        messages: Array<{ content: string }>;
      };
      bodies.push(body);
      const { items } = JSON.parse(body.messages[1]?.content ?? "{}") as {
        items: Array<{ id: string }>;
      };
      const content = JSON.stringify({
        items: items.map((it) => ({
          id: it.id,
          complexity: 2,
          tier: "sonnet",
          role: "coder",
          risky: false,
          confidence: 0.9,
        })),
      });
      return new Response(
        JSON.stringify({
          model: "openai/gpt-oss-20b",
          choices: [{ message: { role: "assistant", content } }],
          usage: { prompt_tokens: 1000, completion_tokens: 100 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof globalThis.fetch;

    const config = adj({ remoteConsent: true });
    const env = { GROQ_API_KEY: "gsk_test" };
    const { candidates } = resolveEvalCandidates(config, ["openai-compatible"], {
      env,
      deps: { fetch },
    });
    expect(candidates).toHaveLength(1);
    const r = await runEval({ config, candidates, env });
    expect(bodies).toHaveLength(4);
    const raw = row(r, "openai-compatible:openai/gpt-oss-20b (raw)");
    const bl = row(r, "openai-compatible:openai/gpt-oss-20b (blended)");
    expect(raw.tier).toMatchObject({
      n: 40,
      correct: EVAL_SET.filter((i) => i.tier === "sonnet").length,
    });
    expect(raw.complexity?.exact.correct).toBe(EVAL_SET.filter((i) => i.complexity === 2).length);
    expect(bl.ops).toMatchObject({
      calls: 4,
      items: 40,
      answered: 40,
      validity: 1,
      fallbackRate: 0,
    });
    // 4 calls × (1000 × 0.075 + 100 × 0.3) / 1M, over 40 items, per 1k.
    expect(bl.ops?.usdPer1k).toBeCloseTo(((4 * (1000 * 0.075 + 100 * 0.3)) / 1e6 / 40) * 1000, 9);
    expect(bl.ops?.tokensPer1k).toBe(110_000);
    expect(formatEvalReport(r)).toMatch(/\$0\.01/);
  });

  it("counts timeouts, missing answers and unknown prices", async () => {
    const hang = fakeProvider({
      hangOn: (reqs) => reqs.some((q) => q.key === "e0"),
      skip: (q) => q.key === "e15",
      costUsd: null,
    });
    const candidates: EvalCandidate[] = [
      { id: "openai-compatible", provider: hang, label: "fake" },
    ];
    const r = await runEval({ config: adj(), candidates, budgetMs: 40 });
    const bl = row(r, "fake (blended)");
    const raw = row(r, "fake (raw)");
    expect(hang.calls).toBe(4);
    expect(bl.ops?.statuses).toMatchObject({ timeout: 10, ok: 29, skipped: 1 });
    expect(bl.ops?.timeoutRate).toBe(0.25);
    expect(bl.ops?.fallbackRate).toBeCloseTo(11 / 40, 9);
    expect(bl.ops?.answered).toBe(29);
    expect(bl.ops?.validity).toBeCloseTo(29 / 40, 9);
    expect(bl.ops?.usdPer1k).toBeNull();
    expect(raw.tier?.n).toBe(29);
    expect(raw.tool).toBeNull();
    expect(formatEvalReport(r)).toMatch(/unknown/);
  });

  it("scores each item as one text: a silent provider's blended row equals the shipped heuristic", async () => {
    // Provider runs go through adjudicate() on surface "plan", which splits briefs per statement
    // unless eval passes units:false; the held-out set has multi-statement items that would shift.
    const silent = fakeProvider({ skip: () => true });
    const r = await runEval({
      config: adj(),
      fixture: { items: HELDOUT_SET, mode: "replace" },
      candidates: [{ id: "openai-compatible", provider: silent, label: "silent" }],
    });
    const ship = row(r, "heuristic (shipped)");
    const bl = row(r, "silent (blended)");
    expect(bl.ops?.answered).toBe(0);
    expect(bl.n).toBe(HELDOUT_SET.length);
    const dims = (x: EvalRow) => ({
      tier: x.tier,
      complexity: x.complexity,
      role: x.role,
      tool: x.tool,
    });
    expect(dims(bl)).toEqual(dims(ship));
  });

  it("verdict compares the blended provider with the shipped heuristic", async () => {
    // An oracle for tier: always the label.
    const byText = new Map(EVAL_SET.map((i, n) => [`e${n}`, i.tier]));
    const oracle = fakeProvider({ tier: (q) => byText.get(q.key) ?? "sonnet" });
    const r = await runEval({
      config: adj(),
      candidates: [{ id: "openai-compatible", provider: oracle, label: "oracle" }],
    });
    const v = r.verdicts[0];
    const ship = row(r, "heuristic (shipped)");
    const bl = row(r, "oracle (blended)");
    expect(row(r, "oracle (raw)").tier?.rate).toBe(1);
    expect(v?.deltaTierPp).toBeCloseTo(((bl.tier?.rate ?? 0) - (ship.tier?.rate ?? 0)) * 100, 1);
    expect(v?.line.startsWith("oracle beats heuristic-only on tier+complexity: ")).toBe(true);
  });
});

describe("report", () => {
  it("holds no item text, saves under the meta key and formats every section", async () => {
    const fake = fakeProvider();
    const r = await runEval({
      config: adj(),
      candidates: [{ id: "openai-compatible", provider: fake, label: "fake" }],
      fixture: { items: HELDOUT_SET.slice(0, 7), mode: "merge" },
      skipped: [{ provider: "typesafe", reason: "no key" }],
    });
    const json = JSON.stringify(r);
    // Short chat items ("hi") are substrings of anything; check every item long enough to tell.
    const texts = [...EVAL_SET, ...HELDOUT_SET.slice(0, 7)].map((i) => i.text);
    for (const t of texts.filter((x) => x.length >= 12)) {
      expect(json).not.toContain(t);
      expect(json).not.toContain(JSON.stringify(t).slice(1, 24));
    }
    const meta = new Map<string, string>();
    saveEvalReport({ metaSet: (k, v) => meta.set(k, v) }, r);
    expect(EVAL_META_KEY).toBe("adjudicator:eval:last");
    expect(JSON.parse(meta.get(EVAL_META_KEY) ?? "null")).toEqual(r);

    const text = formatEvalReport(r);
    expect(text).toContain("47 items (built-in + fixture");
    for (const s of [
      "majority",
      "heuristic (raw)",
      "heuristic (shipped)",
      "fake (raw)",
      "fake (blended)",
      "under",
      "over",
      "cx ±1",
      "MAE",
      "p95",
      "$/1k",
      "calibration (accuracy at confidence ≥ 0.8 | < 0.8)",
      "skipped typesafe: no key",
      "fake beats heuristic-only on tier+complexity:",
    ])
      expect(text).toContain(s);
    for (const t of texts.filter((x) => x.length >= 12)) expect(text).not.toContain(t);
  });
});
