import type Database from "better-sqlite3";
import {
  DECISION_FEATURES,
  type DecisionCallInput,
  type DecisionCallRow,
  type DecisionFeature,
  type DecisionFeatureSummary,
  type DecisionStatus,
  type DecisionStore,
} from "../../decisions/types.js";

type Row = Record<string, unknown>;

/** decision_calls keeps the newest rows only; pruned in the insert transaction. */
export const DECISION_CALLS_KEEP = 5000;
/** decision_cache keeps at most this many rows. */
export const DECISION_CACHE_KEEP = 2000;
/** An undelivered advice note expires after this long. */
export const DECISION_NOTE_MAX_AGE_MS = 600_000;

const json = (v: unknown): string | null => (v === undefined ? null : JSON.stringify(v));
const parse = (s: unknown): unknown => {
  if (typeof s !== "string") return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? null;
}

function toRow(r: Row): DecisionCallRow {
  return {
    id: r.id as number,
    ts: r.ts as number,
    feature: r.feature as DecisionFeature,
    context: r.context as DecisionCallRow["context"],
    sessionId: (r.session_id as string | null) ?? null,
    subject: r.subject as string,
    mode: r.mode as "shadow" | "live",
    status: r.status as DecisionStatus,
    items: r.items as number,
    baseline: parse(r.baseline),
    provider: (r.provider as string | null) ?? null,
    answers: parse(r.answers),
    decision: parse(r.decision),
    changed: r.changed as number,
    applied: r.applied === 1,
    latencyMs: (r.latency_ms as number | null) ?? null,
    tokensIn: (r.tokens_in as number | null) ?? null,
    costUsd: (r.cost_usd as number | null) ?? null,
    model: (r.model as string | null) ?? null,
    exchangeId: (r.exchange_id as number | null) ?? null,
    note: (r.note as string | null) ?? null,
    noteSession: (r.note_session as string | null) ?? null,
    deliveredAt: (r.delivered_at as number | null) ?? null,
    feedback: (r.feedback as DecisionCallRow["feedback"]) ?? null,
  };
}

function emptySummary(): DecisionFeatureSummary {
  return {
    calls: 0,
    byStatus: {},
    shadow: 0,
    live: 0,
    ok: 0,
    agree: 0,
    changed: 0,
    applied: 0,
    costUsd: 0,
    p50Ms: null,
    p95Ms: null,
    helped: 0,
    hurt: 0,
  };
}

/** The decision feature store: calls log, answer cache and the advice outbox (migration v10). */
export class SqliteDecisionStore implements DecisionStore {
  private readonly stmts = new Map<string, Database.Statement<unknown[], unknown>>();

  constructor(private readonly db: Database.Database) {}

