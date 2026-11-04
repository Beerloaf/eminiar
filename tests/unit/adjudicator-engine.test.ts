import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AsyncJob,
  parseJob,
  runAsyncJob,
  spawnAsyncJob,
} from "../../src/adjudicator/async.js";
import {
  AUTH_LOCKOUT_MS,
  authLockout,
  callsToday,
  countsAsFailure,
  gate,
  isAuthFailure,
  keyFingerprint,
  p95,
  recordFailure,
  recordSuccess,
  SLOW_MIN_SAMPLES,
  utcDay,
} from "../../src/adjudicator/breaker.js";
import {
  currentKeyFingerprint,
  type Resolved,
  resolveAdjudicator,
  withAuthLockout,
} from "../../src/adjudicator/config.js";
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

  it("the cache key covers hints, catalogues, tiers and weights; role order does not matter (task #37)", () => {
    const r = { configured: "typesafe" as const, model: "jev-1.14.0" };
    const cfg = adj();
    const roles = [
      { name: "coder", description: "implements" },
      { name: "tester", description: "writes tests" },
    ];
    const text = "Refactor the session store";
    const base0 = { surface: "plan" as const, text, hints: { roles, files: 0, deps: 0 } };
    const k = cacheKeyFor(base0, r, { config: cfg });
    const differs = [
      cacheKeyFor({ ...base0, hints: { ...base0.hints, files: 14 } }, r, { config: cfg }),
      cacheKeyFor({ ...base0, hints: { ...base0.hints, deps: 5 } }, r, { config: cfg }),
      cacheKeyFor({ ...base0, hints: { ...base0.hints, role: "tester" } }, r, { config: cfg }),
      cacheKeyFor({ ...base0, hints: { ...base0.hints, roles: roles.slice(0, 1) } }, r, {
        config: cfg,
      }),
      cacheKeyFor(
        { ...base0, hints: { ...base0.hints, roles: [roles[0]!, { name: "tester" }] } },
        r,
        { config: cfg },
      ),
      cacheKeyFor(base0, r, { config: cfg, tools: ["em_execute", "em_search"] }),
      cacheKeyFor(base0, r, { config: adj({ tiers: ["haiku", "opus"] }) }),
      cacheKeyFor(base0, r, {
        config: adj({ weights: { tierCenters: { haiku: 0.6, sonnet: 2.2, opus: 3.4 } } }),
      }),
    ];
    for (const d of differs) expect(d).not.toBe(k);
    expect(new Set(differs).size).toBe(differs.length);
    // Same inputs in another order hash the same; the key never carries the raw inputs.
    expect(
      cacheKeyFor({ ...base0, hints: { deps: 0, files: 0, roles: [...roles].reverse() } }, r, {
        config: cfg,
      }),
    ).toBe(k);
    expect(cacheKeyFor(base0, r, { config: cfg, tools: ["em_search", "em_execute"] })).toBe(
      differs[5],
    );
    // Without hints.roles, the engine's role list is part of the key.
    const noHints = { surface: "plan" as const, text };
    expect(cacheKeyFor(noHints, r, { config: cfg, roles })).not.toBe(
      cacheKeyFor(noHints, r, { config: cfg }),
    );
    expect(k).toMatch(/^[0-9a-f]{64}$/);
  });

  it("same text, different hints: the second request misses the cache and scores its own hints", async () => {
    const cfg = adj();
    const store = openStore();
    const p = ok();
    const text = "Refactor the session store\nMove the store behind the adapter interface";
    const a = await adjudicateOne(
      { key: "#1", surface: "plan", text, hints: { files: 0, deps: 0, role: "tester" } },
      { ...base(cfg, { store }), provider: p },
    );
    const b = await adjudicateOne(
      { key: "#2", surface: "plan", text, hints: { files: 14, deps: 5, role: "reviewer" } },
      { ...base(cfg, { store }), provider: p },
    );
    expect(a.verdict.source).toBe("blend");
    expect(b.verdict.source).toBe("blend");
    expect(b.cacheKey).not.toBe(a.cacheKey);
    expect(p.calls).toHaveLength(2);
    // The same request again is a hit.
    const again = await adjudicateOne(
      { key: "#3", surface: "plan", text, hints: { deps: 5, files: 14, role: "reviewer" } },
      { ...base(cfg, { store }), provider: p },
    );
    expect(again.verdict.source).toBe("cache");
    expect(again.cacheKey).toBe(b.cacheKey);
  });

  it("an async job carries the tool catalogue from deps.tools, so the child computes the hook's key", async () => {
    const cfg = adj();
    const jobs: AsyncJob[] = [];
    const tools = ["em_search", "em_execute"];
    const [a] = await adjudicate([req("k1")], {
      ...base(cfg),
      provider: ok(),
      call: "async",
      deps: { tools },
      spawn: (j) => {
        jobs.push(j);
        return true;
      },
    });
    expect(jobs[0]?.tools).toEqual(tools);
    expect(a?.cacheKey).toBe(
      cacheKeyFor(req("k1"), resolved(cfg), { config: jobs[0]?.config, tools: jobs[0]?.tools }),
    );
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
    expect(st?.latencyBudgets).toHaveLength(1);
  });

  it("each sample is judged against its own budget: a slow plan batch never makes fast agent calls slow (task #36)", () => {
    const store = openStore();
    const cfg = adj();
    // 19 plan batches at 1500 ms under a 3000 ms budget, then fast agent calls under 800 ms.
    for (let i = 0; i < SLOW_MIN_SAMPLES - 1; i++)
      recordSuccess(store, "typesafe", cfg, {
        now: T0,
        latencyMs: 1500,
        costUsd: 0,
        budgetMs: 3000,
      });
    for (let i = 0; i < 5; i++) {
      const st = recordSuccess(store, "typesafe", cfg, {
        now: T0,
        latencyMs: 150,
        costUsd: 0,
        budgetMs: 800,
      });
      expect(st.state).toBe("closed");
    }
    const st = store.providerState("typesafe");
    expect(st?.latencies).toHaveLength(SLOW_MIN_SAMPLES + 4);
    expect(st?.latencyBudgets?.slice(-2)).toEqual([800, 800]);
    expect(gate(store, "typesafe", cfg, { now: T0 + 1, remote: true }).allow).toBe(true);
  });

  it("the slow guard needs SLOW_MIN_SAMPLES samples: a few outliers cannot trip it", () => {
    const store = openStore();
    const cfg = adj();
    for (let i = 0; i < SLOW_MIN_SAMPLES - 1; i++)
      expect(
        recordSuccess(store, "typesafe", cfg, {
          now: T0,
          latencyMs: 5000,
          costUsd: 0,
          budgetMs: 800,
        }).state,
      ).toBe("closed");
    expect(
      recordSuccess(store, "typesafe", cfg, { now: T0, latencyMs: 5000, costUsd: 0, budgetMs: 800 })
        .state,
    ).toBe("slow");
    // One outlier among 20 fast samples does not decide (p95 is not the max at n = 20).
    const other = "openai-compatible";
    recordSuccess(store, other, cfg, { now: T0, latencyMs: 9000, costUsd: 0, budgetMs: 800 });
    for (let i = 0; i < SLOW_MIN_SAMPLES; i++)
      recordSuccess(store, other, cfg, { now: T0, latencyMs: 100, costUsd: 0, budgetMs: 800 });
    expect(store.providerState(other)?.state).toBe("closed");
  });

  it("legacy samples without a stored budget are ignored, not judged against today's budget", () => {
    const store = openStore();
    const cfg = adj();
    store.saveProviderState("typesafe", { latencies: Array.from({ length: 40 }, () => 4000) });
    const st = recordSuccess(store, "typesafe", cfg, {
      now: T0,
      latencyMs: 100,
      costUsd: 0,
      budgetMs: 800,
    });
    expect(st.state).toBe("closed");
    expect(st.latencyBudgets).toHaveLength(41);
    expect(st.latencyBudgets?.[0]).toBe(0);
  });

  it("warm-up and test calls (surface test) stay out of the latency ring; real calls are sampled", async () => {
    const cfg = adj();
    let now = T0;
    const clock = () => now;
    const coldLoad: Fake = fake(async (reqs) => {
      now += 4000;
      return {
        answers: reqs.map((r) => opusAnswer(r.key)),
        usage: { inTok: 10, outTok: 5, costUsd: 0 },
        latencyMs: 4000,
        model: "jev-1.14.0",
      };
    });
    const warm = await adjudicateOne(req("warmup", "warm up", "test"), {
      ...base(cfg),
      provider: coldLoad,
      now: clock,
      budgetMs: 10_000,
    });
    expect(warm.verdict.source).toBe("blend");
    let st = openStore().providerState("typesafe");
    expect(st?.latencies).toEqual([]);
    expect(st?.calls).toBe(1);
    await adjudicateOne(req("p1", "explain the session cache flow"), {
      ...base(cfg),
      provider: ok({ latencyMs: 150 }),
      now: clock,
    });
    st = openStore().providerState("typesafe");
    expect(st?.latencies).toEqual([150]);
    expect(st?.latencyBudgets).toEqual([surfaceBudget(cfg, "prompt")]);
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

  it("stops an unpriced provider at budget.dailyCalls; a new UTC day resets it", async () => {
    const cfg = adj({ budget: { dailyUsd: 0.5, dailyCalls: 2 } });
    let now = T0;
    const clock = () => now;
    const unpriced = ok({ costUsd: null });
    const text = (i: number) => `distinct unpriced prompt ${i} about a cross cutting change`;
    for (const i of [1, 2]) {
      const r = await adjudicateOne(req(`u${i}`, text(i)), {
        ...base(cfg),
        provider: unpriced,
        now: clock,
      });
      expect(r.verdict.source).toBe("blend");
    }
    const st = openStore().providerState("typesafe");
    expect(st?.calls).toBe(2);
    expect(st?.spendUsd).toBe(0);
    const capped = await adjudicateOne(req("u3", text(3)), {
      ...base(cfg),
      provider: unpriced,
      now: clock,
    });
    expect(capped.verdict.providerStatus).toBe("over_budget");
    expect(unpriced.calls).toHaveLength(2);

    now = T0 + 24 * 3_600_000;
    const next = await adjudicateOne(req("u4", text(4)), {
      ...base(cfg),
      provider: unpriced,
      now: clock,
    });
    expect(next.verdict.source).toBe("blend");
    expect(openStore().providerState("typesafe")?.calls).toBe(1);
  });

  it("dailyCalls: failed calls count, 0 is unlimited, local providers are never capped", () => {
    const store = openStore();
    recordFailure(store, "typesafe", adj(), {
      now: T0,
      kind: "timeout",
      budgetMs: 100,
      halfOpen: false,
    });
    recordFailure(store, "typesafe", adj(), {
      now: T0,
      kind: "no_key",
      budgetMs: 100,
      halfOpen: false,
    });
    expect(callsToday(store.providerState("typesafe"), T0)).toBe(1);
    expect(callsToday(store.providerState("typesafe"), T0 + 24 * 3_600_000)).toBe(0);

    store.saveProviderState("p", { spendDay: utcDay(T0), calls: 5000 });
    const on = adj({ budget: { dailyCalls: 2000 } });
    const off = adj({ budget: { dailyCalls: 0 } });
    expect(on.budget.dailyCalls).toBe(2000);
    expect(adj().budget.dailyCalls).toBe(2000);
    expect(gate(store, "p", on, { now: T0, remote: true })).toEqual({
      allow: false,
      status: "over_budget",
    });
    expect(gate(store, "p", on, { now: T0, remote: false }).allow).toBe(true);
    expect(gate(store, "p", off, { now: T0, remote: true }).allow).toBe(true);
  });

  it("401: the next call skips without network; a new key is retried", async () => {
    const cfg = adj();
    let now = T0;
    const clock = () => now;
    const rejected = failing(() => new ProviderError("http_error", "HTTP 401", { status: 401 }));
    const first = await adjudicateOne(req("a1", "first prompt about auth"), {
      ...base(cfg),
      provider: rejected,
      now: clock,
    });
    expect(first.verdict.providerStatus).toBe("http_error");
    const st = openStore().providerState("typesafe");
    expect(st?.state).toBe("auth_failed");
    expect(st?.authFingerprint).toBe(keyFingerprint(SENTINEL));
    expect(st?.retryAt).toBe(T0 + AUTH_LOCKOUT_MS);
    expect(st?.failures).toBe(0);
    expect(st?.lastErrorClass).toBe("http_error:401");

    now = T0 + 60_000;
    const second = await adjudicateOne(req("a2", "second prompt about auth"), {
      ...base(cfg),
      provider: rejected,
      now: clock,
    });
    expect(second.verdict.providerStatus).toBe("auth_failed");
    expect(second.verdict.source).toBe("fallback");
    expect(rejected.calls).toHaveLength(1);

    // The async hook path peeks too, and spawns nothing.
    const jobs: AsyncJob[] = [];
    const queued = await adjudicateOne(req("a3", "third prompt about auth"), {
      ...base(cfg),
      provider: rejected,
      call: "async",
      spawn: (j) => jobs.push(j) > 0,
      now: clock,
    });
    expect(queued.verdict.providerStatus).toBe("auth_failed");
    expect(jobs).toHaveLength(0);

    // A changed key is retried at once.
    const env2 = { TYPESAFE_API_KEY: "sk-a-brand-new-key-0987654321" } as NodeJS.ProcessEnv;
    const good = ok();
    const retried = await adjudicateOne(req("a4", "fourth prompt about auth"), {
      ...base(cfg),
      env: env2,
      resolved: resolveAdjudicator(cfg, { env: env2 }),
      provider: good,
      now: clock,
    });
    expect(retried.verdict.source).toBe("blend");
    expect(good.calls).toHaveLength(1);
    const after = openStore().providerState("typesafe");
    expect(after?.state).toBe("closed");
    expect(after?.authFingerprint).toBeNull();
  });

  it("403 locks out for AUTH_LOCKOUT_MS when the key does not change", async () => {
    const cfg = adj();
    let now = T0;
    const clock = () => now;
    const forbidden = failing(() => new ProviderError("http_error", "HTTP 403", { status: 403 }));
    await adjudicateOne(req("f1", "first forbidden prompt"), {
      ...base(cfg),
      provider: forbidden,
      now: clock,
    });
    now = T0 + AUTH_LOCKOUT_MS - 1;
    const locked = await adjudicateOne(req("f2", "second forbidden prompt"), {
      ...base(cfg),
      provider: forbidden,
      now: clock,
    });
    expect(locked.verdict.providerStatus).toBe("auth_failed");
    expect(forbidden.calls).toHaveLength(1);

    now = T0 + AUTH_LOCKOUT_MS;
    const good = ok();
    const retried = await adjudicateOne(req("f3", "third forbidden prompt"), {
      ...base(cfg),
      provider: good,
      now: clock,
    });
    expect(retried.verdict.source).toBe("blend");
  });

  it("other 4xx keep the T6 behaviour: no lockout, no breaker failure", () => {
    const store = openStore();
    const s = recordFailure(store, "typesafe", adj(), {
      now: T0,
      kind: "http_error",
      status: 400,
      budgetMs: 100,
      halfOpen: false,
      keyFingerprint: keyFingerprint(SENTINEL),
    });
    expect(s.state).toBe("closed");
    expect(s.failures).toBe(0);
    expect(s.authFingerprint).toBeNull();
    expect(isAuthFailure("http_error", 401)).toBe(true);
    expect(isAuthFailure("http_error", 403)).toBe(true);
    expect(isAuthFailure("http_error", 404)).toBe(false);
    expect(isAuthFailure("rate_limited", 401)).toBe(false);
  });

  it("the key fingerprint never equals or contains the key", async () => {
    const fp = keyFingerprint(SENTINEL);
    expect(fp).toMatch(/^[0-9a-f]{12}$/);
    expect(fp).not.toBe(SENTINEL);
    expect(SENTINEL).not.toContain(fp);
    expect(fp).not.toContain(SENTINEL);
    expect(keyFingerprint("other-key")).not.toBe(fp);
    const cfg = adj();
    expect(currentKeyFingerprint(resolved(cfg), ENV)).toBe(fp);
    expect(currentKeyFingerprint(resolveAdjudicator(cfg, { env: {} }), {})).toBeNull();

    await adjudicateOne(req("s1", "sentinel prompt"), {
      ...base(cfg),
      provider: failing(() => new ProviderError("http_error", "HTTP 401", { status: 401 })),
    });
    const st = openStore().providerState("typesafe");
    expect(JSON.stringify(st)).not.toContain(SENTINEL);
    for (const f of [dbPath, `${dbPath}-wal`])
      if (existsSync(f)) expect(readFileSync(f).includes(Buffer.from(SENTINEL))).toBe(false);
  });

  it("authLockout / withAuthLockout report the rejected key for status and doctor", () => {
    const store = openStore();
    const cfg = adj();
    const r = resolved(cfg);
    expect(withAuthLockout(r, undefined, { now: T0, env: ENV })).toBe(r);
    recordFailure(store, "typesafe", cfg, {
      now: T0,
      kind: "http_error",
      status: 401,
      budgetMs: 100,
      halfOpen: false,
      keyFingerprint: keyFingerprint(SENTINEL),
    });
    const st = store.providerState("typesafe");
    expect(authLockout(st, T0 + 1)).toMatchObject({
      locked: true,
      until: T0 + AUTH_LOCKOUT_MS,
      fingerprint: keyFingerprint(SENTINEL),
      keyChanged: false,
      errorClass: "http_error:401",
    });
    expect(authLockout(st, T0 + 1, "000000000000")?.locked).toBe(false);
    expect(authLockout(st, T0 + AUTH_LOCKOUT_MS)?.locked).toBe(false);
    const w = withAuthLockout(r, st, { now: T0 + 1, env: ENV });
    expect(w.degraded).toBe("auth_failed");
    expect(w.provider).toBe("heuristic");
    expect(w.detail).toContain("API key rejected (HTTP 401)");
    expect(w.detail).not.toContain(SENTINEL);
    const other = { TYPESAFE_API_KEY: "sk-different" } as NodeJS.ProcessEnv;
    expect(withAuthLockout(r, st, { now: T0 + 1, env: other }).degraded).toBeUndefined();
  });

  it("p95 is nearest-rank", () => {
    expect(p95([])).toBeUndefined();
    expect(p95([5])).toBe(5);
    expect(p95(Array.from({ length: 20 }, (_, i) => i + 1))).toBe(19);
  });
});

