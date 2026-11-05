/**
 * Jev exchange log, end to end through the engine (task #186 / X8; design blackboard design-xchg-5
 * T1-T13): the REAL typesafe provider and http layer over a stubbed fetch, the real SQLite store.
 * No network and no model. Complements adjudicator-capture-engine.test.ts (the engine gate with a
 * fake provider, task #181), adjudicator-capture-provider.test.ts (http.ts / typesafe.ts records) and
 * the 'exchange log (migration v9)' block of adjudicator-store.test.ts.
 */
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAdjudicator } from "../../src/adjudicator/config.js";
import { adjudicate, type EngineOptions } from "../../src/adjudicator/engine.js";
import type { FetchLike } from "../../src/adjudicator/providers/http.js";
import { resetProviders } from "../../src/adjudicator/providers/index.js";
import { createTypesafeProvider, JEV_PINNED } from "../../src/adjudicator/providers/typesafe.js";
import { resetSecrets } from "../../src/adjudicator/secrets.js";
import type {
  AdjudicationRequest,
  AdjudicatorProvider,
  ProviderExchange,
  ProviderResult,
} from "../../src/adjudicator/types.js";
import {
  type AdjudicatorConfig,
  ConfigSchema,
  droppedProjectAdjudicatorKeys,
  loadConfig,
  personalConfigTrusted,
} from "../../src/config.js";
import { SqliteAdapter } from "../../src/storage/sqlite/adapter.js";
import { EXCHANGE_KEEP } from "../../src/storage/sqlite/adjudicator.js";
import type { AdjudicatorStore, ExchangeInput } from "../../src/storage/types.js";

const KEY = "sk-XCHGSENTINEL0123456789abcdef";
const ENV = { TYPESAFE_API_KEY: KEY } as NodeJS.ProcessEnv;

// biome-ignore lint/suspicious/noExplicitAny: the tests read untyped JSON
type Json = any;

let home: string;
let root: string;
let dbPath: string;
let adapters: SqliteAdapter[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "em-xchg-e2e-home-"));
  root = mkdtempSync(join(tmpdir(), "em-xchg-e2e-root-"));
  process.env.EMINIAR_HOME = home;
  delete process.env.EMINIAR_ADJUDICATOR_CAPTURE;
  dbPath = join(mkdtempSync(join(tmpdir(), "em-xchg-e2e-db-")), "eminiar.db");
  adapters = [];
  resetSecrets();
  resetProviders();
});
afterEach(() => {
  for (const a of adapters) a.close();
  delete process.env.EMINIAR_HOME;
  delete process.env.EMINIAR_ADJUDICATOR_CAPTURE;
  resetSecrets();
  resetProviders();
});

function open(path = dbPath): SqliteAdapter {
  const a = new SqliteAdapter(path, { vectors: false });
  adapters.push(a);
  return a;
}

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
type Reply = Response | ((call: Call, n: number) => Response | Promise<Response>);

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
    return typeof r === "function" ? r(call, calls.length) : r.clone();
  }) as FetchLike & { calls: Call[] };
  f.calls = calls;
  return f;
}

/** Never settles and ignores the abort signal: only the engine's timer ends the wait. */
const stuck: Reply = () => new Promise<Response>(() => {});

/** A Jev reply answering every question; `extra` is added to the body (an echoing server). */
function jevReply(call: Call, extra: Record<string, unknown> = {}) {
  const qs = (call.body?.questions ?? {}) as Record<string, { type: string; criteria?: unknown }>;
  const answers: Record<string, unknown> = {};
  for (const [id, q] of Object.entries(qs)) {
    if (q.type === "score") {
      const legend = Object.fromEntries((q.criteria as string[]).map((c, i) => [String(i), c]));
      answers[id] = { type: "score", score: 3, confidence: 0.9, legend };
    } else if (q.type === "noul") answers[id] = { type: "noul", noul: 0.3 };
    else {
      const opts = Object.keys(q.criteria as Record<string, string>);
      answers[id] = {
        type: "choice",
        choice: opts[2],
        confidence: 0.9,
        probabilities: Object.fromEntries(
          opts.map((x, i) => [x, i === 2 ? 0.9 : 0.1 / (opts.length - 1)]),
        ),
      };
    }
  }
  return jsonRes({
    model: JEV_PINNED,
    answers,
    usage: { input_tokens: 1500, output_tokens: 80 },
    ...extra,
  });
}

const cfgOf = (capture: boolean, over: Record<string, unknown> = {}): AdjudicatorConfig => {
  const { privacy, ...rest } = over;
  return ConfigSchema.parse({
    adjudicator: {
      enabled: true,
      provider: "typesafe",
      remoteConsent: true,
      privacy: { captureExchanges: capture, ...((privacy as object) ?? {}) },
      ...rest,
    },
  }).adjudicator;
};

