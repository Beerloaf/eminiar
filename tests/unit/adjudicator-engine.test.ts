import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AsyncJob,
  parseJob,
  runAsyncJob,
  spawnAsyncJob,
} from "../../src/adjudicator/async.js";
import {
  countsAsFailure,
  gate,
  p95,
  SLOW_MIN_SAMPLES,
  utcDay,
} from "../../src/adjudicator/breaker.js";
import { type Resolved, resolveAdjudicator } from "../../src/adjudicator/config.js";
import {
  adjudicate,
  adjudicateOne,
  cacheKeyFor,
  type EngineOptions,
  PENDING_TTL_MS,
  surfaceBudget,
} from "../../src/adjudicator/engine.js";
import { ProviderError } from "../../src/adjudicator/providers/http.js";
import { resetProviders } from "../../src/adjudicator/providers/index.js";
import { resetSecrets } from "../../src/adjudicator/secrets.js";
import type {
  AdjudicationRequest,
  AdjudicatorProvider,
  ProviderAnswer,
  ProviderResult,
} from "../../src/adjudicator/types.js";
import { type AdjudicatorConfig, ConfigSchema } from "../../src/config.js";
import { SqliteAdapter } from "../../src/storage/sqlite/adapter.js";
import type { AdjudicatorStore } from "../../src/storage/types.js";

/** Must never appear in a job payload, a row or a cache entry. */
const SENTINEL = "sk-SENTINEL-engine-1234567890abcdef";
const ENV = { TYPESAFE_API_KEY: SENTINEL } as NodeJS.ProcessEnv;
const T0 = Date.UTC(2026, 10, 4, 12, 0, 0);

let dbPath: string;
let adapters: SqliteAdapter[] = [];

beforeEach(() => {
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-adj-eng-"));
  resetSecrets();
  resetProviders();
  dbPath = join(mkdtempSync(join(tmpdir(), "em-adj-eng-db-")), "eminiar.db");
  adapters = [];
});
afterEach(() => {
  for (const a of adapters) a.close();
  delete process.env.EMINIAR_HOME;
  resetSecrets();
  resetProviders();
});

/** A fresh store on the same DB file: what the next hook process would see. */
function openStore(): AdjudicatorStore {
  const a = new SqliteAdapter(dbPath, { vectors: false });
  adapters.push(a);
  return a.adjudicator;
}

const adj = (over: Record<string, unknown> = {}): AdjudicatorConfig =>
  ConfigSchema.parse({
    adjudicator: { enabled: true, provider: "typesafe", remoteConsent: true, ...over },
  }).adjudicator;

const resolved = (cfg: AdjudicatorConfig): Resolved => resolveAdjudicator(cfg, { env: ENV });

const req = (
  key: string,
  text = "refactor the storage layer across every adapter and migration",
  surface: AdjudicationRequest["surface"] = "prompt",
): AdjudicationRequest => ({
  key,
  surface,
  text,
});

const opusAnswer = (key: string): ProviderAnswer => ({
  key,
  complexity: { value: 4, confidence: 0.95 },
  tier: { probs: { opus: 1 }, confidence: 0.95, calibrated: true },
  role: { probs: { architect: 1 }, confidence: 0.95, calibrated: true },
});

interface Fake extends AdjudicatorProvider {
  calls: AdjudicationRequest[][];
}

/** A provider whose answer comes from `fn`; records every call. */
function fake(
  fn: (
    reqs: AdjudicationRequest[],
    signal: AbortSignal,
  ) => Promise<ProviderResult> | ProviderResult,
  o: { remote?: boolean } = {},
): Fake {
  const calls: AdjudicationRequest[][] = [];
  return {
    id: "typesafe",
    remote: o.remote ?? true,
    dims: ["complexity", "tier", "role"],
    calls,
    async adjudicate(reqs, { signal }) {
      calls.push(reqs);
      return fn(reqs, signal);
    },
    async probe() {
      return { ok: true, latencyMs: 1, detail: "fake" };
    },
  };
}

const ok = (o: { costUsd?: number | null; latencyMs?: number; skip?: string[] } = {}) =>
  fake((reqs) => ({
    answers: reqs.filter((r) => !o.skip?.includes(r.key)).map((r) => opusAnswer(r.key)),
    usage: { inTok: 1000, outTok: 10, costUsd: o.costUsd === undefined ? 0.0001 : o.costUsd },
    latencyMs: o.latencyMs ?? 50,
    model: "jev-1.14.0",
  }));

