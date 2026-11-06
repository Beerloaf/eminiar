/**
 * Detached decision jobs are spawned only when they can run and are useful: not for the embedding
 * provider (no embedder in a job), an open breaker, a reached daily cap, a provider that said
 * "unsupported", nor while a job for that session/feature is in flight; kickSwarmJudge uses the
 * same gate; "unsupported" rows do not pile up.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type AdjudicatorConfig, AdjudicatorConfigSchema, ConfigSchema } from "../../src/config.js";
import { getContext, type ProjectContext, resetContextCache } from "../../src/context.js";
import { kickSwarmJudge } from "../../src/decisions/features/swarm.js";
import { decisionPreToolUse } from "../../src/decisions/hooks.js";
import { claimJobSlot, providerAllowsJob, releaseJobSlot } from "../../src/decisions/job.js";
import { runDecisionJob } from "../../src/decisions/run-job.js";
import type { DecisionCallInput, DecisionJob } from "../../src/decisions/types.js";
import type { StorageAdapter } from "../../src/storage/adapter.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";
import { resetSwarmConfigCache } from "../../src/swarm/config.js";

const spawn = vi.hoisted(() => vi.fn(() => true));
vi.mock("../../src/decisions/job.js", async (orig) => ({
  ...(await orig<typeof import("../../src/decisions/job.js")>()),
  spawnDecisionJob: spawn,
}));

const ORIGIN = "https://api.typesafe.ai";
const KEY = "sk-test-key-0123456789";

function cfg(over: Record<string, unknown> = {}, feat: Record<string, unknown> = {}) {
  return AdjudicatorConfigSchema.parse({
    enabled: true,
    provider: "typesafe",
    remoteConsent: true,
    remoteConsentOrigins: [ORIGIN],
    featureConsent: [`diffs@${ORIGIN}`, `swarm@${ORIGIN}`],
    features: {
      commit: { enabled: true, shadow: false, ...feat },
      swarm: { enabled: true, shadow: false, ...feat },
    },
    ...over,
  }) as AdjudicatorConfig;
}

let root: string;
let base: ProjectContext;
let db: StorageAdapter;
const ctxOf = (a: AdjudicatorConfig): ProjectContext => ({
  ...base,
  config: ConfigSchema.parse({ adjudicator: a }),
});
const commit = { tool_name: "Bash", tool_input: { command: 'git commit -m "x"' } } as never;
const openBreaker = (provider = "typesafe") =>
  db.adjudicator.saveProviderState(provider, { state: "open", retryAt: Date.now() + 600_000 });
const row = (over: Partial<DecisionCallInput> = {}): DecisionCallInput => ({
  ts: Date.now(),
  feature: "commit",
  context: "job",
  subject: "s",
  mode: "live",
  status: "ok",
  provider: "typesafe",
  applied: false,
  ...over,
});

beforeAll(() => {
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-spg-home-"));
  process.env.TYPESAFE_API_KEY = KEY;
  root = mkdtempSync(join(tmpdir(), "em-spg-"));
  writeFileSync(join(root, "package.json"), "{}");
  mkdirSync(join(root, ".eminiar"), { recursive: true });
  resetSwarmConfigCache();
  resetContextCache();
  base = getContext(root);
  db = getStorage(base, { vectors: false });
});
afterAll(() => {
  closeAllStorage();
  delete process.env.EMINIAR_HOME;
  delete process.env.TYPESAFE_API_KEY;
});
beforeEach(() => {
  spawn.mockClear();
  db.decisions.purge();
  db.adjudicator.saveProviderState("typesafe", {
    state: "closed",
    retryAt: null,
    failures: 0,
    calls: 0,
    spendUsd: 0,
  });
});

describe("providerAllowsJob", () => {
  it("allows a healthy provider", () => {
    expect(providerAllowsJob(cfg(), db, "commit")).toBe(true);
  });

  it("refuses the embedding provider (a job has no embedder)", () => {
    expect(providerAllowsJob(cfg({ provider: "embedding" }), db, "commit")).toBe(false);
  });

  it("refuses an open or half-open breaker, and allows it again once the retry time passed", () => {
    openBreaker();
    expect(providerAllowsJob(cfg(), db, "commit")).toBe(false);
    expect(providerAllowsJob(cfg(), db, "commit", Date.now() + 660_000)).toBe(true);
    db.adjudicator.saveProviderState("typesafe", {
      state: "half_open",
      retryAt: Date.now() + 60_000,
    });
    expect(providerAllowsJob(cfg(), db, "commit")).toBe(false);
  });

  it("refuses a reached daily cap", () => {
    const c = cfg({}, { maxCallsPerDay: 2 });
    db.decisions.insertCall(row());
    expect(providerAllowsJob(c, db, "commit")).toBe(true);
    db.decisions.insertCall(row());
    expect(providerAllowsJob(c, db, "commit")).toBe(false);
  });

  it("refuses a provider that recently said unsupported, not another provider's", () => {
    db.decisions.insertCall(row({ status: "unsupported", provider: "typesafe" }));
    expect(providerAllowsJob(cfg(), db, "commit")).toBe(false);
    expect(providerAllowsJob(cfg(), db, "swarm")).toBe(true);
    expect(providerAllowsJob(cfg(), db, "commit", Date.now() + 2 * 3_600_000)).toBe(true);
  });

  it("refuses an exhausted daily call budget of a remote provider", () => {
    const c = cfg({ budget: { dailyCalls: 3 } });
    db.adjudicator.saveProviderState("typesafe", {
      state: "closed",
      retryAt: null,
      calls: 3,
      spendDay: new Date().toISOString().slice(0, 10),
    });
    expect(providerAllowsJob(c, db, "commit")).toBe(false);
  });
});

describe("job slots", () => {
  const job = (feature: "commit" | "recall", sessionId: string): DecisionJob => ({
    v: 1,
    feature,
    projectRoot: root,
    sessionId,
    payload: {},
  });

  it("one job per session and feature; released frees it", () => {
    expect(claimJobSlot(db, job("commit", "s1"))).toBe(true);
    expect(claimJobSlot(db, job("commit", "s1"))).toBe(false);
    expect(claimJobSlot(db, job("commit", "s2"))).toBe(true);
    releaseJobSlot(db, job("commit", "s1"));
    expect(claimJobSlot(db, job("commit", "s1"))).toBe(true);
  });

  it("caps jobs per session and in all, and a dead job's lock expires", () => {
    const t = Date.now();
    expect(claimJobSlot(db, job("commit", "s1"), t)).toBe(true);
    expect(claimJobSlot(db, job("recall", "s1"), t)).toBe(true);
    const third = { ...job("recall", "s1"), feature: "memory" as const };
    expect(claimJobSlot(db, third, t)).toBe(false);
    expect(claimJobSlot(db, job("commit", "s2"), t)).toBe(true);
    expect(claimJobSlot(db, job("recall", "s2"), t)).toBe(true);
    expect(claimJobSlot(db, job("commit", "s3"), t)).toBe(false);
    expect(claimJobSlot(db, job("commit", "s3"), t + 31_000)).toBe(true);
  });

  it("a finished job releases its slot", async () => {
    const j = job("commit", "s9");
    expect(claimJobSlot(db, j)).toBe(true);
    await runDecisionJob(JSON.stringify(j), { db });
    expect(claimJobSlot(db, j)).toBe(true);
  });
});

describe("hook spawns", () => {
  it("15 git commits against a down provider start no process", async () => {
    openBreaker();
    for (let i = 0; i < 15; i++) await decisionPreToolUse(ctxOf(cfg()), db, commit, "sess");
    expect(spawn).toHaveBeenCalledTimes(0);
  });

  it("15 git commits against a healthy provider start one process while it runs", async () => {
    for (let i = 0; i < 15; i++) await decisionPreToolUse(ctxOf(cfg()), db, commit, "sess");
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("the embedding provider spawns nothing and writes no row", async () => {
    await decisionPreToolUse(ctxOf(cfg({ provider: "embedding" })), db, commit, "sess");
    expect(spawn).toHaveBeenCalledTimes(0);
    expect(db.decisions.list().length).toBe(0);
  });

  it("a spawn that fails frees the slot", async () => {
    spawn.mockReturnValueOnce(false);
    await decisionPreToolUse(ctxOf(cfg()), db, commit, "sess");
    await decisionPreToolUse(ctxOf(cfg()), db, commit, "sess");
    expect(spawn).toHaveBeenCalledTimes(2);
  });
});

describe("unsupported rows", () => {
  it("are recorded once per feature and provider per hour and evict nothing", () => {
    const first = db.decisions.insertCall(row({ status: "unsupported" }), 5);
    for (let i = 0; i < 50; i++)
      expect(db.decisions.insertCall(row({ status: "unsupported" }), 5)).toBe(first);
    db.decisions.insertCall(row({ subject: "useful" }), 5);
    const rows = db.decisions.list();
    expect(rows.filter((r) => r.status === "unsupported").length).toBe(1);
    expect(rows.length).toBe(2);
    // another provider and another hour are new facts
    db.decisions.insertCall(row({ status: "unsupported", provider: "openai-compatible" }), 5);
    db.decisions.insertCall(row({ status: "unsupported", ts: Date.now() + 2 * 3_600_000 }), 5);
    expect(db.decisions.list().filter((r) => r.status === "unsupported").length).toBe(3);
  });
});

describe("kickSwarmJudge uses the same gate", () => {
  let runId: string;
  let tasks: ReturnType<StorageAdapter["swarm"]["tasks"]>;
  beforeAll(() => {
    const swarm = `version: 1\nswarms:\n  feat:\n    description: t\n    agents:\n      coder:\n        description: c\n`;
    writeFileSync(join(root, ".eminiar", "swarm.yaml"), swarm);
    resetSwarmConfigCache();
    const run = db.swarm.runCreate({
      id: "run-spg",
      swarm: "feat",
      goal: "g",
      topology: "hierarchical",
    });
    runId = (run as { id: string }).id;
    const t = db.swarm.taskAdd({ run_id: runId, title: "work" });
    db.swarm.taskUpdate(t.id, { status: "active", agent_id: "agent-aaaa1111" });
    tasks = db.swarm.tasks(runId);
  });

  it("spawns when healthy, once while in flight", () => {
    const ctx = ctxOf(cfg());
    expect(kickSwarmJudge(ctx, db, runId, tasks, "sess", Date.now() + 40_000)).toBe(true);
    expect(kickSwarmJudge(ctx, db, runId, tasks, "sess", Date.now() + 50_000)).toBe(false);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("does not spawn for an open breaker, the embedding provider or a reached cap", () => {
    openBreaker();
    expect(kickSwarmJudge(ctxOf(cfg()), db, runId, tasks, "sess", Date.now() + 200_000)).toBe(
      false,
    );
    db.adjudicator.saveProviderState("typesafe", { state: "closed", retryAt: null });
    expect(
      kickSwarmJudge(
        ctxOf(cfg({ provider: "embedding" })),
        db,
        runId,
        tasks,
        "sess",
        Date.now() + 300_000,
      ),
    ).toBe(false);
    // The cap counts the UTC day of `now`: the call must carry the same instant, or the test
    // fails whenever it runs within 400 s of UTC midnight.
    const at = Date.now() + 400_000;
    db.decisions.insertCall(row({ feature: "swarm", ts: at }));
    expect(
      kickSwarmJudge(ctxOf(cfg({}, { maxCallsPerDay: 1 })), db, runId, tasks, "sess", at),
    ).toBe(false);
    expect(spawn).toHaveBeenCalledTimes(0);
  });
});
