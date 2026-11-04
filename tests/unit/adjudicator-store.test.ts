import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { Verdict } from "../../src/adjudicator/types.js";
import { SqliteAdapter } from "../../src/storage/sqlite/adapter.js";
import {
  ADJUDICATOR_LATE_COLUMNS,
  healAdjudicatorColumns,
  migrations,
} from "../../src/storage/sqlite/schema.js";
import type { AdjudicationInput } from "../../src/storage/types.js";
import { emPurge } from "../../src/tools/em_purge.js";

const TABLES = [
  "adjudications",
  "adjudicator_cache",
  "adjudicator_provider_state",
  "adjudicator_bias",
];

function tmpDb(prefix: string): string {
  return join(mkdtempSync(join(tmpdir(), prefix)), "eminiar.db");
}

function count(a: SqliteAdapter, table: string): number {
  return (a.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function row(over: Partial<AdjudicationInput> = {}): AdjudicationInput {
  return { surface: "agent", inputHash: "h", ...over };
}

const VERDICT = {
  key: "k1",
  source: "heuristic",
  provider: "heuristic",
  providerStatus: "n/a",
  complexity: 1.5,
  effort: "medium",
  version: "1",
} as unknown as Verdict;

describe("schema migration v8: adjudicator tables", () => {
  it("applies on top of a v7 database and is the latest version", () => {
    expect(migrations.find((m) => m.version === 8)).toBeTruthy();
    expect(migrations[migrations.length - 1]?.version).toBe(8);
    const path = tmpDb("em-v7-");
    const raw = new Database(path);
    for (const m of migrations) {
      if (m.version > 7) break;
      if (m.sql) raw.exec(m.sql);
      m.up?.(raw);
    }
    raw.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '7')").run();
    expect(
      raw.prepare("SELECT name FROM sqlite_master WHERE name = 'adjudications'").get(),
    ).toBeUndefined();
    raw.close();

    const a = new SqliteAdapter(path, { vectors: false });
    try {
      expect(a.metaGet("schema_version")).toBe("8");
      const names = (
        a.db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index')").all() as {
          name: string;
        }[]
      ).map((r) => r.name);
      for (const t of [
        ...TABLES,
        "adjudications_session",
        "adjudications_task",
        "adjudications_hash",
        "adjudications_ts",
        "adjudications_final",
      ])
        expect(names).toContain(t);
      // The v7 swarm ledger is still there and usable.
      expect(names).toContain("swarm_runs");
      expect(a.adjudicator.insert(row())).toBeGreaterThan(0);
      // The provider state carries the daily call count and the rejected-key fingerprint.
      const cols = (
        a.db.prepare("PRAGMA table_info(adjudicator_provider_state)").all() as { name: string }[]
      ).map((c) => c.name);
      expect(cols).toEqual(expect.arrayContaining(["calls", "auth_fingerprint"]));
    } finally {
      a.close();
    }
    // Reopening is a no-op.
    const again = new SqliteAdapter(path, { vectors: false });
    try {
      expect(again.metaGet("schema_version")).toBe("8");
      expect(count(again, "adjudications")).toBe(1);
    } finally {
      again.close();
    }
  });
});

