/**
 * GET /api/adjudicator/jev/exchanges and /jev/exchange (src/ui/adjudicator-api.ts; task #186 / X8,
 * design blackboard design-xchg-3 and x4-exchange-api). The gates answer before getStorage or any
 * read, bad input is a 400 before the gate, errors are fixed texts, and bodies leave only through
 * /jev/exchange. No other adjudicator payload may carry a captured body: the "no input text"
 * guarantee of the other routes is unchanged (only these two routes are exempt from it).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetSecrets } from "../../src/adjudicator/secrets.js";
import { type Config, ConfigSchema } from "../../src/config.js";
import type { ProjectContext } from "../../src/context.js";
import type { StorageAdapter } from "../../src/storage/adapter.js";
import { getStorage } from "../../src/storage/index.js";
import { SqliteAdapter } from "../../src/storage/sqlite/adapter.js";
import type { ExchangeInput } from "../../src/storage/types.js";
import {
  type AdjudicatorRouteDeps,
  adjudicatorRoute,
  jevExchangePayload,
  jevExchangesPayload,
} from "../../src/ui/adjudicator-api.js";

vi.mock("../../src/storage/index.js", () => ({
  getStorage: vi.fn(() => {
    throw new Error("getStorage must not be reached: SQLITE_BUSY at /secret/path/db.sqlite");
  }),
}));

// biome-ignore lint/suspicious/noExplicitAny: the tests read untyped JSON payloads
type Json = any;

const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
const KEY = "sk-XCHGSENTINEL0123456789abcdef";
const REQ_MARKER = "PLUGH-captured-request-marker";
const RES_MARKER = "XYZZY-captured-answer-marker";
const ERR_MARKER = "FROBOZZ-captured-error-marker";
const FIXED_503 = "the adjudication database is unavailable (busy or missing); try again";
const BASE = "/api/adjudicator/jev";

let db: SqliteAdapter;
let ctx: ProjectContext;

const config = (adjudicator: Record<string, unknown> = {}): Config =>
  ConfigSchema.parse({ adjudicator });
const jev = (capture: boolean, over: Record<string, unknown> = {}) =>
  config({
    enabled: true,
    provider: "typesafe",
    remoteConsent: true,
    privacy: { captureExchanges: capture },
    ...over,
  });
const keyEnv = () => ({ TYPESAFE_API_KEY: KEY, EMINIAR_ADJUDICATOR_KEY: KEY });

/** A database that throws on any use at all, and the list of what was touched. */
function poisoned(): { db: StorageAdapter; touched: string[] } {
  const touched: string[] = [];
  const db = new Proxy(
    {},
    {
      get(_t, prop) {
        touched.push(String(prop));
        throw new Error(`the database was touched: ${String(prop)}`);
      },
    },
  ) as unknown as StorageAdapter;
  return { db, touched };
}

function deps(over: Partial<AdjudicatorRouteDeps> = {}): AdjudicatorRouteDeps {
  return { config: jev(true), db, now: () => NOW, env: keyEnv(), ...over };
}

async function call(
  path: string,
  query: Record<string, string> = {},
  d: AdjudicatorRouteDeps = deps(),
  method = "GET",
) {
  return adjudicatorRoute(
    ctx,
    { path, method, query: new URLSearchParams(query), body: async () => ({}) },
    d,
  );
}
const list = (q: Record<string, string> = {}, d?: AdjudicatorRouteDeps) =>
  call(`${BASE}/exchanges`, q, d);
const one = (q: Record<string, string> = {}, d?: AdjudicatorRouteDeps) =>
  call(`${BASE}/exchange`, q, d);

function xchg(over: Partial<ExchangeInput> = {}): ExchangeInput {
  return {
    ts: NOW - 60_000,
    callId: "c1",
    batch: 0,
    provider: "typesafe",
    model: "jev-1.14.0",
    surface: "agent",
    context: "hook",
    method: "POST",
    target: "api.typesafe.ai/v1/systemone",
    rowIds: [3, 4],
    items: 2,
    outcome: "ok",
    httpStatus: 200,
    timedOut: false,
    attempts: 1,
    waitMs: 12,
    jobWaitMs: null,
    ttfbMs: 300,
    durationMs: 420,
    retryWaitMs: 0,
    deadlineMs: 800,
    budgetMs: 1000,
    tokensIn: 1500,
    tokensOut: 80,
    costUsd: 0.000063,
    requestBody: JSON.stringify({
      state: { items: [{ id: "i0", text: `${REQ_MARKER} fix login` }] },
    }),
    requestBytes: 90,
    requestTruncated: false,
    responseBody: JSON.stringify({ answers: {}, note: RES_MARKER, usage: { input_tokens: 1500 } }),
    responseBytes: 70,
    responseTruncated: false,
    error: null,
    ...over,
  };
}

