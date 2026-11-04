import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetSecrets } from "../../src/adjudicator/secrets.js";
import { type AdjudicatorProvider, EVAL_META_KEY } from "../../src/adjudicator/types.js";
import { type Config, ConfigSchema } from "../../src/config.js";
import type { ProjectContext } from "../../src/context.js";
import { SqliteAdapter } from "../../src/storage/sqlite/adapter.js";
import type { AdjudicationInput } from "../../src/storage/types.js";
import {
  type AdjudicatorRouteDeps,
  adjudicatorRoute,
  chartsOf,
  safeUrl,
} from "../../src/ui/adjudicator-api.js";

// biome-ignore lint/suspicious/noExplicitAny: the tests read untyped JSON payloads
type Json = any;

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);
const SENTINEL = "sk-SENTINEL-adjudicator-key-Zq9X";
const PROMPT_MARKER = "PLUGH-raw-prompt-marker";

let db: SqliteAdapter;
let ctx: ProjectContext;

function config(adjudicator: Record<string, unknown> = {}): Config {
  return ConfigSchema.parse({ adjudicator });
}

function deps(over: Partial<AdjudicatorRouteDeps> = {}): AdjudicatorRouteDeps {
  return { config: config(), db, now: () => NOW, env: {}, ...over };
}

async function call(
  path: string,
  query: Record<string, string> = {},
  d: AdjudicatorRouteDeps = deps(),
  method = "GET",
  body: unknown = {},
) {
  return adjudicatorRoute(
    ctx,
    { path, method, query: new URLSearchParams(query), body: async () => body },
    d,
  );
}

function row(over: Partial<AdjudicationInput> = {}): number {
  return db.adjudicator.insert({
    surface: "agent",
    inputHash: "h",
    inputHead: "refactor the auth module",
    ts: NOW - 3 * DAY,
    sessionId: "S",
    complexity: 2.2,
    tier: "sonnet",
    role: "coder",
    source: "heuristic",
    provider: "heuristic",
    providerStatus: "n/a",
    scores: JSON.stringify({
      complexity: 2.2,
      features: { intents: { refactor: 1 } },
      alpha: {},
      bias: {},
    }),
    ...over,
  });
}

const remoteCfg = () =>
  config({
    enabled: true,
    provider: "openai-compatible",
    openai: { preset: "groq" },
    remoteConsent: true,
  });
const sentinelEnv = () => ({ GROQ_API_KEY: SENTINEL, EMINIAR_ADJUDICATOR_KEY: SENTINEL });

const fakeProvider = (): AdjudicatorProvider => ({
  id: "openai-compatible",
  remote: true,
  dims: ["complexity", "tier", "role", "tool"],
  adjudicate: async (reqs) => ({
    answers: reqs.map((r) => ({
      key: r.key,
      complexity: { value: 3.4, confidence: 0.9 },
      tier: { probs: { haiku: 0, sonnet: 0.1, opus: 0.9 }, confidence: 0.9, calibrated: true },
    })),
    usage: { inTok: 120, outTok: 30, costUsd: 0.0002 },
    latencyMs: 4,
    model: "fake-model",
  }),
  probe: async () => ({ ok: true, latencyMs: 1, detail: "ok" }),
});

beforeEach(() => {
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-adj-api-home-"));
  resetSecrets();
  const root = mkdtempSync(join(tmpdir(), "em-adj-api-"));
  const dbPath = join(root, "db.sqlite");
  db = new SqliteAdapter(dbPath, { vectors: false });
  ctx = { root, id: "test", dbPath, config: config() };
});

afterEach(() => {
  db.close();
  delete process.env.EMINIAR_HOME;
  resetSecrets();
});

