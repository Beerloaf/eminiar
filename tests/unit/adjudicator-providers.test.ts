import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Resolved, resolveAdjudicator } from "../../src/adjudicator/config.js";
import {
  buildCatalogue,
  COMPLEXITY_CRITERIA,
  openaiSchema,
  SCHEMA_MAX_CHARS,
  schemaText,
} from "../../src/adjudicator/prompt.js";
import {
  type FetchLike,
  getJson,
  ProviderError,
  postJson,
  RETRY_MIN_REMAINING_MS,
} from "../../src/adjudicator/providers/http.js";
import {
  createProvider,
  registerProvider,
  resetProviders,
} from "../../src/adjudicator/providers/index.js";
import { createOpenAIProvider } from "../../src/adjudicator/providers/openai.js";
import {
  createTypesafeProvider,
  JEV_PINNED,
  pinJevModel,
} from "../../src/adjudicator/providers/typesafe.js";
import { resetSecrets } from "../../src/adjudicator/secrets.js";
import type { AdjudicationRequest, AdjudicatorProvider } from "../../src/adjudicator/types.js";
import { type AdjudicatorConfig, ConfigSchema } from "../../src/config.js";

/** Must never appear in an error, a log line or a request body (only in the Authorization header). */
const SENTINEL = "sk-SENTINEL-1234567890abcdefXYZ";

beforeEach(() => {
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-adj-prov-"));
  resetSecrets();
  resetProviders();
});
afterEach(() => {
  delete process.env.EMINIAR_HOME;
  resetSecrets();
  resetProviders();
});

const adj = (over: Record<string, unknown> = {}): AdjudicatorConfig =>
  ConfigSchema.parse({ adjudicator: { enabled: true, remoteConsent: true, ...over } }).adjudicator;

interface Call {
  url: string;
  init: RequestInit;
  body: Record<string, unknown> | undefined;
}

type Reply = Response | ((call: Call) => Response | Promise<Response>);

/** A fetch that records calls and answers from a queue (the last reply repeats). */
function mockFetch(...replies: Reply[]): FetchLike & { calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const call: Call = {
      url,
      init,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const r = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (!r) throw new Error("no reply queued");
    return typeof r === "function" ? r(call) : r.clone();
  }) as FetchLike & { calls: Call[] };
  f.calls = calls;
  return f;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

/** Never answers; rejects when the request is aborted, like fetch does. */
const hang: Reply = (call) =>
  new Promise<Response>((_, reject) => {
    call.init.signal?.addEventListener("abort", () =>
      reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })),
    );
  });

const rfType = (c: Call | undefined): string | undefined =>
  (c?.body?.response_format as { type?: string } | undefined)?.type;

const headerOf = (c: Call | undefined, name: string): string | undefined =>
  (c?.init.headers as Record<string, string> | undefined)?.[name];

const reqs = (n: number, extra: Partial<AdjudicationRequest> = {}): AdjudicationRequest[] =>
  Array.from({ length: n }, (_, i) => ({
    key: `k${i}`,
    surface: "plan" as const,
    text: `task ${i}: rename the helper in src/a${i}.ts`,
    ...extra,
  }));

const signal = () => new AbortController().signal;

async function caught(p: Promise<unknown>): Promise<ProviderError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ProviderError);
    return e as ProviderError;
  }
  throw new Error("expected a rejection");
}

function expectNoSentinel(...texts: unknown[]): void {
  for (const t of texts) {
    const s = typeof t === "string" ? t : JSON.stringify(t, Object.getOwnPropertyNames(t ?? {}));
    expect(s).not.toContain(SENTINEL);
    expect(String(t)).not.toContain(SENTINEL);
  }
}

// ---------------------------------------------------------------------------------------------

