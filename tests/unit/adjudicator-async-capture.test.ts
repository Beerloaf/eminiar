/**
 * Review-xchg R4 (task #197): the async job carries the config the hook saved when it queued the
 * job. A job queued while privacy.captureExchanges was on must still honour `exchanges off`, the
 * EMINIAR_ADJUDICATOR_CAPTURE=0 kill switch and a purge: it re-reads the CURRENT effective
 * setting before it hands the provider a sink and again right before it stores the exchange. The
 * verdict path is unchanged either way.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AsyncJob, runAsyncJob } from "../../src/adjudicator/async.js";
import { resetProviders } from "../../src/adjudicator/providers/index.js";
import { resetSecrets } from "../../src/adjudicator/secrets.js";
import type {
  AdjudicatorProvider,
  ProviderExchange,
  ProviderResult,
} from "../../src/adjudicator/types.js";
import { ConfigSchema } from "../../src/config.js";
import { SqliteAdapter } from "../../src/storage/sqlite/adapter.js";
import type { AdjudicatorStore } from "../../src/storage/types.js";

const ENV = { TYPESAFE_API_KEY: "sk-async-capture-0123456789abcdef" } as NodeJS.ProcessEnv;

let home: string;
let root: string;
let adapter: SqliteAdapter;
let store: AdjudicatorStore;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "em-async-cap-home-"));
  root = mkdtempSync(join(tmpdir(), "em-async-cap-root-"));
  process.env.EMINIAR_HOME = home;
  delete process.env.EMINIAR_ADJUDICATOR_CAPTURE;
  resetSecrets();
  resetProviders();
  adapter = new SqliteAdapter(join(mkdtempSync(join(tmpdir(), "em-async-cap-db-")), "eminiar.db"), {
    vectors: false,
  });
  store = adapter.adjudicator;
});
afterEach(() => {
  adapter.close();
  delete process.env.EMINIAR_HOME;
  delete process.env.EMINIAR_ADJUDICATOR_CAPTURE;
  resetSecrets();
  resetProviders();
});

const personal = (captureExchanges: boolean) =>
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({ adjudicator: { privacy: { captureExchanges } } }),
  );

// What the hook saved at queue time: capture on.
const queuedCfg = ConfigSchema.parse({
  adjudicator: {
    enabled: true,
    provider: "typesafe",
    remoteConsent: true,
    privacy: { captureExchanges: true },
  },
}).adjudicator;

const job = (over: Partial<AsyncJob> = {}): string =>
  JSON.stringify({
    v: 1,
    projectRoot: root,
    request: { key: "k1", surface: "prompt", text: "SECRETPROMPT refactor the storage layer" },
    cacheKey: "ck",
    config: queuedCfg,
    context: "hook",
    budgetMs: 2000,
    rowId: 7,
    queuedAt: Date.now(),
    ...over,
  });

/** Answers the request; pushes one exchange into the sink when it was given one. */
function fake(beforeReturn?: () => void): AdjudicatorProvider & {
  sinks: Array<ProviderExchange[] | undefined>;
} {
  const sinks: Array<ProviderExchange[] | undefined> = [];
  return {
    id: "typesafe",
    remote: true,
    dims: ["complexity", "tier", "role"],
    sinks,
    async adjudicate(reqs, opts) {
      sinks.push(opts.capture);
      opts.capture?.push({
        http: {
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
          request: { text: "SECRETPROMPT", json: false, bytes: 12, truncated: false },
          response: { text: '{"answers":[]}', json: true, bytes: 14, truncated: false },
          error: null,
        },
        provider: "typesafe",
        model: "jev-1.14.0",
        batch: 0,
        itemKeys: reqs.map((r) => r.key),
        tokensIn: 100,
        tokensOut: 5,
        costUsd: 0.0001,
      });
      beforeReturn?.();
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
      } satisfies ProviderResult;
    },
    async probe() {
      return { ok: true, latencyMs: 1, detail: "fake" };
    },
  };
}

describe("async job re-checks capture before it writes", () => {
  it("setting still on: the exchange is stored and linked to the hook's row", async () => {
    personal(true);
    const p = fake();
    const res = await runAsyncJob(job(), { store, provider: p, env: ENV });
    expect(res).toMatchObject({ ok: true, source: "blend" });
    expect(p.sinks[0]).toBeDefined();
    expect(store.exchangeCount()).toBe(1);
    expect(store.exchangeList().rows[0]).toMatchObject({ rowIds: [7] });
  });

  it("setting turned off after queueing: no sink, no row, the verdict is unchanged", async () => {
    personal(false);
    const p = fake();
    const res = await runAsyncJob(job(), { store, provider: p, env: ENV });
    expect(res).toMatchObject({ ok: true, source: "blend" });
    expect(p.sinks[0]).toBeUndefined();
    expect(store.exchangeCount()).toBe(0);
  });

  it("no personal setting at all (the file was removed): no row", async () => {
    const res = await runAsyncJob(job(), { store, provider: fake(), env: ENV });
    expect(res.ok).toBe(true);
    expect(store.exchangeCount()).toBe(0);
  });

  it("EMINIAR_ADJUDICATOR_CAPTURE=0 beats a personal file that is still on", async () => {
    personal(true);
    process.env.EMINIAR_ADJUDICATOR_CAPTURE = "0";
    const p = fake();
    const res = await runAsyncJob(job(), { store, provider: p, env: ENV });
    expect(res).toMatchObject({ ok: true, source: "blend" });
    expect(p.sinks[0]).toBeUndefined();
    expect(store.exchangeCount()).toBe(0);
  });

  it("turned off while the provider call is in flight: the exchange is dropped, not stored", async () => {
    personal(true);
    const p = fake(() => personal(false));
    const res = await runAsyncJob(job(), { store, provider: p, env: ENV });
    expect(res).toMatchObject({ ok: true, source: "blend" });
    expect(p.sinks[0]).toBeDefined(); // it was on when the call started
    expect(store.exchangeCount()).toBe(0);
  });

  it("a job queued with capture off never captures, even if the setting is on now", async () => {
    personal(true);
    const off = { ...queuedCfg, privacy: { ...queuedCfg.privacy, captureExchanges: false } };
    const p = fake();
    await runAsyncJob(job({ config: off }), { store, provider: p, env: ENV });
    expect(p.sinks[0]).toBeUndefined();
    expect(store.exchangeCount()).toBe(0);
  });
});