const failing = (err: () => unknown) =>
  fake(() => {
    throw err();
  });

const hanging = () => fake(() => new Promise<ProviderResult>(() => {}));

function base(cfg: AdjudicatorConfig, over: Partial<EngineOptions> = {}): EngineOptions {
  return { config: cfg, resolved: resolved(cfg), env: ENV, store: openStore(), ...over };
}

describe("pipeline", () => {
  it("disabled: heuristic only, no provider call, nothing written", async () => {
    const cfg = adj({ enabled: false });
    const p = ok();
    const store = openStore();
    const [a] = await adjudicate([req("k1")], { ...base(cfg, { store }), provider: p });
    expect(a?.verdict.source).toBe("heuristic");
    expect(a?.verdict.providerStatus).toBe("n/a");
    expect(p.calls).toHaveLength(0);
    expect(a?.rowId).toBeUndefined();
    expect(store.list().total).toBe(0);
  });

  it("configured heuristic: persists the row, skips the cache", async () => {
    const cfg = adj({ provider: "heuristic" });
    const store = openStore();
    const [a] = await adjudicate([req("k1")], base(cfg, { store }));
    expect(a?.verdict.source).toBe("heuristic");
    expect(a?.verdict.providerStatus).toBe("n/a");
    expect(a?.rowId).toBeGreaterThan(0);
    const row = store.get(a?.rowId as number);
    expect(row?.surface).toBe("prompt");
    expect(row?.inputHead).toContain("refactor the storage layer");
    expect(row?.tier).toBe(a?.verdict.tier.choice);
    expect(store.cacheGet(a?.cacheKey as string, Date.now())).toBeUndefined();
  });

  it("no consent and no key degrade to the heuristic with the reason as status", async () => {
    const noConsent = adj({ remoteConsent: false });
    const [a] = await adjudicate([req("k1")], { ...base(noConsent), provider: ok() });
    expect(a?.verdict.providerStatus).toBe("no_consent");
    expect(a?.verdict.source).toBe("fallback");

    const cfg = adj();
    const noKey = resolveAdjudicator(cfg, { env: {} });
    const p = ok();
    const [b] = await adjudicate([req("k1")], { ...base(cfg), resolved: noKey, provider: p });
    expect(b?.verdict.providerStatus).toBe("no_key");
    expect(p.calls).toHaveLength(0);
  });

  it("call never: no network, status skipped", async () => {
    const p = ok();
    const [a] = await adjudicate([req("k1")], { ...base(adj()), provider: p, call: "never" });
    expect(p.calls).toHaveLength(0);
    expect(a?.verdict.providerStatus).toBe("skipped");
  });

  it("inline: blends, records cost and model, caches; the second call is a free cache hit", async () => {
    const cfg = adj();
    const store = openStore();
    const p = ok({ costUsd: 0.002 });
    const [a] = await adjudicate([req("k1", "rename one variable")], {
      ...base(cfg, { store }),
      provider: p,
    });
    expect(a?.verdict.source).toBe("blend");
    expect(a?.verdict.providerStatus).toBe("ok");
    expect(a?.verdict.alpha.tier).toBeGreaterThan(0);
    const row = store.get(a?.rowId as number);
    expect(row?.costUsd).toBeCloseTo(0.002);
    expect(row?.providerModel).toBe("jev-1.14.0");
    expect(row?.source).toBe("blend");
    expect(row?.tokensIn).toBe(1000);
    const cached = store.cacheGet(a?.cacheKey as string, Date.now());
    expect(cached?.verdict?.source).toBe("blend");

    const [b] = await adjudicate([req("k2", "rename  one VARIABLE")], {
      ...base(cfg, { store }),
      provider: p,
    });
    expect(p.calls).toHaveLength(1);
    expect(b?.verdict.source).toBe("cache");
    expect(b?.verdict.key).toBe("k2");
    expect(b?.verdict.tier.choice).toBe(a?.verdict.tier.choice);
    const hitRow = store.get(b?.rowId as number);
    expect(hitRow?.costUsd ?? null).toBeNull();
    expect(b?.verdict.id).toBe(b?.rowId);
    expect(JSON.stringify(store.list().rows)).not.toContain(SENTINEL);
  });

  it("missing per-item answers fall back to the heuristic for that key only; usage is split", async () => {
    const cfg = adj();
    const store = openStore();
    const p = ok({ costUsd: 0.003, skip: ["b"] });
    const out = await adjudicate(
      [
        req("a", "design a new plugin architecture"),
        req("b", "list files"),
        req("c", "fix the typo in README.md"),
      ],
      { ...base(cfg, { store }), provider: p },
    );
    expect(p.calls[0]).toHaveLength(3);
    expect(out.map((o) => o.verdict.source)).toEqual(["blend", "fallback", "blend"]);
    expect(out[1]?.verdict.providerStatus).toBe("skipped");
    const costs = out.map((o) => store.get(o.rowId as number)?.costUsd ?? null);
    expect(costs[0]).toBeCloseTo(0.0015);
    expect(costs[1]).toBeNull();
    expect(costs[2]).toBeCloseTo(0.0015);
  });

  it("per-request row extras (plan task ids) and shared extras land on the rows", async () => {
    const store = openStore();
    const out = await adjudicate(
      [req("t1", "x task one", "plan"), req("t2", "x task two", "plan")],
      {
        ...base(adj({ provider: "heuristic" }), { store }),
        row: { runId: "run-1", sessionId: "s1" },
        rows: [{ taskId: 1 }, { taskId: 2 }],
      },
    );
    const rows = out.map((o) => store.get(o.rowId as number));
    expect(rows.map((r) => [r?.runId, r?.taskId, r?.sessionId, r?.surface])).toEqual([
      ["run-1", 1, "s1", "plan"],
      ["run-1", 2, "s1", "plan"],
    ]);
  });

  it("applies the learned bias (function form) and ignores it when learning is off", async () => {
    const bias = () => ({ "tier:opus": 0.9 });
    const [on] = await adjudicate([req("k", "list files")], {
      ...base(adj({ provider: "heuristic" })),
      bias,
    });
    expect(on?.verdict.bias).toEqual({ "tier:opus": 0.9 });
    const opus = on?.verdict.tier.entries.find((e) => e.option === "opus");
    expect(opus?.reasons.some((r) => r.feature === "bias")).toBe(true);
    const [off] = await adjudicate([req("k", "list files")], {
      ...base(adj({ provider: "heuristic", learning: { enabled: false } })),
      bias,
    });
    expect(off?.verdict.bias).toEqual({});
  });

  it("surface budgets: local providers use localMs on hook surfaces, plan uses planMs", () => {
    const cfg = adj();
    expect(surfaceBudget(cfg, "prompt")).toBe(1200);
    expect(surfaceBudget(cfg, "prompt", true)).toBe(600);
    expect(surfaceBudget(cfg, "agent")).toBe(800);
    expect(surfaceBudget(cfg, "plan", true)).toBe(3000);
  });

  it("the cache key depends on provider, model and surface but not on case or spacing", () => {
    const r = { configured: "typesafe" as const, model: "jev-1.14.0" };
    const k = cacheKeyFor({ surface: "prompt", text: "Fix  The bug" }, r);
    expect(cacheKeyFor({ surface: "prompt", text: "fix the bug" }, r)).toBe(k);
    expect(cacheKeyFor({ surface: "agent", text: "fix the bug" }, r)).not.toBe(k);
    expect(cacheKeyFor({ surface: "prompt", text: "fix the bug" }, { ...r, model: "x" })).not.toBe(
      k,
    );
    expect(k).not.toContain("fix");
  });
});