describe("pre-release v8 databases (task #26)", () => {
  const colsOf = (db: Database.Database, table: string) =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

  /** The v8 DDL as it first ran on development machines: without the late columns. */
  function oldV8Sql(): string {
    let sql = migrations.find((m) => m.version === 8)!.sql!;
    for (const [, col, ddl] of ADJUDICATOR_LATE_COLUMNS) {
      sql = sql.replace(`  ${col} ${ddl},\n`, "").replace(`,\n  ${col} ${ddl}\n)`, "\n)");
    }
    return sql;
  }

  function oldV8Db(): string {
    const path = tmpDb("em-v8-old-");
    const raw = new Database(path);
    for (const m of migrations) {
      if (m.version > 7) break;
      if (m.sql) raw.exec(m.sql);
      m.up?.(raw);
    }
    raw.exec(oldV8Sql());
    raw.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '8')").run();
    for (const [table, col] of ADJUDICATOR_LATE_COLUMNS)
      expect(colsOf(raw, table)).not.toContain(col);
    raw
      .prepare(
        "INSERT INTO adjudicator_provider_state (provider, state, failures, spend_usd) VALUES ('openai', 'open', 2, 0.5)",
      )
      .run();
    raw
      .prepare("INSERT INTO adjudications (ts, surface, input_hash) VALUES (1, 'agent', 'old')")
      .run();
    raw.close();
    return path;
  }

  it("adds the missing v8 columns on first use, keeps the rows, and saves state again", () => {
    const path = oldV8Db();
    const a = new SqliteAdapter(path, { vectors: false });
    try {
      expect(a.metaGet("schema_version")).toBe("8");
      // Opening alone leaves the tables alone (a disabled adjudicator never touches them).
      expect(colsOf(a.db, "adjudications")).not.toContain("feedback_note");
      expect(a.adjudicator.providerState("openai")).toMatchObject({
        state: "open",
        failures: 2,
        calls: 0,
        authFingerprint: null,
      });
      for (const [table, col] of ADJUDICATOR_LATE_COLUMNS)
        expect(colsOf(a.db, table)).toContain(col);
      const saved = a.adjudicator.saveProviderState("openai", { calls: 3, authFingerprint: "fp1" });
      expect(saved).toMatchObject({ calls: 3, authFingerprint: "fp1", failures: 2 });
      expect(a.adjudicator.providerState("openai")).toMatchObject({
        calls: 3,
        authFingerprint: "fp1",
      });
      const id = a.adjudicator.insert(row({ feedbackNote: "kept" }));
      expect(a.adjudicator.get(id)?.feedbackNote).toBe("kept");
      expect(a.adjudicator.list().total).toBe(2);
    } finally {
      a.close();
    }
    const again = new SqliteAdapter(path, { vectors: false });
    try {
      expect(healAdjudicatorColumns(again.db)).toEqual([]);
      expect(again.adjudicator.providerState("openai")?.calls).toBe(3);
    } finally {
      again.close();
    }
  });

  it("heals idempotently and skips tables that do not exist yet", () => {
    const empty = new Database(":memory:");
    expect(healAdjudicatorColumns(empty)).toEqual([]);
    empty.close();
    const raw = new Database(oldV8Db());
    expect(healAdjudicatorColumns(raw)).toEqual([
      "adjudicator_provider_state.calls",
      "adjudicator_provider_state.auth_fingerprint",
      "adjudications.feedback_note",
      "adjudicator_provider_state.latency_budgets",
    ]);
    expect(healAdjudicatorColumns(raw)).toEqual([]);
    raw.close();
  });

  it("stores, clears and lists the feedback note on a fresh database", () => {
    const a = new SqliteAdapter(tmpDb("em-note-"), { vectors: false });
    try {
      const id = a.adjudicator.insert(row());
      expect(a.adjudicator.get(id)?.feedbackNote ?? null).toBeNull();
      expect(a.adjudicator.update(id, { feedbackNote: "needed opus" })).toBe(true);
      expect(a.adjudicator.get(id)?.feedbackNote).toBe("needed opus");
      expect(a.adjudicator.list().rows[0]?.feedbackNote).toBe("needed opus");
      a.adjudicator.update(id, { feedbackNote: null });
      expect(a.adjudicator.get(id)?.feedbackNote).toBeNull();
    } finally {
      a.close();
    }
  });
});

