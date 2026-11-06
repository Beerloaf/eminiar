/**
 * Jev usage on a Spendl-shaped day (swarm run 20261106-8219c3, tasks #354-#357): plan rows Jev
 * answered, agent rows that inherit the verdict through parent_id (their own source is
 * fallback/skipped), pinned opus..opus validators, ranged stays, one explicit-model follow, and
 * stored apply bounds. The summary and the impact report must count all of it.
 * No network and no model: rows are seeded into a temp SQLite file.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BlendWeights, blend } from "../../src/adjudicator/blend.js";
import { verdictColumns } from "../../src/adjudicator/engine.js";
import { tableConfidence } from "../../src/adjudicator/heuristic.js";
import { type JevConfig, jevImpact } from "../../src/adjudicator/jev-impact.js";
import type { ScoreSet, ScoreTable, Tier } from "../../src/adjudicator/types.js";
import { SqliteAdapter } from "../../src/storage/sqlite/adapter.js";
import type { AdjudicationInput } from "../../src/storage/types.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
const SINCE = NOW - 30 * DAY;
const POST = NOW - DAY;
const TIERS3: readonly Tier[] = ["haiku", "sonnet", "opus"];
const CFG: JevConfig = {
  tiers: TIERS3,
  weights: { lowConfidence: 0.55 },
  apply: {},
  timeouts: { promptMs: 1500, agentMs: 3000, planMs: 4000 },
};

type Probs = Record<string, number>;

function tableOf(dimension: ScoreTable["dimension"], probs: Probs): ScoreTable {
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

function hset(tier: Probs): ScoreSet {
  return {
    complexity: 1,
    complexityReasons: [],
    tool: tableOf("tool", { em_symbols: 0.4, em_swarm: 0.3, none: 0.3 }),
    tier: tableOf("tier", tier),
    role: tableOf("role", { coder: 0.7, architect: 0.2, none: 0.1 }),
    effort: "low",
  };
}

/** The columns the engine stores for `h` blended with a Jev tier answer. */
function stored(h: ScoreSet, jevTier: Probs, weights: BlendWeights = {}): AdjudicationInput {
  const v = blend(
    h,
    { key: "k", tier: { probs: jevTier, confidence: 0.7, calibrated: true } },
    {},
    weights,
    { key: "k", provider: "typesafe", tiers: TIERS3 },
  );
  v.heuristicComplexity = h.complexity;
  return { surface: "prompt", inputHash: "h", ...verdictColumns(v, {}) } as AdjudicationInput;
}

/** heuristic haiku, Jev sonnet: final sonnet, Jev moved it up one. */
const up1 = () => stored(hset({ haiku: 0.8, sonnet: 0.15, opus: 0.05 }), { sonnet: 1 });
/** heuristic opus, Jev sonnet: final sonnet, Jev moved it down one. */
const down1 = () => stored(hset({ opus: 0.8, sonnet: 0.15, haiku: 0.05 }), { sonnet: 1 });

const scoresOf = (cols: AdjudicationInput, patch: Record<string, unknown>): string =>
  JSON.stringify({ ...JSON.parse(cols.scores as string), ...patch });

let seq = 0;
let db: SqliteAdapter;

beforeEach(() => {
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-jevuse-home-"));
  db = new SqliteAdapter(join(mkdtempSync(join(tmpdir(), "em-jevuse-")), "db.sqlite"), {
    vectors: false,
  });
});

afterEach(() => {
  db.close();
  delete process.env.EMINIAR_HOME;
});

/** A plan row Jev answered (blend), then its agent row inheriting via parent_id. */
function task(
  taskId: number,
  plan: AdjudicationInput,
  agent: Partial<AdjudicationInput> & { scores: string },
): void {
  const swarm = { runId: "R1", taskId };
  const planId = db.adjudicator.insert({
    ...plan,
    surface: "plan",
    ts: POST,
    provider: "typesafe",
    providerModel: "jev-1.14.0",
    providerStatus: "ok",
    source: "blend",
    latencyMs: 300,
    providerLatencyMs: 280,
    costUsd: 0.001,
    ...swarm,
  });
  db.adjudicator.insert({
    ...plan,
    surface: "agent",
    ts: POST,
    tier: "sonnet",
    role: "coder",
    // the agent row's own source: the engine was skipped for it, the verdict is the plan's
    provider: "typesafe",
    source: "fallback",
    providerStatus: "skipped",
    latencyMs: 3,
    parentId: planId,
    sessionId: `S${++seq}`,
    final: true,
    ...swarm,
    ...agent,
  });
}