const req = (
  i: number | string,
  text?: string,
  surface: AdjudicationRequest["surface"] = "agent",
) => ({
  key: `rk-${i}`,
  surface,
  text: text ?? `refactor module ${i} of the storage layer across every adapter and migration`,
});

/** The real typesafe provider over `fetch`, as the engine gets it. */
function realRun(
  fetch: FetchLike,
  store: AdjudicatorStore | undefined,
  capture: boolean,
  o: { cfg?: AdjudicatorConfig; env?: NodeJS.ProcessEnv } & Partial<EngineOptions> = {},
) {
  const { cfg, env, ...engineOpts } = o;
  const config = cfg ?? cfgOf(capture);
  const e = env ?? ENV;
  const resolved = resolveAdjudicator(config, { env: e });
  const provider = createTypesafeProvider(resolved, config, { fetch, env: e });
  const calls: Array<{ hasCaptureKey: boolean }> = [];
  const spy: AdjudicatorProvider = {
    ...provider,
    adjudicate: (reqs, opts) => {
      calls.push({ hasCaptureKey: "capture" in opts });
      return provider.adjudicate(reqs, opts);
    },
  };
  const opts: EngineOptions = {
    config,
    resolved,
    env: e,
    provider: spy,
    budgetMs: 2000,
    ...(store ? { store } : {}),
    ...engineOpts,
  };
  return { opts, calls, resolved };
}

const rowsOf = (a: SqliteAdapter): Array<Record<string, unknown>> =>
  a.db.prepare("SELECT * FROM adjudicator_exchanges ORDER BY id").all() as Array<
    Record<string, unknown>
  >;