/** Every key name anywhere in a payload. */
function everyKey(o: unknown, out: string[] = []): string[] {
  if (Array.isArray(o)) for (const v of o) everyKey(v, out);
  else if (o && typeof o === "object")
    for (const [k, v] of Object.entries(o)) {
      out.push(k);
      everyKey(v, out);
    }
  return out;
}

beforeEach(() => {
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-xchg-route-home-"));
  resetSecrets();
  vi.mocked(getStorage).mockClear();
  const root = mkdtempSync(join(tmpdir(), "em-xchg-route-"));
  const dbPath = join(root, "db.sqlite");
  db = new SqliteAdapter(dbPath, { vectors: false });
  ctx = { root, id: "test", dbPath, config: config() };
});
afterEach(() => {
  db.close();
  delete process.env.EMINIAR_HOME;
  resetSecrets();
});

// --- the gates -------------------------------------------------------------------------------

describe("both routes: {active:false} and {capture:false} answer before any database access", () => {
  const inactive: Array<[string, Record<string, unknown>, string, string]> = [
    ["Jev is disabled", { enabled: false, provider: "typesafe" }, "disabled", "typesafe"],
    ["disabled with the default provider", {}, "disabled", "heuristic"],
    [
      "the provider is the heuristic",
      { enabled: true, provider: "heuristic" },
      "provider",
      "heuristic",
    ],
    [
      "the provider is openai-compatible",
      {
        enabled: true,
        provider: "openai-compatible",
        openai: { preset: "groq" },
        remoteConsent: true,
      },
      "provider",
      "openai-compatible",
    ],
    [
      "the provider is embedding",
      { enabled: true, provider: "embedding" },
      "provider",
      "embedding",
    ],
  ];

  for (const [name, adj, reason, provider] of inactive) {
    it(`{active:false} when ${name}`, async () => {
      for (const [route, q] of [
        [list, {}],
        [one, { id: "5" }],
      ] as const) {
        const stub = poisoned();
        const r = await route(q, deps({ config: config(adj), db: stub.db }));
        expect(r.status).toBe(200);
        expect(r.body).toEqual({ active: false, reason, provider, now: NOW });
        expect(stub.touched).toEqual([]);
      }
      expect(getStorage).not.toHaveBeenCalled();
    });
  }

  it("{active:true, capture:false} when Jev is on but capture is off", async () => {
    for (const [route, q] of [
      [list, {}],
      [one, { id: "5" }],
    ] as const) {
      const stub = poisoned();
      const r = await route(q, deps({ config: jev(false), db: stub.db }));
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ active: true, capture: false, keep: 100, now: NOW });
      expect(stub.touched).toEqual([]);
    }
    // With no db given the route must not open the project's database either.
    const r = await list({}, { config: jev(false), now: () => NOW, env: keyEnv() });
    expect(r.body).toMatchObject({ active: true, capture: false });
    expect(getStorage).not.toHaveBeenCalled();
  });

  it("a capture-off answer holds no rows even when rows are stored", async () => {
    db.adjudicator.exchangeInsert([xchg()]);
    for (const r of [
      await list({}, deps({ config: jev(false) })),
      await one({ id: "1" }, deps({ config: jev(false) })),
    ])
      expect(JSON.stringify(r.body)).not.toContain(REQ_MARKER);
  });

  it("the exported payload functions are gated the same way", () => {
    const stub = poisoned();
    expect(jevExchangesPayload(ctx, deps({ config: config(), db: stub.db })).body).toMatchObject({
      active: false,
      reason: "disabled",
    });
    expect(
      jevExchangePayload(ctx, deps({ config: jev(false), db: stub.db }), 7).body,
    ).toMatchObject({
      active: true,
      capture: false,
    });
    expect(stub.touched).toEqual([]);
  });
});

// --- validation -------------------------------------------------------------------------------