describe("GET /api/adjudicator", () => {
  it("answers while disabled with no data", async () => {
    const r = await call("/api/adjudicator");
    expect(r.status).toBe(200);
    const b = r.body as Json;
    expect(b.enabled).toBe(false);
    expect(b.summary.total).toBe(0);
    expect(b.keySource).toBe("none");
    expect(b.health).toEqual([]);
    expect(b.charts).toEqual({ perDay: [], complexity: [0, 0, 0, 0, 0] });
    expect(b.fallbackRate).toBeNull();
    expect(b.reconcile).toMatchObject({ scanned: 0 });
    expect(b.since).toBe(NOW - 30 * DAY);
    expect(b.filters.surfaces).toContain("prompt");
  });

  it("reports summary, charts, provider health and apply effectiveness", async () => {
    row({ ts: NOW - 3 * DAY, complexity: 0.4, source: "heuristic" });
    row({ ts: NOW - DAY, complexity: 2.2, source: "blend", provider: "openai-compatible" });
    row({ ts: NOW - DAY, complexity: 3.9, source: "fallback", providerStatus: "timeout" });
    row({ ts: NOW - 60 * DAY, source: "cache" }); // outside the default 30d window
    db.adjudicator.saveProviderState("openai-compatible", {
      state: "auth_failed", // a state this module does not know is passed through as is
      failures: 3,
      retryAt: NOW + 60_000,
      lastErrorClass: "auth",
      latencies: [100, 200, 300, 400, 900],
      spendDay: new Date(NOW).toISOString().slice(0, 10),
      spendUsd: 0.12,
    });
    const r = await call("/api/adjudicator", {}, deps({ config: remoteCfg(), env: sentinelEnv() }));
    const b = r.body as Json;
    expect(b.enabled).toBe(true);
    expect(b.summary.total).toBe(3);
    expect(b.fallbackRate).toBeCloseTo(1 / 3);
    expect(b.charts.perDay).toHaveLength(3);
    expect(b.charts.perDay[0]).toMatchObject({ heuristic: 1, total: 1 });
    expect(b.charts.perDay[1]).toMatchObject({ total: 0 });
    expect(b.charts.perDay[2]).toMatchObject({ blend: 1, fallback: 1, total: 2 });
    expect(b.charts.complexity.reduce((s: number, n: number) => s + n, 0)).toBe(3);
    expect(b.provider).toMatchObject({
      configured: "openai-compatible",
      effective: "openai-compatible",
      degraded: null,
    });
    expect(b.keySource).toBe("env");
    const h = b.health.find((x: Json) => x.provider === "openai-compatible");
    expect(h).toMatchObject({
      configured: true,
      remote: true,
      state: "auth_failed",
      failures: 3,
      lastErrorClass: "auth",
      spendTodayUsd: 0.12,
      dailyCapUsd: 0.5,
    });
    expect(h.latency).toEqual({ n: 5, p50: 300, p95: 900 });
    expect(b.apply).toEqual({ checked: 0, ineffective: 0, effective: 0 });

    const all = await call("/api/adjudicator", { since: "all" });
    expect((all.body as Json).summary.total).toBe(4);
  });

  it("shows the degraded reason without a key", async () => {
    const r = await call("/api/adjudicator", {}, deps({ config: remoteCfg() }));
    const b = r.body as Json;
    expect(b.provider).toMatchObject({
      configured: "openai-compatible",
      effective: "heuristic",
      degraded: "no_key",
    });
    expect(b.keySource).toBe("none");
  });

  it("rejects a bad since and non-GET methods", async () => {
    expect((await call("/api/adjudicator", { since: "yesterday" })).status).toBe(400);
    expect((await call("/api/adjudicator", {}, deps(), "POST")).status).toBe(405);
    expect((await call("/api/adjudicator/nope")).status).toBe(404);
  });
});

describe("GET /api/adjudicator/decisions", () => {
  it("filters and pages without the scores JSON", async () => {
    for (let i = 0; i < 7; i++) row({ ts: NOW - i * 1000 });
    row({ surface: "prompt", ts: NOW - 500 });
    row({ surface: "plan", outcome: "success", provider: "embedding", ts: NOW - 40 * DAY });
    const r = await call("/api/adjudicator/decisions", { surface: "agent", limit: "5" });
    expect(r.status).toBe(200);
    const b = r.body as Json;
    expect(b.total).toBe(7);
    expect(b.rows).toHaveLength(5);
    expect(b.rows[0].scores).toBeUndefined();
    expect(b.rows[0].hasScores).toBe(true);
    expect(b.rows[0].inputHead).toBe("refactor the auth module");
    const page2 = await call("/api/adjudicator/decisions", {
      surface: "agent",
      limit: "5",
      offset: "5",
    });
    expect((page2.body as Json).rows).toHaveLength(2);
    const old = await call("/api/adjudicator/decisions", {
      outcome: "success",
      provider: "embedding",
    });
    expect((old.body as Json).total).toBe(1);
    const recent = await call("/api/adjudicator/decisions", { since: "30d" });
    expect((recent.body as Json).total).toBe(8);
  });

  it("validates every query value", async () => {
    const bad: Array<Record<string, string>> = [
      { since: "soon" },
      { since: "1999-01-01" },
      { limit: "0" },
      { limit: "501" },
      { limit: "ten" },
      { offset: "-1" },
      { surface: "voice" },
      { provider: "gpt" },
      { outcome: "maybe" },
    ];
    for (const q of bad) {
      const r = await call("/api/adjudicator/decisions", q);
      expect(r.status, JSON.stringify(q)).toBe(400);
    }
    expect((await call("/api/adjudicator/decisions", { limit: "500" })).status).toBe(200);
  });
});