describe("SqliteAdjudicatorStore", () => {
  let a: SqliteAdapter;
  beforeEach(() => {
    a = new SqliteAdapter(tmpDb("em-adj-"), { vectors: false });
  });
  afterEach(() => a.close());

  it("insert defaults ts, outcome and final; get maps every column back", () => {
    const before = Date.now();
    const id = a.adjudicator.insert(
      row({
        sessionId: "s1",
        runId: "r1",
        taskId: 7,
        inputHead: "fix the bug",
        inputChars: 11,
        complexity: 1.25,
        tier: "haiku",
        effort: "low",
        tool: "Edit",
        role: "coder",
        confidence: 0.8,
        scores: '{"a":1}',
        source: "heuristic",
        provider: "heuristic",
        providerStatus: "n/a",
        latencyMs: 3,
        action: "advised",
        baselineModel: "opus",
      }),
    );
    const r = a.adjudicator.get(id)!;
    expect(r.id).toBe(id);
    expect(r.ts).toBeGreaterThanOrEqual(before);
    expect(r.outcome).toBe("pending");
    expect(r.final).toBe(false);
    expect(r).toMatchObject({
      surface: "agent",
      sessionId: "s1",
      runId: "r1",
      taskId: 7,
      inputHash: "h",
      inputHead: "fix the bug",
      complexity: 1.25,
      tier: "haiku",
      confidence: 0.8,
      scores: '{"a":1}',
      action: "advised",
      baselineModel: "opus",
      agentId: null,
      savingsUsd: null,
    });
    expect(a.adjudicator.get(id + 999)).toBeUndefined();
  });

  it("update patches only the given columns, null clears, unknown id is false", () => {
    const id = a.adjudicator.insert(row({ tier: "sonnet", role: "coder" }));
    expect(
      a.adjudicator.update(id, {
        outcome: "success",
        final: true,
        actualModel: "claude-sonnet-4-5",
        role: null,
        tier: undefined,
      }),
    ).toBe(true);
    const r = a.adjudicator.get(id)!;
    expect(r).toMatchObject({
      outcome: "success",
      final: true,
      actualModel: "claude-sonnet-4-5",
      role: null,
      tier: "sonnet",
    });
    expect(a.adjudicator.update(id, {})).toBe(true);
    expect(a.adjudicator.update(id + 1, { outcome: "failure" })).toBe(false);
  });

  it("list filters, orders newest first, pages and counts the total", () => {
    for (let i = 0; i < 6; i++)
      a.adjudicator.insert(
        row({
          ts: 1000 + i,
          surface: i % 2 ? "prompt" : "agent",
          provider: i < 3 ? "heuristic" : "typesafe",
          outcome: i === 5 ? "success" : "pending",
        }),
      );
    const all = a.adjudicator.list();
    expect(all.total).toBe(6);
    expect(all.rows.map((r) => r.ts)).toEqual([1005, 1004, 1003, 1002, 1001, 1000]);
    expect(a.adjudicator.list({ surface: "prompt" }).total).toBe(3);
    expect(a.adjudicator.list({ provider: "typesafe", surface: "agent" }).rows).toHaveLength(1);
    expect(a.adjudicator.list({ outcome: "success" }).rows[0]?.ts).toBe(1005);
    expect(a.adjudicator.list({ since: 1004 }).total).toBe(2);
    const page = a.adjudicator.list({ limit: 2, offset: 2 });
    expect(page.total).toBe(6);
    expect(page.rows.map((r) => r.ts)).toEqual([1003, 1002]);
  });

  it("latestForSession, forTask and nonFinal", () => {
    a.adjudicator.insert(row({ ts: 10, sessionId: "s", surface: "prompt", inputHash: "a" }));
    a.adjudicator.insert(row({ ts: 20, sessionId: "s", surface: "prompt", inputHash: "b" }));
    a.adjudicator.insert(row({ ts: 30, sessionId: "s", surface: "agent", inputHash: "c" }));
    a.adjudicator.insert(row({ ts: 40, sessionId: "t", surface: "prompt", inputHash: "d" }));
    expect(a.adjudicator.latestForSession("s", "prompt")?.inputHash).toBe("b");
    expect(a.adjudicator.latestForSession("nope", "prompt")).toBeUndefined();

    a.adjudicator.insert(row({ ts: 60, runId: "r", taskId: 1, surface: "agent", inputHash: "y" }));
    a.adjudicator.insert(row({ ts: 50, runId: "r", taskId: 1, surface: "plan", inputHash: "x" }));
    a.adjudicator.insert(row({ ts: 55, runId: "r", taskId: 2, inputHash: "z", final: true }));
    expect(a.adjudicator.forTask("r", 1).map((r) => r.inputHash)).toEqual(["x", "y"]);
    expect(a.adjudicator.forTask("r", 3)).toEqual([]);

    expect(a.adjudicator.nonFinal(100).map((r) => r.ts)).toEqual([10, 20, 30, 40, 50, 60]);
    expect(a.adjudicator.nonFinal(2).map((r) => r.ts)).toEqual([10, 20]);
    expect(a.adjudicator.nonFinal(100, 40).map((r) => r.ts)).toEqual([10, 20, 30]);
  });

  it("cache: put, hit counting, pending marker, max age and prune", () => {
    const s = a.adjudicator;
    expect(s.cacheGet("k1", 1000)).toBeUndefined();
    s.cachePut("k1", VERDICT, "heuristic", 1000);
    const hit = s.cacheGet("k1", 1500)!;
    expect(hit.verdict).toEqual(VERDICT);
    expect(hit).toMatchObject({ provider: "heuristic", createdAt: 1000, hits: 1, lastHitAt: 1500 });
    expect(s.cacheGet("k1", 1600)?.hits).toBe(2);
    // Expired by maxAge: a miss that does not bump.
    expect(s.cacheGet("k1", 5000, 1000)).toBeUndefined();
    expect(s.cacheGet("k1", 1700, 1000)?.hits).toBe(3);

    // The pending marker has no verdict and is not counted as a hit.
    s.cachePut("k2", null, "typesafe", 2000);
    const pending = s.cacheGet("k2", 2001)!;
    expect(pending.verdict).toBeNull();
    expect(pending.hits).toBe(0);
    // Replacing the marker with a verdict resets created_at and hits.
    s.cachePut("k2", VERDICT, "typesafe", 2100);
    expect(s.cacheGet("k2", 2200)).toMatchObject({ createdAt: 2100, hits: 1 });

    // Prune: TTL first, then LRU down to maxEntries.
    s.cachePut("old", VERDICT, "heuristic", 10);
    s.cachePut("k3", VERDICT, "heuristic", 3000);
    expect(s.cachePrune(10, 2500, 3000)).toBe(1);
    expect(s.cacheGet("old", 3000)).toBeUndefined();
    // Remaining: k1 (last hit 1700), k2 (last hit 2200), k3 (created 3000). Keep the 2 most recent.
    expect(s.cachePrune(2, 1_000_000, 3000)).toBe(1);
    expect(s.cacheGet("k1", 3000)).toBeUndefined();
    expect(s.cacheGet("k2", 3000)).toBeTruthy();
    expect(s.cacheGet("k3", 3000)).toBeTruthy();
  });

  it("provider state: defaults, merge, latency ring capped at 50", () => {
    const s = a.adjudicator;
    expect(s.providerState("typesafe")).toBeUndefined();
    const first = s.saveProviderState("typesafe", { failures: 1, lastErrorClass: "timeout" });
    expect(first).toMatchObject({
      provider: "typesafe",
      state: "closed",
      failures: 1,
      lastErrorClass: "timeout",
      latencies: [],
      spendUsd: 0,
      spendDay: null,
      calls: 0,
      authFingerprint: null,
    });
    s.saveProviderState("typesafe", {
      state: "open",
      retryAt: 9999,
      latencies: Array.from({ length: 60 }, (_, i) => i),
      spendDay: "2026-11-04",
      spendUsd: 0.0125,
    });
    const st = s.providerState("typesafe")!;
    expect(st).toMatchObject({
      state: "open",
      failures: 1,
      retryAt: 9999,
      lastErrorClass: "timeout",
      spendDay: "2026-11-04",
      spendUsd: 0.0125,
    });
    expect(st.latencies).toHaveLength(50);
    expect(st.latencies[0]).toBe(10);
    expect(st.latencies[49]).toBe(59);
    // Per-sample budgets round-trip and are never longer than the ring (aligned at the end).
    const withBudgets = s.saveProviderState("typesafe", {
      latencies: [1, 2],
      latencyBudgets: [800, 800, 3000],
    });
    expect(withBudgets.latencyBudgets).toEqual([800, 3000]);
    expect(s.providerState("typesafe")?.latencyBudgets).toEqual([800, 3000]);
    s.saveProviderState("typesafe", { latencies: Array.from({ length: 60 }, (_, i) => i) });
    // Daily calls and the auth lockout round-trip.
    s.saveProviderState("typesafe", {
      state: "auth_failed",
      calls: 7,
      authFingerprint: "0123456789ab",
    });
    expect(s.providerState("typesafe")).toMatchObject({
      state: "auth_failed",
      calls: 7,
      authFingerprint: "0123456789ab",
      spendUsd: 0.0125,
    });
    expect(s.saveProviderState("typesafe", { authFingerprint: null }).authFingerprint).toBeNull();
    // null clears a field; other providers are independent.
    expect(s.saveProviderState("typesafe", { retryAt: null }).retryAt).toBeNull();
    expect(s.providerState("openai-compatible")).toBeUndefined();
  });

  it("bias: upsert replaces by (dimension, bucket, option); reset clears only bias", () => {
    const s = a.adjudicator;
    s.biasUpsert({
      dimension: "tier",
      bucket: "c1",
      option: "haiku",
      n: 3,
      s: 2,
      f: 1,
      costMedian: 0.01,
      bias: 0.1,
      updatedAt: 5,
    });
    s.biasUpsert({
      dimension: "tier",
      bucket: "c1",
      option: "haiku",
      n: 4,
      s: 3,
      f: 1,
      costMedian: null,
      bias: 0.2,
    });
    s.biasUpsert({
      dimension: "role",
      bucket: "debug",
      option: "coder",
      n: 1,
      s: 1,
      f: 0,
      costMedian: null,
      bias: 0,
    });
    const all = s.biasAll();
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ dimension: "role", option: "coder" });
    expect(all[1]).toMatchObject({ dimension: "tier", n: 4, s: 3, costMedian: null, bias: 0.2 });
    expect(all[1]?.updatedAt).toBeGreaterThan(5);
    s.cachePut("k", VERDICT, "heuristic");
    expect(s.biasReset()).toBe(2);
    expect(s.biasAll()).toEqual([]);
    expect(count(a, "adjudicator_cache")).toBe(1);
  });

  it("summary: counts, p50/p95, rates, spend, savings and apply effectiveness", () => {
    const s = a.adjudicator;
    // 20 prompt rows with latency 1..20 ms; provider latency on the first 10 (100..1000).
    for (let i = 1; i <= 20; i++)
      s.insert(
        row({
          ts: 1000 + i,
          surface: "prompt",
          source: i <= 10 ? "blend" : "heuristic",
          providerStatus: i <= 10 ? "ok" : "n/a",
          latencyMs: i,
          providerLatencyMs: i <= 10 ? i * 100 : null,
          costUsd: i <= 10 ? 0.001 : null,
          action: "advised",
          outcome: "n/a",
        }),
      );
    // Advise-mode agent dispatches: 3 followed (2 with savings), 1 ignored.
    s.insert(row({ ts: 2001, action: "followed", savingsUsd: 0.5, source: "cache" }));
    s.insert(row({ ts: 2002, action: "followed", savingsUsd: 0.25 }));
    s.insert(row({ ts: 2003, action: "followed" }));
    s.insert(row({ ts: 2004, action: "ignored", providerStatus: "timeout", source: "fallback" }));
    // Apply-mode: 3 applied (one took effect, one did not, one not yet reconciled), 1 respected.
    s.insert(
      row({
        ts: 3001,
        action: "applied",
        modelFinal: "haiku",
        actualModel: "claude-haiku-4-5",
        savingsUsd: 1,
      }),
    );
    s.insert(
      row({ ts: 3002, action: "applied", modelFinal: "haiku", actualModel: "claude-opus-4-1" }),
    );
    s.insert(row({ ts: 3003, action: "applied", modelFinal: "sonnet" }));
    s.insert(row({ ts: 3004, action: "respected", modelRequested: "opus" }));

    const sum = s.summary();
    expect(sum.since).toBeNull();
    expect(sum.total).toBe(28);
    expect(sum.bySurface).toEqual({ prompt: 20, agent: 8 });
    expect(sum.bySource).toEqual({ blend: 10, heuristic: 10, cache: 1, fallback: 1, "(none)": 6 });
    expect(sum.byProviderStatus).toMatchObject({ ok: 10, "n/a": 10, timeout: 1 });
    expect(sum.byAction).toEqual({
      advised: 20,
      followed: 3,
      ignored: 1,
      applied: 3,
      respected: 1,
    });
    expect(sum.byOutcome).toEqual({ "n/a": 20, pending: 8 });
    expect(sum.latency).toEqual({ n: 20, p50: 10, p95: 19 });
    expect(sum.providerLatency).toEqual({ n: 10, p50: 500, p95: 1000 });
    expect(sum.rates.follow).toBeCloseTo(3 / 24);
    expect(sum.rates.apply).toBeCloseTo(3 / 4);
    expect(sum.rates.respect).toBeCloseTo(1 / 4);
    expect(sum.costUsd).toBeCloseTo(0.01);
    expect(sum.savingsUsd).toBeCloseTo(1.75);
    expect(sum.netUsd).toBeCloseTo(1.74);
    expect(sum.applyChecked).toBe(2);
    expect(sum.applyIneffective).toBe(1);

    const recent = s.summary(3000);
    expect(recent.since).toBe(3000);
    expect(recent.total).toBe(4);
    expect(recent.rates.follow).toBeNull();
    expect(recent.latency).toEqual({ n: 0, p50: null, p95: null });
    expect(recent.savingsUsd).toBeCloseTo(1);
  });

  it("an empty table summarises to zeros and null rates", () => {
    const sum = a.adjudicator.summary();
    expect(sum.total).toBe(0);
    expect(sum.rates).toEqual({ follow: null, apply: null, respect: null });
    expect(sum.costUsd).toBe(0);
    expect(sum.applyIneffective).toBe(0);
  });
});