describe("validation", () => {
  it("rejects a bad limit with 400, before the gate and the database", async () => {
    for (const limit of [
      "0",
      "101",
      "-1",
      "1.5",
      "abc",
      "10x",
      "1e2",
      " 5",
      "0x10",
      "1000000000000",
    ]) {
      const stub = poisoned();
      const r = await list({ limit }, deps({ db: stub.db }));
      expect(r.status, limit).toBe(400);
      expect(r.body).toEqual({ error: "limit must be an integer between 1 and 100" });
      expect(stub.touched).toEqual([]);
    }
    // Even when Jev is off.
    expect((await list({ limit: "0" }, deps({ config: config() }))).status).toBe(400);
  });

  it("rejects a bad row with 400", async () => {
    for (const row of ["0", "-3", "abc", "1.5", "12abc", "1234567890123456"]) {
      const stub = poisoned();
      const r = await list({ row }, deps({ db: stub.db }));
      expect(r.status, row).toBe(400);
      expect(r.body).toEqual({ error: "row must be a positive integer" });
      expect(stub.touched).toEqual([]);
    }
  });

  it("rejects a bad or missing id with 400", async () => {
    for (const q of [
      {},
      { id: "" },
      { id: "abc" },
      { id: "0" },
      { id: "-1" },
      { id: "1.5" },
      { id: "1234567890123456" },
    ]) {
      const stub = poisoned();
      const r = await one(q, deps({ db: stub.db }));
      expect(r.status, JSON.stringify(q)).toBe(400);
      expect(r.body).toEqual({ error: "id must be a positive integer" });
      expect(stub.touched).toEqual([]);
    }
  });

  it("answers 405 to anything but a GET, on both routes, without a database access", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      for (const path of [`${BASE}/exchanges`, `${BASE}/exchange`]) {
        const stub = poisoned();
        const r = await call(path, { id: "1" }, deps({ db: stub.db }), method);
        expect(r.status, `${method} ${path}`).toBe(405);
        expect(r.body).toEqual({ error: "GET only" });
        expect(stub.touched).toEqual([]);
      }
    }
  });

  it("accepts the limits 1 and 100 and the default", async () => {
    db.adjudicator.exchangeInsert([xchg(), xchg(), xchg()]);
    expect(((await list({ limit: "1" })).body as Json).rows).toHaveLength(1);
    expect(((await list({ limit: "100" })).body as Json).rows).toHaveLength(3);
    expect(((await list()).body as Json).rows).toHaveLength(3);
    expect(((await list({ limit: "" })).body as Json).rows).toHaveLength(3);
  });
});

// --- storage failures --------------------------------------------------------------------------------

describe("storage failures are a 503 with the fixed message", () => {
  const leak = /SQLITE|locked|secret|\/Users|no such table/;

  it("when the database cannot be opened", async () => {
    for (const r of [
      await list({}, { config: jev(true), now: () => NOW, env: keyEnv() }),
      await one({ id: "1" }, { config: jev(true), now: () => NOW, env: keyEnv() }),
    ]) {
      expect(r.status).toBe(503);
      expect(r.body).toEqual({ error: FIXED_503 });
      expect(JSON.stringify(r.body)).not.toMatch(leak);
    }
    expect(getStorage).toHaveBeenCalledTimes(2);
  });

  it("when a read throws", async () => {
    const boom = () => {
      throw new Error("SQLITE_BUSY: database is locked at /Users/me/.eminiar/secret.db");
    };
    const busy = {
      adjudicator: { exchangeList: boom, exchangeGet: boom },
    } as unknown as StorageAdapter;
    for (const r of [
      await list({}, deps({ db: busy })),
      await one({ id: "1" }, deps({ db: busy })),
    ]) {
      expect(r.status).toBe(503);
      expect(r.body).toEqual({ error: FIXED_503 });
      expect(JSON.stringify(r.body)).not.toMatch(leak);
    }
  });

  it("when the table is missing", async () => {
    db.db.exec("DROP TABLE adjudicator_exchanges");
    for (const r of [await list(), await one({ id: "1" })]) {
      expect(r.status).toBe(503);
      expect(JSON.stringify(r.body)).not.toMatch(leak);
    }
  });
});

// --- the payloads ---------------------------------------------------------------------------------------