describe("breaker and counters are atomic across processes (task #38)", () => {
  const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const TSX = join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
  /** One hook process: waits for the start line, claims the gate, then records N successes. */
  const CHILD = `
const [root, dbPath, startAt, n] = process.argv.slice(2);
// Never fall back to a relative path (String(undefined) would create ./undefined in the cwd).
if (!root || !dbPath || !dbPath.startsWith("/") || !startAt || !n) {
  process.stdout.write("ERR bad arguments: " + JSON.stringify(process.argv.slice(2)));
  process.exit(2);
}
const { SqliteAdapter } = await import(root + "/src/storage/sqlite/adapter.ts");
const { gate, recordSuccess } = await import(root + "/src/adjudicator/breaker.ts");
const { adjudicatorDefaults } = await import(root + "/src/config.ts");
const db = new SqliteAdapter(dbPath, { vectors: false });
const cfg = adjudicatorDefaults();
db.adjudicator.providerState("typesafe");
while (Date.now() < Number(startAt)) {}
const g = gate(db.adjudicator, "typesafe", cfg, { now: Date.now(), remote: true });
for (let i = 0; i < Number(n); i++)
  recordSuccess(db.adjudicator, "counter", cfg, { now: Date.now(), latencyMs: 1, costUsd: 0.001, budgetMs: 60000 });
db.close();
process.stdout.write(JSON.stringify({ allow: g.allow, halfOpen: g.allow ? g.halfOpen : false }));
`;

  it("10 processes at once: one half-open trial call, no lost spend or call increments", async () => {
    const dir = mkdtempSync(join(tmpdir(), "em-adj-race-"));
    const child = join(dir, "child.mts");
    writeFileSync(child, CHILD);
    const seed = openStore();
    seed.saveProviderState("typesafe", { state: "open", failures: 2, retryAt: Date.now() - 1000 });
    const PROCS = 10;
    const N = 20;
    const startAt = Date.now() + 3000;
    // The children get an explicit absolute DB path and run in the temp dir, never the repo root.
    expect(isAbsolute(dbPath)).toBe(true);
    const stray = [join(ROOT, "undefined"), join(dir, "undefined")];
    const outs = await Promise.all(
      Array.from(
        { length: PROCS },
        () =>
          new Promise<string>((done) => {
            execFile(
              TSX,
              [child, ROOT, dbPath, String(startAt), String(N)],
              { cwd: dir },
              (err, out, errOut) => done(err ? `ERR ${out}${errOut || err.message}` : out),
            );
          }),
      ),
    );
    for (const f of stray) expect(existsSync(f), f).toBe(false);
    const results = outs.map((o) => {
      expect(o.startsWith("{"), o.slice(0, 300)).toBe(true);
      return JSON.parse(o) as { allow: boolean; halfOpen: boolean };
    });
    expect(results.filter((r) => r.halfOpen)).toHaveLength(1);
    expect(results.filter((r) => r.allow)).toHaveLength(1);
    expect(seed.providerState("typesafe")?.state).toBe("half_open");
    const counter = seed.providerState("counter");
    expect(counter?.calls).toBe(PROCS * N);
    expect(counter?.spendUsd).toBeCloseTo(PROCS * N * 0.001, 9);
  }, 60_000);

  it("atomically() joins an outer transaction and rolls back on a throw", () => {
    const store = openStore();
    expect(store.atomically).toBeTypeOf("function");
    const atomically = store.atomically?.bind(store) as <T>(fn: () => T) => T;
    expect(() =>
      atomically(() => {
        store.saveProviderState("p", { calls: 5 });
        atomically(() => store.saveProviderState("p", { calls: 6 }));
        throw new Error("abort");
      }),
    ).toThrow("abort");
    expect(store.providerState("p")).toBeUndefined();
    expect(atomically(() => store.saveProviderState("p", { calls: 7 }).calls)).toBe(7);
  });

  it("a store without atomically() still works (try-it wrapper, test doubles)", () => {
    const real = openStore();
    const plain: AdjudicatorStore = {
      ...({} as AdjudicatorStore),
      providerState: (p) => real.providerState(p),
      saveProviderState: (p, patch) => real.saveProviderState(p, patch),
    };
    real.saveProviderState("typesafe", { state: "open", retryAt: T0 - 1 });
    const g = gate(plain, "typesafe", adj(), { now: T0, remote: true });
    expect(g.allow && g.halfOpen).toBe(true);
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