describe("never throws, never waits past the budget", () => {
  it("a hanging provider that ignores its signal: heuristic within budget + 20 ms", async () => {
    const cfg = adj();
    const p = hanging();
    const t = performance.now();
    const [a] = await adjudicate([req("k1")], { ...base(cfg), provider: p, budgetMs: 100 });
    const elapsed = performance.now() - t;
    expect(elapsed).toBeLessThan(120);
    expect(elapsed).toBeGreaterThanOrEqual(95);
    expect(a?.verdict.source).toBe("fallback");
    expect(a?.verdict.providerStatus).toBe("timeout");
    expect(a?.verdict.tier.entries.length).toBeGreaterThan(0);
  });

  it("aborts the provider's signal at the deadline", async () => {
    let seen: AbortSignal | undefined;
    const p = fake((_r, signal) => {
      seen = signal;
      return new Promise<ProviderResult>(() => {});
    });
    await adjudicate([req("k1")], { ...base(adj()), provider: p, budgetMs: 30 });
    expect(seen?.aborted).toBe(true);
  });

  it("a provider that throws synchronously or a non-ProviderError still yields a verdict", async () => {
    const sync: Fake = {
      ...ok(),
      adjudicate: () => {
        throw new TypeError("boom");
      },
    };
    const [a] = await adjudicate([req("k1")], { ...base(adj()), provider: sync });
    expect(a?.verdict.providerStatus).toBe("invalid");
    expect(a?.verdict.source).toBe("fallback");
  });

  it("a store that throws on every call: verdict still returned, just not persisted", async () => {
    const broken = new Proxy({} as AdjudicatorStore, {
      get: () => () => {
        throw new Error("SQLITE_BUSY");
      },
    });
    const lines: string[] = [];
    const [a] = await adjudicate([req("k1")], {
      ...base(adj()),
      store: broken,
      provider: ok(),
      log: (l) => lines.push(l),
    });
    expect(a?.verdict.source).toBe("blend");
    expect(a?.rowId).toBeUndefined();
    expect(lines.some((l) => l.includes("SQLITE_BUSY"))).toBe(true);
  });

  it("returns [] for no requests and survives a broken config object", async () => {
    expect(await adjudicate([], base(adj()))).toEqual([]);
    const out = await adjudicate([req("k1")], { config: {} as AdjudicatorConfig });
    expect(out).toHaveLength(1);
    expect(out[0]?.verdict.source).toBe("heuristic");
  });
});

