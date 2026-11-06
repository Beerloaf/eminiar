import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AdjudicatorConfig, AdjudicatorConfigSchema } from "../../src/config.js";
import { swarmBadges, trailHash } from "../../src/decisions/features/swarm.js";
import type { DecisionCallRow } from "../../src/decisions/types.js";
import type { StorageAdapter } from "../../src/storage/adapter.js";
import { formatRunStatus } from "../../src/swarm/format.js";
import type { RunSnapshot } from "../../src/swarm/runtime.js";
import type { SwarmEventRow, TaskRow } from "../../src/swarm/types.js";

const ORIGIN = "https://api.typesafe.ai";

// Hermetic: swarmBadges resolves the provider from the environment and the key file. Without a
// key it degrades to the heuristic and hides every badge, so the result would depend on whether
// the machine has ~/.eminiar/adjudicator.key. Use an empty home and a fake key from the env.
const KEYS = [
  "EMINIAR_HOME",
  "TYPESAFE_API_KEY",
  "EMINIAR_ADJUDICATOR",
  "EMINIAR_ADJUDICATOR_PROVIDER",
];
const saved: Record<string, string | undefined> = {};
let tmpHome: string;
beforeAll(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  tmpHome = mkdtempSync(join(tmpdir(), "em-swarm-judge-"));
  process.env.EMINIAR_HOME = tmpHome;
  process.env.TYPESAFE_API_KEY = "test-key-not-real";
  delete process.env.EMINIAR_ADJUDICATOR;
  delete process.env.EMINIAR_ADJUDICATOR_PROVIDER;
});
afterAll(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(tmpHome, { recursive: true, force: true });
});

function cfg(swarm: Record<string, unknown>): AdjudicatorConfig {
  return AdjudicatorConfigSchema.parse({
    enabled: true,
    provider: "typesafe",
    remoteConsent: true,
    remoteConsentOrigins: [ORIGIN],
    featureConsent: [`swarm@${ORIGIN}`],
    features: { swarm },
  }) as AdjudicatorConfig;
}

const task = (over: Partial<TaskRow> = {}): TaskRow => ({
  id: 1,
  run_id: "r1",
  title: "do it",
  detail: null,
  role: null,
  status: "active",
  agent_id: "agent-a",
  deps: [],
  files: [],
  result: null,
  auto_closed: false,
  created_by: null,
  created_at: 1,
  updated_at: 1,
  ...over,
});

const row = (over: Partial<DecisionCallRow>): DecisionCallRow =>
  ({
    id: 1,
    ts: Date.now(),
    feature: "swarm",
    mode: "live",
    status: "ok",
    subject: "run:r1/task:1",
    decision: { task: 1, hash: "h", flags: [{ q: "stalled", p: 0.82, c: true }] },
    ...over,
  }) as DecisionCallRow;

const dbWith = (rows: DecisionCallRow[]) =>
  ({ decisions: { latestBySubject: () => rows } }) as unknown as StorageAdapter;

describe("swarm judge badges", () => {
  it("shows a live, fresh, usable verdict above flagAbove", () => {
    const b = swarmBadges(cfg({ enabled: true, shadow: false }), dbWith([row({})]), "r1");
    expect(b.get(1)).toBe("maybe stalled (0.82)");
  });

  it("shows nothing in shadow, off, unusable status or below the threshold", () => {
    const live = { enabled: true, shadow: false };
    expect(swarmBadges(cfg({ enabled: true }), dbWith([row({})]), "r1").size).toBe(0);
    expect(swarmBadges(cfg({ enabled: false, shadow: false }), dbWith([row({})]), "r1").size).toBe(
      0,
    );
    expect(swarmBadges(cfg(live), dbWith([row({ status: "breaker_open" })]), "r1").size).toBe(0);
    expect(swarmBadges(cfg(live), dbWith([row({ status: "unsupported" })]), "r1").size).toBe(0);
    expect(swarmBadges(cfg({ ...live, flagAbove: 0.9 }), dbWith([row({})]), "r1").size).toBe(0);
    expect(swarmBadges(cfg(live), dbWith([row({ ts: Date.now() - 3_600_000 })]), "r1").size).toBe(
      0,
    );
  });
});

describe("swarm judge badge guards", () => {
  const live = { enabled: true, shadow: false };
  it("needs 0.85 from an uncalibrated verdict", () => {
    const f = (p: number) =>
      row({ decision: { task: 1, hash: "h", flags: [{ q: "stalled", p, c: false }] } });
    expect(swarmBadges(cfg(live), dbWith([f(0.8)]), "r1").size).toBe(0);
    expect(swarmBadges(cfg(live), dbWith([f(0.9)]), "r1").size).toBe(1);
  });
  it("hides a verdict from another provider or while the breaker is open", () => {
    expect(swarmBadges(cfg(live), dbWith([row({ provider: "other" })]), "r1").size).toBe(0);
    const open = {
      decisions: { latestBySubject: () => [row({})] },
      adjudicator: { providerState: () => ({ state: "open", retryAt: Date.now() + 60_000 }) },
    } as unknown as StorageAdapter;
    expect(swarmBadges(cfg(live), open, "r1").size).toBe(0);
  });
});

describe("trailHash", () => {
  it("changes with the status and the story, not with tool calls", () => {
    const ev = (id: number, kind: SwarmEventRow["kind"]): SwarmEventRow => ({
      id,
      run_id: "r1",
      ts: id,
      agent_id: "agent-a",
      role: "coder",
      kind,
      task_id: 1,
      text: null,
      payload: null,
    });
    const base = trailHash(task(), [ev(1, "claim")]);
    expect(trailHash(task(), [ev(1, "claim"), ev(2, "tool")])).toBe(base);
    expect(trailHash(task(), [ev(1, "claim"), ev(3, "post")])).not.toBe(base);
    expect(trailHash(task({ status: "done" }), [ev(1, "claim")])).not.toBe(base);
  });
});

describe("formatRunStatus badges", () => {
  const snap = {
    run: {
      id: "r1",
      swarm: "s",
      topology: "hierarchical",
      status: "active",
      goal: "g",
      summary: null,
      created_at: 1,
      updated_at: 1,
      ended_at: null,
    },
    tasks: [task()],
    workers: [],
    notes: [],
    events: [],
    counts: {
      tasks: { pending: 0, active: 1, blocked: 0, done: 0, failed: 0 },
      workers: { running: 0, stale: 0, done: 0 },
      staleHeld: 0,
      autoClosed: 0,
      toolCalls: 0,
      errors: 0,
    },
  } as unknown as RunSnapshot;

  it("is byte-identical without badges and adds one line suffix with them", () => {
    const plain = formatRunStatus(snap, { now: 10 });
    expect(formatRunStatus(snap, { now: 10, badges: new Map() })).toBe(plain);
    const with1 = formatRunStatus(snap, {
      now: 10,
      badges: new Map([[1, "maybe stalled (0.82)"]]),
    });
    expect(with1).toContain("judge: maybe stalled (0.82)");
    expect(with1.replace(" · judge: maybe stalled (0.82)", "")).toBe(plain);
  });
});
