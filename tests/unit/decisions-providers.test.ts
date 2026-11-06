import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAdjudicator } from "../../src/adjudicator/config.js";
import type { Embedder } from "../../src/adjudicator/providers/embedding.js";
import { ProviderError } from "../../src/adjudicator/providers/http.js";
import { type AdjudicatorConfig, AdjudicatorConfigSchema } from "../../src/config.js";
import { createDecisionProvider } from "../../src/decisions/providers/index.js";
import { JEV_PINNED, toDecisionAnswer } from "../../src/decisions/providers/jev.js";
import type { DecisionBatch, DecisionProvider } from "../../src/decisions/providers/types.js";
import type { DecisionQuestionSpec } from "../../src/decisions/types.js";

const KEY = "sk-test-key-0123456789";
const ENV = { TYPESAFE_API_KEY: KEY } as NodeJS.ProcessEnv;
const ORIGIN = "https://api.typesafe.ai";

const homeBefore = process.env.EMINIAR_HOME;
beforeEach(() => {
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "decp-home-"));
});
afterEach(() => {
  if (homeBefore === undefined) delete process.env.EMINIAR_HOME;
  else process.env.EMINIAR_HOME = homeBefore;
});

function typesafeCfg(): AdjudicatorConfig {
  return AdjudicatorConfigSchema.parse({
    enabled: true,
    provider: "typesafe",
    remoteConsent: true,
    remoteConsentOrigins: [ORIGIN],
  }) as AdjudicatorConfig;
}
function ollamaCfg(): AdjudicatorConfig {
  return AdjudicatorConfigSchema.parse({
    enabled: true,
    provider: "openai-compatible",
    openai: { preset: "ollama", model: "llama-test" },
  }) as AdjudicatorConfig;
}
function embeddingCfg(): AdjudicatorConfig {
  return AdjudicatorConfigSchema.parse({
    enabled: true,
    provider: "embedding",
  }) as AdjudicatorConfig;
}

function build(
  cfg: AdjudicatorConfig,
  deps: Parameters<typeof createDecisionProvider>[2] = {},
  env: NodeJS.ProcessEnv = ENV,
): DecisionProvider {
  const r = resolveAdjudicator(cfg, { context: "server", env });
  const p = createDecisionProvider(r, cfg, { env, ...deps });
  if (!p) throw new Error(`no provider for ${r.provider}`);
  return p;
}

const yn: DecisionQuestionSpec = {
  name: "rel",
  kind: "yes_no",
  instructions: "Is {item} relevant?",
};
const ynSim: DecisionQuestionSpec = { ...yn, similarity: "relevance" };
const choice: DecisionQuestionSpec = {
  name: "kind",
  kind: "choice",
  instructions: "How does {item} relate?",
  options: { dup: "duplicate", unrelated: "unrelated" },
};
const score: DecisionQuestionSpec = {
  name: "size",
  kind: "score",
  instructions: "How big is {item}?",
  levels: ["tiny", "small", "medium", "large", "huge"],
};

const batch = (questions: DecisionQuestionSpec[]): DecisionBatch => ({
  feature: "recall",
  context: "ctx",
  items: [
    { id: "i0", text: "alpha" },
    { id: "i1", text: "beta" },
  ],
  questions,
});
const O = { deadlineMs: 1000 };

interface Body {
  model: string;
  state: { items: unknown[] };
  questions: Record<string, unknown>;
  response_format?: unknown;
  temperature?: number;
}

function capture(respond: (body: { questions: Record<string, unknown> }) => unknown, status = 200) {
  const seen: Array<{
    url: string;
    headers: Record<string, string>;
    body: Body;
  }> = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Body;
    seen.push({ url, headers: (init.headers ?? {}) as Record<string, string>, body });
    return new Response(JSON.stringify(respond(body)), { status });
  }) as never;
  return { seen, fetch };
}

describe("createDecisionProvider", () => {
  it("picks the provider of the adjudicator's effective provider; heuristic has none", () => {
    expect(build(typesafeCfg()).id).toBe("typesafe");
    expect(build(ollamaCfg(), {}, {} as NodeJS.ProcessEnv).id).toBe("openai-compatible");
    expect(build(embeddingCfg(), { getEmbedder: async () => undefined }).id).toBe("embedding");
    const h = AdjudicatorConfigSchema.parse({
      enabled: true,
      provider: "heuristic",
    }) as AdjudicatorConfig;
    const r = resolveAdjudicator(h, { context: "server", env: ENV });
    expect(createDecisionProvider(r, h, { env: ENV })).toBeUndefined();
  });
});

