/**
 * Reconcile and learning (docs/design/adjudicator.md §7.7, §13).
 *
 * reconcile(db, {limit}) links non-final adjudication rows to what happened afterwards:
 * - plan / agent rows of a swarm task take the task's status as their outcome and the
 *   worker's api_calls as their tokens;
 * - agent rows without a swarm task are linked best-effort to the first sidechain agent that
 *   starts within 60 s of the dispatch (outcome_source "link");
 * - prompt rows take the session's main-thread calls up to the next prompt row.
 * It reprices those calls at the baseline model (savings.ts), credits savings only for
 * followed or applied dispatches, charges a redone failed attempt its full cost, and on the
 * row's transition to final updates the learned bias buckets. Final rows are never touched
 * again, so re-runs are idempotent.
 *
 * Learning keeps decayed counts per bucket (tier: complexity bucket × tier; role: top intent ×
 * role) and turns them into a bounded additive bias with a Beta(2,2) prior:
 *   bias = clamp((s+2)/(n+4) − 0.8 − costWeight·log2(costMedian / bucket median), ±maxBias)
 * applied only when n ≥ minSamples. biasFor() returns it keyed "tier:<option>" /
 * "role:<option>" for blend; learning.enabled=false gives {}.
 */

import type { Config } from "../config.js";
import type { StorageAdapter } from "../storage/adapter.js";
import type { AdjudicationPatch, AdjudicatorBiasRow, ApiCallRow } from "../storage/types.js";
import type { TaskRow, WorkerRow } from "../swarm/types.js";
import type { PricingOverrides } from "../usage/pricing.js";
import { complexityBucket, topIntent } from "./heuristic.js";
import {
  actualCost,
  allRows,
  dominantModel,
  repriceAt,
  resolveBaseline,
  tierOf,
  totalTokens,
} from "./savings.js";
import { type AdjudicationOutcome, type AdjudicationRow, type Features, TIERS } from "./types.js";

// --- constants -----------------------------------------------------------------------

/** Rows younger than this are left alone: their dispatch may still be starting. */
export const SETTLE_MS = 2 * 60_000;
/** A row is final after this long, whatever is known by then. */
export const FINAL_AFTER_MS = 24 * 60 * 60_000;
/** A non-swarm agent's first call must start within this long after the dispatch row. */
export const LINK_WINDOW_MS = 60_000;
/** A linked non-swarm agent silent for this long is taken as finished. */
export const AGENT_IDLE_MS = 30 * 60_000;
/** Main-thread lookback for the session model at a dispatch (baseline step 2). */
const BASELINE_LOOKBACK_MS = 12 * 60 * 60_000;

export interface LearningConfig {
  enabled: boolean;
  maxBias: number;
  minSamples: number;
  halfLife: number;
  costWeight: number;
}

export const DEFAULT_LEARNING: Readonly<LearningConfig> = Object.freeze({
  enabled: true,
  maxBias: 0.3,
  minSamples: 5,
  halfLife: 50,
  costWeight: 0.05,
});

/** The parts of the full config reconcile reads; every field optional. */
export interface LearnConfigInput {
  adjudicator?:
    | { learning?: Partial<LearningConfig> | undefined; tiers?: readonly string[] | undefined }
    | undefined;
  usage?: { pricing?: Config["usage"]["pricing"] | undefined } | undefined;
}

function learningOf(
  explicit: Partial<LearningConfig> | undefined,
  config: LearnConfigInput | undefined,
): LearningConfig {
  return { ...DEFAULT_LEARNING, ...(config?.adjudicator?.learning ?? {}), ...(explicit ?? {}) };
}

// --- bias math -----------------------------------------------------------------------

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Multiplier applied to a bucket's counts on each update: 2^(−1/halfLife). */
export function decayFactor(halfLife: number): number {
  return halfLife > 0 && Number.isFinite(halfLife) ? 2 ** (-1 / halfLife) : 1;
}