describe("http layer", () => {
  it("posts JSON with the bearer key and returns the parsed body", async () => {
    const f = mockFetch(json({ ok: 1 }));
    const r = await postJson(
      "https://x.test/v1/a",
      { q: 1 },
      { deadlineMs: 1000, key: SENTINEL, fetch: f },
    );
    expect(r).toMatchObject({ status: 200, json: { ok: 1 }, attempts: 1 });
    expect(f.calls[0]?.init.method).toBe("POST");
    expect(headerOf(f.calls[0], "authorization")).toBe(`Bearer ${SENTINEL}`);
    expect(headerOf(f.calls[0], "content-type")).toBe("application/json");
    expect(f.calls[0]?.body).toEqual({ q: 1 });
  });

  it("retries a 429 once when enough time remains", async () => {
    const f = mockFetch(json({}, 429, { "retry-after": "0" }), json({ ok: 2 }));
    const r = await postJson("https://x.test/a", {}, { deadlineMs: 2000, fetch: f });
    expect(r.attempts).toBe(2);
    expect(r.json).toEqual({ ok: 2 });
    expect(f.calls).toHaveLength(2);
  });

  it("gives up after one retry with rate_limited", async () => {
    const f = mockFetch(json({}, 529, { "retry-after": "0" }));
    const e = await caught(postJson("https://x.test/a", {}, { deadlineMs: 2000, fetch: f }));
    expect(e.kind).toBe("rate_limited");
    expect(e.status).toBe(529);
    expect(f.calls).toHaveLength(2);
  });

  it(`does not retry when less than ${RETRY_MIN_REMAINING_MS} ms would remain`, async () => {
    const f = mockFetch(json({}, 429), json({ ok: 1 }));
    // 350 ms budget minus the 100 ms default backoff leaves 250 ms.
    const e = await caught(postJson("https://x.test/a", {}, { deadlineMs: 350, fetch: f }));
    expect(e.kind).toBe("rate_limited");
    expect(f.calls).toHaveLength(1);
  });

  it("does not retry when Retry-After is longer than the deadline allows", async () => {
    const f = mockFetch(json({}, 429, { "retry-after": "5" }), json({ ok: 1 }));
    const e = await caught(postJson("https://x.test/a", {}, { deadlineMs: 2000, fetch: f }));
    expect(e.kind).toBe("rate_limited");
    expect(f.calls).toHaveLength(1);
  });

  it("classifies 4xx/5xx as http_error and never retries them", async () => {
    const f = mockFetch(json({ error: "boom" }, 503));
    const e = await caught(postJson("https://x.test/a", {}, { deadlineMs: 2000, fetch: f }));
    expect(e.kind).toBe("http_error");
    expect(e.status).toBe(503);
    expect(e.body).toContain("boom");
    expect(f.calls).toHaveLength(1);
  });

  it("aborts at the deadline with timeout", async () => {
    const f = mockFetch(hang);
    const t0 = Date.now();
    const e = await caught(postJson("https://x.test/a", {}, { deadlineMs: 60, fetch: f }));
    expect(e.kind).toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(f.calls[0]?.init.signal?.aborted).toBe(true);
  });

  it("ends as timeout when the caller's signal aborts", async () => {
    const f = mockFetch(hang);
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 20);
    const e = await caught(
      postJson("https://x.test/a", {}, { deadlineMs: 5000, fetch: f, signal: ctl.signal }),
    );
    expect(e.kind).toBe("timeout");
  });

  it("does not send when the deadline is already spent", async () => {
    const f = mockFetch(json({}));
    const e = await caught(postJson("https://x.test/a", {}, { deadlineMs: 0, fetch: f }));
    expect(e.kind).toBe("timeout");
    expect(f.calls).toHaveLength(0);
  });

  it("classifies a non-JSON body as invalid", async () => {
    const f = mockFetch(new Response("<html>gateway</html>", { status: 200 }));
    expect((await caught(getJson("https://x.test/a", { deadlineMs: 1000, fetch: f }))).kind).toBe(
      "invalid",
    );
  });

  it("classifies a refused connection as http_error", async () => {
    const f = mockFetch(() => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    });
    const e = await caught(postJson("http://localhost:1/a", {}, { deadlineMs: 1000, fetch: f }));
    expect(e.kind).toBe("http_error");
    expect(e.message).toContain("ECONNREFUSED");
  });

  it("keeps the key out of errors and log lines (sentinel)", async () => {
    const logs: string[] = [];
    const log = (l: string) => logs.push(l);
    const errors: ProviderError[] = [];
    // The server echoes the key in its body.
    for (const reply of [
      json({ error: `invalid key ${SENTINEL}` }, 401),
      json({ error: `slow down ${SENTINEL}` }, 429, { "retry-after": "0" }),
      new Response(`not json ${SENTINEL}`, { status: 200 }),
      (() => {
        throw new TypeError(`connect failed for Bearer ${SENTINEL}`);
      }) as Reply,
    ]) {
      const f = mockFetch(reply);
      errors.push(
        await caught(
          postJson(
            `https://x.test/a?k=${SENTINEL}`,
            {},
            { deadlineMs: 1000, key: SENTINEL, fetch: f, log },
          ),
        ),
      );
    }
    errors.push(
      await caught(
        postJson(
          "https://x.test/a",
          {},
          { deadlineMs: 30, key: SENTINEL, fetch: mockFetch(hang), log },
        ),
      ),
    );
    expect(errors.map((e) => e.kind)).toEqual([
      "http_error",
      "rate_limited",
      "invalid",
      "http_error",
      "timeout",
    ]);
    expect(logs.length).toBeGreaterThanOrEqual(5);
    for (const e of errors) expectNoSentinel(e, e.message, e.body ?? "", e.stack ?? "");
    for (const l of logs) expectNoSentinel(l);
  });
});

// ---------------------------------------------------------------------------------------------

function typesafe(
  over: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv = { TYPESAFE_API_KEY: SENTINEL },
) {
  const cfg = adj({ provider: "typesafe", ...over });
  const r = resolveAdjudicator(cfg, { context: "server", env });
  return { cfg, r };
}

/** A Jev reply answering every question in the request. */
function jevReply(
  call: Call,
  o: { score?: number; usage?: { input_tokens: number; output_tokens: number } } = {},
) {
  const qs = (call.body?.questions ?? {}) as Record<string, { type: string; criteria?: unknown }>;
  const answers: Record<string, unknown> = {};
  for (const [id, q] of Object.entries(qs)) {
    if (q.type === "score") {
      // Like the live API: the score is on the criteria's levels, echoed in `legend`.
      const legend = Object.fromEntries((q.criteria as string[]).map((c, i) => [String(i), c]));
      answers[id] = { type: "score", score: o.score ?? 2, confidence: 0.8, legend };
    }
    else if (q.type === "noul")
      answers[id] = { type: "noul", noul: id.endsWith(".risky") ? 0.9 : 0.2 };
    else {
      const opts = Object.keys(q.criteria as Record<string, string>);
      const probabilities = Object.fromEntries(
        opts.map((x, i) => [x, i === 1 ? 0.6 : 0.4 / (opts.length - 1)]),
      );
      answers[id] = { type: "choice", choice: opts[1], confidence: 0.6, probabilities };
    }
  }
  return json({
    model: JEV_PINNED,
    answers,
    usage: o.usage ?? { input_tokens: 1000, output_tokens: 70 },
  });
}