describe("typesafe / Jev provider", () => {
  it("answers yes_no, choice and score for every kind, and sends the pinned model and bearer key", async () => {
    const { seen, fetch } = capture((body) => {
      const a: Record<string, unknown> = {};
      for (const k of Object.keys(body.questions)) {
        if (k.endsWith(".rel")) a[k] = { type: "noul", noul: 0.8 };
        else if (k.endsWith(".kind"))
          a[k] = {
            type: "choice",
            choice: "dup",
            confidence: 0.9,
            probabilities: { dup: 0.9, unrelated: 0.1 },
          };
        else
          a[k] = {
            type: "score",
            score: 1.99,
            confidence: 0.7,
            legend: { "0": "tiny", "1": "small", "2": "medium", "3": "large", "4": "huge" },
            probabilities: { "1": 0.5, "2": 0.5 },
          };
      }
      return { model: JEV_PINNED, answers: a, usage: { input_tokens: 200 } };
    });
    const p = build(typesafeCfg(), { fetch });
    expect(p.supports("yes_no")).toBe(true);
    expect(p.supports("choice")).toBe(true);
    expect(p.supports("score")).toBe(true);
    expect(p.model).toBe(JEV_PINNED);
    const res = await p.ask(batch([yn, choice, score]), O);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(`${ORIGIN}/v1/systemone`);
    expect(seen[0]?.body.model).toBe(JEV_PINNED);
    expect(JSON.stringify(seen[0]?.headers)).toContain(KEY);
    expect(Object.keys(seen[0]?.body.questions ?? {})).toEqual(
      expect.arrayContaining(["i0.rel", "i1.rel", "i0.kind", "i1.size"]),
    );
    expect(seen[0]?.body.questions["i0.kind"]).toMatchObject({ type: "choice" });
    expect(seen[0]?.body.state.items).toHaveLength(2);
    const a0 = res.answers.i0!;
    expect(a0.rel).toEqual({ kind: "yes_no", p: 0.8, calibrated: true });
    expect(a0.kind).toMatchObject({ kind: "choice", choice: "dup", calibrated: true });
    // the live legend scale: score 1.99 on 0..4 normalises to 1.99 / 4, not 1.99
    expect(a0.size).toMatchObject({ kind: "score", calibrated: true });
    expect((a0.size as { value: number }).value).toBeCloseTo(1.99 / 4, 5);
    expect(res.tokensIn).toBe(200);
    expect(res.costUsd).toBeGreaterThan(0);
  });

  it("score handling follows the legend's levels, and rejects a score above them", () => {
    const legend = { "0": "a", "1": "b", "2": "c", "3": "d", "4": "e" };
    const v = (s: number) =>
      toDecisionAnswer({ type: "score", score: s, confidence: 0.5, legend }, score) as
        | { value: number }
        | undefined;
    expect(v(0)?.value).toBe(0);
    expect(v(4)?.value).toBe(1);
    expect(v(0.9)?.value).toBeCloseTo(0.225, 5); // not inflated 4x
    expect(v(4.5)).toBeUndefined();
    // no legend: the rubric's own top level (levels.length - 1)
    expect(
      (toDecisionAnswer({ type: "score", score: 2 }, score) as { value: number }).value,
    ).toBeCloseTo(0.5, 5);
  });

  it("drops malformed, wrong-kind and unknown-option answers but keeps the good ones", async () => {
    const { fetch } = capture(() => ({
      answers: {
        "i0.rel": { type: "noul", noul: 0.7 },
        "i1.rel": { type: "noul", noul: 7 }, // out of range
        "i0.kind": { type: "choice", choice: "mystery" }, // not an option
        "i1.kind": { type: "noul", noul: 0.5 }, // wrong kind
      },
    }));
    const p = build(typesafeCfg(), { fetch });
    const res = await p.ask(batch([yn, choice]), O);
    expect(res.answers.i0?.rel).toMatchObject({ p: 0.7 });
    expect(res.answers.i0?.kind).toBeUndefined();
    expect(res.answers.i1?.rel).toBeUndefined();
    expect(res.answers.i1?.kind).toBeUndefined();
  });

  it("pins a moving alias to the tuned model", () => {
    const cfg = AdjudicatorConfigSchema.parse({
      enabled: true,
      provider: "typesafe",
      remoteConsent: true,
      remoteConsentOrigins: [ORIGIN],
      typesafe: { model: "jev-latest" },
    }) as AdjudicatorConfig;
    expect(build(cfg).model).toBe(JEV_PINNED);
  });

  it("no key is a no_key ProviderError and no call", async () => {
    const { seen, fetch } = capture(() => ({ answers: {} }));
    // resolution without a key degrades to the heuristic (no provider at all) ...
    const cfg = typesafeCfg();
    const none = resolveAdjudicator(cfg, { context: "server", env: {} as NodeJS.ProcessEnv });
    expect(createDecisionProvider(none, cfg, { env: {} as NodeJS.ProcessEnv })).toBeUndefined();
    // ... and a provider whose key vanished after resolution refuses without a call
    const r = resolveAdjudicator(cfg, { context: "server", env: ENV });
    const p = createDecisionProvider(r, cfg, { env: {} as NodeJS.ProcessEnv, fetch })!;
    await expect(p.ask(batch([yn]), O)).rejects.toMatchObject({ kind: "no_key" });
    expect(seen).toHaveLength(0);
  });

  it("an unexpected response shape is an invalid ProviderError", async () => {
    const { fetch } = capture(() => ({ nope: 1 }));
    const p = build(typesafeCfg(), { fetch });
    await expect(p.ask(batch([yn]), O)).rejects.toBeInstanceOf(ProviderError);
    await expect(p.ask(batch([yn]), O)).rejects.toMatchObject({ kind: "invalid" });
  });

  it("an HTTP error status is a typed ProviderError", async () => {
    const { fetch } = capture(() => ({ error: "x" }), 500);
    const p = build(typesafeCfg(), { fetch });
    await expect(p.ask(batch([yn]), O)).rejects.toMatchObject({ kind: "http_error" });
  });
});

