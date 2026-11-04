import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_IDLE_MS,
  applyFeedback,
  biasFor,
  biasFromRows,
  computeBias,
  DEFAULT_LEARNING,
  decayFactor,
  FINAL_AFTER_MS,
  posterior,
  reconcile,
  recordSignal,
  stepMedian,
} from "../../src/adjudicator/learn.js";
import {
  FALLBACK_MODEL,
  isPinned,
  promptWindows,
  repriceAt,
  resolveBaseline,
  savingsReport,
  tierOf,
} from "../../src/adjudicator/savings.js";
import { SqliteAdapter } from "../../src/storage/sqlite/adapter.js";
import type { AdjudicationInput, ApiCallInput, ApiCallRow } from "../../src/storage/types.js";
import { costOfCall, resolvePrice } from "../../src/usage/pricing.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
let NOW = 0;
let seq = 0;
let db: SqliteAdapter;

function call(over: Partial<ApiCallInput> = {}): ApiCallInput {
  seq++;
  return {
    request_id: `r${seq}`,
    message_id: `m${seq}`,
    session_id: "S",
    agent_id: null,
    sidechain: 0,
    ts: NOW - 5 * MIN,
    model: "claude-opus-5-5",
    input_tokens: 1000,
    output_tokens: 500,
    cache_create_5m: 0,
    cache_create_1h: 0,
    cache_read: 0,
    thinking_tokens: 0,
    web_searches: 0,
    web_fetches: 0,
    service_tier: null,
    speed: null,
    stop_reason: null,
    prompt_id: null,
    git_branch: null,
    cwd: null,
    effort: null,
    version: null,
    entrypoint: null,
    ...over,
  };
}

function row(over: Partial<AdjudicationInput> = {}): number {
  return db.adjudicator.insert({
    surface: "agent",
    inputHash: "h",
    ts: NOW - 10 * MIN,
    sessionId: "S",
    complexity: 1.2,
    tier: "haiku",
    role: "coder",
    scores: JSON.stringify({ features: { intents: { implement: 1 } } }),
    ...over,
  });
}

// 1000 in / 500 out at list prices.
const OPUS = 0.004 + 0.01; // opus-5-5: $4 / $20
const HAIKU = 0.001 + 0.0025; // haiku alias → 4.5: $1 / $5
const SONNET = 0.002 + 0.005; // sonnet-5-5: $2 / $10

/** A run with one task claimed by `agent`, the task moved to `status`. */
function swarmTask(status: "done" | "failed" | "blocked" | "active", agent = "A1", runId = "R1") {
  if (!db.swarm.runGet(runId))
    db.swarm.runCreate({
      id: runId,
      swarm: "feature",
      goal: "g",
      topology: "hierarchical",
      session_id: "S",
    });
  const t = db.swarm.taskAdd({ run_id: runId, title: "t", role: "coder" });
  db.swarm.taskClaim(t.id, agent);
  db.swarm.workerUpsert({
    run_id: runId,
    agent_id: agent,
    agent_type: "swarm-feature-coder",
    role: "coder",
    session_id: "S",
    task_id: t.id,
  });
  if (status !== "active") db.swarm.taskUpdate(t.id, { status });
  return t.id;
}

beforeEach(() => {
  NOW = Date.now();
  seq = 0;
  db = new SqliteAdapter(join(mkdtempSync(join(tmpdir(), "em-learn-")), "eminiar.db"), {
    vectors: false,
  });
});
afterEach(() => db.close());