describe("GET /api/adjudicator/decision", () => {
  it("returns the full row with parsed scores", async () => {
    const id = row();
    const r = await call("/api/adjudicator/decision", { id: String(id) });
    expect(r.status).toBe(200);
    const b = r.body as Json;
    expect(b.row.id).toBe(id);
    expect(b.row.scores).toBeUndefined();
    expect(b.scores.features.intents.refactor).toBe(1);
  });

  it("400s a bad id and 404s a missing one", async () => {
    expect((await call("/api/adjudicator/decision", { id: "x" })).status).toBe(400);
    expect((await call("/api/adjudicator/decision", {})).status).toBe(400);
    expect((await call("/api/adjudicator/decision", { id: "0" })).status).toBe(400);
    expect((await call("/api/adjudicator/decision", { id: "999" })).status).toBe(404);
  });
});

describe("GET /api/adjudicator/savings and /eval", () => {
  it("returns the savings report", async () => {
    row({ costUsd: 0.01 });
    const r = await call("/api/adjudicator/savings");
    expect(r.status).toBe(200);
    const b = r.body as Json;
    expect(b.spendUsd).toBeCloseTo(0.01);
    expect(b.netUsd).toBeCloseTo(-0.01);
    expect(Array.isArray(b.assumptions)).toBe(true);
    expect(b.assumptions.length).toBeGreaterThan(0);
    expect(Array.isArray(b.matrix)).toBe(true);
    expect(b.reconcile).toBeDefined();
    expect((await call("/api/adjudicator/savings", { since: "nope" })).status).toBe(400);
  });

  it("returns null without an eval report, and strips item text from one", async () => {
    expect((await call("/api/adjudicator/eval")).body).toMatchObject({ report: null });
    db.metaSet(
      EVAL_META_KEY,
      JSON.stringify({
        rows: [{ name: "heuristic-only", tier: 0.6 }],
        items: [{ text: "secret" }],
      }),
    );
    const r = await call("/api/adjudicator/eval");
    expect((r.body as Json).report.rows[0].name).toBe("heuristic-only");
    expect(JSON.stringify(r.body)).not.toContain("secret");
  });
});