describe("the list: summaries only", () => {
  beforeEach(() => {
    db.adjudicator.exchangeInsert([
      xchg({ callId: "a", rowIds: [1] }),
      xchg({
        callId: "b",
        rowIds: [2, 3],
        outcome: "timeout",
        timedOut: true,
        httpStatus: null,
        responseBody: null,
        responseBytes: null,
        error: `${ERR_MARKER} no answer`,
      }),
      xchg({
        callId: "c",
        rowIds: [9],
        outcome: "rate_limited",
        httpStatus: 429,
        attempts: 2,
        retryWaitMs: 100,
        error: ERR_MARKER,
      }),
    ]);
  });

  it("returns the newest first with the summary fields and no body, error or key", async () => {
    const r = await list();
    expect(r.status).toBe(200);
    const b = r.body as Json;
    expect(b).toMatchObject({ active: true, capture: true, keep: 100, total: 3, now: NOW });
    expect(b.rows.map((x: Json) => x.callId)).toEqual(["c", "b", "a"]);
    expect(Object.keys(b.rows[0]).sort()).toEqual(
      [
        "id",
        "ts",
        "callId",
        "batch",
        "surface",
        "context",
        "model",
        "target",
        "outcome",
        "status",
        "timedOut",
        "attempts",
        "waitMs",
        "jobWaitMs",
        "ttfbMs",
        "durationMs",
        "retryWaitMs",
        "deadlineMs",
        "budgetMs",
        "items",
        "rowIds",
        "tokensIn",
        "tokensOut",
        "costUsd",
        "requestBytes",
        "requestTruncated",
        "responseBytes",
        "responseTruncated",
      ].sort(),
    );
    expect(b.rows[0]).toMatchObject({
      outcome: "rate_limited",
      status: 429,
      attempts: 2,
      retryWaitMs: 100,
    });
    expect(b.rows[1]).toMatchObject({
      outcome: "timeout",
      timedOut: true,
      status: null,
      responseBytes: null,
    });
    const text = JSON.stringify(r.body);
    for (const m of [REQ_MARKER, RES_MARKER, ERR_MARKER, KEY, "fix login"])
      expect(text).not.toContain(m);
    for (const forbidden of [
      "request",
      "response",
      "error",
      "requestBody",
      "responseBody",
      "request_body",
      "response_body",
      "input_head",
      "inputHead",
      "itemKeys",
      "key",
      "apiKey",
      "authorization",
      "headers",
      "header",
    ]) {
      expect(everyKey(r.body), forbidden).not.toContain(forbidden);
    }
  });

  it("limit and row narrow it; total is the filtered count", async () => {
    const lim = (await list({ limit: "2" })).body as Json;
    expect(lim.rows.map((x: Json) => x.callId)).toEqual(["c", "b"]);
    expect(lim.total).toBe(3);
    const byRow = (await list({ row: "3" })).body as Json;
    expect(byRow.rows.map((x: Json) => x.callId)).toEqual(["b"]);
    expect(byRow.total).toBe(1);
    const none = (await list({ row: "77" })).body as Json;
    expect(none).toMatchObject({ rows: [], total: 0, capture: true });
  });

  it("is empty but still capture:true on a fresh database", async () => {
    db.adjudicator.exchangePurge();
    expect((await list()).body).toEqual({
      active: true,
      capture: true,
      keep: 100,
      total: 0,
      rows: [],
      now: NOW,
    });
  });

  it("never reconciles or writes", async () => {
    const before = JSON.stringify(db.db.prepare("SELECT * FROM adjudicator_exchanges").all());
    await list();
    await one({ id: "1" });
    expect(JSON.stringify(db.db.prepare("SELECT * FROM adjudicator_exchanges").all())).toBe(before);
    expect(db.adjudicator.list().total).toBe(0);
  });
});

describe("the detail: the one route that carries bodies", () => {
  it("returns the request, the response, the error and the summary of one request", async () => {
    const [id] = db.adjudicator.exchangeInsert([xchg({ error: ERR_MARKER })]) as [number];
    const r = await one({ id: String(id) });
    expect(r.status).toBe(200);
    const b = r.body as Json;
    expect(b).toMatchObject({ active: true, capture: true, now: NOW });
    expect(Object.keys(b).sort()).toEqual(["active", "capture", "exchange", "now"]);
    const x = b.exchange;
    expect(x).toMatchObject({
      id,
      callId: "c1",
      outcome: "ok",
      status: 200,
      items: 2,
      rowIds: [3, 4],
      error: ERR_MARKER,
    });
    expect(x.request.json).toBe(true);
    expect(x.request.truncated).toBe(false);
    expect(x.request.text).toContain(REQ_MARKER);
    expect(x.request.bytes).toBe(90);
    expect(x.response.text).toContain(RES_MARKER);
    expect(x.response.json).toBe(true);
    expect(JSON.stringify(b)).not.toContain(KEY);
    for (const forbidden of [
      "input_head",
      "inputHead",
      "itemKeys",
      "key",
      "apiKey",
      "authorization",
      "headers",
      "header",
      "requestBody",
      "responseBody",
      "request_body",
      "response_body",
    ])
      expect(everyKey(b), forbidden).not.toContain(forbidden);
  });

  it("a response-less timeout has response:null; a cut body is flagged and not json", async () => {
    const [t, c] = db.adjudicator.exchangeInsert([
      xchg({
        outcome: "timeout",
        timedOut: true,
        httpStatus: null,
        responseBody: null,
        responseBytes: null,
        error: "no answer within 800 ms",
      }),
      xchg({
        requestBody: '{"state":{"items":[{"text":"cut off in th',
        requestBytes: 90_000,
        requestTruncated: true,
      }),
    ]) as [number, number];
    const timeout = ((await one({ id: String(t) })).body as Json).exchange;
    expect(timeout.response).toBeNull();
    expect(timeout.error).toBe("no answer within 800 ms");
    expect(timeout.timedOut).toBe(true);
    const cut = ((await one({ id: String(c) })).body as Json).exchange;
    expect(cut.request).toMatchObject({ json: false, truncated: true, bytes: 90_000 });
  });

  it("a stored body that is not JSON is json:false", async () => {
    const [id] = db.adjudicator.exchangeInsert([
      xchg({ responseBody: "<html>bad gateway</html>", responseBytes: 24 }),
    ]) as [number];
    const x = ((await one({ id: String(id) })).body as Json).exchange;
    expect(x.response).toEqual({
      text: "<html>bad gateway</html>",
      json: false,
      bytes: 24,
      truncated: false,
    });
  });

  it("answers 404 for a request that is not stored (deleted or never existed)", async () => {
    const [id] = db.adjudicator.exchangeInsert([xchg()]) as [number];
    db.adjudicator.exchangePurge();
    for (const n of [String(id), "99999"]) {
      const r = await one({ id: n });
      expect(r.status).toBe(404);
      expect(r.body).toEqual({ error: `request ${n} not found` });
    }
  });
});