describe("breaker (persisted across processes)", () => {
  it("closed → open after `failures` timeouts/5xx; fresh stores see it; half-open lets one call through", async () => {
    const cfg = adj({ breaker: { failures: 2, cooldownSec: 60 } });
    let now = T0;
    const clock = () => now;
    const boom = failing(() => new ProviderError("http_error", "503", { status: 503 }));

    const r1 = await adjudicateOne(req("k1"), { ...base(cfg), provider: boom, now: clock });
    expect(r1.verdict.providerStatus).toBe("http_error");
    expect(openStore().providerState("typesafe")?.state).toBe("closed");
    const r2 = await adjudicateOne(req("k2"), { ...base(cfg), provider: boom, now: clock });
    expect(r2.verdict.providerStatus).toBe("http_error");
    const st = openStore().providerState("typesafe");
    expect(st?.state).toBe("open");
    expect(st?.failures).toBe(2);
    expect(st?.retryAt).toBe(T0 + 60_000);

    // A new "process" while open: skipped without calling.
    const good = ok();
    const r3 = await adjudicateOne(req("k3"), { ...base(cfg), provider: good, now: clock });
    expect(r3.verdict.providerStatus).toBe("breaker_open");
    expect(good.calls).toHaveLength(0);

    // Cooled down: one trial call; a parallel process meanwhile still sees it open.
    now = T0 + 61_000;
    const g = gate(openStore(), "typesafe", cfg, { now, remote: true });
    expect(g).toMatchObject({ allow: true, halfOpen: true });
    expect(gate(openStore(), "typesafe", cfg, { now, remote: true })).toEqual({
      allow: false,
      status: "breaker_open",
    });
  });

  it("half-open success closes; half-open failure reopens at once", async () => {
    const cfg = adj({ breaker: { failures: 3, cooldownSec: 10 } });
    let now = T0;
    const clock = () => now;
    openStore().saveProviderState("typesafe", { state: "open", failures: 3, retryAt: T0 - 1 });

    const boom = failing(() => new ProviderError("timeout", "slow"));
    await adjudicateOne(req("k1"), { ...base(cfg), provider: boom, now: clock });
    let st = openStore().providerState("typesafe");
    expect(st?.state).toBe("open");
    expect(st?.retryAt).toBe(T0 + 10_000);

    now = T0 + 10_001;
    const good = ok();
    const r = await adjudicateOne(req("k2"), { ...base(cfg), provider: good, now: clock });
    expect(r.verdict.source).toBe("blend");
    st = openStore().providerState("typesafe");
    expect(st?.state).toBe("closed");
    expect(st?.failures).toBe(0);
    expect(st?.lastOkAt).toBe(now);
  });

  it("a refused localhost connection counts; 4xx and invalid answers do not", async () => {
    expect(countsAsFailure("http_error")).toBe(true); // ECONNREFUSED: no status
    expect(countsAsFailure("http_error", 502)).toBe(true);
    expect(countsAsFailure("rate_limited", 429)).toBe(true);
    expect(countsAsFailure("timeout")).toBe(true);
    expect(countsAsFailure("http_error", 401)).toBe(false);
    expect(countsAsFailure("invalid")).toBe(false);

    const cfg = adj({ breaker: { failures: 1, cooldownSec: 10 } });
    const bad = failing(() => new ProviderError("invalid", "garbage"));
    await adjudicateOne(req("k1"), { ...base(cfg), provider: bad });
    const st = openStore().providerState("typesafe");
    expect(st?.state).toBe("closed");
    expect(st?.lastErrorClass).toBe("invalid");
  });

  it("a hang counts as a timeout failure", async () => {
    const cfg = adj({ breaker: { failures: 1, cooldownSec: 10 } });
    await adjudicateOne(req("k1"), { ...base(cfg), provider: hanging(), budgetMs: 20 });
    expect(openStore().providerState("typesafe")?.state).toBe("open");
  });
});

