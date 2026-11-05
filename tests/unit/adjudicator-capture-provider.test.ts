/**
 * Jev exchange log, the provider half (task #186 / X8; design blackboard design-xchg, x1-capture-api):
 * providers/capture.ts (structural scrub and cap), the live record http.ts keeps when it is given
 * `exchange`, and what typesafe.ts puts into the sink. A stubbed fetch only: no network, no model.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAdjudicator } from "../../src/adjudicator/config.js";
import {
  captureBody,
  captureText,
  EXCHANGE_BODY_MAX,
} from "../../src/adjudicator/providers/capture.js";
import {
  type FetchLike,
  getJson,
  ProviderError,
  postJson,
} from "../../src/adjudicator/providers/http.js";
import { resetProviders } from "../../src/adjudicator/providers/index.js";
import {
  createTypesafeProvider,
  JEV_PINNED,
  JEV_PRICE_IN,
} from "../../src/adjudicator/providers/typesafe.js";
import { resetSecrets } from "../../src/adjudicator/secrets.js";
import type {
  AdjudicationRequest,
  HttpExchange,
  ProviderExchange,
} from "../../src/adjudicator/types.js";
import { type AdjudicatorConfig, ConfigSchema } from "../../src/config.js";

/** Must never appear in a captured record: only in the Authorization header that is sent. */
const KEY = "sk-XCHGSENTINEL0123456789abcdef";

beforeEach(() => {
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-xchg-prov-"));
  resetSecrets();
  resetProviders();
});
afterEach(() => {
  delete process.env.EMINIAR_HOME;
  resetSecrets();
  resetProviders();
});

// biome-ignore lint/suspicious/noExplicitAny: the tests read untyped JSON
type Json = any;

const jsonRes = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

interface Call {
  url: string;
  init: RequestInit;
  body: Json;
}
type Reply = Response | ((call: Call) => Response | Promise<Response>);

/** Records each call and answers from a queue (the last reply repeats). */
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

/** A fetch that never settles and ignores the abort signal (the engine's timer must cut it off). */
const stuck: Reply = () => new Promise<Response>(() => {});

const text = (n: number): string =>
  Array.from({ length: n }, (_, i) => `module${i % 97}`).join(" ");
/** Exactly `len` characters of plain words (redact() leaves them alone). */
const fill = (len: number): string => "lorem ipsum ".repeat(Math.ceil(len / 12)).slice(0, len);

async function caught(p: Promise<unknown>): Promise<ProviderError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ProviderError);
    return e as ProviderError;
  }
  throw new Error("expected a rejection");
}

/** Everything a record holds, as one string, for the "never appears" scans. */
const everything = (x: unknown): string =>
  JSON.stringify(x, (_k, v) => (v instanceof Error ? { message: v.message } : v));

// ---------------------------------------------------------------------------------------------