describe("purge", () => {
  function seed(a: SqliteAdapter): void {
    a.adjudicator.insert(row());
    a.adjudicator.cachePut("k", VERDICT, "heuristic");
    a.adjudicator.saveProviderState("typesafe", { failures: 2 });
    a.adjudicator.biasUpsert({
      dimension: "tier",
      bucket: "c0",
      option: "haiku",
      n: 1,
      s: 1,
      f: 0,
      costMedian: null,
      bias: 0,
    });
    a.metaSet("adjudicator:eval:last", "{}");
  }

  it.each(["adjudicator", "all"] as const)("purge(%s) clears the four tables", (scope) => {
    const a = new SqliteAdapter(tmpDb("em-adj-purge-"), { vectors: false });
    try {
      seed(a);
      for (const t of TABLES) expect(count(a, t)).toBe(1);
      a.purge(scope);
      for (const t of TABLES) expect(count(a, t)).toBe(0);
    } finally {
      a.close();
    }
  });

  it("other scopes leave the adjudicator tables alone", () => {
    const a = new SqliteAdapter(tmpDb("em-adj-purge-"), { vectors: false });
    try {
      seed(a);
      for (const scope of ["index", "sessions", "graph", "memories", "usage"] as const)
        a.purge(scope);
      for (const t of TABLES) expect(count(a, t)).toBe(1);
    } finally {
      a.close();
    }
  });

  it("em_purge accepts the adjudicator scope", () => {
    const schema = z.object(emPurge.schema);
    expect(schema.parse({ scope: "adjudicator", confirm: true }).scope).toBe("adjudicator");
    expect(() => schema.parse({ scope: "bogus", confirm: true })).toThrow();
  });
});
