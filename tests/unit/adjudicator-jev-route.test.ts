/**
 * GET /api/adjudicator/jev (src/ui/adjudicator-api.ts jevPayload; design: blackboard
 * design-jev B and C). The gate runs before any database access, errors never carry text, and
 * the payload holds counts, ids, tiers and reason codes only.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blend } from "../../src/adjudicator/blend.js";
import { verdictColumns } from "../../src/adjudicator/engine.js";
import { tableConfidence } from "../../src/adjudicator/heuristic.js";
import { reconcile } from "../../src/adjudicator/learn.js";
import { resetSecrets } from "../../src/adjudicator/secrets.js";
import { type Config, ConfigSchema } from "../../src/config.js";
import type { ProjectContext } from "../../src/context.js";
import type { StorageAdapter } from "../../src/storage/adapter.js";
import { getStorage } from "../../src/storage/index.js";
import { SqliteAdapter } from "../../src/storage/sqlite/adapter.js";
import type { AdjudicationInput } from "../../src/storage/types.js";
import {
  type AdjudicatorRouteDeps,
  adjudicatorRoute,
  type JevApiPayload,
  jevPayload,
} from "../../src/ui/adjudicator-api.js";

vi.mock("../../src/storage/index.js", () => ({
  getStorage: vi.fn(() => {
    throw new Error("getStorage must not be reached: SQLITE_BUSY at /secret/path/db.sqlite");
  }),
}));

vi.mock("../../src/adjudicator/learn.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/adjudicator/learn.js")>();
  return { ...real, reconcile: vi.fn(real.reconcile) };
});

const real = await vi.importActual<typeof import("../../src/adjudicator/learn.js")>(
  "../../src/adjudicator/learn.js",
);

// biome-ignore lint/suspicious/noExplicitAny: the tests read untyped JSON payloads
type Json = any;

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
const SENTINEL = "sk-SENTINEL-jev-key-Zq9X-0123456789";
const PROMPT_MARKER = "PLUGH-raw-prompt-marker";
const NOTE_MARKER = "XYZZY-feedback-note-marker";
const FIXED_503 = "the adjudication database is unavailable (busy or missing); try again";

let db: SqliteAdapter;
let ctx: ProjectContext;

function config(adjudicator: Record<string, unknown> = {}): Config {
  return ConfigSchema.parse({ adjudicator });
}

const jevCfg = (over: Record<string, unknown> = {}) =>
  config({ enabled: true, provider: "typesafe", remoteConsent: true, ...over });
const keyEnv = () => ({ TYPESAFE_API_KEY: SENTINEL, EMINIAR_ADJUDICATOR_KEY: SENTINEL });

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
  return { config: jevCfg(), db, now: () => NOW, env: keyEnv(), ...over };
}

async function call(
  query: Record<string, string> = {},
  d: AdjudicatorRouteDeps = deps(),
  method = "GET",
  path = "/api/adjudicator/jev",
) {
  return adjudicatorRoute(
    ctx,
    { path, method, query: new URLSearchParams(query), body: async () => ({}) },
    d,
  );
}

// --- seeded rows ---------------------------------------------------------------------------

function hTable(probs: Record<string, number>, dimension: "tier" | "role" | "tool") {
  const entries = Object.entries(probs)
    .map(([option, score]) => ({ option, score, reasons: [] }))
    .sort((a, b) => b.score - a.score);
  return {
    dimension,
    entries,
    choice: entries[0]?.option ?? "none",
    confidence: tableConfidence(entries),
  };
}

function jevRow(over: Partial<AdjudicationInput> = {}): AdjudicationInput {
  const h = {
    complexity: 1,
    complexityReasons: [],
    tier: hTable({ haiku: 0.8, sonnet: 0.15, opus: 0.05 }, "tier"),
    role: hTable({ coder: 0.7, architect: 0.2, none: 0.1 }, "role"),
    tool: hTable({ em_symbols: 0.4, em_swarm: 0.3, none: 0.3 }, "tool"),
    effort: "low" as const,
  };
  const v = blend(
    h,
    {
      key: "k",
      tier: { probs: { sonnet: 1 }, confidence: 0.7, calibrated: true },
    },
    {},
    {},
    { key: "k", provider: "typesafe", tiers: ["haiku", "sonnet", "opus"] },
  );
  v.heuristicComplexity = 1;
  return {
    surface: "agent",
    inputHash: "h",
    inputHead: `${PROMPT_MARKER} refactor the auth module`,
    feedbackNote: NOTE_MARKER,
    sessionId: "S",
    ts: NOW - DAY,
    ...verdictColumns(v, {}),
    provider: "typesafe",
    providerModel: "jev-1.14.0",
    providerStatus: "ok",
    source: "blend",
    latencyMs: 300,
    providerLatencyMs: 280,
    costUsd: 0.001,
    role: "coder",
    action: "applied",
    final: true,
    outcome: "failure",
    outcomeSource: "feedback:too_small",
    ...over,
  } as AdjudicationInput;
}

beforeEach(() => {
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-jev-route-home-"));
  resetSecrets();
  vi.mocked(getStorage).mockClear();
  vi.mocked(reconcile).mockClear();
  const root = mkdtempSync(join(tmpdir(), "em-jev-route-"));
  const dbPath = join(root, "db.sqlite");
  db = new SqliteAdapter(dbPath, { vectors: false });
  ctx = { root, id: "test", dbPath, config: config() };
});

afterEach(() => {
  db.close();
  delete process.env.EMINIAR_HOME;
  resetSecrets();
});

// --- the gate ---------------------------------------------------------------------------------

describe("GET /api/adjudicator/jev: inactive", () => {
  const cases: Array<[string, Record<string, unknown>, "disabled" | "provider", string]> = [
    [
      "the adjudicator is disabled",
      { enabled: false, provider: "typesafe" },
      "disabled",
      "typesafe",
    ],
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

  for (const [name, adj, reason, provider] of cases) {
    it(`answers {active:false} and never touches the database when ${name}`, async () => {
      const stub = poisoned();
      const r = await call({}, deps({ config: config(adj), db: stub.db, env: keyEnv() }));
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ active: false, reason, provider, now: NOW });
      expect(stub.touched).toEqual([]);
      expect(reconcile).not.toHaveBeenCalled();
    });
  }

  it("does not open the project's database when no db is given and Jev is not in play", async () => {
    const r = await call(
      {},
      { config: config({ enabled: true, provider: "heuristic" }), now: () => NOW },
    );
    expect(r.body).toMatchObject({ active: false, reason: "provider" });
    expect(getStorage).not.toHaveBeenCalled();
  });

  it("jevPayload itself is gated the same way", () => {
    const stub = poisoned();
    const r = jevPayload(ctx, deps({ config: config(), db: stub.db }));
    expect(r.body).toMatchObject({ active: false, reason: "disabled" });
  });

  it("carries no key, key mask or row data in the inactive payload", async () => {
    const r = await call({}, deps({ config: config({ enabled: true, provider: "heuristic" }) }));
    expect(Object.keys(r.body as object).sort()).toEqual(["active", "now", "provider", "reason"]);
    expect(JSON.stringify(r.body)).not.toContain(SENTINEL);
  });
});

describe("GET /api/adjudicator/jev: validation", () => {
  it("rejects a bad since with 400, before any database access", async () => {
    for (const since of ["banana", "7", "-3d", "1.5d", "30 days", "d7"]) {
      const stub = poisoned();
      const r = await call({ since }, deps({ db: stub.db }));
      expect(r.status, since).toBe(400);
      expect(Object.keys(r.body as object)).toEqual(["error"]);
      expect(stub.touched).toEqual([]);
    }
  });

  it("rejects a bad surface with 400, test and unknown surfaces included", async () => {
    for (const surface of ["bogus", "test", "PROMPT", "prompt,agent", "../etc"]) {
      const stub = poisoned();
      const r = await call({ surface }, deps({ db: stub.db }));
      expect(r.status, surface).toBe(400);
      expect((r.body as Json).error).toContain("surface must be one of");
      expect(stub.touched).toEqual([]);
    }
  });

  it("validates even when Jev is inactive", async () => {
    const r = await call({ since: "banana" }, deps({ config: config() }));
    expect(r.status).toBe(400);
  });

  it("answers 405 to anything but a GET", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const stub = poisoned();
      const r = await call({}, deps({ db: stub.db }), method);
      expect(r.status, method).toBe(405);
      expect(r.body).toEqual({ error: "GET only" });
      expect(stub.touched).toEqual([]);
    }
  });

  it("accepts the supported windows and surfaces", async () => {
    for (const since of ["7d", "30d", "90d", "all", "12h"]) {
      const r = await call({ since });
      expect(r.status, since).toBe(200);
    }
    for (const surface of ["prompt", "agent", "plan", "mcp"]) {
      const r = await call({ surface });
      expect(r.status, surface).toBe(200);
      expect((r.body as Json).surface).toBe(surface);
    }
  });

  it("windows: default 30d, explicit 7d, all", async () => {
    expect(((await call()).body as Json).since).toBe(NOW - 30 * DAY);
    expect(((await call({ since: "7d" })).body as Json).since).toBe(NOW - 7 * DAY);
    expect(((await call({ since: "all" })).body as Json).since).toBeNull();
    expect(((await call({ since: "" })).body as Json).since).toBe(NOW - 30 * DAY);
  });
});

// --- storage failure -----------------------------------------------------------------------------

describe("GET /api/adjudicator/jev: storage failures", () => {
  it("answers 503 with the fixed message when the database cannot be opened", async () => {
    // no db in deps: the mocked getStorage throws an error whose text must not leak
    const r = await call({}, { config: jevCfg(), now: () => NOW, env: keyEnv() });
    expect(getStorage).toHaveBeenCalledTimes(1);
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ error: FIXED_503 });
    expect(JSON.stringify(r.body)).not.toContain("SQLITE_BUSY");
    expect(JSON.stringify(r.body)).not.toContain("/secret/path");
  });

  it("answers 503 with the fixed message when a read throws mid-way", async () => {
    const real = db.adjudicator;
    const busy = {
      ...db,
      adjudicator: {
        ...real,
        providerState: real.providerState.bind(real),
        list: () => {
          throw new Error("SQLITE_BUSY: database is locked at /Users/me/.eminiar/secret.db");
        },
      },
      apiCallsLatestTs: () => undefined,
    } as unknown as StorageAdapter;
    const r = await call({}, deps({ db: busy }));
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ error: FIXED_503 });
    expect(JSON.stringify(r.body)).not.toMatch(/SQLITE|locked|secret/);
  });

  it("answers 503 when the breaker state cannot be read", async () => {
    const real = db.adjudicator;
    const busy = {
      ...db,
      adjudicator: {
        ...real,
        list: real.list.bind(real),
        providerState: () => {
          throw new Error("disk I/O error");
        },
      },
      apiCallsLatestTs: () => undefined,
    } as unknown as StorageAdapter;
    const r = await call({}, deps({ db: busy }));
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ error: FIXED_503 });
  });

  it("answers 503 when the usage probe throws", async () => {
    const real = db.adjudicator;
    const busy = {
      adjudicator: real,
      apiCallsLatestTs: () => {
        throw new Error("no such table: api_calls");
      },
    } as unknown as StorageAdapter;
    const r = await call({}, deps({ db: busy }));
    expect(r.status).toBe(503);
    expect(JSON.stringify(r.body)).not.toContain("api_calls");
  });

  it("an empty database is a valid, empty report, not an error", async () => {
    const r = await call();
    expect(r.status).toBe(200);
    expect((r.body as JevApiPayload).sample.rows).toBe(0);
    expect((r.body as JevApiPayload).verdict.label).toBe("not enough data");
  });
});

// --- the active payload ----------------------------------------------------------------------------

describe("GET /api/adjudicator/jev: active", () => {
  beforeEach(() => {
    for (let i = 0; i < 3; i++) db.adjudicator.insert(jevRow());
    db.adjudicator.insert(jevRow({ surface: "prompt", outcome: "pending", outcomeSource: null }));
  });

  it("returns the provider block and the full report shape", async () => {
    const r = await call();
    expect(r.status).toBe(200);
    const b = r.body as JevApiPayload;
    expect(b.active).toBe(true);
    expect(b.provider).toMatchObject({
      configured: "typesafe",
      effective: "typesafe",
      degraded: null,
    });
    expect(typeof b.provider.model).toBe("string");
    expect(b.provider.health).toMatchObject({
      provider: "typesafe",
      configured: true,
      remote: true,
      state: null,
      failures: 0,
    });
    expect(Object.keys(b).sort()).toEqual(
      [
        "active",
        "provider",
        "since",
        "now",
        "surface",
        "sample",
        "coverage",
        "influence",
        "outcomes",
        "cost",
        "savings",
        "verdict",
        "reconcile",
      ].sort(),
    );
    expect(b.now).toBe(NOW);
    expect(b.reconcile).toMatchObject({ scanned: expect.any(Number), updated: expect.any(Number) });
    expect(b.sample).toMatchObject({ rows: 4, decisions: 4, jevApplied: 4 });
    expect(b.influence.tier).toMatchObject({ compared: 4, up: 4 });
    expect(b.influence.effective).toMatchObject({ dispatches: 3, changed: 3 });
    expect(b.outcomes.evidence).toMatchObject({ help: 3, hurt: 0 });
    expect(b.verdict.label).toBe("not enough data");
    expect(b.verdict.rule).toContain("90% lower bound");
  });

  it("narrows to one surface", async () => {
    const r = await call({ surface: "prompt" });
    const b = r.body as JevApiPayload;
    expect(b.surface).toBe("prompt");
    expect(b.sample.rows).toBe(1);
    expect(b.influence.effective.dispatches).toBe(0);
  });

  it("reads the stored breaker state into the health block and the warnings", async () => {
    db.adjudicator.saveProviderState("typesafe", {
      state: "open",
      failures: 4,
      retryAt: NOW + 60_000,
      lastErrorClass: "timeout",
      latencies: [100, 200, 300],
      spendDay: new Date(NOW).toISOString().slice(0, 10),
      spendUsd: 0.05,
    });
    const b = (await call()).body as JevApiPayload;
    expect(b.provider.health).toMatchObject({ state: "open", failures: 4, spendTodayUsd: 0.05 });
    expect(b.provider.health.latency.n).toBe(3);
    expect(b.verdict.warnings).toContain("Jev's breaker is open");
  });

  it("reconciles once per request after the gate, then only reads", async () => {
    await call();
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(vi.mocked(reconcile).mock.calls[0]?.[1]).toMatchObject({ limit: 500, now: NOW });
    await call({ since: "7d", surface: "agent" });
    expect(reconcile).toHaveBeenCalledTimes(2);
    // the report itself writes nothing: with nothing to reconcile the rows and breaker are unchanged
    const before = JSON.stringify(db.adjudicator.list({ limit: 500 }).rows);
    const stateBefore = JSON.stringify(db.adjudicator.providerState("typesafe") ?? null);
    await call();
    expect(JSON.stringify(db.adjudicator.list({ limit: 500 }).rows)).toBe(before);
    expect(JSON.stringify(db.adjudicator.providerState("typesafe") ?? null)).toBe(stateBefore);
  });

  it("reads the outcomes the reconcile just wrote (a refresh no longer lags one behind)", async () => {
    const rows0 = ((await call()).body as JevApiPayload).sample.rows;
    vi.mocked(reconcile).mockImplementationOnce((d, o) => {
      d.adjudicator.insert(jevRow());
      return real.reconcile(d, o);
    });
    const b = (await call()).body as JevApiPayload;
    expect(b.sample.rows).toBe(rows0 + 1);
  });

  it("stays fail-soft when the reconcile throws", async () => {
    db.adjudicator.insert(jevRow());
    vi.mocked(reconcile).mockImplementationOnce(() => {
      throw new Error("SQLITE_BUSY at /secret/path/db.sqlite");
    });
    const r = await call();
    expect(r.status).toBe(200);
    expect((r.body as JevApiPayload).active).toBe(true);
    // the failure is visible, with a fixed text (no path or SQLite message)
    expect((r.body as JevApiPayload).reconcile).toEqual({ error: "the outcome reconcile failed" });
    expect(JSON.stringify(r.body)).not.toContain("/secret/path");
  });

  it("is deterministic for a fixed clock", async () => {
    const a = await call();
    const b = await call();
    expect(b.body).toEqual(a.body);
  });
});

describe("GET /api/adjudicator/jev: degraded stays active", () => {
  beforeEach(() => {
    db.adjudicator.insert(jevRow());
    db.adjudicator.insert(
      jevRow({ source: "fallback", providerStatus: "no_key", providerModel: null, costUsd: null }),
    );
  });

  it("no key: active, effective provider is the heuristic, and the warning says why", async () => {
    const r = await call({}, deps({ env: {} }));
    const b = r.body as JevApiPayload;
    expect(r.status).toBe(200);
    expect(b.active).toBe(true);
    expect(b.provider).toMatchObject({
      configured: "typesafe",
      effective: "heuristic",
      degraded: "no_key",
    });
    expect(b.verdict.warnings.some((w) => w.includes("degraded (no_key)"))).toBe(true);
    expect(b.coverage.byClass.config).toBe(1);
  });

  it("no consent: active, and the warning says why", async () => {
    const r = await call({}, deps({ config: jevCfg({ remoteConsent: false }) }));
    const b = r.body as JevApiPayload;
    expect(b.active).toBe(true);
    expect(b.provider.degraded).toBe("no_consent");
    expect(b.provider.effective).toBe("heuristic");
    expect(b.verdict.warnings.some((w) => w.includes("degraded (no_consent)"))).toBe(true);
  });
});

// --- no secrets, no text ---------------------------------------------------------------------------------

describe("GET /api/adjudicator/jev: the payload holds no secrets and no text", () => {
  function everyKey(o: unknown, out: string[] = []): string[] {
    if (Array.isArray(o)) for (const v of o) everyKey(v, out);
    else if (o && typeof o === "object")
      for (const [k, v] of Object.entries(o)) {
        out.push(k);
        everyKey(v, out);
      }
    return out;
  }

  const variants: Array<[string, () => Promise<{ body: unknown }>]> = [
    ["active", () => call()],
    ["no key", () => call({}, deps({ env: {} }))],
    ["no consent", () => call({}, deps({ config: jevCfg({ remoteConsent: false }) }))],
    ["inactive", () => call({}, deps({ config: config() }))],
    ["since all", () => call({ since: "all" })],
  ];

  beforeEach(() => {
    for (let i = 0; i < 4; i++) db.adjudicator.insert(jevRow());
    db.adjudicator.insert(jevRow({ surface: "plan", runId: "R", taskId: 1, outcome: "pending" }));
    db.adjudicator.insert(
      jevRow({ source: "fallback", providerStatus: "timeout", providerLatencyMs: 1500 }),
    );
  });

  for (const [name, run] of variants) {
    it(`has no key, key mask, input text, input_head or note (${name})`, async () => {
      const { body } = await run();
      const text = JSON.stringify(body);
      expect(text).not.toContain(SENTINEL);
      expect(text).not.toContain("Zq9X");
      expect(text).not.toContain("sk-SENT");
      expect(text).not.toContain(PROMPT_MARKER);
      expect(text).not.toContain("refactor the auth module");
      expect(text).not.toContain(NOTE_MARKER);
      const names = everyKey(body);
      for (const forbidden of [
        "key",
        "keyMasked",
        "keySource",
        "keyEnv",
        "apiKey",
        "input_head",
        "inputHead",
        "input",
        "text",
        "prompt_text",
        "feedbackNote",
        "feedback_note",
        "baseUrl",
        "scores",
      ])
        expect(names, forbidden).not.toContain(forbidden);
      expect(names.filter((n) => /key|mask|secret|token/i.test(n))).toEqual([]);
    });
  }

  it("evidence rows hold only ids, tiers and a reason code", async () => {
    const b = (await call()).body as JevApiPayload;
    expect(b.outcomes.evidence.rows.length).toBeGreaterThan(0);
    for (const e of b.outcomes.evidence.rows)
      expect(Object.keys(e).sort()).toEqual(["code", "from", "id", "kind", "surface", "to", "ts"]);
  });

  it("the provider block names the provider and model but not the endpoint or key source", async () => {
    const b = (await call()).body as JevApiPayload;
    expect(Object.keys(b.provider).sort()).toEqual([
      "configured",
      "degraded",
      "effective",
      "health",
      "model",
    ]);
    expect(Object.keys(b.provider.health).sort()).toEqual(
      [
        "configured",
        "dailyCapUsd",
        "failures",
        "lastErrorAt",
        "lastErrorClass",
        "lastOkAt",
        "latency",
        "provider",
        "remote",
        "retryAt",
        "spendTodayUsd",
        "state",
      ].sort(),
    );
  });

  it("a stored row's scores JSON is never returned", async () => {
    const b = (await call()).body as JevApiPayload;
    const text = JSON.stringify(b);
    expect(text).not.toContain("complexityReasons");
    expect(text).not.toContain("heuristicComplexity");
    expect(text).not.toContain("entries");
  });
});