describe("OpenAI-compatible provider", () => {
  const reply = (
    answers: unknown[],
    usage: unknown = { prompt_tokens: 12, completion_tokens: 6 },
  ) => ({
    model: "llama-test",
    choices: [{ message: { content: JSON.stringify({ answers }) } }],
    usage,
  });

  it("answers yes_no, choice and score as uncalibrated, posting JSON to /chat/completions", async () => {
    const { seen, fetch } = capture(() =>
      reply([
        { id: "i0.rel", p: 0.9 },
        { id: "i1.rel", p: 1.7 }, // clamped
        { id: "i0.kind", choice: "dup" },
        { id: "i1.kind", choice: "nope" }, // unknown option: dropped
        { id: "i0.size", level: 2 },
        { id: "i1.size", level: 9 }, // out of range: dropped
      ]),
    );
    const p = build(ollamaCfg(), { fetch }, {} as NodeJS.ProcessEnv);
    expect(p.remote).toBe(false);
    for (const k of ["yes_no", "choice", "score"] as const) expect(p.supports(k)).toBe(true);
    const res = await p.ask(batch([yn, choice, score]), O);
    expect(seen[0]?.url).toMatch(/\/chat\/completions$/);
    expect(seen[0]?.body.response_format).toEqual({ type: "json_object" });
    expect(seen[0]?.body.temperature).toBe(0);
    expect(seen[0]?.body.model).toBe("llama-test");
    expect(res.answers.i0?.rel).toEqual({ kind: "yes_no", p: 0.9, calibrated: false });
    expect(res.answers.i1?.rel).toEqual({ kind: "yes_no", p: 1, calibrated: false });
    expect(res.answers.i0?.kind).toMatchObject({ choice: "dup", calibrated: false });
    expect(res.answers.i1?.kind).toBeUndefined();
    expect(res.answers.i0?.size).toMatchObject({ kind: "score", value: 0.5, calibrated: false });
    expect(res.answers.i1?.size).toBeUndefined();
    expect(res.tokensIn).toBe(12);
    expect(res.costUsd).toBe(0); // a local endpoint is free
  });

  it("accepts a fenced JSON answer", async () => {
    const fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [
            { message: { content: '```json\n{"answers":[{"id":"i0.rel","p":0.95}]}\n```' } },
          ],
        }),
        { status: 200 },
      )) as never;
    const p = build(ollamaCfg(), { fetch }, {} as NodeJS.ProcessEnv);
    const res = await p.ask(batch([yn]), O);
    expect(res.answers.i0?.rel).toMatchObject({ p: 0.95 });
    expect(res.answers.i1?.rel).toBeUndefined();
  });

  it("non-JSON content, an empty completion and a missing answers array are invalid", async () => {
    for (const content of ["I think yes.", "", '{"nothing":1}']) {
      const fetch = (async () =>
        new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
          status: 200,
        })) as never;
      const p = build(ollamaCfg(), { fetch }, {} as NodeJS.ProcessEnv);
      await expect(p.ask(batch([yn]), O)).rejects.toMatchObject({ kind: "invalid" });
    }
  });
});