/** Throws on any property read whose name starts with "exchange": nothing may touch the log. */
function exchangeTripwire(store: AdjudicatorStore): { store: AdjudicatorStore; touched: string[] } {
  const touched: string[] = [];
  const proxy = new Proxy(store, {
    get(t, k, rcv) {
      if (typeof k === "string" && k.startsWith("exchange")) {
        touched.push(k);
        throw new Error(`the exchange log was touched: ${k}`);
      }
      const v = Reflect.get(t, k, rcv);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  return { store: proxy, touched };
}

// ---------------------------------------------------------------------------------------------

describe("T1: the key never reaches a stored record", () => {
  it("not in any column, nor in the database file bytes, even when the server echoes it", async () => {
    // The realistic path: the key is in the key file, not the environment.
    writeFileSync(join(home, "adjudicator.key"), JSON.stringify({ typesafe: KEY }), {
      mode: 0o600,
    });
    resetSecrets();
    const a = open();
    const echo = `bad key ${KEY}; Authorization: Bearer ${KEY}`;
    const f = mockFetch(
      (c) => jevReply(c, { debug: { echo, headers: { authorization: `Bearer ${KEY}` } } }),
      jsonRes({ error: echo, authorization: `Bearer ${KEY}` }, 500),
    );
    const prompt = `Refactor the config loader across the codebase and keep ${KEY} out of the logs`;
    const run1 = realRun(f, a.adjudicator, true, { env: {} });
    expect(run1.resolved.provider).toBe("typesafe");
    const [ok] = await adjudicate([req("a", prompt)], run1.opts);
    expect(ok?.verdict.source).toBe("blend");
    const run2 = realRun(f, a.adjudicator, true, { env: {} });
    const [bad] = await adjudicate([req("b", `${prompt} and then some other change`)], run2.opts);
    expect(bad?.verdict.providerStatus).toBe("http_error");

    // The Authorization header really was sent with the key.
    expect(f.calls).toHaveLength(2);
    expect(((f.calls[0]?.init.headers ?? {}) as Record<string, string>).authorization).toBe(
      `Bearer ${KEY}`,
    );

    const rows = rowsOf(a);
    expect(rows.map((r) => r.outcome)).toEqual(["ok", "http_error"]);
    const dump = JSON.stringify(rows);
    for (const needle of [KEY, KEY.slice(0, 14), "XCHGSENTINEL"]) {
      expect(dump, needle).not.toContain(needle);
    }
    // The server's own echo of "Authorization: Bearer <key>" may keep its words, but never the token.
    expect(dump).not.toMatch(/Bearer\s+(?!\*\*\*)[A-Za-z0-9]/i);
    // The request we sent has no header at all.
    for (const r of rows) {
      expect(String(r.request_body).toLowerCase()).not.toContain("authorization");
      expect(String(r.request_body).toLowerCase()).not.toContain("bearer");
    }
    // The prompt is masked inside the request string; the rest is there.
    expect(String(rows[0]?.request_body)).toContain("Refactor the config loader");

    // Raw bytes of the database and its WAL/SHM: the key is nowhere (the key file is elsewhere).
    a.db.pragma("wal_checkpoint(PASSIVE)");
    const dir = join(dbPath, "..");
    const files = readdirSync(dir).filter((n) => n.startsWith("eminiar.db"));
    expect(files).toContain("eminiar.db");
    for (const name of files) {
      const bytes = readFileSync(join(dir, name));
      expect(bytes.includes(KEY), name).toBe(false);
      expect(bytes.includes("XCHGSENTINEL"), name).toBe(false);
    }
    // And the request body that was stored has no header or key field at all.
    const stored = JSON.parse(String(rows[0]?.request_body)) as Json;
    expect(Object.keys(stored).sort()).toEqual(["model", "questions", "state"]);
  });
});

describe("T2-T4: only the personal config can turn capture on", () => {
  const PERSONAL = { adjudicator: { enabled: true, provider: "typesafe", remoteConsent: true } };

  function writePersonal(dir: string, privacy?: Record<string, unknown>) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ adjudicator: { ...PERSONAL.adjudicator, ...(privacy ? { privacy } : {}) } }),
    );
  }

  async function fullRun(cfg: AdjudicatorConfig) {
    const a = open();
    const f = mockFetch((c) => jevReply(c));
    const r = realRun(f, a.adjudicator, cfg.privacy.captureExchanges, { cfg });
    const out = await adjudicate([req("x")], r.opts);
    return { a, out, r };
  }

  it("T2: eminiar.config.json cannot enable it, __proto__ variants included", async () => {
    writePersonal(home);
    const variants = [
      { adjudicator: { privacy: { captureExchanges: true } } },
      '{"adjudicator":{"privacy":{"__proto__":{"captureExchanges":true}}}}',
      '{"adjudicator":{"__proto__":{"privacy":{"captureExchanges":true}}}}',
      '{"__proto__":{"adjudicator":{"privacy":{"captureExchanges":true}}}}',
      { adjudicator: { privacy: { captureExchanges: "true" } } },
    ];
    for (const v of variants) {
      writeFileSync(
        join(root, "eminiar.config.json"),
        typeof v === "string" ? v : JSON.stringify(v),
      );
      const cfg = loadConfig(root).adjudicator;
      expect(cfg.privacy.captureExchanges, String(JSON.stringify(v))).toBe(false);
      expect(cfg.enabled).toBe(true); // the personal file still applies
      expect(({} as Json).captureExchanges).toBeUndefined();
    }
    writeFileSync(
      join(root, "eminiar.config.json"),
      JSON.stringify({ adjudicator: { privacy: { captureExchanges: true } } }),
    );
    expect(
      droppedProjectAdjudicatorKeys(
        JSON.parse(readFileSync(join(root, "eminiar.config.json"), "utf8")),
      ),
    ).toEqual(["privacy"]);
    const { a, out, r } = await fullRun(loadConfig(root).adjudicator);
    expect(out[0]?.verdict.source).toBe("blend"); // Jev was used...
    expect(r.calls).toEqual([{ hasCaptureKey: false }]); // ...with no sink
    expect(a.adjudicator.exchangeCount()).toBe(0); // ...and nothing was kept
  });

  it("T3: a personal file inside the project is untrusted and cannot enable it", async () => {
    const inside = join(root, ".em");
    process.env.EMINIAR_HOME = inside;
    writePersonal(inside, { captureExchanges: true });
    expect(personalConfigTrusted(root)).toBe(false);
    const cfg = loadConfig(root).adjudicator;
    expect(cfg.privacy.captureExchanges).toBe(false);
    expect(cfg.privacy.maxChars).toBe(2000);
    // Run Jev with what the untrusted file left of the config: nothing is captured.
    const { a, r } = await fullRun({
      ...cfg,
      enabled: true,
      provider: "typesafe",
      remoteConsent: true,
    });
    expect(r.calls).toEqual([{ hasCaptureKey: false }]);
    expect(a.adjudicator.exchangeCount()).toBe(0);

    // Control: the same file outside the project does enable it, so the above is not vacuous.
    const outside = mkdtempSync(join(tmpdir(), "em-xchg-trusted-"));
    process.env.EMINIAR_HOME = outside;
    writePersonal(outside, { captureExchanges: true });
    expect(personalConfigTrusted(root)).toBe(true);
    expect(loadConfig(root).adjudicator.privacy.captureExchanges).toBe(true);
  });

  it("T4: EMINIAR_ADJUDICATOR_CAPTURE=1 does nothing; =0 forces it off whatever the file says", async () => {
    writePersonal(home);
    process.env.EMINIAR_ADJUDICATOR_CAPTURE = "1";
    expect(loadConfig(root).adjudicator.privacy.captureExchanges).toBe(false);
    for (const v of ["true", "yes", "on", "2", ""]) {
      process.env.EMINIAR_ADJUDICATOR_CAPTURE = v;
      expect(loadConfig(root).adjudicator.privacy.captureExchanges, v).toBe(false);
    }
    writePersonal(home, { captureExchanges: true, maxChars: 777 });
    delete process.env.EMINIAR_ADJUDICATOR_CAPTURE;
    expect(loadConfig(root).adjudicator.privacy.captureExchanges).toBe(true);
    // =1 does not touch a setting that is already on.
    process.env.EMINIAR_ADJUDICATOR_CAPTURE = "1";
    expect(loadConfig(root).adjudicator.privacy.captureExchanges).toBe(true);
    process.env.EMINIAR_ADJUDICATOR_CAPTURE = "0";
    const cfg = loadConfig(root).adjudicator;
    expect(cfg.privacy.captureExchanges).toBe(false);
    expect(cfg.privacy.maxChars).toBe(777);
    const { a, r } = await fullRun(cfg);
    expect(r.calls).toEqual([{ hasCaptureKey: false }]);
    expect(a.adjudicator.exchangeCount()).toBe(0);
  });
});

