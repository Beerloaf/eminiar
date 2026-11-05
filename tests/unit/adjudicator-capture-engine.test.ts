/**
 * Task #181 (X3): the privacy.captureExchanges switch and the engine / async job writes of the
 * Jev exchange log. The provider is a fake that pushes ProviderExchange records into the sink,
 * so these tests cover the engine's gate, linking and fail-open write, not http.ts.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AsyncJob, parseJob, runAsyncJob } from "../../src/adjudicator/async.js";
import { resolveAdjudicator } from "../../src/adjudicator/config.js";
import { adjudicate, type EngineOptions } from "../../src/adjudicator/engine.js";
import { resetProviders } from "../../src/adjudicator/providers/index.js";
import { resetSecrets } from "../../src/adjudicator/secrets.js";
import type {
  AdjudicationRequest,
  AdjudicatorProvider,
  HttpExchange,
  ProviderExchange,
  ProviderResult,
} from "../../src/adjudicator/types.js";
import { type AdjudicatorConfig, ConfigSchema, loadConfig } from "../../src/config.js";
import { SqliteAdapter } from "../../src/storage/sqlite/adapter.js";
import type { AdjudicatorStore } from "../../src/storage/types.js";

const ENV = { TYPESAFE_API_KEY: "sk-capture-engine-0123456789abcdef" } as NodeJS.ProcessEnv;

let dbPath: string;
let adapters: SqliteAdapter[] = [];
beforeEach(() => {
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-xchg-eng-"));
  resetSecrets();
  resetProviders();
  dbPath = join(mkdtempSync(join(tmpdir(), "em-xchg-eng-db-")), "eminiar.db");
  adapters = [];
});
afterEach(() => {
  for (const a of adapters) a.close();
  delete process.env.EMINIAR_HOME;
  delete process.env.EMINIAR_ADJUDICATOR_CAPTURE;
  resetSecrets();
  resetProviders();
});

function openStore(): AdjudicatorStore {
  const a = new SqliteAdapter(dbPath, { vectors: false });
  adapters.push(a);
  return a.adjudicator;
}

const adj = (capture: boolean, over: Record<string, unknown> = {}): AdjudicatorConfig =>
  ConfigSchema.parse({
    adjudicator: {
      enabled: true,
      provider: "typesafe",
      remoteConsent: true,
      privacy: { captureExchanges: capture },
      ...over,
    },
  }).adjudicator;

const req = (key: string, surface: AdjudicationRequest["surface"] = "agent") => ({
  key,
  surface,
  text: "refactor the storage layer across every adapter and migration",
});

function httpX(over: Partial<HttpExchange> = {}): HttpExchange {
  return {
    method: "POST",
    target: "api.typesafe.ai/v1/adjudicate",
    sentAt: Date.now(),
    deadlineMs: 800,
    attempts: 1,
    retryWaitMs: 0,
    ttfbMs: 40,
    durationMs: 55,
    status: 200,
    outcome: "ok",
    request: { text: '{"questions":[]}', json: true, bytes: 16, truncated: false },
    response: { text: '{"answers":[]}', json: true, bytes: 14, truncated: false },
    error: null,
    ...over,
  };
}

interface Fake extends AdjudicatorProvider {
  sinks: Array<ProviderExchange[] | undefined>;
}

/** Answers every request; pushes one exchange per batch of `batch` items into the sink. */
function fake(
  o: { batch?: number; http?: Partial<HttpExchange>; hang?: boolean; fail?: boolean } = {},
): Fake {
  const sinks: Array<ProviderExchange[] | undefined> = [];
  return {
    id: "typesafe",
    remote: true,
    dims: ["complexity", "tier", "role"],
    sinks,
    async adjudicate(reqs, opts) {
      sinks.push(opts.capture);
      expect("capture" in opts).toBe(opts.capture !== undefined);
      const size = o.batch ?? 10;
      for (let i = 0; i * size < reqs.length; i++) {
        opts.capture?.push({
          http: httpX(o.http),
          provider: "typesafe",
          model: "jev-1.14.0",
          batch: i,
          itemKeys: reqs.slice(i * size, (i + 1) * size).map((r) => r.key),
          tokensIn: 100,
          tokensOut: 5,
          costUsd: 0.0001,
        });
      }
      if (o.hang) return new Promise<ProviderResult>(() => {});
      if (o.fail) throw new Error("boom");
      return {
        answers: reqs.map((r) => ({
          key: r.key,
          complexity: { value: 4, confidence: 0.95 },
          tier: { probs: { opus: 1 }, confidence: 0.95, calibrated: true },
          role: { probs: { architect: 1 }, confidence: 0.95, calibrated: true },
        })),
        usage: { inTok: 100, outTok: 5, costUsd: 0.0001 },
        latencyMs: 50,
        model: "jev-1.14.0",
      };
    },
    async probe() {
      return { ok: true, latencyMs: 1, detail: "fake" };
    },
  };
}