describe("slow guard and daily cap", () => {
  it("p95 over the surface budget turns the provider slow for cooldownSec, then it starts over", async () => {
    const cfg = adj({ breaker: { failures: 2, cooldownSec: 30 } });
    let now = T0;
    const clock = () => now;
    const slow = ok({ latencyMs: 5000 });
    for (let i = 0; i < SLOW_MIN_SAMPLES; i++) {
      const r = await adjudicateOne(req(`k${i}`, `prompt number ${i} about refactoring`), {
        ...base(cfg),
        provider: slow,
        now: clock,
      });
      expect(r.verdict.source).toBe("blend");
    }
    expect(openStore().providerState("typesafe")?.state).toBe("slow");
    const r = await adjudicateOne(req("kx", "another distinct prompt"), {
      ...base(cfg),
      provider: slow,
      now: clock,
    });
    expect(r.verdict.providerStatus).toBe("slow_guard");
    expect(slow.calls).toHaveLength(SLOW_MIN_SAMPLES);

    now = T0 + 31_000;
    const fast = ok({ latencyMs: 40 });
    const after = await adjudicateOne(req("ky", "yet another distinct prompt"), {
      ...base(cfg),
      provider: fast,
      now: clock,
    });
    expect(after.verdict.source).toBe("blend");
    const st = openStore().providerState("typesafe");
    expect(st?.state).toBe("closed");
    expect(st?.latencies).toEqual([40]);
  });

  it("stops a remote provider at budget.dailyUsd; a new UTC day resets it", async () => {
    const cfg = adj({ budget: { dailyUsd: 0.5 } });
    let now = T0;
    const clock = () => now;
    const pricey = ok({ costUsd: 0.3 });
    const text = (i: number) => `distinct prompt ${i} about a cross cutting change`;
    await adjudicateOne(req("a", text(1)), { ...base(cfg), provider: pricey, now: clock });
    await adjudicateOne(req("b", text(2)), { ...base(cfg), provider: pricey, now: clock });
    const st = openStore().providerState("typesafe");
    expect(st?.spendUsd).toBeCloseTo(0.6);
    expect(st?.spendDay).toBe(utcDay(T0));
    const r = await adjudicateOne(req("c", text(3)), {
      ...base(cfg),
      provider: pricey,
      now: clock,
    });
    expect(r.verdict.providerStatus).toBe("over_budget");
    expect(pricey.calls).toHaveLength(2);

    now = T0 + 24 * 3_600_000;
    const next = await adjudicateOne(req("d", text(4)), {
      ...base(cfg),
      provider: pricey,
      now: clock,
    });
    expect(next.verdict.source).toBe("blend");
    expect(openStore().providerState("typesafe")?.spendUsd).toBeCloseTo(0.3);
  });

  it("an unknown price (null cost) adds no dollars and is stored as NULL, not 0", async () => {
    const cfg = adj({ budget: { dailyUsd: 0.5 } });
    const store = openStore();
    const unknown = ok({ costUsd: null });
    const a = await adjudicateOne(req("a"), { ...base(cfg, { store }), provider: unknown });
    expect(a.verdict.usage?.costUsd).toBeNull();
    expect(store.get(a.rowId as number)?.costUsd ?? null).toBeNull();
    expect(store.get(a.rowId as number)?.tokensIn).toBe(1000);
    expect(store.providerState("typesafe")?.spendUsd).toBe(0);
  });

  it("a local provider is never capped by the daily budget", () => {
    const store = openStore();
    const cfg = adj({ budget: { dailyUsd: 0 } });
    store.saveProviderState("openai-compatible", { spendDay: utcDay(T0), spendUsd: 5 });
    expect(gate(store, "openai-compatible", cfg, { now: T0, remote: false }).allow).toBe(true);
    expect(gate(store, "openai-compatible", cfg, { now: T0, remote: true })).toEqual({
      allow: false,
      status: "over_budget",
    });
  });

  it("p95 is nearest-rank", () => {
    expect(p95([])).toBeUndefined();
    expect(p95([5])).toBe(5);
    expect(p95(Array.from({ length: 20 }, (_, i) => i + 1))).toBe(19);
  });
});