describe("T5: exactly the newest 100 are kept, with several writers", () => {
  const xs = (n: number, tag: string): ExchangeInput[] =>
    Array.from({ length: n }, (_, i) => ({
      ts: Date.now(),
      callId: tag,
      batch: i,
      provider: "typesafe",
      method: "POST",
      target: "api.typesafe.ai/v1/systemone",
      items: 1,
      outcome: "ok",
      deadlineMs: 800,
      requestBody: `{"tag":"${tag}"}`,
      requestBytes: 10,
    }));

  const ids = (a: SqliteAdapter) => rowsOf(a).map((r) => r.id as number);
  const contiguous = (all: number[]) =>
    all.every((id, i) => i === 0 || id === (all[i - 1] as number) + 1);

  it("two connections to the same file, interleaved single rows and batches", () => {
    const a = open();
    const b = open();
    let n = 0;
    for (let i = 0; i < 90; i++) {
      (i % 2 ? a : b).adjudicator.exchangeInsert(xs(1 + (i % 3), `w${i}`));
      n += 1 + (i % 3);
    }
    expect(n).toBeGreaterThan(EXCHANGE_KEEP);
    for (const c of [a, b]) {
      expect(c.adjudicator.exchangeCount()).toBe(100);
    }
    const all = ids(a);
    expect(all).toHaveLength(100);
    expect(all[0]).toBe(Math.max(...all) - 99);
    expect(contiguous(all)).toBe(true);
    // The newest survive: the last writer's rows are all there.
    expect(rowsOf(a).at(-1)?.call_id).toBe("w89");
    // A 2-row batch across the boundary, and a small keep, on top.
    a.adjudicator.exchangeInsert(xs(2, "edge"));
    expect(ids(b)).toHaveLength(100);
    b.adjudicator.exchangeInsert(xs(2, "small"), 3);
    expect(ids(a)).toHaveLength(3);
  });

  it("many concurrent engine runs on one store keep exactly 100, newest first", async () => {
    const a = open();
    const fake = (): AdjudicatorProvider => ({
      id: "typesafe",
      remote: true,
      dims: ["complexity", "tier", "role"],
      async adjudicate(reqs, opts): Promise<ProviderResult> {
        for (let i = 0; i * 10 < reqs.length; i++) {
          const rec: ProviderExchange = {
            http: {
              method: "POST",
              target: "api.typesafe.ai/v1/systemone",
              sentAt: Date.now(),
              deadlineMs: 800,
              attempts: 1,
              retryWaitMs: 0,
              ttfbMs: 1,
              durationMs: 2,
              status: 200,
              outcome: "ok",
              request: { text: "{}", json: true, bytes: 2, truncated: false },
              response: { text: "{}", json: true, bytes: 2, truncated: false },
              error: null,
            },
            provider: "typesafe",
            model: JEV_PINNED,
            batch: i,
            itemKeys: reqs.slice(i * 10, i * 10 + 10).map((r) => r.key),
            tokensIn: 1,
            tokensOut: 1,
            costUsd: 0,
          };
          opts.capture?.push(rec);
        }
        await new Promise((r) => setTimeout(r, Math.random() * 5));
        return {
          answers: reqs.map((r) => ({
            key: r.key,
            complexity: { value: 3, confidence: 0.9 },
            tier: { probs: { sonnet: 1 }, confidence: 0.9, calibrated: true },
            role: { probs: { coder: 1 }, confidence: 0.9, calibrated: true },
          })),
          usage: { inTok: 1, outTok: 1, costUsd: 0 },
          latencyMs: 1,
          model: JEV_PINNED,
        };
      },
      async probe() {
        return { ok: true, latencyMs: 1, detail: "fake" };
      },
    });
    const config = cfgOf(true);
    const resolved = resolveAdjudicator(config, { env: ENV });
    const runs = Array.from({ length: 40 }, (_, w) =>
      adjudicate(
        Array.from({ length: 12 }, (_, i) =>
          req(`${w}-${i}`, `change ${w} item ${i}: rework adapter ${w * 100 + i}`),
        ),
        { config, resolved, env: ENV, store: a.adjudicator, provider: fake(), budgetMs: 3000 },
      ),
    );
    await Promise.all(runs);
    // 40 runs x 2 batches = 80 rows, then a second wave takes it past the limit.
    expect(a.adjudicator.exchangeCount()).toBe(80);
    await Promise.all(
      Array.from({ length: 20 }, (_, w) =>
        adjudicate(
          Array.from({ length: 12 }, (_, i) =>
            req(`b${w}-${i}`, `second wave ${w} item ${i}: tune query ${w * 100 + i}`),
          ),
          { config, resolved, env: ENV, store: a.adjudicator, provider: fake(), budgetMs: 3000 },
        ),
      ),
    );
    const all = ids(a);
    expect(all).toHaveLength(100);
    expect(all[0]).toBe(Math.max(...all) - 99);
    expect(contiguous(all)).toBe(true);
    // Every kept row still links to existing decision rows.
    for (const r of a.adjudicator.exchangeList({ limit: 100 }).rows) {
      expect(r.rowIds.length).toBe(r.items);
      for (const id of r.rowIds) expect(a.adjudicator.get(id)).toBeDefined();
    }
  });
});