function base(cfg: AdjudicatorConfig, store: AdjudicatorStore, p: Fake): EngineOptions {
  return {
    config: cfg,
    resolved: resolveAdjudicator(cfg, { env: ENV }),
    env: ENV,
    store,
    provider: p,
    budgetMs: 2000,
  };
}

describe("config switch", () => {
  it("defaults to off; the schema accepts true", () => {
    expect(ConfigSchema.parse({}).adjudicator.privacy.captureExchanges).toBe(false);
    expect(adj(true).privacy.captureExchanges).toBe(true);
    expect(adj(true).privacy.maxChars).toBe(2000);
  });

  it("is personal only: a project file cannot turn it on", () => {
    const root = mkdtempSync(join(tmpdir(), "em-xchg-root-"));
    writeFileSync(
      join(root, "eminiar.config.json"),
      JSON.stringify({ adjudicator: { privacy: { captureExchanges: true } } }),
    );
    expect(loadConfig(root).adjudicator.privacy.captureExchanges).toBe(false);
  });

  it("the personal file turns it on; EMINIAR_ADJUDICATOR_CAPTURE=0 turns it off, =1 does nothing", () => {
    const root = mkdtempSync(join(tmpdir(), "em-xchg-root-"));
    const home = process.env.EMINIAR_HOME as string;
    process.env.EMINIAR_ADJUDICATOR_CAPTURE = "1";
    expect(loadConfig(root).adjudicator.privacy.captureExchanges).toBe(false);
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ adjudicator: { privacy: { captureExchanges: true, maxChars: 500 } } }),
    );
    expect(loadConfig(root).adjudicator.privacy.captureExchanges).toBe(true);
    process.env.EMINIAR_ADJUDICATOR_CAPTURE = "0";
    const c = loadConfig(root).adjudicator.privacy;
    expect(c.captureExchanges).toBe(false);
    expect(c.maxChars).toBe(500);
  });
});