describe("redirects are never followed (#33)", () => {
  /** A local HTTP server; every request it receives is recorded with its auth header and body. */
  async function server(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
  ): Promise<{ url: string; hits: string[]; close: () => Promise<void> }> {
    const hits: string[] = [];
    const s = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        hits.push(`${req.method} ${req.url} ${req.headers.authorization ?? "-"} ${body}`);
        handler(req, res);
      });
    });
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const { port } = s.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${port}`,
      hits,
      close: () => new Promise<void>((r) => s.close(() => r())),
    };
  }

  it("a 307 is an http_error and neither the prompt nor the key reaches the redirect target", async () => {
    const other = await server((_q, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    const first = await server((_q, res) => {
      res.writeHead(307, { location: `${other.url}/steal` });
      res.end();
    });
    try {
      const err = await postJson(
        `${first.url}/v1/chat/completions`,
        { prompt: "secret text" },
        {
          deadlineMs: 2000,
          key: SENTINEL,
        },
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).kind).toBe("http_error");
      expect((err as ProviderError).status).toBe(307);
      expect((err as ProviderError).message).toMatch(/redirect to 127\.0\.0\.1:\d+\/steal refused/);
      expect((err as ProviderError).message).not.toContain(SENTINEL);
      expect(first.hits).toHaveLength(1);
      expect(other.hits).toEqual([]);
      // GET (probe) is refused the same way.
      await expect(
        getJson(`${first.url}/v1/models`, { deadlineMs: 2000, key: SENTINEL }),
      ).rejects.toMatchObject({
        kind: "http_error",
        status: 307,
      });
      expect(other.hits).toEqual([]);
    } finally {
      await first.close();
      await other.close();
    }
  });

  it("asks fetch not to follow redirects", async () => {
    const seen: RequestInit[] = [];
    const f: FetchLike = async (_u, init) => {
      seen.push(init);
      return new Response("{}", { status: 200 });
    };
    await postJson("https://h.example/v1", {}, { deadlineMs: 1000, fetch: f });
    expect(seen[0]?.redirect).toBe("manual");
  });
});

describe("typesafe (Jev) provider", () => {
  it("pins the model and never sends an alias", () => {
    expect(pinJevModel("jev-latest")).toBe(JEV_PINNED);
    expect(pinJevModel("jev-preview")).toBe(JEV_PINNED);
    expect(pinJevModel(undefined)).toBe(JEV_PINNED);
    expect(pinJevModel("jev-1.13.0")).toBe("jev-1.13.0");
  });

  it("sends one request with namespaced questions, the catalogue and redacted text", async () => {
    const { cfg, r } = typesafe({ typesafe: { model: "jev-latest" } });
    expect(r.provider).toBe("typesafe");
    const f = mockFetch((c) => jevReply(c));
    const p = createTypesafeProvider(r, cfg, { fetch: f, env: { TYPESAFE_API_KEY: SENTINEL } });
    const batch = reqs(3);
    batch[0] = { ...batch[0]!, text: `fix login, token=${SENTINEL}` };
    await p.adjudicate(batch, { signal: signal(), deadlineMs: 2000 });

    expect(f.calls).toHaveLength(1);
    const c = f.calls[0]!;
    expect(c.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(headerOf(c, "authorization")).toBe(`Bearer ${SENTINEL}`);
    expect(c.body?.model).toBe(JEV_PINNED);
    const qs = c.body?.questions as Record<
      string,
      { type: string; instructions: string; criteria?: unknown }
    >;
    expect(Object.keys(qs).sort()).toEqual(
      ["i0", "i1", "i2"]
        .flatMap((i) => [
          `${i}.complexity`,
          `${i}.needs_plan`,
          `${i}.risky`,
          `${i}.role`,
          `${i}.tier`,
        ])
        .sort(),
    );
    expect(qs["i1.complexity"]).toMatchObject({
      type: "score",
      criteria: [...COMPLEXITY_CRITERIA],
    });
    expect(qs["i1.tier"]?.type).toBe("choice");
    expect(Object.keys(qs["i1.tier"]?.criteria as object)).toEqual(["haiku", "sonnet", "opus"]);
    expect(qs["i1.risky"]?.type).toBe("noul");
    for (const [id, q] of Object.entries(qs))
      expect(q.instructions).toContain(`"${id.split(".")[0]}"`);
    const state = c.body?.state as {
      catalogue: { tiers: string[]; roles: unknown[]; tools: string[] };
      items: Array<{ id: string; text: string }>;
    };
    expect(state.catalogue.tiers).toEqual(["haiku", "sonnet", "opus"]);
    expect(state.catalogue.roles.length).toBeGreaterThan(3);
    expect(state.items.map((i) => i.id)).toEqual(["i0", "i1", "i2"]);
    // The request key never leaves the machine; the text is redacted.
    expect(JSON.stringify(c.body)).not.toContain("k0");
    expect(JSON.stringify(c.body)).not.toContain(SENTINEL);
  });

  it("asks the tool question only when weights.features.toolProvider > 0", async () => {
    const f = mockFetch((c) => jevReply(c));
    const { cfg, r } = typesafe({ weights: { features: { toolProvider: 0.2 } } });
    const p = createTypesafeProvider(r, cfg, { fetch: f, env: { TYPESAFE_API_KEY: SENTINEL } });
    expect(p.dims).toContain("tool");
    const res = await p.adjudicate(reqs(1), { signal: signal(), deadlineMs: 2000 });
    expect(Object.keys(f.calls[0]?.body?.questions as object)).toContain("i0.tool");
    expect(res.answers[0]?.tool?.calibrated).toBe(true);
  });

  it("maps answers to calibrated Dists, complexity on the rubric levels and input-token cost", async () => {
    const { cfg, r } = typesafe();
    const f = mockFetch((c) =>
      jevReply(c, { score: 3, usage: { input_tokens: 2_000_000, output_tokens: 500 } }),
    );
    const p = createTypesafeProvider(r, cfg, { fetch: f, env: { TYPESAFE_API_KEY: SENTINEL } });
    const res = await p.adjudicate(reqs(2), { signal: signal(), deadlineMs: 2000 });
    expect(res.model).toBe(JEV_PINNED);
    expect(res.answers.map((a) => a.key)).toEqual(["k0", "k1"]);
    const a = res.answers[0]!;
    expect(a.complexity).toEqual({ value: 3, confidence: 0.8 });
    expect(a.tier?.calibrated).toBe(true);
    expect(a.tier?.confidence).toBe(0.6);
    expect(Object.values(a.tier?.probs ?? {}).reduce((s, x) => s + x, 0)).toBeCloseTo(1);
    expect(a.tier?.probs.sonnet).toBeCloseTo(0.6);
    expect(a.role?.calibrated).toBe(true);
    expect(a.tool).toBeUndefined();
    expect(a.risky).toBe(0.9);
    expect(a.needsPlan).toBe(0.2);
    expect(res.usage.inTok).toBe(2_000_000);
    expect(res.usage.outTok).toBe(500);
    expect(res.usage.costUsd).toBeCloseTo(0.084); // output tokens are free
  });

  it("splits more than 10 items into at most 2 requests of at most 10", async () => {
    const { cfg, r } = typesafe();
    const f = mockFetch((c) => jevReply(c));
    const p = createTypesafeProvider(r, cfg, { fetch: f, env: { TYPESAFE_API_KEY: SENTINEL } });
    const res = await p.adjudicate(reqs(12), { signal: signal(), deadlineMs: 2000 });
    expect(f.calls).toHaveLength(2);
    expect(
      f.calls.map(
        (c) => ((c.body?.state as { items?: unknown[] } | undefined)?.items ?? []).length,
      ),
    ).toEqual([10, 2]);
    expect(res.answers).toHaveLength(12);
    expect(res.usage.inTok).toBe(2000);

    const f2 = mockFetch((c) => jevReply(c));
    const p2 = createTypesafeProvider(r, cfg, { fetch: f2, env: { TYPESAFE_API_KEY: SENTINEL } });
    const res2 = await p2.adjudicate(reqs(25), { signal: signal(), deadlineMs: 2000 });
    expect(f2.calls).toHaveLength(2);
    expect(res2.answers).toHaveLength(20); // the rest fall back to the heuristic
  });

  it("returns the answers of a successful half when the other request fails", async () => {
    const { cfg, r } = typesafe();
    const f = mockFetch((c) => jevReply(c), json({ error: "x" }, 500));
    const p = createTypesafeProvider(r, cfg, { fetch: f, env: { TYPESAFE_API_KEY: SENTINEL } });
    const res = await p.adjudicate(reqs(15), { signal: signal(), deadlineMs: 2000 });
    expect(res.answers).toHaveLength(10);
  });

  it("rejects malformed answers as invalid and skips malformed items", async () => {
    const { cfg, r } = typesafe();
    const env = { TYPESAFE_API_KEY: SENTINEL };
    const bad = createTypesafeProvider(r, cfg, { fetch: mockFetch(json({ nope: true })), env });
    expect(
      (await caught(bad.adjudicate(reqs(1), { signal: signal(), deadlineMs: 2000 }))).kind,
    ).toBe("invalid");

    const odd = createTypesafeProvider(r, cfg, {
      fetch: mockFetch(
        json({
          answers: {
            "i0.complexity": { type: "score", score: 7 },
            "i0.tier": { type: "choice", choice: "gpt", confidence: 0.9 },
            "i1.complexity": { type: "score", score: 0, confidence: 0.9 },
          },
        }),
      ),
      env,
    });
    const res = await odd.adjudicate(reqs(2), { signal: signal(), deadlineMs: 2000 });
    expect(res.answers).toEqual([{ key: "k1", complexity: { value: 0, confidence: 0.9 } }]);
  });

  it("reads the complexity score on the legend's levels, not 0..1 (live jev-1.14.0 shapes)", async () => {
    const { cfg, r } = typesafe();
    const legend = Object.fromEntries(COMPLEXITY_CRITERIA.map((c, i) => [String(i), c]));
    const f = mockFetch(
      json({
        answers: {
          // A score above 1 used to fail the schema and be dropped.
          "i0.complexity": { type: "score", score: 1.99, confidence: 0.96, legend },
          // A score below 1 used to be multiplied by 4 (0.9 → 3.6 for a typo fix).
          "i1.complexity": { type: "score", score: 0.9, confidence: 0.98, legend },
          // Above the legend's top level: malformed, skipped.
          "i2.complexity": { type: "score", score: 5, confidence: 0.9, legend },
          // A legend on another scale is rescaled to 0..4.
          "i3.complexity": {
            type: "score",
            score: 1,
            confidence: 0.7,
            legend: { "0": "low", "1": "mid", "2": "high" },
          },
        },
      }),
    );
    const p = createTypesafeProvider(r, cfg, { fetch: f, env: { TYPESAFE_API_KEY: SENTINEL } });
    const res = await p.adjudicate(reqs(4), { signal: signal(), deadlineMs: 2000 });
    expect(res.answers).toEqual([
      { key: "k0", complexity: { value: 1.99, confidence: 0.96 } },
      { key: "k1", complexity: { value: 0.9, confidence: 0.98 } },
      { key: "k3", complexity: { value: 2, confidence: 0.7 } },
    ]);
  });

  it("throws no_key without sending when the key is gone at send time", async () => {
    const { cfg, r } = typesafe();
    const f = mockFetch(json({}));
    const p = createTypesafeProvider(r, cfg, { fetch: f, env: {} });
    expect((await caught(p.adjudicate(reqs(1), { signal: signal(), deadlineMs: 2000 }))).kind).toBe(
      "no_key",
    );
    expect(f.calls).toHaveLength(0);
  });

  it("probes GET /models and reports failures without the key", async () => {
    const { cfg, r } = typesafe();
    const env = { TYPESAFE_API_KEY: SENTINEL };
    const ok = await createTypesafeProvider(r, cfg, {
      fetch: mockFetch(json({ data: [{ id: "jev-1.14.0" }, { id: "jev-latest" }] })),
      env,
    }).probe({ signal: signal() });
    expect(ok).toMatchObject({ ok: true, detail: expect.stringContaining("reachable") });

    const f = mockFetch(json({ error: `bad ${SENTINEL}` }, 401));
    const bad = await createTypesafeProvider(r, cfg, { fetch: f, env }).probe({ signal: signal() });
    expect(f.calls[0]?.url).toBe("https://api.typesafe.ai/v1/models");
    expect(bad.ok).toBe(false);
    expect(bad.detail).toContain("http_error");
    expectNoSentinel(bad.detail);
  });
});

// ---------------------------------------------------------------------------------------------

function openai(
  over: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv = { GROQ_API_KEY: SENTINEL },
) {
  const cfg = adj({ provider: "openai-compatible", ...over });
  const r = resolveAdjudicator(cfg, { context: "server", env });
  return { cfg, r, env };
}

function completion(
  items: unknown[],
  o: { usage?: unknown; fence?: boolean; model?: string } = {},
) {
  const content = JSON.stringify({ items });
  return json({
    model: o.model ?? "openai/gpt-oss-20b",
    choices: [
      {
        message: {
          role: "assistant",
          content: o.fence ? `\`\`\`json\n${content}\n\`\`\`` : content,
        },
      },
    ],
    usage: o.usage ?? { prompt_tokens: 1_000_000, completion_tokens: 100_000 },
  });
}