describe("a Spendl-shaped day of Jev dispatches", () => {
  const range = { floor: "haiku", ceiling: "opus" };

  beforeEach(() => {
    // 1: a ranged stay. The pick (sonnet) is the fallback's tier, and the pin was kept.
    task(1, up1(), {
      action: "advised",
      actualModel: "claude-sonnet-5",
      scores: scoresOf(up1(), {
        pinDeferred: true,
        ranged: true,
        advisedPick: "sonnet",
        pin: { status: "ranged", model: "sonnet", range },
      }),
    });
    // 2: a ranged move with an explicit model equal to the advised pick: a follow.
    task(2, down1(), {
      action: "followed",
      modelRequested: "sonnet",
      actualModel: "claude-sonnet-5",
      baselineModel: "claude-opus-5",
      scores: scoresOf(down1(), { ranged: true, advisedPick: "sonnet", pin: { range } }),
    });
    // 3: a pinned opus..opus validator whose advice named sonnet: kept, and it disagrees.
    task(3, down1(), {
      action: "advised",
      actualModel: "claude-opus-5",
      scores: scoresOf(down1(), {
        pinDeferred: true,
        advisedPick: "sonnet",
        pin: { status: "pinned", model: "opus", range: { floor: "opus", ceiling: "opus" } },
      }),
    });
    // 4: a pinned opus..opus validator whose advice named opus: kept, no disagreement.
    task(4, down1(), {
      action: "advised",
      actualModel: "claude-opus-5",
      scores: scoresOf(down1(), {
        pinDeferred: true,
        advisedPick: "opus",
        pin: { status: "pinned", model: "opus", range: { floor: "opus", ceiling: "opus" } },
      }),
    });
    // 5: an unranged dispatch with its apply bounds stored: no guessing at today's bounds.
    task(5, up1(), {
      action: "applied",
      modelRequested: "sonnet",
      actualModel: "claude-sonnet-5",
      scores: scoresOf(up1(), {
        advisedPick: "sonnet",
        applyBounds: { floor: "haiku", ceiling: "opus" },
      }),
    });
  });

  it("summary: inherited rows are counted, the pinned and ranged stays leave the follow rate", () => {
    const s = db.adjudicator.summary(SINCE);
    expect(s.total).toBe(10);
    expect(s.bySurface).toMatchObject({ plan: 5, agent: 5 });
    expect(s.inherited).toBe(5);
    // dispatches that ran on a model Claude Code chose: the two pinned validators and the
    // ranged stay (all kept pins that ran on the pin)
    expect(s.keptModel.pin).toBeGreaterThanOrEqual(2);
    // follow rate: task 2 followed; task 5 applied is not an advise-mode action
    expect(s.rates.follow).toBe(1);
  });

  it("impact: ranged stays and moves are counted, none is unknown", () => {
    const r = jevImpact(db, { since: SINCE }, { config: CFG, now: NOW });
    expect(r.sample.decisions).toBe(5); // the plan rows; agent rows inherit, none is a second decision
    expect(r.influence.effective.unknown).toBe(0);
    expect(r.influence.effective.changed).toBeGreaterThan(0);
    expect(r.influence.effective).toMatchObject({ dispatches: 3, changed: 3, unchanged: 0 });
    expect(r.outcomes.excluded).toMatchObject({ unknown: 0, bounds: 0, kept: 2 });
  });

  it("impact: keptDisagreed counts only the pinned rows whose advice named another tier", () => {
    const r = jevImpact(db, { since: SINCE }, { config: CFG, now: NOW });
    expect(r.outcomes.excluded.kept).toBe(2);
    expect(r.outcomes.excluded.keptDisagreed).toBe(1);
  });

  it("impact: the explicit-model follow is a followed dispatch among the changed ones", () => {
    const r = jevImpact(db, { since: SINCE }, { config: CFG, now: NOW });
    // Task 2 followed. Task 1 (the ranged stay, advised, no model passed) is a Jev-decided
    // dispatch, but its advice is "keep the fallback": nothing to pass, so it stays out of the
    // follow rate, as in the store summary (rates.follow above; review-A A3).
    expect(r.outcomes.changed).toMatchObject({ dispatches: 3, followed: 1, followDenom: 1 });
    expect(r.outcomes.changed.followRate).toBe(db.adjudicator.summary(SINCE).rates.follow);
  });
});