describe("savings: tiers, baseline, repricing", () => {
  it("maps model ids to tiers", () => {
    expect(tierOf("claude-opus-5-5[1m]")).toBe("opus");
    expect(tierOf("us.anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe("sonnet");
    expect(tierOf("claude-haiku-4-5")).toBe("haiku");
    expect(tierOf("claude-mythos-5-1")).toBe("fable");
    expect(tierOf("gpt-4o")).toBeUndefined();
    expect(tierOf(null)).toBeUndefined();
  });

  it("resolves the baseline: pinned, then session model at ts, then the fallback", () => {
    expect(isPinned("inherit")).toBe(false);
    expect(isPinned("")).toBe(false);
    expect(isPinned("opus")).toBe(true);
    db.apiCallsUpsert([
      call({ ts: NOW - 30 * MIN, model: "claude-sonnet-5-5" }),
      call({ ts: NOW - 20 * MIN, model: "claude-opus-5-5" }),
      call({ ts: NOW - 15 * MIN, model: "claude-haiku-4-5", sidechain: 1, agent_id: "X" }),
      call({ ts: NOW - 5 * MIN, model: "claude-haiku-4-5" }),
    ]);
    const ts = NOW - 10 * MIN;
    expect(resolveBaseline(db, { pinned: "sonnet", sessionId: "S", ts })).toEqual({
      model: "sonnet",
      source: "pinned",
    });
    // inherit is not pinned; the latest main-thread call before ts wins (sidechain and later ignored).
    expect(resolveBaseline(db, { pinned: "inherit", sessionId: "S", ts })).toEqual({
      model: "claude-opus-5-5",
      source: "session",
    });
    expect(resolveBaseline(db, { sessionId: "other", ts })).toEqual({
      model: FALLBACK_MODEL,
      source: "fallback",
    });
    expect(resolveBaseline(db, { ts })).toEqual({ model: FALLBACK_MODEL, source: "fallback" });
  });

  it("reprices the same token vector through usage pricing, honouring overrides", () => {
    const c = {
      ...call({ cache_read: 10_000, cache_create_1h: 2000 }),
      cost_usd: null,
      priced: 0,
    } as ApiCallRow;
    const expected = costOfCall(c, resolvePrice("claude-sonnet-5-5") as never).total;
    expect(repriceAt([c], "claude-sonnet-5-5")).toBeCloseTo(expected, 12);
    expect(repriceAt([c], "sonnet")).toBeCloseTo(expected, 12);
    expect(repriceAt([c], "sonnet", { sonnet: { input: 100, output: 100 } })).toBeGreaterThan(
      expected,
    );
    expect(repriceAt([c], "unknown-model-9")).toBeNull();
  });

  it("splits main-thread calls into prompt windows", () => {
    const prompts = [
      { id: 1, ts: 100, sessionId: "S" },
      { id: 2, ts: 200, sessionId: "S" },
      { id: 3, ts: 150, sessionId: "T" },
    ];
    const mk = (ts: number, session = "S", sidechain = 0) =>
      ({
        ...call({ ts, session_id: session, sidechain }),
        cost_usd: null,
        priced: 0,
      }) as ApiCallRow;
    const w = promptWindows(prompts, [
      mk(50),
      mk(100),
      mk(150),
      mk(199),
      mk(200),
      mk(250),
      mk(160, "S", 1),
      mk(160, "T"),
    ]);
    expect(w.get(1)?.map((c) => c.ts)).toEqual([100, 150, 199]);
    expect(w.get(2)?.map((c) => c.ts)).toEqual([200, 250]);
    expect(w.get(3)?.map((c) => c.ts)).toEqual([160]);
  });
});

describe("reconcile: swarm outcomes", () => {
  it("maps task status to outcome and links the worker's tokens", () => {
    const done = swarmTask("done", "A1");
    const failed = swarmTask("failed", "A2");
    const blocked = swarmTask("blocked", "A3");
    db.apiCallsUpsert([
      call({ agent_id: "A1", sidechain: 1, model: "claude-haiku-4-5" }),
      call({ agent_id: "A1", sidechain: 1, model: "claude-haiku-4-5" }),
      call({ agent_id: "A2", sidechain: 1 }),
      call({ agent_id: "A3", sidechain: 1 }),
    ]);
    const a = row({ runId: "R1", taskId: done, action: "advised" });
    const b = row({ runId: "R1", taskId: failed });
    const c = row({ runId: "R1", taskId: blocked });
    const res = reconcile(db, { now: NOW });
    expect(res.scanned).toBe(3);
    expect(res.finalized).toBe(3);
    const ra = db.adjudicator.get(a);
    expect(ra).toMatchObject({
      outcome: "success",
      outcomeSource: "swarm",
      agentId: "A1",
      actualModel: "claude-haiku-4-5",
      actualTokens: 3000,
      final: true,
    });
    expect(ra?.actualCostUsd).toBeCloseTo(2 * HAIKU, 10);
    expect(ra?.outcomeTs).toBe(NOW);
    // Advised (not followed or applied) earns no credit.
    expect(ra?.savingsUsd ?? null).toBeNull();
    expect(db.adjudicator.get(b)).toMatchObject({ outcome: "failure", agentId: "A2", final: true });
    expect(db.adjudicator.get(c)).toMatchObject({ outcome: "failure", agentId: "A3", final: true });
  });

  it("waits on an active task, and abandons it once the run finishes", () => {
    const t = swarmTask("active");
    const id = row({ runId: "R1", taskId: t, surface: "plan" });
    reconcile(db, { now: NOW });
    expect(db.adjudicator.get(id)).toMatchObject({ outcome: "pending", final: false });
    db.swarm.runUpdate("R1", { status: "done" });
    reconcile(db, { now: NOW });
    expect(db.adjudicator.get(id)).toMatchObject({ outcome: "abandoned", final: true });
  });

  it("finalises after 24 h whatever is known", () => {
    const t = swarmTask("active");
    const swarmRow = row({ runId: "R1", taskId: t, ts: NOW - FINAL_AFTER_MS - MIN });
    const plain = row({ ts: NOW - FINAL_AFTER_MS - MIN });
    const tool = row({ surface: "mcp" });
    reconcile(db, { now: NOW });
    expect(db.adjudicator.get(swarmRow)).toMatchObject({
      outcome: "abandoned",
      outcomeSource: "timeout",
      final: true,
    });
    expect(db.adjudicator.get(plain)).toMatchObject({ outcome: "n/a", final: true });
    expect(db.adjudicator.get(tool)).toMatchObject({ outcome: "n/a", final: true });
  });

  it("leaves rows younger than two minutes alone", () => {
    const id = row({ surface: "mcp", ts: NOW - MIN });
    expect(reconcile(db, { now: NOW }).scanned).toBe(0);
    expect(db.adjudicator.get(id)?.final).toBe(false);
  });

  it("keeps a done task open while usage ingestion lags behind it", () => {
    const t = swarmTask("done");
    db.apiCallsUpsert([call({ ts: NOW - HOUR })]); // ingestion stopped an hour ago
    const id = row({ runId: "R1", taskId: t });
    reconcile(db, { now: NOW });
    expect(db.adjudicator.get(id)).toMatchObject({ outcome: "success", final: false });
    db.apiCallsUpsert([call({ agent_id: "A1", sidechain: 1, ts: NOW + 1000 })]);
    reconcile(db, { now: NOW + 2000 });
    expect(db.adjudicator.get(id)).toMatchObject({
      outcome: "success",
      final: true,
      actualTokens: 1500,
    });
  });
});

describe("reconcile: best-effort agent linking", () => {
  it("links the first sidechain agent starting within 60 s and skips taken ones", () => {
    const ts = NOW - 20 * MIN;
    db.apiCallsUpsert([
      call({ agent_id: "late", sidechain: 1, ts: ts + 90_000 }),
      call({ agent_id: "early", sidechain: 1, ts: ts + 30_000, model: "claude-sonnet-5-5" }),
      call({ agent_id: "before", sidechain: 1, ts: ts - 1000 }),
    ]);
    const a = row({ ts });
    const b = row({ ts: ts + 1 });
    const res = reconcile(db, { now: NOW });
    expect(res.linked).toBe(1);
    expect(db.adjudicator.get(a)).toMatchObject({
      agentId: "early",
      outcomeSource: "link",
      actualModel: "claude-sonnet-5-5",
      actualTokens: 1500,
      // The agent has been idle for well under 30 min: still open for more calls / feedback.
      final: false,
    });
    // "late" starts 90 s after b: outside the window. "early" is taken.
    expect(db.adjudicator.get(b)?.agentId ?? null).toBeNull();
    // Once the linked agent is idle, the row closes with outcome n/a.
    reconcile(db, { now: ts + 30_000 + AGENT_IDLE_MS + MIN });
    expect(db.adjudicator.get(a)).toMatchObject({ outcome: "n/a", final: true });
  });
});

describe("reconcile: prompt windows", () => {
  it("takes the main-thread calls up to the next prompt row", () => {
    const p1 = row({ surface: "prompt", ts: NOW - 30 * MIN, tier: "haiku" });
    const p2 = row({ surface: "prompt", ts: NOW - 20 * MIN });
    db.apiCallsUpsert([
      call({ ts: NOW - 29 * MIN }),
      call({ ts: NOW - 25 * MIN }),
      call({ ts: NOW - 24 * MIN, sidechain: 1, agent_id: "Z" }), // not main thread
      call({ ts: NOW - 19 * MIN, model: "claude-sonnet-5-5" }),
    ]);
    reconcile(db, { now: NOW });
    const r1 = db.adjudicator.get(p1);
    expect(r1).toMatchObject({
      outcome: "n/a",
      outcomeSource: "window",
      actualTokens: 3000,
      final: true,
    });
    expect(r1?.actualCostUsd).toBeCloseTo(2 * OPUS, 10);
    expect(r1?.savingsUsd ?? null).toBeNull();
    // The last prompt's window is still open until the next prompt or 24 h.
    expect(db.adjudicator.get(p2)).toMatchObject({ actualTokens: 1500, final: false });
    expect(db.adjudicator.get(p2)?.actualCostUsd).toBeCloseTo(SONNET, 10);
    // Prompts never teach.
    expect(db.adjudicator.biasAll()).toEqual([]);
  });
});

describe("reconcile: savings credit", () => {
  it("credits applied dispatches: baseline repriced minus actual", () => {
    const t = swarmTask("done");
    db.apiCallsUpsert([call({ agent_id: "A1", sidechain: 1, model: "claude-haiku-4-5" })]);
    const id = row({
      runId: "R1",
      taskId: t,
      action: "applied",
      modelFinal: "haiku",
      baselineModel: "claude-opus-5-5",
    });
    reconcile(db, { now: NOW });
    const r = db.adjudicator.get(id);
    expect(r?.baselineCostUsd).toBeCloseTo(OPUS, 10);
    expect(r?.actualCostUsd).toBeCloseTo(HAIKU, 10);
    expect(r?.savingsUsd).toBeCloseTo(OPUS - HAIKU, 10);
  });

  it("detects followed advice (requested = advice ≠ baseline) and credits it; ignored is not", () => {
    // Baseline from the session: main thread runs opus before the dispatch.
    db.apiCallsUpsert([call({ ts: NOW - 40 * MIN })]);
    const t1 = swarmTask("done", "F1");
    const t2 = swarmTask("done", "I1");
    db.apiCallsUpsert([
      call({ agent_id: "F1", sidechain: 1, model: "claude-haiku-4-5" }),
      call({ agent_id: "I1", sidechain: 1, model: "claude-sonnet-5-5" }),
    ]);
    const plan = row({
      surface: "plan",
      runId: "R1",
      taskId: t1,
      tier: "haiku",
      action: "advised",
    });
    const followed = row({
      runId: "R1",
      taskId: t1,
      parentId: plan,
      action: "advised",
      modelRequested: "haiku",
    });
    const ignored = row({
      runId: "R1",
      taskId: t2,
      action: "advised",
      tier: "haiku",
      modelRequested: "sonnet",
    });
    reconcile(db, { now: NOW });
    const f = db.adjudicator.get(followed);
    expect(f).toMatchObject({ action: "followed", baselineModel: "claude-opus-5-5" });
    expect(f?.savingsUsd).toBeCloseTo(OPUS - HAIKU, 10);
    const i = db.adjudicator.get(ignored);
    expect(i?.action).toBe("ignored");
    expect(i?.savingsUsd ?? null).toBeNull();
    // The plan row is advice only.
    expect(db.adjudicator.get(plan)?.savingsUsd ?? null).toBeNull();
  });

  it("charges a redone failed attempt its full cost", () => {
    const t = swarmTask("active", "A1");
    db.apiCallsUpsert([
      call({ agent_id: "A1", sidechain: 1, model: "claude-haiku-4-5", ts: NOW - 9 * MIN }),
    ]);
    const first = row({
      runId: "R1",
      taskId: t,
      action: "applied",
      baselineModel: "claude-opus-5-5",
      ts: NOW - 10 * MIN,
    });
    // Attempt fails and is finalised before the redo exists.
    db.swarm.taskUpdate(t, { status: "failed" });
    reconcile(db, { now: NOW });
    expect(db.adjudicator.get(first)?.final).toBe(true);
    expect(db.adjudicator.get(first)?.savingsUsd).toBeCloseTo(OPUS - HAIKU, 10);
    // Redo: a second dispatch for the same task by a new worker.
    db.swarm.taskUpdate(t, { status: "done", agent_id: "A2" });
    db.swarm.workerUpsert({
      run_id: "R1",
      agent_id: "A2",
      agent_type: "x",
      role: "coder",
      session_id: "S",
      task_id: t,
    });
    db.apiCallsUpsert([
      call({ agent_id: "A2", sidechain: 1, model: "claude-opus-5-5", ts: NOW - 2 * MIN }),
    ]);
    const second = row({
      runId: "R1",
      taskId: t,
      action: "advised",
      ts: NOW - 4 * MIN,
      baselineModel: "claude-opus-5-5",
    });
    reconcile(db, { now: NOW });
    const f = db.adjudicator.get(first);
    expect(f).toMatchObject({ outcome: "failure" });
    expect(f?.savingsUsd).toBeCloseTo(-HAIKU, 10);
    expect(db.adjudicator.get(second)).toMatchObject({
      outcome: "success",
      agentId: "A2",
      final: true,
    });
  });

  it("labels an earlier attempt reconciled after its redo as a redo failure", () => {
    const t = swarmTask("done", "A2");
    db.swarm.workerUpsert({
      run_id: "R1",
      agent_id: "A0",
      agent_type: "x",
      role: "coder",
      session_id: "S",
      task_id: t,
    });
    db.apiCallsUpsert([call({ agent_id: "A2", sidechain: 1 })]);
    const first = row({
      runId: "R1",
      taskId: t,
      ts: NOW - 30 * MIN,
      action: "applied",
      agentId: "A0",
    });
    const second = row({ runId: "R1", taskId: t, ts: NOW - 10 * MIN });
    reconcile(db, { now: NOW });
    expect(db.adjudicator.get(first)).toMatchObject({
      outcome: "failure",
      outcomeSource: "redo",
      final: true,
    });
    expect(db.adjudicator.get(second)).toMatchObject({ outcome: "success", agentId: "A2" });
  });
});

describe("savingsReport", () => {
  it("nets credited savings against the adjudicator's spend and keeps potential separate", () => {
    const t = swarmTask("done");
    db.apiCallsUpsert([call({ agent_id: "A1", sidechain: 1, model: "claude-haiku-4-5" })]);
    row({
      runId: "R1",
      taskId: t,
      action: "applied",
      baselineModel: "claude-opus-5-5",
      costUsd: 0.001,
    });
    // A prompt where haiku was advised but opus ran: potential only.
    row({ surface: "prompt", ts: NOW - 50 * MIN, tier: "haiku", costUsd: 0.0005 });
    row({ surface: "prompt", ts: NOW - 40 * MIN, tier: "opus" });
    db.apiCallsUpsert([call({ ts: NOW - 45 * MIN }), call({ ts: NOW - 35 * MIN })]);
    row({ surface: "mcp", costUsd: 0.0002 });
    reconcile(db, { now: NOW });
    const rep = savingsReport(db);
    expect(rep.usageAvailable).toBe(true);
    expect(rep.realisedUsd).toBeCloseTo(OPUS - HAIKU, 10);
    expect(rep.creditedRows).toBe(1);
    expect(rep.spendUsd).toBeCloseTo(0.0017, 10);
    expect(rep.netUsd).toBeCloseTo(OPUS - HAIKU - 0.0017, 10);
    expect(rep.potentialRows).toBe(1);
    expect(rep.potentialUsd).toBeCloseTo(OPUS - HAIKU, 10);
    expect(rep.tokensPerSuccessByTier.haiku).toMatchObject({
      tasks: 1,
      tokens: 1500,
      tokensPerTask: 1500,
    });
    expect(rep.matrix).toContainEqual({ suggested: "haiku", actual: "haiku", n: 1 });
    expect(rep.assumptions.length).toBeGreaterThanOrEqual(5);
    // The store's summary agrees on realised and net.
    const s = db.adjudicator.summary();
    expect(s.savingsUsd).toBeCloseTo(rep.realisedUsd, 10);
    expect(s.netUsd).toBeCloseTo(rep.netUsd, 10);
  });

  it("says so when no usage is recorded", () => {
    row({ surface: "mcp" });
    const rep = savingsReport(db);
    expect(rep.usageAvailable).toBe(false);
    expect(rep.assumptions.some((a) => a.includes("No API calls"))).toBe(true);
  });
});

describe("learning: bias math", () => {
  const L = { ...DEFAULT_LEARNING };

  it("uses a Beta(2,2) posterior and halfLife decay", () => {
    expect(posterior(0, 0)).toBe(0.5);
    expect(posterior(10, 10)).toBeCloseTo(12 / 14, 12);
    expect(decayFactor(50) ** 50).toBeCloseTo(0.5, 12);
    expect(decayFactor(0)).toBe(1);
  });

  it("is zero below minSamples, clamps to ±maxBias, and penalises cost", () => {
    expect(computeBias({ n: 4, s: 4, costMedian: null }, null, L)).toBe(0);
    // n=5 all good: 7/9 − 0.8
    expect(computeBias({ n: 5, s: 5, costMedian: null }, null, L)).toBeCloseTo(7 / 9 - 0.8, 12);
    // n=20 all failures: 2/24 − 0.8 → clamped at −0.3
    expect(computeBias({ n: 20, s: 0, costMedian: null }, null, L)).toBe(-0.3);
    // n=1000 all good: 1002/1004 − 0.8 ≈ 0.198 → clamped at +0.1
    expect(computeBias({ n: 1000, s: 1000, costMedian: null }, null, { ...L, maxBias: 0.1 })).toBe(
      0.1,
    );
    // Twice the bucket's median cost costs costWeight · log2(2).
    const base = computeBias({ n: 10, s: 10, costMedian: 1 }, 1, L);
    const pricey = computeBias({ n: 10, s: 10, costMedian: 2 }, 1, L);
    expect(base - pricey).toBeCloseTo(L.costWeight, 12);
  });

  it("steps the cost median by at most ×1.2 and never past the sample", () => {
    expect(stepMedian(null, 3)).toBe(3);
    expect(stepMedian(1, 10)).toBeCloseTo(1.2, 12);
    expect(stepMedian(1, 1.1)).toBe(1.1);
    expect(stepMedian(1, 0.1)).toBeCloseTo(1 / 1.2, 12);
  });

  it("records decayed counts and exposes biases keyed by dimension once n ≥ minSamples", () => {
    for (let i = 0; i < 4; i++)
      recordSignal(db, { dimension: "tier", bucket: "1", option: "haiku", success: false }, L, NOW);
    expect(biasFor(db, L, { complexity: 1.2, intent: "implement" })).toEqual({});
    recordSignal(db, { dimension: "tier", bucket: "1", option: "haiku", success: false }, L, NOW);
    const [r] = db.adjudicator.biasAll();
    const d = decayFactor(L.halfLife);
    // Five updates: n = 1 + d + d² + d³ + d⁴.
    expect(r?.n).toBeCloseTo(1 + d + d ** 2 + d ** 3 + d ** 4, 12);
    expect(r?.f).toBeCloseTo(r?.n ?? 0, 12);
    expect(r?.s).toBe(0);
    expect(r?.n).toBeLessThan(5);
    // Decay keeps n under the raw count; minSamples needs a sixth signal here.
    recordSignal(db, { dimension: "tier", bucket: "1", option: "haiku", success: false }, L, NOW);
    const bias = biasFor(db, L, { complexity: 1.2, intent: "implement" });
    expect(bias["tier:haiku"]).toBeLessThan(0);
    expect(bias["tier:haiku"]).toBeGreaterThanOrEqual(-L.maxBias);
    // Other complexity buckets and the role dimension are untouched.
    expect(biasFor(db, L, { complexity: 3 })).toEqual({});
    expect(biasFor(db, { enabled: false }, { complexity: 1.2 })).toEqual({});
    expect(
      biasFromRows(db.adjudicator.biasAll(), { ...L, enabled: false }, { complexity: 1.2 }),
    ).toEqual({});
  });

  it("does nothing when learning is disabled", () => {
    recordSignal(
      db,
      { dimension: "tier", bucket: "1", option: "haiku", success: true },
      { ...L, enabled: false },
    );
    expect(db.adjudicator.biasAll()).toEqual([]);
    const t = swarmTask("done");
    db.apiCallsUpsert([call({ agent_id: "A1", sidechain: 1, model: "claude-haiku-4-5" })]);
    row({ runId: "R1", taskId: t });
    reconcile(db, { now: NOW, config: { adjudicator: { learning: { enabled: false } } } });
    expect(db.adjudicator.biasAll()).toEqual([]);
  });
});

describe("learning: reconcile signals and idempotency", () => {
  it("credits the tier that actually ran and the task's role, once", () => {
    const t = swarmTask("done");
    db.apiCallsUpsert([call({ agent_id: "A1", sidechain: 1, model: "claude-sonnet-5-5" })]);
    // Advised haiku, but sonnet ran: sonnet gets the credit.
    row({ surface: "plan", runId: "R1", taskId: t, tier: "haiku" });
    row({ runId: "R1", taskId: t, tier: "haiku" });
    const first = reconcile(db, { now: NOW });
    expect(first.learned).toBe(2);
    const bias = db.adjudicator.biasAll();
    expect(bias.map((b) => `${b.dimension}/${b.bucket}/${b.option}/${b.s}`).sort()).toEqual([
      "role/implement/coder/1",
      "tier/1/sonnet/1",
    ]);
    expect(bias.find((b) => b.dimension === "tier")?.costMedian).toBeCloseTo(SONNET, 10);
    // Re-running changes nothing.
    const again = reconcile(db, { now: NOW + 1000 });
    expect(again).toMatchObject({ scanned: 0, updated: 0, learned: 0 });
    expect(db.adjudicator.biasAll()).toEqual(bias);
  });

  it("re-running over still-pending rows writes nothing new", () => {
    const t = swarmTask("active");
    db.apiCallsUpsert([call({ agent_id: "A1", sidechain: 1 })]);
    row({ runId: "R1", taskId: t, action: "applied" });
    const a = reconcile(db, { now: NOW });
    expect(a.updated).toBe(1);
    const b = reconcile(db, { now: NOW + 1000 });
    expect(b).toMatchObject({ scanned: 1, updated: 0, finalized: 0 });
  });
});

describe("feedback", () => {
  it("maps good / too_small / too_big to outcomes and bias signals", () => {
    const L = { ...DEFAULT_LEARNING, minSamples: 0 };
    const good = row({ surface: "mcp", tier: "sonnet", role: "reviewer" });
    const small = row({ surface: "mcp", tier: "haiku" });
    const big = row({ surface: "mcp", tier: "opus", actualModel: "claude-opus-5-5" });

    expect(applyFeedback(db, good, "good", { learning: L, now: NOW })).toMatchObject({
      outcome: "success",
      outcomeSource: "feedback",
      outcomeTs: NOW,
      final: true,
    });
    expect(applyFeedback(db, small, "too_small", { learning: L })?.outcome).toBe("failure");
    expect(
      applyFeedback(db, big, "too_big", { learning: L, tiers: ["haiku", "sonnet", "opus"] })
        ?.outcome,
    ).toBe("success");
    expect(applyFeedback(db, 9999, "good")).toBeUndefined();

    const rows = db.adjudicator.biasAll();
    const get = (dim: string, opt: string) =>
      rows.find((r) => r.dimension === dim && r.option === opt);
    // good + too_big's lower tier: two decayed successes.
    const d = decayFactor(L.halfLife);
    expect(get("tier", "sonnet")).toMatchObject({ bucket: "1", f: 0 });
    expect(get("tier", "sonnet")?.n).toBeCloseTo(1 + d, 12);
    expect(get("tier", "sonnet")?.s).toBeCloseTo(1 + d, 12);
    expect(get("tier", "haiku")).toMatchObject({ n: 1, s: 0, f: 1 });
    expect(get("tier", "opus")).toMatchObject({ n: 1, s: 1 });
    expect(get("role", "reviewer")).toMatchObject({ bucket: "implement", s: 1 });
  });

  it("records the outcome but no bias with learning off", () => {
    const id = row({ surface: "mcp" });
    expect(applyFeedback(db, id, "good", { learning: { enabled: false } })?.outcome).toBe(
      "success",
    );
    expect(db.adjudicator.biasAll()).toEqual([]);
  });
});