describe("T6: a busy database loses the exchange, never the verdict", () => {
  /** exchangeInsert runs while a second connection holds the write lock. */
  function busyWhileInserting(store: AdjudicatorStore): AdjudicatorStore {
    return new Proxy(store, {
      get(t, k, rcv) {
        const v = Reflect.get(t, k, rcv);
        if (k !== "exchangeInsert") return typeof v === "function" ? v.bind(t) : v;
        return (...args: unknown[]) => {
          const holder = new Database(dbPath);
          holder.exec("BEGIN IMMEDIATE");
          try {
            return (v as (...a: unknown[]) => unknown).apply(t, args);
          } finally {
            holder.exec("ROLLBACK");
            holder.close();
          }
        };
      },
    });
  }

  it("skips the write, logs it once, and returns the same verdict as an unlocked run", async () => {
    const a = open();
    const lines: string[] = [];
    const budgetMs = 2000;
    const f = mockFetch((c) => jevReply(c));
    const control = await adjudicate([req("ctl")], realRun(f, a.adjudicator, true).opts);
    expect(a.adjudicator.exchangeCount()).toBe(1);

    const t0 = Date.now();
    const run = realRun(f, busyWhileInserting(a.adjudicator), true, {
      budgetMs,
      log: (l) => lines.push(l),
    });
    const out = await adjudicate([req("ctl")], run.opts); // same text: answered from the cache
    const run2 = realRun(f, busyWhileInserting(a.adjudicator), true, {
      budgetMs,
      log: (l) => lines.push(l),
    });
    const [fresh] = await adjudicate(
      [req("busy", "plan the migration of the auth service to oauth")],
      run2.opts,
    );
    const elapsed = Date.now() - t0;
    expect(out[0]?.verdict.tier.choice).toBe(control[0]?.verdict.tier.choice);
    expect(fresh?.verdict.source).toBe("blend");
    expect(fresh?.verdict.providerStatus).toBe("ok");
    expect(fresh?.rowId).toBeGreaterThan(0);
    expect(lines.filter((l) => l.includes("exchange capture skipped"))).toHaveLength(1);
    expect(lines.join("\n")).not.toContain(KEY);
    expect(a.adjudicator.exchangeCount()).toBe(1); // only the control's
    expect(elapsed).toBeLessThan(budgetMs / 2); // fail fast: no lock wait was spent on it
    // Once the lock is gone the next call is written.
    await adjudicate(
      [req("later", "audit the retry logic in the http layer")],
      realRun(f, a.adjudicator, true).opts,
    );
    expect(a.adjudicator.exchangeCount()).toBe(2);
  });

  it("with the whole database write-locked the call still returns a verdict and throws nothing", async () => {
    const a = open();
    const holder = new Database(dbPath);
    holder.exec("BEGIN IMMEDIATE");
    const lines: string[] = [];
    const budgetMs = 1500;
    try {
      const t0 = Date.now();
      const f = mockFetch((c) => jevReply(c));
      const run = realRun(f, a.adjudicator, true, { budgetMs, log: (l) => lines.push(l) });
      const out = await adjudicate([req("locked")], run.opts);
      expect(out).toHaveLength(1);
      expect(out[0]?.verdict.tier.choice).toBeTruthy();
      expect(Date.now() - t0).toBeLessThan(budgetMs + 50);
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
    expect(a.adjudicator.exchangeCount()).toBe(0);
    expect(lines.join("\n")).not.toContain(KEY);
  });

  it("a read-only or missing table loses the exchange the same way", async () => {
    const a = open();
    a.db.exec("DROP TABLE adjudicator_exchanges");
    const lines: string[] = [];
    const f = mockFetch((c) => jevReply(c));
    const run = realRun(f, a.adjudicator, true, { log: (l) => lines.push(l) });
    const [r] = await adjudicate([req("noTable")], run.opts);
    expect(r?.verdict.source).toBe("blend");
    expect(lines.some((l) => l.includes("exchange capture skipped"))).toBe(true);
  });
});

describe("T7 / T13: off, and the callers that are never captured, cost nothing", () => {
  it("off: the provider gets no capture key and the exchange log is never touched", async () => {
    const a = open();
    const t = exchangeTripwire(a.adjudicator);
    const f = mockFetch((c) => jevReply(c));
    const run = realRun(f, t.store, false);
    const out = await adjudicate([req("o1"), req("o2")], run.opts);
    expect(out[0]?.verdict.source).toBe("blend");
    expect(run.calls).toEqual([{ hasCaptureKey: false }]);
    expect(t.touched).toEqual([]);
    expect(rowsOf(a)).toEqual([]);
  });

  it("on but persist:false (eval, `adjudicator test`, the try-it box): no sink, no log access", async () => {
    const a = open();
    const t = exchangeTripwire(a.adjudicator);
    const f = mockFetch((c) => jevReply(c));
    const run = realRun(f, t.store, true, { persist: false });
    const out = await adjudicate([req("p1", undefined, "test")], run.opts);
    expect(out[0]?.verdict.source).toBe("blend");
    expect(f.calls.length).toBeGreaterThan(0);
    expect(run.calls).toEqual([{ hasCaptureKey: false }]);
    expect(t.touched).toEqual([]);
    expect(a.adjudicator.exchangeCount()).toBe(0);
  });

  it("on with no store at all: nothing to write to, nothing breaks", async () => {
    const f = mockFetch((c) => jevReply(c));
    const run = realRun(f, undefined, true);
    const [r] = await adjudicate([req("nostore")], run.opts);
    expect(r?.verdict.source).toBe("blend");
    expect(run.calls).toEqual([{ hasCaptureKey: false }]);
  });

  it("on for the openai-compatible provider: never captured (Jev POSTs only)", async () => {
    const a = open();
    const t = exchangeTripwire(a.adjudicator);
    const fake: AdjudicatorProvider = {
      id: "openai-compatible",
      remote: true,
      dims: ["complexity", "tier", "role"],
      async adjudicate(reqs, opts) {
        expect("capture" in opts).toBe(false);
        return {
          answers: reqs.map((r) => ({
            key: r.key,
            tier: { probs: { opus: 1 }, confidence: 0.9, calibrated: false },
          })),
          usage: { inTok: 1, outTok: 1, costUsd: 0 },
          latencyMs: 1,
          model: "m",
        };
      },
      async probe() {
        return { ok: true, latencyMs: 1, detail: "" };
      },
    };
    const config = cfgOf(true, { provider: "openai-compatible", openai: { preset: "groq" } });
    const env = { GROQ_API_KEY: KEY } as NodeJS.ProcessEnv;
    const resolved = resolveAdjudicator(config, { env });
    expect(resolved.provider).toBe("openai-compatible");
    await adjudicate([req("oa")], {
      config,
      resolved,
      env,
      store: t.store,
      provider: fake,
      budgetMs: 1000,
    });
    expect(t.touched).toEqual([]);
  });

  it("probe() leaves no exchange, with capture on", async () => {
    const a = open();
    const t = exchangeTripwire(a.adjudicator);
    const f = mockFetch(jsonRes({ data: [{ id: JEV_PINNED }] }));
    const run = realRun(f, t.store, true);
    const r = await run.opts.provider?.probe({ signal: new AbortController().signal });
    expect(r?.ok).toBe(true);
    expect(t.touched).toEqual([]);
    expect(a.adjudicator.exchangeCount()).toBe(0);
  });

  it("a cache hit never reaches the provider, so it writes nothing", async () => {
    const a = open();
    const f = mockFetch((c) => jevReply(c));
    await adjudicate([req("same")], realRun(f, a.adjudicator, true).opts);
    expect(a.adjudicator.exchangeCount()).toBe(1);
    const again = await adjudicate([req("same")], realRun(f, a.adjudicator, true).opts);
    expect(again[0]?.verdict.source).toBe("cache");
    expect(f.calls).toHaveLength(1);
    expect(a.adjudicator.exchangeCount()).toBe(1);
  });
});

describe("T8-T12: what a stored row says about the call", () => {
  it("12 requests make two rows linked to their decisions (10 + 2), one call id", async () => {
    const a = open();
    const f = mockFetch((c) => jevReply(c));
    const reqs = Array.from({ length: 12 }, (_, i) => req(i));
    const run = realRun(f, a.adjudicator, true, { context: "hook" });
    const out = await adjudicate(reqs, run.opts);
    expect(f.calls).toHaveLength(2);
    const rows = a.adjudicator.exchangeList({ limit: 10 }).rows.sort((x, y) => x.batch - y.batch);
    expect(rows.map((r) => r.items)).toEqual([10, 2]);
    expect(rows[0]?.rowIds).toEqual(out.slice(0, 10).map((o) => o.rowId));
    expect(rows[1]?.rowIds).toEqual(out.slice(10).map((o) => o.rowId));
    expect(rows[0]?.callId).toBe(rows[1]?.callId);
    expect(rows[0]).toMatchObject({
      provider: "typesafe",
      model: JEV_PINNED,
      surface: "agent",
      context: "hook",
      outcome: "ok",
      httpStatus: 200,
      timedOut: false,
      attempts: 1,
      retryWaitMs: 0,
      tokensIn: 1500,
      tokensOut: 80,
      target: "api.typesafe.ai/v1/systemone",
    });
    // Row ids filter: the list for one decision names the request that served it.
    const id = out[11]?.rowId as number;
    expect(a.adjudicator.exchangeList({ rowId: id }).rows.map((r) => r.batch)).toEqual([1]);
  });

  it("a 429 then a 200: attempts 2, the retry wait, a consistent timeline", async () => {
    const a = open();
    const f = mockFetch(jsonRes({ error: "slow down" }, 429, { "retry-after": "0.1" }), (c) =>
      jevReply(c),
    );
    const budgetMs = 2000;
    const [r] = await adjudicate([req("rl")], realRun(f, a.adjudicator, true, { budgetMs }).opts);
    expect(r?.verdict.source).toBe("blend");
    expect(f.calls).toHaveLength(2);
    const [row] = a.adjudicator.exchangeList().rows;
    expect(row).toMatchObject({
      attempts: 2,
      retryWaitMs: 100,
      httpStatus: 200,
      outcome: "ok",
      timedOut: false,
    });
    expect(row?.durationMs as number).toBeGreaterThanOrEqual(90);
    expect(row?.ttfbMs).not.toBeNull();
    expect(row?.durationMs as number).toBeGreaterThanOrEqual(
      (row?.retryWaitMs as number) + (row?.ttfbMs as number) - 5,
    );
    expect(row?.waitMs).toBeGreaterThanOrEqual(0);
    expect(row?.jobWaitMs).toBeNull(); // only the async job has one
    expect(row?.deadlineMs).toBeGreaterThan(0);
    expect(row?.deadlineMs).toBeLessThanOrEqual(budgetMs);
    expect(row?.budgetMs).toBe(budgetMs);
  });

  it("an answer cut off by the engine's budget is one timeout row with no response, written without extra wait", async () => {
    const a = open();
    const f = mockFetch(stuck);
    const budgetMs = 150;
    const t0 = Date.now();
    const [r] = await adjudicate([req("slow")], realRun(f, a.adjudicator, true, { budgetMs }).opts);
    const elapsed = Date.now() - t0;
    expect(r?.verdict.providerStatus).toBe("timeout");
    expect(elapsed).toBeLessThan(budgetMs + 250);
    const rows = a.adjudicator.exchangeList().rows;
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toMatchObject({
      outcome: "timeout",
      timedOut: true,
      responseBytes: null,
      httpStatus: null,
    });
    const full = a.adjudicator.exchangeGet(row?.id as number);
    expect(full?.responseBody).toBeNull();
    expect(full?.requestBody.length).toBeGreaterThan(10);
    // The deadline the provider was given is what is stored, and the duration is bounded by it.
    expect(row?.deadlineMs).toBeLessThanOrEqual(budgetMs);
    expect(row?.deadlineMs).toBeGreaterThan(budgetMs - 100);
    expect(row?.durationMs as number).toBeGreaterThanOrEqual(budgetMs - 100);
    expect(row?.durationMs as number).toBeLessThan(budgetMs + 250);
    expect(row?.rowIds).toEqual([r?.rowId]);
  });

  it("a hang the http layer ends itself (abort honoured) is a timeout row with an error line", async () => {
    const a = open();
    const f = mockFetch(
      (c) =>
        new Promise<Response>((_, reject) =>
          c.init.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          ),
        ),
    );
    const [r] = await adjudicate(
      [req("slow2")],
      realRun(f, a.adjudicator, true, { budgetMs: 120 }).opts,
    );
    expect(r?.verdict.providerStatus).toBe("timeout");
    const [row] = a.adjudicator.exchangeList().rows;
    expect(row).toMatchObject({ outcome: "timeout", timedOut: true });
    expect(a.adjudicator.exchangeGet(row?.id as number)?.error).toMatch(/no answer within/);
  });

  it("T10: a 200 with the wrong shape is outcome invalid, the body kept, the error set", async () => {
    const a = open();
    const f = mockFetch(jsonRes({ unexpected: ["shape"] }));
    const [r] = await adjudicate([req("bad")], realRun(f, a.adjudicator, true).opts);
    expect(r?.verdict.source).toBe("fallback");
    const [row] = a.adjudicator.exchangeList().rows;
    expect(row).toMatchObject({ outcome: "invalid", httpStatus: 200, timedOut: false });
    const full = a.adjudicator.exchangeGet(row?.id as number);
    expect(JSON.parse(full?.responseBody as string)).toEqual({ unexpected: ["shape"] });
    expect(full?.error).toMatch(/unexpected shape/);
  });

  it("T11: ten items at privacy.maxChars 20000 are cut at 65,536 and flagged", async () => {
    const a = open();
    const f = mockFetch((c) => jevReply(c));
    const long = (i: number) =>
      `item ${i}: ${Array.from({ length: 4000 }, (_, k) => `module${(k + i) % 89}`).join(" ")}`;
    const reqs = Array.from({ length: 10 }, (_, i) => req(i, long(i)));
    const cfg = cfgOf(true, { privacy: { maxChars: 20_000 } });
    await adjudicate(reqs, realRun(f, a.adjudicator, true, { cfg }).opts);
    const sent = JSON.stringify(f.calls[0]?.body).length;
    expect(sent).toBeGreaterThan(65_536 * 2);
    const [row] = a.adjudicator.exchangeList().rows;
    expect(row).toMatchObject({ requestTruncated: true, items: 10, outcome: "ok" });
    expect(row?.requestBytes as number).toBeGreaterThan(65_536);
    const len = a.db
      .prepare("SELECT length(request_body) AS n FROM adjudicator_exchanges WHERE id = ?")
      .get(row?.id) as { n: number };
    expect(len.n).toBeLessThanOrEqual(65_536);
    expect(a.adjudicator.exchangeGet(row?.id as number)?.responseTruncated).toBe(false);
  });

  it("T12: a typical exchange stores valid JSON both ways; secrets are masked inside strings; token counts stay numbers", async () => {
    const a = open();
    const f = mockFetch((c) => jevReply(c));
    const prompt =
      "Deploy the release with password=hunter2xyz and then run the smoke tests across services";
    await adjudicate([req("j", prompt)], realRun(f, a.adjudicator, true).opts);
    const [row] = a.adjudicator.exchangeList().rows;
    const full = a.adjudicator.exchangeGet(row?.id as number);
    const reqJson = JSON.parse(full?.requestBody as string) as Json;
    const resJson = JSON.parse(full?.responseBody as string) as Json;
    expect(full?.requestBody).not.toContain("hunter2xyz");
    expect(reqJson.state.items[0].text).toContain("Deploy the release");
    expect(typeof resJson.usage.input_tokens).toBe("number");
    expect(resJson.usage.input_tokens).toBe(1500);
    expect(typeof resJson.usage.output_tokens).toBe("number");
    expect(full?.requestTruncated).toBe(false);
    // The same secret was already masked before it was sent (the stored copy is "redacted once more").
    expect(JSON.stringify(f.calls[0]?.body)).not.toContain("hunter2xyz");
    expect(statSync(dbPath).size).toBeGreaterThan(0);
  });
});