describe("POST /api/adjudicator/test", () => {
  const text = `${PROMPT_MARKER} refactor the session store across src/a.ts and src/b.ts and add tests`;

  it("scores with the heuristic while disabled and persists nothing", async () => {
    const r = await call("/api/adjudicator/test", {}, deps(), "POST", { text, useProvider: true });
    expect(r.status).toBe(200);
    const b = r.body as Json;
    expect(b).toMatchObject({
      enabled: false,
      usedProvider: false,
      reason: "disabled",
      persisted: false,
    });
    expect(b.verdict.source).toBe("heuristic");
    expect(b.verdict.key).toBeUndefined();
    expect(typeof b.verdict.complexity).toBe("number");
    expect(b.verdict.tier.entries.length).toBeGreaterThan(0);
    expect(typeof b.advice).toBe("string");
    expect(JSON.stringify(b)).not.toContain(PROMPT_MARKER);
    expect(db.adjudicator.list().total).toBe(0);
  });

  it("uses the provider only when enabled, asked, consented and keyed; never persists", async () => {
    const d = deps({ config: remoteCfg(), env: sentinelEnv(), provider: fakeProvider() });
    const off = await call("/api/adjudicator/test", {}, d, "POST", { text });
    expect(off.body).toMatchObject({ usedProvider: false, reason: "not_requested" });
    expect((off.body as Json).verdict.source).toBe("heuristic");

    const on = await call("/api/adjudicator/test", {}, d, "POST", { text, useProvider: true });
    const b = on.body as Json;
    expect(b).toMatchObject({ usedProvider: true, reason: "used", providerModel: "fake-model" });
    expect(b.verdict.source).toBe("blend");
    expect(b.verdict.providerStatus).toBe("ok");
    const json = JSON.stringify(b);
    expect(json).not.toContain(PROMPT_MARKER);
    expect(json).not.toContain(SENTINEL);
    expect(db.adjudicator.list().total).toBe(0);
    expect(db.adjudicator.summary().total).toBe(0);
    // A test call is a real call: it counts against the daily cap.
    expect(db.adjudicator.providerState("openai-compatible")?.spendUsd).toBeCloseTo(0.0002);

    const noKey = await call(
      "/api/adjudicator/test",
      {},
      deps({ config: remoteCfg(), provider: fakeProvider() }),
      "POST",
      { text, useProvider: true },
    );
    expect(noKey.body).toMatchObject({ usedProvider: false, reason: "no_key" });
  });

  it("runs the breaker's read-modify-write in the store's transaction (#48)", async () => {
    const tx = vi.spyOn(db.adjudicator, "atomically");
    const d = deps({ config: remoteCfg(), env: sentinelEnv(), provider: fakeProvider() });
    const on = await call("/api/adjudicator/test", {}, d, "POST", { text, useProvider: true });
    expect(on.body).toMatchObject({ usedProvider: true, reason: "used" });
    // gate + recordSuccess, each in one BEGIN IMMEDIATE
    expect(tx.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(db.adjudicator.providerState("openai-compatible")?.calls).toBe(1);
    tx.mockRestore();
  });

  it("validates the body and the method", async () => {
    const post = (body: unknown) => call("/api/adjudicator/test", {}, deps(), "POST", body);
    expect((await post({})).status).toBe(400);
    expect((await post({ text: "   " })).status).toBe(400);
    expect((await post({ text: 42 })).status).toBe(400);
    expect((await post({ text: "x".repeat(20_001) })).status).toBe(400);
    expect((await post({ text: "hi there", useProvider: "yes" })).status).toBe(400);
    expect((await post([1])).status).toBe(400);
    expect((await call("/api/adjudicator/test", { text: "hi" })).status).toBe(405);
    const broken = await adjudicatorRoute(
      ctx,
      {
        path: "/api/adjudicator/test",
        method: "POST",
        query: new URLSearchParams(),
        body: async () => {
          throw new SyntaxError("bad json");
        },
      },
      deps(),
    );
    expect(broken.status).toBe(400);
  });
});

describe("no secrets in any payload", () => {
  it("never returns the key, its mask or URL credentials", async () => {
    const cfg = config({
      enabled: true,
      provider: "openai-compatible",
      openai: {
        preset: "custom",
        baseUrl: "https://user:pw-SECRET@llm.example.com/v1?token=t0k",
        model: "m",
      },
      keyEnv: "MY_ADJ_KEY",
      remoteConsent: true,
    });
    const env = { ...sentinelEnv(), MY_ADJ_KEY: SENTINEL };
    row({ provider: "openai-compatible", costUsd: 0.001 });
    db.adjudicator.saveProviderState("openai-compatible", { state: "closed", latencies: [5] });
    const d = deps({ config: cfg, env, provider: fakeProvider() });
    const bodies = [
      await call("/api/adjudicator", {}, d),
      await call("/api/adjudicator/decisions", {}, d),
      await call("/api/adjudicator/decision", { id: "1" }, d),
      await call("/api/adjudicator/savings", {}, d),
      await call("/api/adjudicator/eval", {}, d),
      await call("/api/adjudicator/test", {}, d, "POST", {
        text: "fix the bug",
        useProvider: true,
      }),
    ];
    for (const r of bodies) {
      expect(r.status).toBe(200);
      const json = JSON.stringify(r.body);
      expect(json).not.toContain(SENTINEL);
      expect(json).not.toContain("Zq9X");
      expect(json).not.toContain("pw-SECRET");
      expect(json).not.toContain("t0k");
    }
    const overview = bodies[0]?.body as Json;
    expect(overview.keySource).toBe("env");
    expect(overview.config.keyEnv).toBe("MY_ADJ_KEY");
    expect(overview.config.openai.baseUrl).toBe("https://llm.example.com/v1");
  });
});

describe("helpers", () => {
  it("safeUrl drops userinfo, query and fragment", () => {
    expect(safeUrl("http://a:b@localhost:11434/v1?x=1#f")).toBe("http://localhost:11434/v1");
    expect(safeUrl("not a url")).toBeNull();
    expect(safeUrl(undefined)).toBeNull();
  });

  it("chartsOf fills day gaps and buckets complexity", () => {
    const c = chartsOf([
      { ts: NOW - 2 * DAY, source: "cache", complexity: 0 },
      { ts: NOW, source: null, complexity: 4 },
    ]);
    expect(c.perDay.map((d) => d.total)).toEqual([1, 0, 1]);
    expect(c.perDay[0]?.cache).toBe(1);
    expect(c.perDay[2]?.heuristic).toBe(1);
    expect(c.complexity[0]).toBe(1);
    expect(c.complexity[4]).toBe(1);
  });
});