const item = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  complexity: 2,
  tier: "sonnet",
  role: "coder",
  risky: true,
  confidence: 0.8,
  ...over,
});

/** Every object node: additionalProperties false and every property required. */
function assertStrict(node: unknown): void {
  if (!node || typeof node !== "object") return;
  const n = node as Record<string, unknown>;
  if (n.type === "object") {
    expect(n.additionalProperties).toBe(false);
    expect([...(n.required as string[])].sort()).toEqual(
      Object.keys(n.properties as object).sort(),
    );
  }
  for (const v of Object.values(n)) assertStrict(v);
}

describe("openai-compatible provider", () => {
  it("sends a strict json_schema request with the rubric and the items", async () => {
    const { cfg, r, env } = openai();
    const f = mockFetch(completion([item("i0"), item("i1")]));
    const p = createOpenAIProvider(r, cfg, { fetch: f, env });
    await p.adjudicate(reqs(2), { signal: signal(), deadlineMs: 2000 });

    const c = f.calls[0]!;
    expect(c.url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(headerOf(c, "authorization")).toBe(`Bearer ${SENTINEL}`);
    const b = c.body!;
    expect(b.model).toBe("openai/gpt-oss-20b");
    expect(b.temperature).toBe(0);
    expect(b.max_tokens).toBe(64 + 48 * 2);
    expect(b.reasoning_effort).toBe("low");
    const rf = b.response_format as {
      type: string;
      json_schema: { strict: boolean; schema: unknown };
    };
    expect(rf.type).toBe("json_schema");
    expect(rf.json_schema.strict).toBe(true);
    assertStrict(rf.json_schema.schema);
    expect(schemaText(rf.json_schema.schema).length).toBeLessThanOrEqual(SCHEMA_MAX_CHARS);
    const [sys, user] = b.messages as Array<{ role: string; content: string }>;
    expect(sys?.role).toBe("system");
    expect(sys?.content).toContain(COMPLEXITY_CRITERIA[4]);
    expect(sys?.content).not.toContain('"additionalProperties"');
    expect(JSON.parse(user?.content ?? "{}").items.map((i: { id: string }) => i.id)).toEqual([
      "i0",
      "i1",
    ]);
  });

  it("keeps the schema under 5000 chars even with many long custom roles", () => {
    const roles = Array.from({ length: 40 }, (_, i) => ({
      name: `custom-role-with-a-long-name-${i}`,
      description: "x".repeat(300),
    }));
    const cat = buildCatalogue(reqs(1, { hints: { roles } }), {
      tiers: ["haiku", "sonnet", "opus", "fable"],
    });
    const ids = Array.from({ length: 20 }, (_, i) => `i${i}`);
    expect(schemaText(openaiSchema(cat, ids, { askTool: true })).length).toBeLessThanOrEqual(
      SCHEMA_MAX_CHARS,
    );
    const small = buildCatalogue(reqs(1), { tiers: ["haiku", "sonnet", "opus"] });
    expect(schemaText(openaiSchema(small, ids, { askTool: true })).length).toBeLessThanOrEqual(
      SCHEMA_MAX_CHARS,
    );
  });

  it("maps answers to one-hot, uncalibrated Dists and prices them", async () => {
    const { cfg, r, env } = openai();
    const f = mockFetch(
      completion([item("i1", { risky: false, tier: "opus", complexity: 4 }), item("i0")]),
    );
    const res = await createOpenAIProvider(r, cfg, { fetch: f, env }).adjudicate(reqs(2), {
      signal: signal(),
      deadlineMs: 2000,
    });
    expect(res.answers).toEqual([
      {
        key: "k0",
        complexity: { value: 2, confidence: 0.8 },
        tier: { probs: { sonnet: 1 }, confidence: 0.8, calibrated: false },
        role: { probs: { coder: 1 }, confidence: 0.8, calibrated: false },
        risky: 1,
      },
      {
        key: "k1",
        complexity: { value: 4, confidence: 0.8 },
        tier: { probs: { opus: 1 }, confidence: 0.8, calibrated: false },
        role: { probs: { coder: 1 }, confidence: 0.8, calibrated: false },
        risky: 0,
      },
    ]);
    // groq: 1M in × 0.075 + 0.1M out × 0.30
    expect(res.usage).toEqual({
      inTok: 1_000_000,
      outTok: 100_000,
      costUsd: expect.closeTo(0.105, 6),
    });
  });

  it("records a null cost when the preset price is unknown", async () => {
    const { cfg, r, env } = openai(
      { openai: { preset: "cerebras" } },
      { CEREBRAS_API_KEY: SENTINEL },
    );
    const f = mockFetch(completion([item("i0")]));
    const res = await createOpenAIProvider(r, cfg, { fetch: f, env }).adjudicate(reqs(1), {
      signal: signal(),
      deadlineMs: 2000,
    });
    expect(f.calls[0]?.url).toBe("https://api.cerebras.ai/v1/chat/completions");
    expect(res.usage.costUsd).toBeNull();
  });

  it("json auto: retries a response_format 400 once with json_object, then remembers", async () => {
    const { cfg, r, env } = openai();
    const f = mockFetch(
      json(
        { error: { message: "response_format json_schema is not supported for this model" } },
        400,
      ),
      completion([item("i0")], { fence: true }),
    );
    const p = createOpenAIProvider(r, cfg, { fetch: f, env });
    const res = await p.adjudicate(reqs(1), { signal: signal(), deadlineMs: 2000 });
    expect(res.answers).toHaveLength(1);
    expect(f.calls).toHaveLength(2);
    expect(rfType(f.calls[1])).toBe("json_object");
    const sys =
      (f.calls[1]?.body?.messages as Array<{ content: string }> | undefined)?.[0]?.content ?? "";
    expect(sys).toContain('"additionalProperties":false');
    expect(sys).toContain("JSON");

    await p.adjudicate(reqs(1), { signal: signal(), deadlineMs: 2000 });
    expect(f.calls).toHaveLength(3);
    expect(rfType(f.calls[2])).toBe("json_object");
  });

  it("does not fall back on other 400s, or when json is 'schema'", async () => {
    const other = openai();
    const f1 = mockFetch(json({ error: { message: "context length exceeded" } }, 400));
    const e1 = await caught(
      createOpenAIProvider(other.r, other.cfg, { fetch: f1, env: other.env }).adjudicate(reqs(1), {
        signal: signal(),
        deadlineMs: 2000,
      }),
    );
    expect(e1.kind).toBe("http_error");
    expect(f1.calls).toHaveLength(1);

    const strict = openai({ openai: { preset: "groq", json: "schema" } });
    const f2 = mockFetch(json({ error: { message: "response_format not supported" } }, 400));
    await caught(
      createOpenAIProvider(strict.r, strict.cfg, { fetch: f2, env: strict.env }).adjudicate(
        reqs(1),
        { signal: signal(), deadlineMs: 2000 },
      ),
    );
    expect(f2.calls).toHaveLength(1);

    const obj = openai({ openai: { preset: "groq", json: "object" } });
    const f3 = mockFetch(completion([item("i0")]));
    await createOpenAIProvider(obj.r, obj.cfg, { fetch: f3, env: obj.env }).adjudicate(reqs(1), {
      signal: signal(),
      deadlineMs: 2000,
    });
    expect(rfType(f3.calls[0])).toBe("json_object");
  });

  it("applies the ollama preset: localhost, no key, keep_alive and options, free", async () => {
    const { cfg, r } = openai({ openai: { preset: "ollama" }, remoteConsent: false }, {});
    expect(r.provider).toBe("openai-compatible");
    expect(r.local).toBe(true);
    const f = mockFetch(completion([item("i0")], { model: "qwen2.5:1.5b-instruct" }));
    const res = await createOpenAIProvider(r, cfg, { fetch: f, env: {} }).adjudicate(reqs(1), {
      signal: signal(),
      deadlineMs: 600,
    });
    const c = f.calls[0]!;
    expect(c.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(headerOf(c, "authorization")).toBeUndefined();
    expect(c.body?.keep_alive).toBe("30m");
    expect(c.body?.options).toEqual({ temperature: 0, num_predict: 256 });
    expect(c.body?.model).toBe("qwen2.5:1.5b-instruct");
    expect(c.body?.reasoning_effort).toBeUndefined();
    expect(res.usage.costUsd).toBe(0);
  });

  it("validates the answer: drops bad items, rejects non-JSON and empty answers", async () => {
    const { cfg, r, env } = openai();
    const run = (reply: Response) =>
      createOpenAIProvider(r, cfg, { fetch: mockFetch(reply), env }).adjudicate(reqs(2), {
        signal: signal(),
        deadlineMs: 2000,
      });
    const res = await run(completion([item("i0", { tier: "gpt-9" }), item("i1"), item("i9")]));
    expect(res.answers.map((a) => a.key)).toEqual(["k1"]);
    expect(
      (await caught(run(json({ choices: [{ message: { content: "sure! here you go" } }] })))).kind,
    ).toBe("invalid");
    expect((await caught(run(json({ choices: [{ message: { content: null } }] })))).kind).toBe(
      "invalid",
    );
    expect((await caught(run(completion([item("i0", { confidence: 3 })])))).kind).toBe("invalid");
    expect((await caught(run(json({ id: "x" })))).kind).toBe("invalid");
  });

  it("throws no_key for a remote preset without a key, and keeps the key out of errors", async () => {
    const { cfg, r } = openai();
    const f = mockFetch(json({}));
    const e = await caught(
      createOpenAIProvider(r, cfg, { fetch: f, env: {} }).adjudicate(reqs(1), {
        signal: signal(),
        deadlineMs: 2000,
      }),
    );
    expect(e.kind).toBe("no_key");
    expect(f.calls).toHaveLength(0);

    const logs: string[] = [];
    const f2 = mockFetch(json({ error: { message: `Invalid API Key ${SENTINEL}` } }, 401));
    const e2 = await caught(
      createOpenAIProvider(r, cfg, {
        fetch: f2,
        env: { GROQ_API_KEY: SENTINEL },
        log: (l) => logs.push(l),
      }).adjudicate(reqs(1), {
        signal: signal(),
        deadlineMs: 2000,
      }),
    );
    expect(e2.kind).toBe("http_error");
    expectNoSentinel(e2, e2.message, e2.body ?? "", ...logs);
  });

  it("honours the deadline across the json_object retry", async () => {
    const { cfg, r, env } = openai();
    const f = mockFetch(json({ error: { message: "response_format unsupported" } }, 400), hang);
    const t0 = Date.now();
    const e = await caught(
      createOpenAIProvider(r, cfg, { fetch: f, env }).adjudicate(reqs(1), {
        signal: signal(),
        deadlineMs: 80,
      }),
    );
    expect(e.kind).toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

// ---------------------------------------------------------------------------------------------

describe("no env key for a loopback provider (#32)", () => {
  /** Every env var a key could come from, all set to secrets that must never reach a local port. */
  const HOST_ENV = {
    GITHUB_TOKEN: "ghp_SENTINEL_HOST_GITHUB_TOKEN_0000000000",
    EMINIAR_ADJUDICATOR_KEY: "SENTINEL_GENERIC_ADJ_KEY_0000",
    GROQ_API_KEY: "gsk_SENTINEL_GROQ_0000000000",
    TYPESAFE_API_KEY: "ts_SENTINEL_TYPESAFE_000000",
  };

  it("a local preset at 127.0.0.1 gets no key from keyEnv, the generic or a provider env var", async () => {
    const { cfg, r } = openai(
      {
        remoteConsent: false,
        keyEnv: "GITHUB_TOKEN",
        openai: { preset: "llamacpp", baseUrl: "http://127.0.0.1:9/v1" },
      },
      HOST_ENV,
    );
    expect([r.provider, r.local, r.keySource]).toEqual(["openai-compatible", true, "none"]);
    const f = mockFetch(completion([item("i0")]));
    await createOpenAIProvider(r, cfg, { fetch: f, env: HOST_ENV }).adjudicate(reqs(1), {
      signal: signal(),
      deadlineMs: 600,
    });
    expect(f.calls[0]?.url).toBe("http://127.0.0.1:9/v1/chat/completions");
    expect(headerOf(f.calls[0], "authorization")).toBeUndefined();
    expect(JSON.stringify(f.calls[0]?.init)).not.toMatch(/SENTINEL/);
  });

  it("the same holds for a custom preset on localhost, even with a hand-made Resolved", async () => {
    const { cfg, r } = openai(
      {
        remoteConsent: false,
        openai: { preset: "custom", baseUrl: "http://localhost:1/v1", model: "m" },
      },
      HOST_ENV,
    );
    expect(r.local).toBe(true);
    // keyEnv/providerEnv on the Resolved do not matter: the target is local.
    const forged: Resolved = { ...r, keyEnv: "GITHUB_TOKEN", providerEnv: "GROQ_API_KEY" };
    const f = mockFetch(completion([item("i0")]));
    await createOpenAIProvider(forged, cfg, { fetch: f, env: HOST_ENV }).adjudicate(reqs(1), {
      signal: signal(),
      deadlineMs: 600,
    });
    expect(headerOf(f.calls[0], "authorization")).toBeUndefined();
  });

  it("a key the user stored for that local provider id is still sent", async () => {
    const { setKey } = await import("../../src/adjudicator/secrets.js");
    setKey("openai:lmstudio", "lm-studio-own-token-1234");
    const { cfg, r } = openai({ remoteConsent: false, openai: { preset: "lmstudio" } }, HOST_ENV);
    expect(r.keySource).toBe("file");
    const f = mockFetch(completion([item("i0")]));
    await createOpenAIProvider(r, cfg, { fetch: f, env: HOST_ENV }).adjudicate(reqs(1), {
      signal: signal(),
      deadlineMs: 600,
    });
    expect(headerOf(f.calls[0], "authorization")).toBe("Bearer lm-studio-own-token-1234");
  });

  it("typesafe on a loopback baseUrl ignores TYPESAFE_API_KEY and keyEnv", async () => {
    const { cfg, r } = typesafe(
      {
        remoteConsent: false,
        keyEnv: "GITHUB_TOKEN",
        typesafe: { baseUrl: "http://127.0.0.1:9/v1" },
      },
      HOST_ENV,
    );
    expect([r.provider, r.degraded]).toEqual(["heuristic", "no_key"]);
    const f = mockFetch(json({}));
    const p = createTypesafeProvider({ ...r, provider: "typesafe", remote: false }, cfg, {
      fetch: f,
      env: HOST_ENV,
    });
    expect((await caught(p.adjudicate(reqs(1), { signal: signal(), deadlineMs: 600 }))).kind).toBe(
      "no_key",
    );
    expect(f.calls).toHaveLength(0);
  });

  it("a remote provider still reads keyEnv from the user config", async () => {
    const { cfg, r } = openai({ keyEnv: "MY_GROQ" }, { MY_GROQ: SENTINEL });
    expect(r.keySource).toBe("env");
    const f = mockFetch(completion([item("i0")]));
    await createOpenAIProvider(r, cfg, { fetch: f, env: { MY_GROQ: SENTINEL } }).adjudicate(
      reqs(1),
      { signal: signal(), deadlineMs: 2000 },
    );
    expect(headerOf(f.calls[0], "authorization")).toBe(`Bearer ${SENTINEL}`);
  });
});

// ---------------------------------------------------------------------------------------------

describe("provider registry", () => {
  const stub = (id: "embedding"): AdjudicatorProvider => ({
    id,
    remote: false,
    dims: ["tier", "complexity"],
    adjudicate: async () => ({
      answers: [],
      usage: { inTok: 0, outTok: 0, costUsd: 0 },
      latencyMs: 0,
      model: "stub",
    }),
    probe: async () => ({ ok: true, latencyMs: 0, detail: "stub" }),
  });

  it("creates the built-in providers and returns null for the heuristic", () => {
    const h = adj();
    expect(createProvider(resolveAdjudicator(h), h)).toBeNull();
    const t = typesafe();
    expect(createProvider(t.r, t.cfg)?.id).toBe("typesafe");
    const o = openai();
    expect(createProvider(o.r, o.cfg)?.id).toBe("openai-compatible");
    // A degraded resolution (no consent) runs the heuristic: no provider.
    const nc = adj({ provider: "typesafe", remoteConsent: false });
    expect(
      createProvider(resolveAdjudicator(nc, { env: { TYPESAFE_API_KEY: SENTINEL } }), nc),
    ).toBeNull();
  });

  it("registers embedding at runtime only", () => {
    const cfg = adj({ provider: "embedding" });
    const r: Resolved = resolveAdjudicator(cfg, { context: "server" });
    expect(r.provider).toBe("embedding");
    expect(createProvider(r, cfg)).toBeNull();
    registerProvider("embedding", () => stub("embedding"));
    expect(createProvider(r, cfg)?.id).toBe("embedding");
    resetProviders();
    expect(createProvider(r, cfg)).toBeNull();
  });

  it("providers/index.ts never imports embedding.ts, statically or dynamically", () => {
    const src = readFileSync(
      new URL("../../src/adjudicator/providers/index.ts", import.meta.url),
      "utf8",
    );
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/embedding(\.js|\.ts)?["']/);
    expect(code).not.toMatch(/import\s*\(/);
    expect(code).not.toMatch(/require\s*\(/);
    for (const m of code.matchAll(/from\s+["']([^"']+)["']/g))
      expect(m[1]).not.toContain("embedding");
  });
});