describe("engine writes", () => {
  it("off: no sink reaches the provider and nothing is written", async () => {
    const store = openStore();
    const p = fake();
    const [a] = await adjudicate([req("k1")], base(adj(false), store, p));
    expect(a?.verdict.source).toBe("blend");
    expect(p.sinks).toEqual([undefined]);
    expect(store.exchangeCount()).toBe(0);
  });

  it("on: one row per batch, linked to the inserted decision rows", async () => {
    const store = openStore();
    const p = fake({ batch: 10 });
    const reqs = Array.from({ length: 12 }, (_, i) => req(`k${i}`));
    const out = await adjudicate(reqs, { ...base(adj(true), store, p), context: "hook" });
    expect(p.sinks[0]).toBeDefined();
    const { rows, total } = store.exchangeList({ limit: 10 });
    expect(total).toBe(2);
    const byBatch = [...rows].sort((x, y) => x.batch - y.batch);
    const ids = out.map((o) => o.rowId);
    expect(byBatch[0]?.items).toBe(10);
    expect(byBatch[0]?.rowIds).toEqual(ids.slice(0, 10));
    expect(byBatch[1]?.items).toBe(2);
    expect(byBatch[1]?.rowIds).toEqual(ids.slice(10));
    expect(byBatch[0]?.callId).toBe(byBatch[1]?.callId);
    expect(byBatch[0]).toMatchObject({
      outcome: "ok",
      httpStatus: 200,
      timedOut: false,
      surface: "agent",
      context: "hook",
      budgetMs: 2000,
      deadlineMs: 800,
      tokensIn: 100,
    });
    const full = store.exchangeGet(byBatch[0]?.id as number);
    expect(full?.requestBody).toBe('{"questions":[]}');
    expect(full?.responseBody).toBe('{"answers":[]}');
  });

  it("not stored without rows to link (persist false), nor for another provider", async () => {
    const store = openStore();
    const p = fake();
    await adjudicate([req("k1")], { ...base(adj(true), store, p), persist: false });
    expect(p.sinks).toEqual([undefined]);
    // Jev only: the same call resolved to another provider gets no sink.
    const q = fake();
    const o = base(adj(true), store, q);
    // Another text, so the first call's cache entry does not answer it.
    const r2 = { ...req("k2"), text: "design the exchange log schema and its migration" };
    const [b] = await adjudicate([r2], {
      ...o,
      resolved: {
        ...(o.resolved as NonNullable<EngineOptions["resolved"]>),
        provider: "openai-compatible",
      },
    });
    expect(b?.verdict.source).toBe("blend");
    expect(q.sinks).toEqual([undefined]);
    expect(store.exchangeCount()).toBe(0);
  });

  it("a record still pending when the engine timer fires is stored as a timeout", async () => {
    const store = openStore();
    const p = fake({
      hang: true,
      http: { outcome: "pending", status: null, durationMs: null, ttfbMs: null, response: null },
    });
    const t0 = Date.now();
    const [a] = await adjudicate([req("k1")], { ...base(adj(true), store, p), budgetMs: 60 });
    expect(Date.now() - t0).toBeLessThan(500);
    expect(a?.verdict.providerStatus).toBe("timeout");
    const [row] = store.exchangeList().rows;
    expect(row).toMatchObject({ outcome: "timeout", timedOut: true, responseBytes: null });
    expect(row?.durationMs).toBeGreaterThanOrEqual(0);
    expect(row?.rowIds).toEqual([a?.rowId]);
    expect(store.exchangeGet(row?.id as number)?.responseBody).toBeNull();
  });

  it("a failed call still stores its exchange", async () => {
    const store = openStore();
    const p = fake({ fail: true, http: { outcome: "http_error", status: 500, response: null } });
    await adjudicate([req("k1")], base(adj(true), store, p));
    expect(store.exchangeList().rows[0]).toMatchObject({ outcome: "http_error", httpStatus: 500 });
  });

  it("fails open: a store that throws loses the exchange, never the verdict", async () => {
    const store = openStore();
    const busy = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    const spy = new Proxy(store, {
      get(t, k, rcv) {
        if (k === "exchangeInsert")
          return () => {
            throw busy;
          };
        const v = Reflect.get(t, k, rcv);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const lines: string[] = [];
    const [a] = await adjudicate([req("k1")], {
      ...base(adj(true), spy, fake()),
      log: (l) => lines.push(l),
    });
    expect(a?.verdict.source).toBe("blend");
    expect(a?.rowId).toBeGreaterThan(0);
    expect(lines.some((l) => l.includes("exchange capture skipped"))).toBe(true);
    expect(store.exchangeCount()).toBe(0);
  });
});

describe("async job", () => {
  const job = (cfg: AdjudicatorConfig, over: Partial<AsyncJob> = {}): string =>
    JSON.stringify({
      v: 1,
      projectRoot: "/tmp/x",
      request: req("k1", "prompt"),
      cacheKey: "ck",
      config: cfg,
      context: "hook",
      budgetMs: 2000,
      ...over,
    });

  it("parseJob keeps a finite queuedAt only", () => {
    expect(parseJob(job(adj(true), { queuedAt: 123 }))?.queuedAt).toBe(123);
    expect(parseJob(job(adj(true), { queuedAt: "x" as unknown as number }))?.queuedAt).toBe(
      undefined,
    );
  });

  it("links the hook's row and records the job wait", async () => {
    // The job re-reads the current setting (task #197): it must still be on in the personal file.
    writeFileSync(
      join(process.env.EMINIAR_HOME as string, "config.json"),
      JSON.stringify({ adjudicator: { privacy: { captureExchanges: true } } }),
    );
    const store = openStore();
    const now = Date.now();
    const res = await runAsyncJob(job(adj(true), { rowId: 7, queuedAt: now - 30 }), {
      store,
      provider: fake(),
      env: ENV,
      now: () => now,
    });
    expect(res.ok).toBe(true);
    const [row] = store.exchangeList().rows;
    expect(row).toMatchObject({ rowIds: [7], jobWaitMs: 30, context: "hook", surface: "prompt" });
  });

  it("writes nothing without a row id or with capture off", async () => {
    const store = openStore();
    await runAsyncJob(job(adj(true)), { store, provider: fake(), env: ENV });
    await runAsyncJob(job(adj(false), { rowId: 7 }), { store, provider: fake(), env: ENV });
    expect(store.exchangeCount()).toBe(0);
  });
});