/** Posterior success with a Beta(2,2) prior: (s+2)/(n+4). */
export function posterior(s: number, n: number): number {
  return (s + 2) / (n + 4);
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/**
 * The bias of one option: 0 below minSamples; otherwise (ŝ − 0.8) minus the cost term
 * costWeight·log2(costMedian / bucketMedian) (0 when either is unknown), clamped to ±maxBias.
 */
export function computeBias(
  row: Pick<AdjudicatorBiasRow, "n" | "s" | "costMedian">,
  bucketMedian: number | null,
  l: LearningConfig,
): number {
  if (!(row.n >= l.minSamples) || row.n <= 0) return 0;
  let b = posterior(row.s, row.n) - 0.8;
  if (row.costMedian && row.costMedian > 0 && bucketMedian && bucketMedian > 0)
    b -= l.costWeight * Math.log2(row.costMedian / bucketMedian);
  return clamp(b, -l.maxBias, l.maxBias);
}

/** Median of the options' cost medians within one (dimension, bucket). */
function bucketMedianOf(rows: readonly AdjudicatorBiasRow[]): number | null {
  return median(
    rows.map((r) => r.costMedian).filter((c): c is number => typeof c === "number" && c > 0),
  );
}

/**
 * Streaming median estimate: step towards the new sample by at most ×1.2 (never past it),
 * so one outlier cannot move the estimate far.
 */
export function stepMedian(current: number | null, sample: number): number {
  if (current === null || !(current > 0)) return sample;
  if (sample > current) return Math.min(sample, current * 1.2);
  if (sample < current) return Math.max(sample, current / 1.2);
  return current;
}

export interface BiasSignal {
  dimension: "tier" | "role";
  bucket: string;
  option: string;
  success: boolean;
  /** Actual cost of the success, feeds cost_median. */
  costUsd?: number | null | undefined;
}

/**
 * Decay and count one signal in its bucket, then recompute the stored bias of every option
 * in that bucket (the cost term depends on the bucket median). No-op when learning is off.
 */
export function recordSignal(
  db: StorageAdapter,
  sig: BiasSignal,
  learning: LearningConfig,
  now = Date.now(),
): void {
  if (!learning.enabled || !sig.option || !sig.bucket) return;
  const inBucket = db.adjudicator
    .biasAll()
    .filter((r) => r.dimension === sig.dimension && r.bucket === sig.bucket);
  let target = inBucket.find((r) => r.option === sig.option);
  if (!target) {
    target = {
      dimension: sig.dimension,
      bucket: sig.bucket,
      option: sig.option,
      n: 0,
      s: 0,
      f: 0,
      costMedian: null,
      bias: 0,
      updatedAt: null,
    };
    inBucket.push(target);
  }
  const d = decayFactor(learning.halfLife);
  target.n = target.n * d + 1;
  target.s = target.s * d + (sig.success ? 1 : 0);
  target.f = target.f * d + (sig.success ? 0 : 1);
  if (sig.success && typeof sig.costUsd === "number" && sig.costUsd > 0)
    target.costMedian = stepMedian(target.costMedian, sig.costUsd);
  target.updatedAt = now;
  const med = bucketMedianOf(inBucket);
  for (const r of inBucket) {
    const bias = computeBias(r, med, learning);
    if (r !== target && bias === r.bias) continue;
    r.bias = bias;
    db.adjudicator.biasUpsert({ ...r, updatedAt: r === target ? now : r.updatedAt });
  }
}

export interface BiasKey {
  /** Continuous complexity; bucketed with complexityBucket. */
  complexity?: number | null | undefined;
  /** Top intent of the request (role bucket). */
  intent?: string | null | undefined;
}

/** Pure form of biasFor over already-loaded bias rows. */
export function biasFromRows(
  rows: readonly AdjudicatorBiasRow[],
  learning: LearningConfig,
  key: BiasKey,
): Record<string, number> {
  const out: Record<string, number> = {};
  if (!learning.enabled) return out;
  const tierBucket =
    typeof key.complexity === "number" && Number.isFinite(key.complexity)
      ? String(complexityBucket(key.complexity))
      : undefined;
  const roleBucket = key.intent || "none";
  for (const [dimension, bucket] of [
    ["tier", tierBucket],
    ["role", roleBucket],
  ] as const) {
    if (bucket === undefined) continue;
    const inBucket = rows.filter((r) => r.dimension === dimension && r.bucket === bucket);
    const med = bucketMedianOf(inBucket);
    for (const r of inBucket) {
      const b = computeBias(r, med, learning);
      if (b !== 0) out[`${dimension}:${r.option}`] = b;
    }
  }
  return out;
}

/**
 * Learned additive biases for one request, keyed "tier:<option>" and "role:<option>", from
 * buckets with n ≥ minSamples. Empty when learning is disabled.
 */
export function biasFor(
  db: StorageAdapter,
  learning: Partial<LearningConfig> | undefined,
  key: BiasKey,
): Record<string, number> {
  const l = learningOf(learning, undefined);
  if (!l.enabled) return {};
  return biasFromRows(db.adjudicator.biasAll(), l, key);
}

// --- row helpers ---------------------------------------------------------------------

function parsedFeatures(row: Pick<AdjudicationRow, "scores">): Features | undefined {
  if (!row.scores) return undefined;
  try {
    const s = JSON.parse(row.scores) as { features?: Features } | null;
    return s && typeof s === "object" && s.features && typeof s.features === "object"
      ? s.features
      : undefined;
  } catch {
    return undefined;
  }
}

/** The (tier, role) buckets of a row: complexity bucket, and top intent ("none" without one). */
export function bucketsOf(row: Pick<AdjudicationRow, "complexity" | "scores">): {
  tier: string | undefined;
  role: string;
} {
  const tier =
    typeof row.complexity === "number" && Number.isFinite(row.complexity)
      ? String(complexityBucket(row.complexity))
      : undefined;
  const f = parsedFeatures(row);
  const intent = f?.intents && typeof f.intents === "object" ? topIntent(f) : undefined;
  return { tier, role: intent ?? "none" };
}

/** Patch holding only the fields whose value differs from the row. */
function diff(row: AdjudicationRow, patch: AdjudicationPatch): AdjudicationPatch {
  const out: AdjudicationPatch = {};
  for (const [k, v] of Object.entries(patch) as Array<[keyof AdjudicationPatch, unknown]>) {
    if (v === undefined) continue;
    const cur = (row as unknown as Record<string, unknown>)[k] ?? null;
    if (cur === (v ?? null)) continue;
    (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

// --- reconcile -----------------------------------------------------------------------

export interface ReconcileOptions {
  /** Rows to look at per run (oldest non-final first). Default 200. */
  limit?: number | undefined;
  now?: number | undefined;
  learning?: Partial<LearningConfig> | undefined;
  pricing?: PricingOverrides | undefined;
  /** The loaded config; learning and pricing are read from it when not passed explicitly. */
  config?: LearnConfigInput | undefined;
}

export interface ReconcileResult {
  scanned: number;
  updated: number;
  finalized: number;
  /** Non-swarm agent rows linked to a sidechain agent in this run. */
  linked: number;
  /** Bias signals recorded. */
  learned: number;
}

const CREDITED = new Set(["applied", "followed"]);

class Reconciler {
  readonly result: ReconcileResult = {
    scanned: 0,
    updated: 0,
    finalized: 0,
    linked: 0,
    learned: 0,
  };
  private readonly sessionCalls = new Map<string, ApiCallRow[]>();
  private readonly taskRows = new Map<string, AdjudicationRow[]>();
  private readonly runWorkers = new Map<string, WorkerRow[]>();
  private promptsBySession: Map<string, AdjudicationRow[]> | undefined;
  /** Agent ids already tied to an adjudication row. */
  private readonly taken = new Set<string>();
  private readonly latestCallTs: number | undefined;

  constructor(
    private readonly db: StorageAdapter,
    private readonly now: number,
    private readonly learning: LearningConfig,
    private readonly pricing: PricingOverrides | undefined,
    private readonly sessionsSince: Map<string, number>,
  ) {
    this.latestCallTs = db.apiCallsLatestTs();
  }

  /** Calls of a session from (its oldest pending row − lookback), loaded once per run. */
  private calls(sessionId: string): ApiCallRow[] {
    let c = this.sessionCalls.get(sessionId);
    if (!c) {
      const since = (this.sessionsSince.get(sessionId) ?? this.now) - BASELINE_LOOKBACK_MS;
      c = this.db.apiCalls({ sessionId, since });
      this.sessionCalls.set(sessionId, c);
    }
    return c;
  }

  private siblings(runId: string, taskId: number): AdjudicationRow[] {
    const k = `${runId}#${taskId}`;
    let r = this.taskRows.get(k);
    if (!r) {
      r = this.db.adjudicator.forTask(runId, taskId);
      this.taskRows.set(k, r);
    }
    return r;
  }

  private workers(runId: string): WorkerRow[] {
    let w = this.runWorkers.get(runId);
    if (!w) {
      w = this.db.swarm.workers(runId);
      this.runWorkers.set(runId, w);
    }
    return w;
  }

  private prompts(sessionId: string, since: number): AdjudicationRow[] {
    if (!this.promptsBySession) {
      const m = new Map<string, AdjudicationRow[]>();
      for (const p of allRows(this.db, { surface: "prompt", since })) {
        if (!p.sessionId) continue;
        const list = m.get(p.sessionId);
        if (list) list.push(p);
        else m.set(p.sessionId, [p]);
      }
      this.promptsBySession = m;
    }
    return this.promptsBySession.get(sessionId) ?? [];
  }

  /** Seed `taken` with the agent ids already on agent / plan rows near these rows. */
  seedTaken(since: number): void {
    for (const surface of ["agent", "plan"])
      for (const r of allRows(this.db, { surface, since: since - FINAL_AFTER_MS }))
        if (r.agentId) this.taken.add(r.agentId);
  }

  /** Commit a patch; on the transition to final, record the row's learning signals. */
  private commit(
    row: AdjudicationRow,
    patch: AdjudicationPatch,
    teach?: { tier?: string | undefined; role?: string | undefined } | undefined,
  ): void {
    if (
      patch.outcome &&
      patch.outcome !== "pending" &&
      row.outcomeTs == null &&
      patch.outcomeTs === undefined
    )
      patch.outcomeTs = this.now;
    const d = diff(row, patch);
    if (!Object.keys(d).length) return;
    this.db.adjudicator.update(row.id, d);
    this.result.updated++;
    if (d.final === true && !row.final) {
      this.result.finalized++;
      const outcome = (d.outcome ?? row.outcome) as AdjudicationOutcome;
      if (teach && (outcome === "success" || outcome === "failure"))
        this.teach(row, outcome === "success", teach, d.actualCostUsd ?? row.actualCostUsd);
    }
  }

  private teach(
    row: AdjudicationRow,
    success: boolean,
    what: { tier?: string | undefined; role?: string | undefined },
    cost: number | null | undefined,
  ): void {
    if (!this.learning.enabled) return;
    const b = bucketsOf(row);
    if (what.tier && b.tier !== undefined) {
      recordSignal(
        this.db,
        { dimension: "tier", bucket: b.tier, option: what.tier, success, costUsd: cost },
        this.learning,
        this.now,
      );
      this.result.learned++;
    }
    if (what.role) {
      recordSignal(
        this.db,
        { dimension: "role", bucket: b.role, option: what.role, success, costUsd: cost },
        this.learning,
        this.now,
      );
      this.result.learned++;
    }
  }

  /**
   * Actual model, tokens and cost of `calls`, the baseline and its cost, follow detection
   * and the credited savings. `calls` empty leaves the token fields alone.
   */
  private pricePatch(
    row: AdjudicationRow,
    calls: ApiCallRow[],
    sessionId: string | undefined,
    redone: boolean,
    outcome: AdjudicationOutcome,
  ): AdjudicationPatch {
    const patch: AdjudicationPatch = {};
    const baseline =
      row.baselineModel ??
      resolveBaseline(undefined, {
        sessionId,
        ts: row.ts,
        calls: sessionId ? this.calls(sessionId) : [],
      }).model;
    if (!row.baselineModel) patch.baselineModel = baseline;

    // Follow detection: the coordinator passed a model; compare it with the advice it saw.
    let action = row.action ?? null;
    if (action === "advised" && row.modelRequested) {
      const parent = row.parentId ? this.db.adjudicator.get(row.parentId) : undefined;
      const advice = parent?.tier ?? row.tier ?? undefined;
      const requested = tierOf(row.modelRequested) ?? row.modelRequested;
      if (advice && requested === advice) {
        if (advice !== (tierOf(baseline) ?? baseline)) action = "followed";
      } else if (advice) action = "ignored";
      if (action !== row.action) patch.action = action;
    }

    if (!calls.length) return patch;
    const actual = actualCost(calls, this.pricing);
    const base = repriceAt(calls, baseline, this.pricing);
    patch.actualModel = dominantModel(calls) ?? null;
    patch.actualTokens = totalTokens(calls);
    patch.actualCostUsd = actual;
    patch.baselineCostUsd = base;
    let savings: number | null = null;
    if (CREDITED.has(action ?? "")) {
      if (redone && outcome === "failure") savings = actual === null ? null : -actual;
      else if (actual !== null && base !== null) savings = base - actual;
    }
    patch.savingsUsd = savings;
    return patch;
  }

  /** Apply the redo penalty to earlier credited attempts of a task that already went final. */
  private penaliseEarlier(row: AdjudicationRow, sibs: AdjudicationRow[]): void {
    for (const e of sibs) {
      if (e.surface !== "agent" || e.id >= row.id || !e.final) continue;
      if (!CREDITED.has(e.action ?? "") || typeof e.actualCostUsd !== "number") continue;
      const patch: AdjudicationPatch = { savingsUsd: -e.actualCostUsd };
      if (e.outcome !== "failure") {
        // A later dispatch for the same task means this attempt did not hold. The bias
        // already counted it at finalisation; only the outcome label and savings change.
        patch.outcome = "failure";
        patch.outcomeSource = "redo";
      }
      const d = diff(e, patch);
      if (Object.keys(d).length) {
        this.db.adjudicator.update(e.id, d);
        Object.assign(e, d);
        this.result.updated++;
      }
    }
  }

  swarmRow(row: AdjudicationRow): void {
    const runId = row.runId as string;
    const taskId = row.taskId as number;
    const run = this.db.swarm.runGet(runId);
    const rawTask = this.db.swarm.taskGet(taskId);
    const task: TaskRow | undefined = rawTask && rawTask.run_id === runId ? rawTask : undefined;
    const sibs = this.siblings(runId, taskId);
    const later = sibs.find((s) => s.surface === "agent" && s.id > row.id);
    const redone = row.surface === "agent" && later !== undefined;
    const age = this.now - row.ts;

    let outcome: AdjudicationOutcome = "pending";
    let source = "swarm";
    if (redone) {
      outcome = "failure";
      source = "redo";
    } else if (task?.status === "done") outcome = "success";
    else if (task?.status === "failed" || task?.status === "blocked") outcome = "failure";
    else if (!task || (run && run.status !== "active")) outcome = "abandoned";
    if (outcome === "pending" && age >= FINAL_AFTER_MS) {
      outcome = "abandoned";
      source = "timeout";
    }

    // The worker that ran this attempt: for an agent row, the first worker of the task
    // spawned at or after the dispatch (and before the next attempt); else the task's agent.
    const workers = this.workers(runId).filter((w) => w.task_id === taskId);
    // Agents already tied to other attempts of this task are not this attempt's worker.
    const otherAttempts = new Set(
      sibs
        .filter((s) => s.surface === "agent" && s.id !== row.id && s.agentId)
        .map((s) => s.agentId),
    );
    let worker: WorkerRow | undefined;
    if (row.surface === "agent") {
      worker = workers
        .filter(
          (w) =>
            !otherAttempts.has(w.agent_id) &&
            w.spawned_at >= row.ts - 5_000 &&
            (!later || w.spawned_at < later.ts),
        )
        .sort((a, b) => a.spawned_at - b.spawned_at)[0];
    }
    const agentId =
      row.agentId ?? worker?.agent_id ?? (redone ? undefined : (task?.agent_id ?? undefined));
    if (!worker && agentId) worker = workers.find((w) => w.agent_id === agentId);
    if (agentId) this.taken.add(agentId);

    const sessionId = row.sessionId ?? run?.session_id ?? worker?.session_id ?? undefined;
    const calls =
      agentId && sessionId
        ? this.calls(sessionId).filter((c) => c.agent_id === agentId && c.ts >= row.ts - 5_000)
        : [];

    const patch: AdjudicationPatch = {
      ...this.pricePatch(row, calls, sessionId, redone, outcome),
      outcome,
      outcomeSource: outcome === "pending" ? row.outcomeSource : source,
    };
    if (agentId && !row.agentId) patch.agentId = agentId;

    // Final once the outcome is known and ingestion has caught up with the attempt's end:
    // the redo dispatch for a superseded attempt, else the task's last update.
    const settledAt = later?.ts ?? task?.updated_at ?? row.ts;
    const caughtUp =
      this.latestCallTs === undefined || this.latestCallTs >= settledAt || calls.length > 0;
    if (age >= FINAL_AFTER_MS || (outcome !== "pending" && caughtUp)) patch.final = true;

    // Learn from the dispatch; a plan row teaches only when no agent row tracks the task.
    const teaches = row.surface === "agent" || !sibs.some((s) => s.surface === "agent");
    const teach = teaches
      ? {
          tier: tierOf(patch.actualModel ?? row.actualModel),
          role: task?.role ?? worker?.role ?? undefined,
        }
      : undefined;
    this.commit(row, patch, teach);
    if (row.surface === "agent") this.penaliseEarlier(row, sibs);
  }

  agentRow(row: AdjudicationRow): void {
    const sessionId = row.sessionId ?? undefined;
    const age = this.now - row.ts;
    const all = sessionId ? this.calls(sessionId) : [];
    let agentId = row.agentId ?? undefined;
    let linkedNow = false;
    if (!agentId && sessionId) {
      const first = new Map<string, number>();
      for (const c of all) {
        if (!c.sidechain || !c.agent_id) continue;
        const t = first.get(c.agent_id);
        if (t === undefined || c.ts < t) first.set(c.agent_id, c.ts);
      }
      let best: [string, number] | undefined;
      for (const [id, t] of first) {
        if (this.taken.has(id) || t < row.ts || t > row.ts + LINK_WINDOW_MS) continue;
        if (!best || t < best[1]) best = [id, t];
      }
      if (best) {
        agentId = best[0];
        linkedNow = true;
        this.taken.add(agentId);
        this.result.linked++;
      }
    }
    const calls = agentId ? all.filter((c) => c.agent_id === agentId) : [];
    const patch: AdjudicationPatch = this.pricePatch(row, calls, sessionId, false, row.outcome);
    if (linkedNow) {
      patch.agentId = agentId;
      patch.outcomeSource = "link";
    }
    const last = calls.length ? (calls[calls.length - 1] as ApiCallRow).ts : undefined;
    const idle = last !== undefined && this.now - last >= AGENT_IDLE_MS;
    if (age >= FINAL_AFTER_MS || idle) {
      patch.final = true;
      if (row.outcome === "pending") patch.outcome = "n/a";
    }
    this.commit(row, patch);
  }

  promptRow(row: AdjudicationRow, promptsSince: number): void {
    const sessionId = row.sessionId ?? undefined;
    const age = this.now - row.ts;
    const patch: AdjudicationPatch = { outcome: "n/a", outcomeSource: "window" };
    let closed = false;
    if (sessionId) {
      const next = this.prompts(sessionId, promptsSince).find(
        (p) => p.ts > row.ts || (p.ts === row.ts && p.id > row.id),
      );
      const end = next?.ts ?? Number.POSITIVE_INFINITY;
      const calls = this.calls(sessionId).filter(
        (c) => !c.sidechain && c.ts >= row.ts && c.ts < end,
      );
      if (calls.length) {
        patch.actualModel = dominantModel(calls) ?? null;
        patch.actualTokens = totalTokens(calls);
        patch.actualCostUsd = actualCost(calls, this.pricing);
      }
      if (!row.baselineModel)
        patch.baselineModel = resolveBaseline(undefined, {
          sessionId,
          ts: row.ts,
          calls: this.calls(sessionId),
        }).model;
      // The window is complete once the next prompt exists and ingestion has reached it.
      closed =
        next !== undefined && (this.latestCallTs === undefined || this.latestCallTs >= next.ts);
    }
    if (closed || age >= FINAL_AFTER_MS || !sessionId) patch.final = true;
    // Main-session prompts never teach: there is no outcome to learn from.
    this.commit(row, patch);
  }

  otherRow(row: AdjudicationRow): void {
    this.commit(row, {
      outcome: row.outcome === "pending" ? "n/a" : row.outcome,
      final: true,
    });
  }
}

/**
 * Link outcomes, tokens and savings for up to `limit` non-final rows older than two minutes,
 * finalise what is settled (or 24 h old) and teach the bias buckets. Idempotent: final rows
 * are skipped and repeated runs over pending rows write the same values. One bad row never
 * stops the rest.
 */
export function reconcile(db: StorageAdapter, opts: ReconcileOptions = {}): ReconcileResult {
  const now = opts.now ?? Date.now();
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 10_000));
  const learning = learningOf(opts.learning, opts.config);
  const pricing = opts.pricing ?? (opts.config?.usage?.pricing as PricingOverrides | undefined);
  const rows = db.adjudicator.nonFinal(limit, now - SETTLE_MS);
  if (!rows.length) return { scanned: 0, updated: 0, finalized: 0, linked: 0, learned: 0 };

  const isSwarm = (r: AdjudicationRow) =>
    (r.surface === "agent" || r.surface === "plan") && !!r.runId && typeof r.taskId === "number";

  // Oldest pending row per session (swarm rows may borrow the run's session).
  const sessionsSince = new Map<string, number>();
  const note = (sid: string | null | undefined, ts: number) => {
    if (!sid) return;
    const cur = sessionsSince.get(sid);
    if (cur === undefined || ts < cur) sessionsSince.set(sid, ts);
  };
  for (const r of rows) {
    note(r.sessionId, r.ts);
    if (isSwarm(r) && !r.sessionId) note(db.swarm.runGet(r.runId as string)?.session_id, r.ts);
  }
  for (const w of rows.filter(isSwarm)) {
    // Worker rows may carry their own session id; include them so their calls load.
    for (const wk of db.swarm.workers(w.runId as string))
      if (wk.task_id === w.taskId) note(wk.session_id, w.ts);
  }

  const minTs = Math.min(...rows.map((r) => r.ts));
  const rec = new Reconciler(db, now, learning, pricing, sessionsSince);
  rec.seedTaken(minTs);
  rec.result.scanned = rows.length;

  // Swarm rows first: they claim their agent ids before best-effort linking runs.
  const ordered = [...rows.filter(isSwarm), ...rows.filter((r) => !isSwarm(r))];
  for (const row of ordered) {
    try {
      if (isSwarm(row)) rec.swarmRow(row);
      else if (row.surface === "agent") rec.agentRow(row);
      else if (row.surface === "prompt") rec.promptRow(row, minTs);
      else rec.otherRow(row);
    } catch {
      // Never let one row (or a locked DB) break reconcile for the rest.
    }
  }
  return rec.result;
}

// --- feedback ------------------------------------------------------------------------

export type Feedback = "good" | "too_small" | "too_big";

export const FEEDBACK_OUTCOME: Readonly<Record<Feedback, AdjudicationOutcome>> = Object.freeze({
  good: "success",
  too_small: "failure",
  too_big: "success",
});

export interface FeedbackOptions {
  now?: number | undefined;
  learning?: Partial<LearningConfig> | undefined;
  config?: LearnConfigInput | undefined;
  /** The tier ladder used for "next-lower tier"; default config.adjudicator.tiers or TIERS. */
  tiers?: readonly string[] | undefined;
}

/**
 * Explicit feedback on one decision: sets the outcome (outcome_source "feedback", final) and
 * teaches the bias. good = success for the tier (and role); too_small = failure for the tier;
 * too_big = success for the tier plus one success for the next-lower tier. The tier is the
 * one that actually ran when known, else the applied / requested / advised tier. Returns the
 * updated row, or undefined for an unknown id.
 */
export function applyFeedback(
  db: StorageAdapter,
  id: number,
  feedback: Feedback,
  opts: FeedbackOptions = {},
): AdjudicationRow | undefined {
  const row = db.adjudicator.get(id);
  if (!row) return undefined;
  const now = opts.now ?? Date.now();
  const learning = learningOf(opts.learning, opts.config);
  const outcome = FEEDBACK_OUTCOME[feedback];
  db.adjudicator.update(id, { outcome, outcomeSource: "feedback", outcomeTs: now, final: true });

  if (learning.enabled) {
    const b = bucketsOf(row);
    const tier =
      tierOf(row.actualModel) ??
      tierOf(row.modelFinal) ??
      tierOf(row.modelRequested) ??
      tierOf(row.tier) ??
      undefined;
    const cost = row.actualCostUsd;
    if (tier && b.tier !== undefined) {
      recordSignal(
        db,
        {
          dimension: "tier",
          bucket: b.tier,
          option: tier,
          success: outcome === "success",
          costUsd: cost,
        },
        learning,
        now,
      );
      if (feedback === "too_big") {
        const ladder = opts.tiers ?? opts.config?.adjudicator?.tiers ?? TIERS;
        const at = ladder.indexOf(tier);
        const lower = at > 0 ? ladder[at - 1] : undefined;
        if (lower)
          recordSignal(
            db,
            { dimension: "tier", bucket: b.tier, option: lower, success: true },
            learning,
            now,
          );
      }
    }
    if (feedback === "good" && row.role)
      recordSignal(
        db,
        { dimension: "role", bucket: b.role, option: row.role, success: true, costUsd: cost },
        learning,
        now,
      );
  }
  return db.adjudicator.get(id);
}