const pOf = (a: unknown): number => (a as { p: number }).p;

describe("embedding provider", () => {
  /** Vectors: the context and the items are placed at known angles. */
  const embedder = (): Embedder => ({
    model: "fake-embed",
    async embed(texts, kind) {
      return texts.map((t) => {
        if (kind === "query") return Float32Array.from([1, 0]);
        if (t === "close") return Float32Array.from([1, 0]);
        if (t === "far") return Float32Array.from([0, 1]);
        return Float32Array.from([0.8, 0.6]);
      });
    },
  });

  it("supports only yes_no questions that name a similarity, and only with an embedder", () => {
    const withEmb = build(embeddingCfg(), { getEmbedder: async () => embedder() });
    expect(withEmb.supports("yes_no", ynSim)).toBe(true);
    expect(withEmb.supports("yes_no", yn)).toBe(false);
    expect(withEmb.supports("choice", choice)).toBe(false);
    expect(withEmb.supports("score", score)).toBe(false);
    const without = build(embeddingCfg(), {});
    expect(without.supports("yes_no", ynSim)).toBe(false);
  });

  it("answers by rescaled cosine similarity, never calibrated, at no cost", async () => {
    const p = build(embeddingCfg(), { getEmbedder: async () => embedder() });
    const res = await p.ask(
      {
        ...batch([ynSim]),
        items: [
          { id: "i0", text: "close" },
          { id: "i1", text: "far" },
          { id: "i2", text: "mid" },
        ],
      },
      O,
    );
    expect(p.remote).toBe(false);
    expect(res.answers.i0?.rel).toEqual({ kind: "yes_no", p: 1, calibrated: false });
    expect(res.answers.i1?.rel).toEqual({ kind: "yes_no", p: 0, calibrated: false });
    const mid = pOf(res.answers.i2?.rel);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    expect(res.costUsd).toBe(0);
    expect(res.tokensIn).toBe(0);
    expect(res.model).toBe("fake-embed");
  });

  it("the duplicate form is stricter than relevance for the same similarity", async () => {
    const p = build(embeddingCfg(), { getEmbedder: async () => embedder() });
    const dup: DecisionQuestionSpec = { ...yn, name: "dup", similarity: "duplicate" };
    const res = await p.ask({ ...batch([ynSim, dup]), items: [{ id: "i0", text: "mid" }] }, O);
    // cos = 0.8: below the 0.85 duplicate floor, above the relevance floor
    expect(pOf(res.answers.i0?.dup)).toBe(0);
    expect(pOf(res.answers.i0?.rel)).toBeGreaterThan(0);
  });

  it("no embedder, a failing embedder and a slow embedder are typed ProviderErrors", async () => {
    await expect(
      build(embeddingCfg(), { getEmbedder: async () => undefined }).ask(batch([ynSim]), O),
    ).rejects.toMatchObject({ kind: "invalid" });
    const boom: Embedder = {
      model: "x",
      embed: async () => {
        throw new Error("model crashed");
      },
    };
    await expect(
      build(embeddingCfg(), { getEmbedder: async () => boom }).ask(batch([ynSim]), O),
    ).rejects.toMatchObject({ kind: "invalid" });
    const slow: Embedder = { model: "x", embed: () => new Promise(() => {}) };
    await expect(
      build(embeddingCfg(), { getEmbedder: async () => slow }).ask(batch([ynSim]), {
        deadlineMs: 30,
      }),
    ).rejects.toMatchObject({ kind: "timeout" });
  });

  it("the wrong number of vectors is invalid", async () => {
    const short: Embedder = {
      model: "x",
      embed: async (t, k) =>
        k === "query" ? [Float32Array.from([1])] : t.slice(1).map(() => Float32Array.from([1])),
    };
    await expect(
      build(embeddingCfg(), { getEmbedder: async () => short }).ask(batch([ynSim]), O),
    ).rejects.toMatchObject({ kind: "invalid" });
  });
});