describe("captureBody / captureText (structural scrub)", () => {
  it("keeps valid JSON valid and numbers numeric", () => {
    const c = captureBody({
      model: "jev-1.14.0",
      answers: { "i0.tier": { type: "choice", choice: "opus", confidence: 0.7 } },
      usage: { input_tokens: 1234, output_tokens: 56 },
      list: [1, null, true, "x"],
    });
    expect(c.json).toBe(true);
    expect(c.truncated).toBe(false);
    const parsed = JSON.parse(c.text) as Json;
    expect(parsed.usage.input_tokens).toBe(1234);
    expect(typeof parsed.usage.input_tokens).toBe("number");
    expect(typeof parsed.usage.output_tokens).toBe("number");
    expect(parsed.list).toEqual([1, null, true, "x"]);
    expect(c.bytes).toBe(c.text.length);
  });

  it("applies redact() to string leaves and to object keys", () => {
    const c = captureBody({
      state: {
        items: [{ id: "i0", text: "deploy now, password=hunter2xyz and api_key=abcd1234efgh" }],
      },
      "token=topsecretvalue99": "plain",
      AKIAABCDEFGHIJKLMNOP: 1,
    });
    expect(c.text).not.toContain("hunter2xyz");
    expect(c.text).not.toContain("abcd1234efgh");
    expect(c.text).not.toContain("topsecretvalue99");
    expect(c.text).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(() => JSON.parse(c.text)).not.toThrow();
    // The structure around the masked spans survives.
    const parsed = JSON.parse(c.text) as Json;
    expect(parsed.state.items[0].id).toBe("i0");
    expect(parsed.state.items[0].text).toContain("deploy now");
  });

  it("replaces the key verbatim in strings and in keys, whatever redact() would do", () => {
    const c = captureBody({ [`k-${KEY}`]: `a ${KEY} b`, arr: [KEY, `Bearer ${KEY}`] }, KEY);
    expect(c.text).not.toContain(KEY);
    expect(c.text).not.toContain(KEY.slice(0, 12));
    expect(() => JSON.parse(c.text)).not.toThrow();
  });

  it("ignores a key shorter than 4 characters (it would mangle every word)", () => {
    const c = captureBody({ a: "abc abc" }, "abc");
    expect(JSON.parse(c.text)).toEqual({ a: "abc abc" });
  });

  it("is safe for a __proto__ key: an own property, no prototype pollution", () => {
    const hostile = JSON.parse(
      '{"__proto__":{"polluted":"yes"},"a":"b","nested":{"__proto__":[1]}}',
    );
    const c = captureBody(hostile);
    expect(({} as Json).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("polluted");
    const parsed = JSON.parse(c.text) as Json;
    expect(parsed.a).toBe("b");
    expect(Object.keys(parsed)).toContain("__proto__");
    expect(c.text).toContain('"__proto__"');
    expect(({} as Json).polluted).toBeUndefined();
  });

  it("does not recurse without bound", () => {
    let deep: Json = "leaf";
    for (let i = 0; i < 500; i++) deep = { n: deep };
    const c = captureBody(deep);
    expect(c.text).toContain("[too deep]");
    expect(() => JSON.parse(c.text)).not.toThrow();
  });

  it("an undefined value is an empty, non-JSON body", () => {
    expect(captureBody(undefined)).toEqual({ text: "", json: false, bytes: 0, truncated: false });
  });

  it("caps at 65,536 characters after scrubbing and reports the full size", () => {
    expect(EXCHANGE_BODY_MAX).toBe(65_536);
    const long = text(30_000);
    const c = captureBody({ long });
    expect(c.truncated).toBe(true);
    expect(c.text).toHaveLength(EXCHANGE_BODY_MAX);
    expect(c.bytes).toBeGreaterThan(EXCHANGE_BODY_MAX);
    expect(c.bytes).toBe(JSON.stringify({ long }).length);
    // A cut body is no longer valid JSON; the flag is what tells the viewer.
    expect(() => JSON.parse(c.text)).toThrow();
    const exact = captureBody(fill(EXCHANGE_BODY_MAX - 2)); // two quotes make it exactly the cap
    expect(exact.truncated).toBe(false);
    expect(exact.text).toHaveLength(EXCHANGE_BODY_MAX);
    expect(captureBody(fill(EXCHANGE_BODY_MAX - 1)).truncated).toBe(true);
  });

  it("no part of the key survives at the cut", () => {
    // The key starts a few characters before the cap, so a cut-then-scrub order would leave a prefix.
    const lead = EXCHANGE_BODY_MAX - 6 - 10; // `{"a":"` is 6 characters
    const c = captureBody({ a: `${fill(lead)}${KEY}${" tail".repeat(100)}` }, KEY);
    expect(c.truncated).toBe(true);
    expect(c.text).not.toContain("sk-XCHG");
    expect(c.text).not.toContain(KEY.slice(0, 6));
  });

  it("captureText: JSON text is scrubbed structurally and stays JSON", () => {
    const c = captureText(
      JSON.stringify({
        error: `bad key ${KEY}`,
        usage: { input_tokens: 9 },
        n: "password=hunter2xyz",
      }),
      KEY,
    );
    expect(c.json).toBe(true);
    expect(c.text).not.toContain(KEY);
    expect(c.text).not.toContain("hunter2xyz");
    expect((JSON.parse(c.text) as Json).usage.input_tokens).toBe(9);
  });

  it("captureText: plain text is scrubbed as text, json false", () => {
    const c = captureText(`upstream said: Authorization: Bearer ${KEY}\nstatus 502`, KEY);
    expect(c.json).toBe(false);
    expect(c.text).not.toContain(KEY);
    expect(c.text).toContain("status 502");
    expect(c.truncated).toBe(false);
  });

  it("captureText: a huge text body is not parsed; its head is scrubbed and flagged", () => {
    const big = `${KEY} ${"lorem ipsum ".repeat(120_000)}`;
    const c = captureText(big, KEY);
    expect(c.truncated).toBe(true);
    expect(c.json).toBe(false);
    expect(c.bytes).toBe(big.length);
    expect(c.text.length).toBeLessThanOrEqual(EXCHANGE_BODY_MAX);
    expect(c.text).not.toContain(KEY);
  });
});

// ---------------------------------------------------------------------------------------------

describe("http.ts: the live exchange record", () => {
  const ok = () => jsonRes({ answers: {}, usage: { input_tokens: 7, output_tokens: 1 } });

  function run(
    fetch: FetchLike,
    o: { deadlineMs?: number; body?: unknown; signal?: AbortSignal } = {},
  ): { p: Promise<unknown>; seen: HttpExchange[] } {
    const seen: HttpExchange[] = [];
    const p = postJson("https://api.typesafe.ai/v1/systemone?secret=1", o.body ?? { q: "hello" }, {
      deadlineMs: o.deadlineMs ?? 2000,
      signal: o.signal,
      key: KEY,
      fetch,
      exchange: (x) => seen.push(x),
    });
    return { p, seen };
  }

  it("sends the body once, as JSON, and keeps the call a plain success", async () => {
    const f = mockFetch(ok());
    const { p, seen } = run(f, { body: { q: "hello", n: 3 } });
    const res = (await p) as { status: number; attempts: number };
    expect(res.status).toBe(200);
    expect(f.calls[0]?.init.body).toBe(JSON.stringify({ q: "hello", n: 3 }));
    expect(seen).toHaveLength(1);
    const x = seen[0] as HttpExchange;
    expect(x).toMatchObject({
      method: "POST",
      target: "api.typesafe.ai/v1/systemone", // host and path: no query string
      attempts: 1,
      retryWaitMs: 0,
      status: 200,
      outcome: "ok",
      deadlineMs: 2000,
      error: null,
    });
    expect(x.ttfbMs).toBeGreaterThanOrEqual(0);
    expect(x.durationMs).toBeGreaterThanOrEqual(x.ttfbMs as number);
    expect(JSON.parse(x.request.text)).toEqual({ q: "hello", n: 3 });
    expect(JSON.parse(x.response?.text as string).usage.input_tokens).toBe(7);
  });

  it("the record is pending while the call is in flight, then settles in place", async () => {
    let release: (r: Response) => void = () => {};
    const f = mockFetch(() => new Promise<Response>((r) => (release = r)));
    const { p, seen } = run(f);
    await new Promise((r) => setTimeout(r, 15));
    const x = seen[0] as HttpExchange;
    expect(x.outcome).toBe("pending");
    expect(x.status).toBeNull();
    expect(x.durationMs).toBeNull();
    expect(x.response).toBeNull();
    expect(x.request.text).toContain("hello");
    release(ok());
    await p;
    expect(seen).toHaveLength(1); // the same object, filled in
    expect(x.outcome).toBe("ok");
    expect(x.status).toBe(200);
  });

  it("never stores the key or an Authorization header in the record", async () => {
    const f = mockFetch(ok());
    const { p, seen } = run(f, { body: { q: `use ${KEY} please`, "token=abcdef123456": 1 } });
    await p;
    // The header really was sent...
    expect(((f.calls[0]?.init.headers ?? {}) as Record<string, string>).authorization).toBe(
      `Bearer ${KEY}`,
    );
    // ...and is nowhere in what was kept.
    const all = everything(seen);
    expect(all).not.toContain(KEY);
    expect(all.toLowerCase()).not.toContain("authorization");
    expect(all.toLowerCase()).not.toContain("bearer");
    expect(Object.keys(seen[0] as object).sort()).toEqual(
      [
        "attempts",
        "deadlineMs",
        "durationMs",
        "error",
        "method",
        "outcome",
        "request",
        "response",
        "retryWaitMs",
        "sentAt",
        "status",
        "target",
        "ttfbMs",
      ].sort(),
    );
  });

  it("a provider that echoes the key in an error body leaves it out of response and error", async () => {
    const echo = jsonRes(
      { error: `invalid api key ${KEY}`, header: `Authorization: Bearer ${KEY}` },
      401,
    );
    const { p, seen } = run(mockFetch(echo));
    const err = await caught(p);
    expect(err.kind).toBe("http_error");
    expect(err.message).not.toContain(KEY);
    const x = seen[0] as HttpExchange;
    expect(x).toMatchObject({ outcome: "http_error", status: 401 });
    expect(x.response?.json).toBe(true);
    const all = everything(x);
    expect(all).not.toContain(KEY);
    expect(all).not.toContain("sk-XCHG");
    expect(x.error).toContain("HTTP 401");
  });

  it("a plain-text error body that echoes the key is scrubbed too", async () => {
    const { p, seen } = run(
      mockFetch(new Response(`gateway: bad credentials ${KEY}`, { status: 502 })),
    );
    await caught(p);
    const x = seen[0] as HttpExchange;
    expect(x.response?.json).toBe(false);
    expect(everything(x)).not.toContain(KEY);
    expect(x.response?.text).toContain("gateway: bad credentials");
  });

  it("429 with Retry-After then 200: attempts 2, retryWaitMs, a consistent timeline", async () => {
    const t0 = Date.now();
    const seenAtRetry: Array<Pick<HttpExchange, "attempts" | "ttfbMs" | "outcome">> = [];
    const hold: { x?: HttpExchange } = {};
    const f = mockFetch(jsonRes({ error: "slow down" }, 429, { "retry-after": "0.1" }), () => {
      const x = hold.x as HttpExchange;
      seenAtRetry.push({ attempts: x.attempts, ttfbMs: x.ttfbMs, outcome: x.outcome });
      return ok();
    });
    const { p, seen } = run(f);
    await new Promise((r) => setTimeout(r, 5));
    hold.x = seen[0] as HttpExchange;
    const res = (await p) as { attempts: number };
    expect(res.attempts).toBe(2);
    expect(f.calls).toHaveLength(2);
    const x = seen[0] as HttpExchange;
    expect(x).toMatchObject({ attempts: 2, retryWaitMs: 100, status: 200, outcome: "ok" });
    // While the second attempt was in flight: attempts already 2, its ttfb not known yet.
    expect(seenAtRetry).toEqual([{ attempts: 2, ttfbMs: null, outcome: "pending" }]);
    // The final attempt's ttfb; the duration covers sentAt..end including the wait.
    expect(x.ttfbMs).not.toBeNull();
    expect(x.durationMs as number).toBeGreaterThanOrEqual(90);
    expect(x.durationMs as number).toBeGreaterThanOrEqual(x.retryWaitMs + (x.ttfbMs as number) - 5);
    expect(x.sentAt).toBeGreaterThanOrEqual(t0);
    expect(x.sentAt).toBeLessThanOrEqual(Date.now());
    // The 429 body was superseded: the record keeps the final answer.
    expect(JSON.parse(x.response?.text as string).usage.input_tokens).toBe(7);
  });

  it("429 twice: rate_limited, two attempts, the last answer's body", async () => {
    const { p, seen } = run(mockFetch(jsonRes({ error: "later" }, 429, { "retry-after": "0" })));
    const err = await caught(p);
    expect(err.kind).toBe("rate_limited");
    const x = seen[0] as HttpExchange;
    expect(x).toMatchObject({ outcome: "rate_limited", status: 429, attempts: 2, retryWaitMs: 0 });
    expect(x.response?.text).toContain("later");
  });

  it("a deadline with no answer: timeout, no response, an error line", async () => {
    const f = mockFetch(
      (c) =>
        new Promise<Response>((_, reject) =>
          c.init.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          ),
        ),
    );
    const { p, seen } = run(f, { deadlineMs: 60 });
    const err = await caught(p);
    expect(err.kind).toBe("timeout");
    const x = seen[0] as HttpExchange;
    expect(x).toMatchObject({ outcome: "timeout", status: null, response: null, deadlineMs: 60 });
    expect(x.durationMs as number).toBeGreaterThanOrEqual(50);
    expect(x.error).toMatch(/no answer within 60 ms/);
  });

  it("a fetch that ignores the abort leaves the record pending (the engine writes it as a timeout)", async () => {
    const { p, seen } = run(mockFetch(stuck), { deadlineMs: 40 });
    p.catch(() => {});
    await new Promise((r) => setTimeout(r, 120));
    expect((seen[0] as HttpExchange).outcome).toBe("pending");
    expect((seen[0] as HttpExchange).response).toBeNull();
  });

  it("a 200 that is not JSON: invalid, with the scrubbed text kept", async () => {
    const { p, seen } = run(mockFetch(new Response(`<html>${KEY}</html>`, { status: 200 })));
    const err = await caught(p);
    expect(err.kind).toBe("invalid");
    const x = seen[0] as HttpExchange;
    expect(x).toMatchObject({ outcome: "invalid", status: 200 });
    expect(x.response?.json).toBe(false);
    expect(x.response?.text).toContain("<html>");
    expect(everything(x)).not.toContain(KEY);
  });

  it("a redirect is an http_error and is recorded as one", async () => {
    const { p, seen } = run(
      mockFetch(new Response("", { status: 302, headers: { location: "https://evil.example/x" } })),
    );
    await caught(p);
    expect(seen[0]).toMatchObject({ outcome: "http_error", status: 302 });
    expect((seen[0] as HttpExchange).error).toContain("redirect");
  });

  it("a request body over the cap is cut and flagged; the real request is whole", async () => {
    const body = { q: text(30_000) };
    const f = mockFetch(ok());
    const { p, seen } = run(f, { body });
    await p;
    const x = seen[0] as HttpExchange;
    expect(x.request.truncated).toBe(true);
    expect(x.request.text).toHaveLength(EXCHANGE_BODY_MAX);
    expect(x.request.bytes).toBeGreaterThan(EXCHANGE_BODY_MAX);
    expect(f.calls[0]?.init.body).toBe(JSON.stringify(body));
  });

  it("a capture callback that throws never changes the HTTP result", async () => {
    const f = mockFetch(ok());
    const res = await postJson(
      "https://api.typesafe.ai/v1/systemone",
      { q: 1 },
      {
        deadlineMs: 2000,
        key: KEY,
        fetch: f,
        exchange: () => {
          throw new Error("sink exploded");
        },
      },
    );
    expect(res.status).toBe(200);
    expect(res.attempts).toBe(1);
  });

  it("without `exchange` the call is unchanged and nothing is built", async () => {
    const f = mockFetch(ok());
    const res = await postJson(
      "https://api.typesafe.ai/v1/systemone",
      { q: 1 },
      { deadlineMs: 2000, key: KEY, fetch: f },
    );
    expect(res.status).toBe(200);
    expect(f.calls[0]?.init.body).toBe('{"q":1}');
  });

  it("without `exchange` a failure carries no capture data either", async () => {
    const f = mockFetch(jsonRes({ error: `nope ${KEY}` }, 500));
    const err = await caught(
      postJson(
        "https://api.typesafe.ai/v1/systemone",
        { q: 1 },
        { deadlineMs: 2000, key: KEY, fetch: f },
      ),
    );
    expect(Object.keys(err).sort()).toEqual(["body", "kind", "name", "status"]);
    expect(everything(err)).not.toContain(KEY);
  });

  it("a GET sends no body", async () => {
    const f = mockFetch(jsonRes({ data: [] }));
    await getJson("https://api.typesafe.ai/v1/models", { deadlineMs: 1000, key: KEY, fetch: f });
    expect(f.calls[0]?.init.body).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------

describe("typesafe.ts: what lands in the sink", () => {
  const adj = (over: Record<string, unknown> = {}): AdjudicatorConfig =>
    ConfigSchema.parse({
      adjudicator: { enabled: true, remoteConsent: true, provider: "typesafe", ...over },
    }).adjudicator;
  const ENV = { TYPESAFE_API_KEY: KEY } as NodeJS.ProcessEnv;

  function make(fetch: FetchLike, over: Record<string, unknown> = {}) {
    const cfg = adj(over);
    const r = resolveAdjudicator(cfg, { context: "server", env: ENV });
    return createTypesafeProvider(r, cfg, { fetch, env: ENV });
  }

  const reqs = (n: number, extra: Partial<AdjudicationRequest> = {}): AdjudicationRequest[] =>
    Array.from({ length: n }, (_, i) => ({
      key: `req-key-${i}`,
      surface: "agent" as const,
      text: `task ${i}: rename the helper in src/a${i}.ts`,
      ...extra,
    }));

  /** A Jev reply answering every question in the request. */
  function jevReply(call: Call, usage = { input_tokens: 1000, output_tokens: 70 }) {
    const qs = (call.body?.questions ?? {}) as Record<string, { type: string; criteria?: unknown }>;
    const answers: Record<string, unknown> = {};
    for (const [id, q] of Object.entries(qs)) {
      if (q.type === "score") {
        const legend = Object.fromEntries((q.criteria as string[]).map((c, i) => [String(i), c]));
        answers[id] = { type: "score", score: 2, confidence: 0.8, legend };
      } else if (q.type === "noul") answers[id] = { type: "noul", noul: 0.2 };
      else {
        const opts = Object.keys(q.criteria as Record<string, string>);
        answers[id] = {
          type: "choice",
          choice: opts[1],
          confidence: 0.6,
          probabilities: Object.fromEntries(
            opts.map((x, i) => [x, i === 1 ? 0.6 : 0.4 / (opts.length - 1)]),
          ),
        };
      }
    }
    return jsonRes({ model: JEV_PINNED, answers, usage });
  }

  const signal = () => new AbortController().signal;

  it("12 items make two records: batches 0 and 1 with their item keys, model, tokens and cost", async () => {
    const f = mockFetch((c) => jevReply(c));
    const sink: ProviderExchange[] = [];
    await make(f).adjudicate(reqs(12), { signal: signal(), deadlineMs: 2000, capture: sink });
    expect(sink).toHaveLength(2);
    const [a, b] = [...sink].sort((x, y) => x.batch - y.batch) as [
      ProviderExchange,
      ProviderExchange,
    ];
    expect([a.batch, b.batch]).toEqual([0, 1]);
    expect(a.itemKeys).toEqual(
      reqs(12)
        .slice(0, 10)
        .map((r) => r.key),
    );
    expect(b.itemKeys).toEqual(["req-key-10", "req-key-11"]);
    for (const pe of sink) {
      expect(pe).toMatchObject({
        provider: "typesafe",
        model: JEV_PINNED,
        tokensIn: 1000,
        tokensOut: 70,
      });
      expect(pe.costUsd).toBeCloseTo(1000 * JEV_PRICE_IN);
      expect(pe.http).toMatchObject({
        method: "POST",
        target: "api.typesafe.ai/v1/systemone",
        outcome: "ok",
        status: 200,
        deadlineMs: 2000,
      });
    }
  });

  it("the stored request is the request that was sent, redacted, with no key, header or item key", async () => {
    const f = mockFetch((c) => jevReply(c));
    const sink: ProviderExchange[] = [];
    const batch = reqs(2);
    batch[0] = { ...batch[0]!, text: `fix login, password=hunter2xyz and ${KEY}` };
    await make(f).adjudicate(batch, { signal: signal(), deadlineMs: 2000, capture: sink });
    const x = sink[0]?.http as HttpExchange;
    const sent = f.calls[0]?.body as Json;
    const stored = JSON.parse(x.request.text) as Json;
    expect(x.request.json).toBe(true);
    expect(Object.keys(stored).sort()).toEqual(["model", "questions", "state"]);
    expect(stored.model).toBe(sent.model);
    expect(Object.keys(stored.questions)).toEqual(Object.keys(sent.questions));
    expect(stored.state.items).toHaveLength(2);
    // Masked inside the string, the rest of the sentence is still there.
    expect(stored.state.items[0].text).toContain("fix login");
    expect(x.request.text).not.toContain("hunter2xyz");
    expect(everything(sink)).not.toContain(KEY);
    expect(everything(sink.map((s) => s.http))).not.toContain("req-key-0"); // itemKeys sit on pe, never in the record
    expect(x.request.text.toLowerCase()).not.toContain("authorization");
    expect(everything(x).toLowerCase()).not.toContain("bearer");
  });

  it("the stored answer is valid JSON and usage.input_tokens is still a number", async () => {
    const f = mockFetch((c) => jevReply(c, { input_tokens: 4321, output_tokens: 9 }));
    const sink: ProviderExchange[] = [];
    await make(f).adjudicate(reqs(1), { signal: signal(), deadlineMs: 2000, capture: sink });
    const x = sink[0]?.http as HttpExchange;
    const answer = JSON.parse(x.response?.text as string) as Json;
    expect(typeof answer.usage.input_tokens).toBe("number");
    expect(answer.usage.input_tokens).toBe(4321);
    expect(Object.keys(answer.answers).length).toBeGreaterThan(3);
    expect(x.response?.json).toBe(true);
  });

  it("a ten-item request at privacy.maxChars 20000 is cut at 65,536 and flagged", async () => {
    const f = mockFetch((c) => jevReply(c));
    const sink: ProviderExchange[] = [];
    const batch = reqs(10).map((r, i) => ({ ...r, text: `${i} ${text(20_000)}`.slice(0, 20_000) }));
    await make(f, { privacy: { maxChars: 20_000 } }).adjudicate(batch, {
      signal: signal(),
      deadlineMs: 2000,
      capture: sink,
    });
    const x = sink[0]?.http as HttpExchange;
    expect(x.request.truncated).toBe(true);
    expect(x.request.bytes).toBeGreaterThan(EXCHANGE_BODY_MAX);
    expect(x.request.text.length).toBeLessThanOrEqual(EXCHANGE_BODY_MAX);
    // What went over the wire is whole.
    expect(JSON.stringify(f.calls[0]?.body).length).toBeGreaterThan(EXCHANGE_BODY_MAX);
  });

  it("a 200 with the wrong shape is outcome invalid with the body kept and an error set", async () => {
    const sink: ProviderExchange[] = [];
    const p = make(mockFetch(jsonRes({ nope: true }))).adjudicate(reqs(1), {
      signal: signal(),
      deadlineMs: 2000,
      capture: sink,
    });
    expect((await caught(p)).kind).toBe("invalid");
    const x = sink[0]?.http as HttpExchange;
    expect(x.outcome).toBe("invalid");
    expect(x.status).toBe(200);
    expect(x.error).toMatch(/unexpected shape/);
    expect(JSON.parse(x.response?.text as string)).toEqual({ nope: true });
    expect(sink[0]?.tokensIn).toBeNull();
  });

  it("a 200 that answers no item is invalid too", async () => {
    const sink: ProviderExchange[] = [];
    const p = make(mockFetch(jsonRes({ answers: {} }))).adjudicate(reqs(1), {
      signal: signal(),
      deadlineMs: 2000,
      capture: sink,
    });
    expect((await caught(p)).kind).toBe("invalid");
    expect(sink[0]?.http).toMatchObject({ outcome: "invalid" });
    expect(sink[0]?.http.error).toMatch(/answered no item/);
  });

  it("when one half fails the sink holds both: one ok, one http_error", async () => {
    const f = mockFetch((c) => jevReply(c), jsonRes({ error: `nope ${KEY}` }, 500));
    const sink: ProviderExchange[] = [];
    const res = await make(f).adjudicate(reqs(15), {
      signal: signal(),
      deadlineMs: 2000,
      capture: sink,
    });
    expect(res.answers).toHaveLength(10);
    expect(sink.map((s) => s.http.outcome).sort()).toEqual(["http_error", "ok"]);
    expect(everything(sink)).not.toContain(KEY);
  });

  it("no sink, no records: the answers are the same", async () => {
    const withSink: ProviderExchange[] = [];
    const a = await make(mockFetch((c) => jevReply(c))).adjudicate(reqs(3), {
      signal: signal(),
      deadlineMs: 2000,
      capture: withSink,
    });
    const b = await make(mockFetch((c) => jevReply(c))).adjudicate(reqs(3), {
      signal: signal(),
      deadlineMs: 2000,
    });
    expect(withSink).toHaveLength(1);
    expect(b.answers).toEqual(a.answers);
    expect(b.usage).toEqual(a.usage);
  });

  it("probe() is never captured", async () => {
    const f = mockFetch(jsonRes({ data: [{ id: JEV_PINNED }] }));
    const sink: ProviderExchange[] = [];
    const p = make(f);
    const r = await p.probe({ signal: signal() });
    expect(r.ok).toBe(true);
    expect(sink).toEqual([]);
    expect(f.calls[0]?.init.method).toBe("GET");
    // Even after a captured adjudicate on the same provider, a probe adds nothing.
    const g = mockFetch((c) => jevReply(c), jsonRes({ data: [] }));
    const q = make(g);
    await q.adjudicate(reqs(1), { signal: signal(), deadlineMs: 2000, capture: sink });
    await q.probe({ signal: signal() });
    expect(sink).toHaveLength(1);
  });

  it("a request that fails before the HTTP call (no key) pushes no record", async () => {
    const cfg = adj();
    const r = resolveAdjudicator(cfg, { context: "server", env: ENV });
    const p = createTypesafeProvider(r, cfg, { fetch: mockFetch(stuck), env: {} });
    const sink: ProviderExchange[] = [];
    const err = await caught(
      p.adjudicate(reqs(1), { signal: signal(), deadlineMs: 500, capture: sink }),
    );
    expect(err.kind).toBe("no_key");
    expect(sink).toEqual([]);
  });
});