describe("async jobs", () => {
  it("call async: heuristic now, one job per key with its row id; the pending marker dedupes", async () => {
    const cfg = adj({ promptMode: "async" });
    let now = T0;
    const clock = () => now;
    const store = openStore();
    const jobs: AsyncJob[] = [];
    const spawn = (j: AsyncJob) => {
      jobs.push(j);
      return true;
    };
    const p = ok();
    const o = {
      ...base(cfg, { store }),
      provider: p,
      call: "async" as const,
      spawn,
      now: clock,
      projectRoot: "/proj",
    };

    const a = await adjudicateOne(req("k1"), o);
    expect(p.calls).toHaveLength(0);
    expect(a.verdict.source).toBe("fallback");
    expect(a.queued).toBe(true);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.rowId).toBe(a.rowId);
    expect(jobs[0]?.cacheKey).toBe(a.cacheKey);
    expect(jobs[0]?.budgetMs).toBe(2 * 1200);
    expect(jobs[0]?.projectRoot).toBe("/proj");
    expect(store.cacheGet(a.cacheKey, now)?.verdict).toBeNull();

    now += 5_000;
    const b = await adjudicateOne(req("k2"), o);
    expect(b.queued).toBe(true);
    expect(jobs).toHaveLength(1);

    now += PENDING_TTL_MS;
    await adjudicateOne(req("k3"), o);
    expect(jobs).toHaveLength(2);
  });

  it("call async with an open breaker spawns nothing (peek only, no half-open claim)", async () => {
    const cfg = adj();
    const store = openStore();
    store.saveProviderState("typesafe", { state: "open", retryAt: T0 + 1000 });
    const spawn = vi.fn(() => true);
    const a = await adjudicateOne(req("k1"), {
      ...base(cfg, { store }),
      provider: ok(),
      call: "async",
      spawn,
      now: () => T0,
    });
    expect(a.verdict.providerStatus).toBe("breaker_open");
    expect(spawn).not.toHaveBeenCalled();
    // Cooled down: the hook still does not claim the slot; the child will.
    const later = await adjudicateOne(req("k2"), {
      ...base(cfg, { store }),
      provider: ok(),
      call: "async",
      spawn,
      now: () => T0 + 2000,
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(later.queued).toBe(true);
    expect(store.providerState("typesafe")?.state).toBe("open");
  });

  it("spawnAsyncJob: detached child, job on stdin, unref'd, no key in the payload", async () => {
    const cfg = adj({ keyEnv: "MY_KEY_VAR" });
    let job: AsyncJob | undefined;
    await adjudicateOne(req("k1"), {
      ...base(cfg),
      provider: ok(),
      call: "async",
      spawn: (j) => {
        job = j;
        return true;
      },
    });
    expect(job).toBeDefined();

    let written = "";
    const child = Object.assign(new EventEmitter(), {
      stdin: Object.assign(new EventEmitter(), {
        end: (s: string) => {
          written = s;
        },
      }),
      unref: vi.fn(),
    });
    const spawn = vi.fn(() => child);
    const ok1 = spawnAsyncJob(job as AsyncJob, {
      spawn: spawn as never,
      execPath: "/usr/bin/node",
      script: "/plugin/dist/hook.js",
    });
    expect(ok1).toBe(true);
    expect(spawn).toHaveBeenCalledWith(
      "/usr/bin/node",
      ["/plugin/dist/hook.js", "--adjudicate"],
      expect.objectContaining({ detached: true, stdio: ["pipe", "ignore", "ignore"] }),
    );
    expect(child.unref).toHaveBeenCalled();
    expect(JSON.parse(written)).toMatchObject({ v: 1, rowId: job?.rowId, request: { key: "k1" } });
    expect(written).not.toContain(SENTINEL);
    expect(written).toContain("MY_KEY_VAR"); // the NAME only
    // Child errors are swallowed.
    expect(() => child.emit("error", new Error("ENOENT"))).not.toThrow();
    expect(
      spawnAsyncJob(job as AsyncJob, {
        spawn: (() => {
          throw new Error("EAGAIN");
        }) as never,
      }),
    ).toBe(false);
  });

  it("runAsyncJob: calls the provider, writes the cache and updates the hook's row", async () => {
    const cfg = adj();
    const store = openStore();
    let job: AsyncJob | undefined;
    const hookSide = await adjudicateOne(req("k1"), {
      ...base(cfg, { store }),
      provider: ok(),
      call: "async",
      spawn: (j) => {
        job = j;
        return true;
      },
    });
    const before = store.get(hookSide.rowId as number);
    expect(before?.source).toBe("fallback");

    const p = ok({ costUsd: 0.001 });
    const res = await runAsyncJob(JSON.stringify(job), { store, provider: p, env: ENV });
    expect(res).toMatchObject({
      ok: true,
      source: "blend",
      providerStatus: "ok",
      rowUpdated: true,
    });
    expect(p.calls).toHaveLength(1);
    const after = store.get(hookSide.rowId as number);
    expect(after?.source).toBe("blend");
    expect(after?.providerStatus).toBe("ok");
    expect(after?.providerModel).toBe("jev-1.14.0");
    expect(after?.costUsd).toBeCloseTo(0.001);
    expect(after?.latencyMs).toBe(before?.latencyMs); // the hook's own latency is kept
    expect(store.cacheGet(hookSide.cacheKey, Date.now())?.verdict?.source).toBe("blend");

    // The same turn's next surface now hits the cache.
    const next = await adjudicateOne(req("k9"), {
      ...base(cfg, { store }),
      provider: p,
      call: "never",
    });
    expect(next.verdict.source).toBe("cache");
  });

  it("runAsyncJob: a failing provider records the status on the row and never throws", async () => {
    const store = openStore();
    let job: AsyncJob | undefined;
    const a = await adjudicateOne(req("k1"), {
      ...base(adj(), { store }),
      provider: ok(),
      call: "async",
      spawn: (j) => {
        job = j;
        return true;
      },
    });
    const res = await runAsyncJob(JSON.stringify(job), {
      store,
      provider: failing(() => new ProviderError("rate_limited", "429", { status: 429 })),
      env: ENV,
    });
    expect(res.ok).toBe(true);
    expect(store.get(a.rowId as number)?.providerStatus).toBe("rate_limited");
    expect(await runAsyncJob("not json")).toEqual({ ok: false, reason: "invalid job" });
    expect(
      parseJob(JSON.stringify({ ...job, config: { ...job?.config, enabled: false } })),
    ).toBeDefined();
    expect(
      await runAsyncJob(JSON.stringify({ ...job, config: { ...job?.config, enabled: false } }), {
        store,
      }),
    ).toEqual({
      ok: false,
      reason: "disabled",
    });
  });

  it("src/hook.ts routes --adjudicate to runAsyncJob with a hard exit timer", () => {
    const src = readFileSync(join(__dirname, "../../src/hook.ts"), "utf8");
    expect(src).toMatch(/argv\.includes\("--adjudicate"\)/);
    expect(src).toContain("runAsyncJob(raw");
    expect(src).toContain("ASYNC_JOB_MAX_MS");
  });
});