  private prep(sql: string): Database.Statement<unknown[], unknown> {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  insertCall(c: DecisionCallInput, keep = DECISION_CALLS_KEEP): number {
    const tx = this.db.transaction(() => {
      const info = this.prep(
        `INSERT INTO decision_calls (ts, feature, context, session_id, subject, mode, status, items,
           baseline, provider, answers, decision, changed, applied, latency_ms, tokens_in, cost_usd, model,
           exchange_id, note, note_session)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        c.ts,
        c.feature,
        c.context,
        c.sessionId ?? null,
        c.subject,
        c.mode,
        c.status,
        c.items ?? 0,
        json(c.baseline) ?? "null",
        c.provider ?? null,
        json(c.answers),
        json(c.decision),
        c.changed ?? 0,
        c.applied ? 1 : 0,
        c.latencyMs ?? null,
        c.tokensIn ?? null,
        c.costUsd ?? null,
        c.model ?? null,
        c.exchangeId ?? null,
        c.note ?? null,
        c.noteSession ?? null,
      );
      const id = Number(info.lastInsertRowid);
      this.prep("DELETE FROM decision_calls WHERE id <= ?").run(id - Math.max(1, keep));
      return id;
    });
    return tx();
  }

  callsToday(feature: DecisionFeature, now: number): number {
    const d = new Date(now);
    const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    // Only calls that reached the provider count towards the cap.
    const r = this.prep(
      `SELECT COUNT(*) AS n FROM decision_calls WHERE feature = ? AND ts >= ?
         AND status IN ('ok','partial','timeout','http_error','rate_limited','invalid')`,
    ).get(feature, start) as { n: number };
    return r.n;
  }

  countSince(feature: DecisionFeature, status: DecisionStatus, since: number): number {
    const r = this.prep(
      "SELECT COUNT(*) AS n FROM decision_calls WHERE feature = ? AND status = ? AND ts >= ?",
    ).get(feature, status, since) as { n: number };
    return r.n;
  }

  cacheGet(key: string, now: number, ttlMs: number): unknown | undefined {
    const r = this.prep("SELECT answers, created_at FROM decision_cache WHERE key = ?").get(key) as
      | { answers: string; created_at: number }
      | undefined;
    if (!r || now - r.created_at > ttlMs) return undefined;
    const v = parse(r.answers);
    return v === null ? undefined : v;
  }

  cachePut(key: string, feature: DecisionFeature, answers: unknown, now: number): void {
    this.prep(
      "INSERT OR REPLACE INTO decision_cache (key, feature, answers, created_at) VALUES (?, ?, ?, ?)",
    ).run(key, feature, JSON.stringify(answers), now);
    if (Math.random() < 1 / 50) this.cachePrune(DECISION_CACHE_KEEP);
  }

  cachePrune(max: number): number {
    return this.prep(
      `DELETE FROM decision_cache WHERE key NOT IN
         (SELECT key FROM decision_cache ORDER BY created_at DESC, key LIMIT ?)`,
    ).run(max).changes;
  }

  pendingNotes(
    sessionId: string,
    now: number,
    maxAgeMs = DECISION_NOTE_MAX_AGE_MS,
  ): Array<{ id: number; note: string }> {
    return this.prep(
      `SELECT id, note FROM decision_calls
         WHERE note IS NOT NULL AND note_session = ? AND delivered_at IS NULL AND ts >= ?
         ORDER BY id`,
    ).all(sessionId, now - maxAgeMs) as Array<{ id: number; note: string }>;
  }

  /** Atomically marks the pending notes delivered and returns them, so a note goes to one claimer only. */
  claimNotes(
    sessionId: string,
    now: number,
    maxAgeMs = DECISION_NOTE_MAX_AGE_MS,
  ): Array<{ id: number; note: string }> {
    const rows = this.prep(
      `UPDATE decision_calls SET delivered_at = ?
         WHERE note IS NOT NULL AND note_session = ? AND delivered_at IS NULL AND ts >= ?
         RETURNING id, note`,
    ).all(now, sessionId, now - maxAgeMs) as Array<{ id: number; note: string }>;
    return rows.sort((a, b) => a.id - b.id);
  }

  markDelivered(ids: number[], now: number): void {
    if (ids.length === 0) return;
    const mark = this.prep(
      "UPDATE decision_calls SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL",
    );
    this.db.transaction(() => {
      for (const id of ids) mark.run(now, id);
    })();
  }

  latestBySubject(
    feature: DecisionFeature,
    subjectPrefix: string,
    limit: number,
  ): DecisionCallRow[] {
    const esc = subjectPrefix.replace(/[\\%_]/g, (c) => `\\${c}`);
    return (
      this.prep(
        `SELECT * FROM decision_calls WHERE feature = ? AND subject LIKE ? ESCAPE '\\'
           ORDER BY id DESC LIMIT ?`,
      ).all(feature, `${esc}%`, Math.max(1, limit)) as Row[]
    ).map(toRow);
  }

  summary(o: { since?: number } = {}): Record<DecisionFeature, DecisionFeatureSummary> {
    const out = Object.fromEntries(DECISION_FEATURES.map((f) => [f, emptySummary()])) as Record<
      DecisionFeature,
      DecisionFeatureSummary
    >;
    const rows = this.prep(
      `SELECT feature, status, mode, changed, applied, latency_ms, cost_usd, feedback
         FROM decision_calls WHERE ts >= ?`,
    ).all(o.since ?? 0) as Row[];
    const lat = new Map<DecisionFeature, number[]>();
    for (const r of rows) {
      const f = r.feature as DecisionFeature;
      const s = out[f];
      if (!s) continue;
      s.calls++;
      const st = r.status as string;
      s.byStatus[st] = (s.byStatus[st] ?? 0) + 1;
      if (r.mode === "live") s.live++;
      else s.shadow++;
      if (st === "ok") {
        s.ok++;
        if (r.changed === 0) s.agree++;
      }
      if ((r.changed as number) > 0) s.changed++;
      if (r.applied === 1) s.applied++;
      s.costUsd += (r.cost_usd as number | null) ?? 0;
      if (st === "ok" && typeof r.latency_ms === "number") {
        const l = lat.get(f) ?? [];
        l.push(r.latency_ms);
        lat.set(f, l);
      }
      if (r.feedback === "helped") s.helped++;
      else if (r.feedback === "hurt") s.hurt++;
    }
    for (const [f, l] of lat) {
      l.sort((a, b) => a - b);
      out[f].p50Ms = percentile(l, 50);
      out[f].p95Ms = percentile(l, 95);
    }
    return out;
  }

  list(
    o: { feature?: DecisionFeature; limit?: number; beforeId?: number } = {},
  ): DecisionCallRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (o.feature) {
      where.push("feature = ?");
      params.push(o.feature);
    }
    if (o.beforeId !== undefined) {
      where.push("id < ?");
      params.push(o.beforeId);
    }
    const limit = Math.min(200, Math.max(1, o.limit ?? 50));
    return (
      this.prep(
        `SELECT * FROM decision_calls ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
           ORDER BY id DESC LIMIT ?`,
      ).all(...params, limit) as Row[]
    ).map(toRow);
  }

  feedback(id: number, v: "helped" | "hurt" | null): boolean {
    return this.prep("UPDATE decision_calls SET feedback = ? WHERE id = ?").run(v, id).changes > 0;
  }

  purge(): void {
    this.db.exec("DELETE FROM decision_calls; DELETE FROM decision_cache;");
  }
}