// --- bodies leave through the two routes only ------------------------------------------------------------------

describe("no other adjudicator payload carries a captured body", () => {
  it("overview, decisions, decision, savings, eval and /jev stay free of captured text", async () => {
    // A decision row to list, with an input head, so the other routes have something to say.
    const id = db.adjudicator.insert({
      surface: "agent",
      inputHash: "h",
      inputHead: "refactor the auth module",
      sessionId: "S",
      ts: NOW - 1000,
      complexity: 1,
      effort: "low",
      tier: "haiku",
      scores: "{}",
      source: "heuristic",
      providerStatus: "n/a",
      latencyMs: 1,
      final: true,
      outcome: "pending",
    } as never);
    db.adjudicator.exchangeInsert([xchg({ rowIds: [id], error: ERR_MARKER })]);
    const paths: Array<[string, Record<string, string>]> = [
      ["/api/adjudicator", {}],
      ["/api/adjudicator", { since: "all" }],
      ["/api/adjudicator/decisions", {}],
      ["/api/adjudicator/decision", { id: String(id) }],
      ["/api/adjudicator/savings", {}],
      ["/api/adjudicator/eval", {}],
      [BASE, {}],
      [BASE, { surface: "agent" }],
    ];
    for (const [path, q] of paths) {
      const r = await call(path, q);
      expect(r.status, path).toBe(200);
      const text = JSON.stringify(r.body);
      for (const m of [REQ_MARKER, RES_MARKER, ERR_MARKER, "adjudicator_exchanges", "request_body"])
        expect(text, `${path}: ${m}`).not.toContain(m);
    }
    // ...while the two routes do carry them, so the scan above could fail.
    expect(JSON.stringify((await one({ id: "1" })).body)).toContain(REQ_MARKER);
  });

  it("try-it with capture on does not store or read an exchange and gets no sink", async () => {
    const seen: Array<{ hasCapture: boolean }> = [];
    const provider = {
      id: "typesafe" as const,
      remote: true,
      dims: ["complexity", "tier", "role"] as Array<"complexity" | "tier" | "role">,
      async adjudicate(reqs: Array<{ key: string }>, o: Record<string, unknown>) {
        seen.push({ hasCapture: "capture" in o });
        return {
          answers: reqs.map((r) => ({
            key: r.key,
            tier: { probs: { opus: 1 }, confidence: 0.9, calibrated: true },
          })),
          usage: { inTok: 1, outTok: 1, costUsd: 0 },
          latencyMs: 1,
          model: "jev-1.14.0",
        };
      },
      async probe() {
        return { ok: true, latencyMs: 1, detail: "" };
      },
    };
    const r = await adjudicatorRoute(
      ctx,
      {
        path: "/api/adjudicator/test",
        method: "POST",
        query: new URLSearchParams(),
        body: async () => ({
          text: "refactor the storage layer across every adapter",
          useProvider: true,
        }),
      },
      deps({ provider: provider as never }),
    );
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ usedProvider: true, persisted: false });
    expect(seen).toEqual([{ hasCapture: false }]);
    expect(db.adjudicator.exchangeCount()).toBe(0);
  });
});
