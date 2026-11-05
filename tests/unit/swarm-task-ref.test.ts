/**
 * How a swarm spawn prompt is linked to its task (reserveSpawn, PreToolUse(Agent)). A prompt
 * often names several tasks (its own plus others for context); the spawn links the one still
 * open for its role, or none. The positive multi-ref walk-through lives in
 * swarm-review.test.ts; these pin the boundaries around it.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getContext, resetContextCache } from "../../src/context.js";
import type { StorageAdapter } from "../../src/storage/adapter.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";
import { activeSwarmConfig, resetSwarmConfigCache } from "../../src/swarm/config.js";
import {
  addTasks,
  callerOf,
  claimTask,
  finishRun,
  releaseSpawn,
  reserveSpawn,
  startRun,
  taskRef,
  taskRefs,
  updateTask,
} from "../../src/swarm/runtime.js";
import type { SwarmConfig } from "../../src/swarm/types.js";

describe("spawn prompt task link", () => {
  let root: string;
  let db: StorageAdapter;
  let cfg: SwarmConfig;
  const sql = () =>
    (db as unknown as { db: { prepare(s: string): { run(...a: unknown[]): void } } }).db;
  const coord = () => callerOf(cfg, {});
  const worker = (id: string, type = "swarm-feat-coder") =>
    callerOf(cfg, { agentId: id, agentType: type });
  const swarmOf = (name: string) => cfg.swarms.find((s) => s.name === name)!;

  beforeAll(() => {
    process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-home-"));
    root = mkdtempSync(join(tmpdir(), "em-swarm-taskref-"));
    writeFileSync(join(root, "package.json"), "{}");
    mkdirSync(join(root, ".eminiar"), { recursive: true });
    writeFileSync(
      join(root, ".eminiar", "swarm.yaml"),
      `swarms:
  feat:
    description: d
    max_agents: 6
    agents:
      coder: { description: writes code, count: 3 }
      tester: { description: tests code, count: 3 }
  meshy:
    description: m
    topology: mesh
    max_agents: 6
    agents:
      coder: { description: writes code, count: 3 }
      tester: { description: tests code, count: 3 }
  line:
    description: p
    topology: pipeline
    agents:
      plan: { description: plans }
      build: { description: builds }
`,
    );
    resetContextCache();
    resetSwarmConfigCache();
    db = getStorage(getContext(root), { vectors: false });
    cfg = activeSwarmConfig(root)!;
  });
  afterAll(() => closeAllStorage());

  /** A clean slate: no active runs, no live workers, no open reservations. */
  beforeEach(() => {
    for (const r of db.swarm.runs({ status: "active" }))
      finishRun(getContext(root), db, r, coord(), { status: "cancelled" });
    sql().prepare("UPDATE swarm_spawns SET consumed = 1").run();
  });

  let n = 0;
  /** Reserve a spawn of `agentType` with `prompt`; the link it got, or the raw denial. */
  const spawn = (agentType: string, prompt: string, sessionId = "S") => {
    const toolUseId = `ref-${++n}`;
    const d = reserveSpawn(db, cfg, { agentType, prompt, sessionId, toolUseId });
    releaseSpawn(db, toolUseId);
    return d?.decision === "allow" ? { run: d.run?.id, task: d.taskId } : d;
  };
  const ref = (t: { id: number } | undefined) => `task #${t!.id}`;
  const start = (swarm: string, goal = "g", session = "S") =>
    startRun(db, cfg, { swarm, goal, sessionId: session });

  describe("two tasks of different roles", () => {
    it("links the task of the role being spawned, whichever role that is", () => {
      const run = start("feat");
      const [a, b] = addTasks(db, { root }, run, swarmOf("feat"), coord(), [
        { title: "A", role: "coder" },
        { title: "B", role: "tester" },
      ]);
      const prompt = `${ref(a)} is the coder's; ${ref(b)} is for the tester, after A lands`;
      expect(spawn("swarm-feat-coder", prompt)).toEqual({ run: run.id, task: a!.id });
      expect(spawn("swarm-feat-tester", prompt)).toEqual({ run: run.id, task: b!.id });
      // the order the prompt names them in does not matter
      const flipped = `${ref(b)} comes after ${ref(a)}`;
      expect(spawn("swarm-feat-coder", flipped)).toEqual({ run: run.id, task: a!.id });
      expect(spawn("swarm-feat-tester", flipped)).toEqual({ run: run.id, task: b!.id });
    });

    it("records the linked task on the spawn event", () => {
      const run = start("feat");
      const [a, b] = addTasks(db, { root }, run, swarmOf("feat"), coord(), [
        { title: "A", role: "coder" },
        { title: "B", role: "tester" },
      ]);
      spawn("swarm-feat-coder", `${ref(a)} then ${ref(b)}`);
      const last = db.swarm.eventLast(run.id);
      expect(last?.kind).toBe("spawn");
      expect(last?.task_id).toBe(a!.id);
    });

    it("a task for a role that does not exist in the swarm is never linked", () => {
      const run = start("feat");
      const [a, b] = addTasks(db, { root }, run, swarmOf("feat"), coord(), [
        { title: "A", role: "tester" },
        { title: "B", role: "tester" },
      ]);
      expect(spawn("swarm-feat-coder", `${ref(a)} and ${ref(b)}`)).toEqual({
        run: run.id,
        task: undefined,
      });
    });
  });

  describe("two open tasks of the same role", () => {
    it("is ambiguous: no task, but the default run", () => {
      const run = start("feat");
      const [a, b] = addTasks(db, { root }, run, swarmOf("feat"), coord(), [
        { title: "A", role: "coder" },
        { title: "B", role: "coder" },
      ]);
      expect(spawn("swarm-feat-coder", `do ${ref(a)}, or maybe ${ref(b)}`)).toEqual({
        run: run.id,
        task: undefined,
      });
      const last = db.swarm.eventLast(run.id);
      expect(last?.kind).toBe("spawn");
      expect(last?.task_id ?? undefined).toBeUndefined();
    });

    it("three candidates are still ambiguous", () => {
      const run = start("feat");
      const ts = addTasks(db, { root }, run, swarmOf("feat"), coord(), [
        { title: "A", role: "coder" },
        { title: "B", role: "coder" },
        { title: "C", role: "coder" },
      ]);
      expect(spawn("swarm-feat-coder", ts.map(ref).join(", "))).toEqual({
        run: run.id,
        task: undefined,
      });
    });

    it("a role-less task counts as a candidate beside the role's own", () => {
      const run = start("feat");
      const [a, any] = addTasks(db, { root }, run, swarmOf("feat"), coord(), [
        { title: "A", role: "coder" },
        { title: "anyone" },
      ]);
      expect(spawn("swarm-feat-coder", `${ref(a)} and ${ref(any)}`)).toEqual({
        run: run.id,
        task: undefined,
      });
      // alone it is the open one
      expect(spawn("swarm-feat-coder", `${ref(any)} plus ignore #999999`)).toEqual({
        run: run.id,
        task: any!.id,
      });
    });

    it("the same task named twice is one reference", () => {
      const run = start("feat");
      const [a] = addTasks(db, { root }, run, swarmOf("feat"), coord(), [
        { title: "A", role: "coder" },
      ]);
      expect(taskRefs(`${ref(a)} ... again ${ref(a)}`)).toEqual([a!.id]);
      expect(spawn("swarm-feat-coder", `${ref(a)} ... again ${ref(a)}`)).toEqual({
        run: run.id,
        task: a!.id,
      });
    });
  });

  describe("one of them is no longer open", () => {
    const fixture = () => {
      const run = start("feat");
      const [a, b] = addTasks(db, { root }, run, swarmOf("feat"), coord(), [
        { title: "A", role: "coder" },
        { title: "B", role: "coder" },
      ]);
      return { run, a: a!, b: b! };
    };

    it("done: links the other, in either order", () => {
      const { run, a, b } = fixture();
      claimTask(db, run, swarmOf("feat"), worker("W1"), a.id);
      updateTask(db, run, worker("W1"), { task: a.id, status: "done" });
      expect(spawn("swarm-feat-coder", `${ref(a)} done; now ${ref(b)}`)).toEqual({
        run: run.id,
        task: b.id,
      });
      expect(spawn("swarm-feat-coder", `${ref(b)}, building on ${ref(a)}`)).toEqual({
        run: run.id,
        task: b.id,
      });
    });

    it("failed and blocked tasks are not open either", () => {
      const run = start("feat");
      const [open, failed, blocked] = addTasks(db, { root }, run, swarmOf("feat"), coord(), [
        { title: "open", role: "coder" },
        { title: "failed", role: "coder" },
        { title: "blocked", role: "coder" },
      ]);
      db.swarm.workerUpsert({
        run_id: run.id,
        agent_id: "W2",
        agent_type: "swarm-feat-coder",
        role: "coder",
      });
      claimTask(db, run, swarmOf("feat"), worker("W2"), failed!.id);
      updateTask(db, run, worker("W2"), { task: failed!.id, status: "failed", result: "x" });
      claimTask(db, run, swarmOf("feat"), worker("W2"), blocked!.id);
      updateTask(db, run, worker("W2"), { task: blocked!.id, status: "blocked", result: "x" });
      expect(spawn("swarm-feat-coder", `${ref(failed)}, ${ref(blocked)} and ${ref(open)}`)).toEqual(
        { run: run.id, task: open!.id },
      );
    });

    it("both closed: no task", () => {
      const { run, a, b } = fixture();
      for (const t of [a, b]) {
        claimTask(db, run, swarmOf("feat"), worker("W3"), t.id);
        updateTask(db, run, worker("W3"), { task: t.id, status: "done" });
      }
      expect(spawn("swarm-feat-coder", `${ref(a)} and ${ref(b)} are done`)).toEqual({
        run: run.id,
        task: undefined,
      });
    });

    it("an active task whose coordinator holds it is not open", () => {
      const { run, a, b } = fixture();
      claimTask(db, run, swarmOf("feat"), coord(), a.id);
      expect(spawn("swarm-feat-coder", `${ref(a)} is mine; ${ref(b)} is yours`)).toEqual({
        run: run.id,
        task: b.id,
      });
    });

    it("an active task whose worker went quiet is open again", () => {
      const { run, a, b } = fixture();
      db.swarm.workerUpsert({
        run_id: run.id,
        agent_id: "WQ",
        agent_type: "swarm-feat-coder",
        role: "coder",
      });
      claimTask(db, run, swarmOf("feat"), worker("WQ"), a.id);
      // live: only b is open
      expect(spawn("swarm-feat-coder", `${ref(a)} and ${ref(b)}`)).toEqual({
        run: run.id,
        task: b.id,
      });
      // quiet: both are open, so ambiguous
      sql().prepare("UPDATE swarm_agents SET last_ts = 0 WHERE agent_id = 'WQ'").run();
      expect(spawn("swarm-feat-coder", `${ref(a)} and ${ref(b)}`)).toEqual({
        run: run.id,
        task: undefined,
      });
    });

    it("an active task whose worker finished is open again", () => {
      const { run, a, b } = fixture();
      db.swarm.workerUpsert({
        run_id: run.id,
        agent_id: "WD",
        agent_type: "swarm-feat-coder",
        role: "coder",
      });
      claimTask(db, run, swarmOf("feat"), worker("WD"), a.id);
      db.swarm.workerUpdate(run.id, "WD", { status: "done" });
      expect(spawn("swarm-feat-coder", `${ref(a)} and ${ref(b)}`)).toEqual({
        run: run.id,
        task: undefined,
      });
    });
  });

  describe("a reference to a task of another run or swarm", () => {
    it("another swarm's task is context, not a candidate", () => {
      const run = start("feat");
      const [mine] = addTasks(db, { root }, run, swarmOf("feat"), coord(), [
        { title: "mine", role: "coder" },
      ]);
      const lineRun = start("line");
      const [foreign] = addTasks(db, { root }, lineRun, swarmOf("line"), coord(), [
        { title: "plan it", role: "plan" },
      ]);
      const [roleless] = addTasks(db, { root }, lineRun, swarmOf("line"), coord(), [
        { title: "no role" },
      ]);
      for (const p of [
        `${ref(mine)}, like ${ref(foreign)}`,
        `${ref(foreign)} first, then ${ref(mine)}`,
        `${ref(mine)}, unlike ${ref(roleless)}`,
      ])
        expect(spawn("swarm-feat-coder", p)).toEqual({ run: run.id, task: mine!.id });
    });

    it("the same role in the same swarm name, but only another swarm's task named: no link", () => {
      const run = start("feat");
      const lineRun = start("line");
      const [f1, f2] = addTasks(db, { root }, lineRun, swarmOf("line"), coord(), [
        { title: "x" },
        { title: "y" },
      ]);
      expect(spawn("swarm-feat-coder", `${ref(f1)} and ${ref(f2)}`)).toEqual({
        run: run.id,
        task: undefined,
      });
    });

    it("a finished run's tasks are ignored, so the active run's task is the sole one", () => {
      const old = start("feat", "old");
      const [stale] = addTasks(db, { root }, old, swarmOf("feat"), coord(), [
        { title: "stale", role: "coder" },
      ]);
      finishRun(getContext(root), db, old, coord(), { status: "cancelled" });
      const run = start("feat", "current");
      const [mine] = addTasks(db, { root }, run, swarmOf("feat"), coord(), [
        { title: "mine", role: "coder" },
      ]);
      expect(spawn("swarm-feat-coder", `${ref(stale)} was cancelled; do ${ref(mine)}`)).toEqual({
        run: run.id,
        task: mine!.id,
      });
    });

    it("only finished runs' tasks named: no link, and no run is opened", () => {
      const old = start("feat", "old");
      const [a, b] = addTasks(db, { root }, old, swarmOf("feat"), coord(), [
        { title: "a", role: "coder" },
        { title: "b", role: "coder" },
      ]);
      finishRun(getContext(root), db, old, coord(), { status: "cancelled" });
      const before = db.swarm.runs({ limit: 500 }).length;
      expect(spawn("swarm-feat-coder", `${ref(a)} and ${ref(b)}`)).toEqual({
        run: undefined,
        task: undefined,
      });
      expect(db.swarm.runs({ limit: 500 }).length).toBe(before);
    });

    it("the session's own run wins over another session's run of the swarm", () => {
      const mineRun = start("feat", "mine", "S");
      const theirRun = start("feat", "theirs", "S2");
      const [m] = addTasks(db, { root }, mineRun, swarmOf("feat"), coord(), [
        { title: "m", role: "coder" },
      ]);
      const [t] = addTasks(db, { root }, theirRun, swarmOf("feat"), coord(), [
        { title: "t", role: "coder" },
      ]);
      const prompt = `${ref(t)} or ${ref(m)}`;
      expect(spawn("swarm-feat-coder", prompt, "S")).toEqual({ run: mineRun.id, task: m!.id });
      expect(spawn("swarm-feat-coder", prompt, "S2")).toEqual({ run: theirRun.id, task: t!.id });
    });

    it("an unknown task id beside a real one is ignored", () => {
      const run = start("feat");
      const [a] = addTasks(db, { root }, run, swarmOf("feat"), coord(), [
        { title: "A", role: "coder" },
      ]);
      expect(spawn("swarm-feat-coder", `${ref(a)}; task #987654 is gone`)).toEqual({
        run: run.id,
        task: a!.id,
      });
    });
  });

  describe("a claimable candidate beats one still waiting on its deps (review #98 F10)", () => {
    it("the task plus the one after it links the task", () => {
      const run = start("feat");
      const [a] = addTasks(db, { root }, run, swarmOf("feat"), coord(), [
        { title: "A", role: "coder" },
      ]);
      const [b] = addTasks(db, { root }, run, swarmOf("feat"), coord(), [
        { title: "B", role: "coder", deps: [a!.id] },
      ]);
      const toA = { run: run.id, task: a!.id };
      expect(
        spawn("swarm-feat-coder", `You are the coder for ${ref(a)}. ${ref(b)} comes after it.`),
      ).toEqual(toA);
      expect(spawn("swarm-feat-coder", `${ref(b)} waits on ${ref(a)}; do the first`)).toEqual(toA);
      expect(db.swarm.eventLast(run.id)?.task_id).toBe(a!.id);
    });

    it("once the dep is done, the waiting task is the one left", () => {
      const run = start("feat");
      const [a] = addTasks(db, { root }, run, swarmOf("feat"), coord(), [
        { title: "A", role: "coder" },
      ]);
      const [b] = addTasks(db, { root }, run, swarmOf("feat"), coord(), [
        { title: "B", role: "coder", deps: [a!.id] },
      ]);
      claimTask(db, run, swarmOf("feat"), worker("WF1"), a!.id);
      updateTask(db, run, worker("WF1"), { task: a!.id, status: "done" });
      expect(spawn("swarm-feat-coder", `${ref(b)}, building on ${ref(a)}`)).toEqual({
        run: run.id,
        task: b!.id,
      });
    });

    it("a lone open task still links while it waits on a dep of another role", () => {
      const run = start("feat");
      const [t] = addTasks(db, { root }, run, swarmOf("feat"), coord(), [
        { title: "tests", role: "tester" },
      ]);
      const [c] = addTasks(db, { root }, run, swarmOf("feat"), coord(), [
        { title: "code", role: "coder", deps: [t!.id] },
      ]);
      expect(spawn("swarm-feat-coder", `${ref(c)} after ${ref(t)}`)).toEqual({
        run: run.id,
        task: c!.id,
      });
    });

    it("two that both wait are still ambiguous; two claimable ones too", () => {
      const run = start("feat");
      const [gate] = addTasks(db, { root }, run, swarmOf("feat"), coord(), [
        { title: "gate", role: "tester" },
      ]);
      const [x, y, p, q] = addTasks(db, { root }, run, swarmOf("feat"), coord(), [
        { title: "X", role: "coder", deps: [gate!.id] },
        { title: "Y", role: "coder", deps: [gate!.id] },
        { title: "P", role: "coder" },
        { title: "Q", role: "coder" },
      ]);
      expect(spawn("swarm-feat-coder", `${ref(x)} and ${ref(y)}`)).toEqual({
        run: run.id,
        task: undefined,
      });
      expect(spawn("swarm-feat-coder", `${ref(p)}, ${ref(q)} and ${ref(x)}`)).toEqual({
        run: run.id,
        task: undefined,
      });
    });

    it("a quiet worker's task counts as claimable", () => {
      const run = start("feat");
      const [a] = addTasks(db, { root }, run, swarmOf("feat"), coord(), [
        { title: "A", role: "coder" },
      ]);
      const [b] = addTasks(db, { root }, run, swarmOf("feat"), coord(), [
        { title: "B", role: "coder", deps: [a!.id] },
      ]);
      db.swarm.workerUpsert({
        run_id: run.id,
        agent_id: "WQ2",
        agent_type: "swarm-feat-coder",
        role: "coder",
      });
      claimTask(db, run, swarmOf("feat"), worker("WQ2"), a!.id);
      sql().prepare("UPDATE swarm_agents SET last_ts = 0 WHERE agent_id = 'WQ2'").run();
      expect(spawn("swarm-feat-coder", `take over ${ref(a)}; ${ref(b)} is next`)).toEqual({
        run: run.id,
        task: a!.id,
      });
    });
  });

  describe("a single reference links only a task for the spawned role (review #98 F11)", () => {
    it("another role's task decides the run but is not linked", () => {
      const run = start("feat");
      const [c] = addTasks(db, { root }, run, swarmOf("feat"), coord(), [
        { title: "C", role: "coder" },
      ]);
      expect(
        spawn("swarm-feat-tester", `Write tests for what the coder did in ${ref(c)}.`),
      ).toEqual({ run: run.id, task: undefined });
      expect(db.swarm.eventLast(run.id)?.task_id ?? undefined).toBeUndefined();
      // the coder's own spawn still links it
      expect(spawn("swarm-feat-coder", ref(c))).toEqual({ run: run.id, task: c!.id });
    });

    it("the task's run still wins over the session's default run", () => {
      start("feat", "default");
      const other = start("feat", "other", "S2");
      const [c] = addTasks(db, { root }, other, swarmOf("feat"), coord(), [
        { title: "C", role: "coder" },
      ]);
      expect(spawn("swarm-feat-tester", `test ${ref(c)}`)).toEqual({
        run: other.id,
        task: undefined,
      });
    });

    it("a role-less task links for any role", () => {
      const run = start("feat");
      const [any] = addTasks(db, { root }, run, swarmOf("feat"), coord(), [{ title: "anyone" }]);
      expect(spawn("swarm-feat-tester", ref(any))).toEqual({ run: run.id, task: any!.id });
    });

    it("a mesh swarm checks the role too", () => {
      const run = start("meshy");
      const [c] = addTasks(db, { root }, run, swarmOf("meshy"), coord(), [
        { title: "C", role: "coder" },
      ]);
      expect(spawn("swarm-meshy-tester", ref(c))).toEqual({ run: run.id, task: undefined });
      expect(spawn("swarm-meshy-coder", ref(c))).toEqual({ run: run.id, task: c!.id });
    });

    it("a re-spawn for a reopened, done or failed task of the role still links", () => {
      const run = start("feat");
      const [reopened, done, failed] = addTasks(db, { root }, run, swarmOf("feat"), coord(), [
        { title: "reopened", role: "coder" },
        { title: "done", role: "coder" },
        { title: "failed", role: "coder" },
      ]);
      for (const [t, status] of [
        [reopened, "failed"],
        [done, "done"],
        [failed, "failed"],
      ] as const) {
        claimTask(db, run, swarmOf("feat"), worker("WR"), t!.id);
        updateTask(db, run, worker("WR"), { task: t!.id, status, result: "x" });
      }
      updateTask(db, run, coord(), { task: reopened!.id, status: "pending" });
      expect(db.swarm.taskGet(reopened!.id)?.status).toBe("pending");
      for (const t of [reopened, done, failed])
        expect(spawn("swarm-feat-coder", `retry ${ref(t)}`)).toEqual({ run: run.id, task: t!.id });
    });
  });

  describe("a single reference otherwise keeps its old behaviour", () => {
    it("links the role's task whatever its state; another role's task decides only the run", () => {
      const run = start("feat");
      const [done, forTester, pending] = addTasks(db, { root }, run, swarmOf("feat"), coord(), [
        { title: "done", role: "coder" },
        { title: "tester's", role: "tester" },
        { title: "pending", role: "coder" },
      ]);
      claimTask(db, run, swarmOf("feat"), worker("S1"), done!.id);
      updateTask(db, run, worker("S1"), { task: done!.id, status: "done" });
      expect(spawn("swarm-feat-coder", `redo ${ref(done)}`)).toEqual({
        run: run.id,
        task: done!.id,
      });
      expect(spawn("swarm-feat-coder", `look at ${ref(forTester)}`)).toEqual({
        run: run.id,
        task: undefined,
      });
      expect(spawn("swarm-feat-coder", ref(pending))).toEqual({
        run: run.id,
        task: pending!.id,
      });
    });

    it("another swarm's task is not linked and does not move the run", () => {
      const run = start("feat");
      const lineRun = start("line");
      const [foreign] = addTasks(db, { root }, lineRun, swarmOf("line"), coord(), [{ title: "x" }]);
      expect(spawn("swarm-feat-coder", ref(foreign))).toEqual({ run: run.id, task: undefined });
    });

    it("a task of a finished run is not linked; the default run is used", () => {
      const old = start("feat", "old");
      const [t] = addTasks(db, { root }, old, swarmOf("feat"), coord(), [
        { title: "t", role: "coder" },
      ]);
      finishRun(getContext(root), db, old, coord(), { status: "cancelled" });
      const run = start("feat", "new");
      expect(spawn("swarm-feat-coder", ref(t))).toEqual({ run: run.id, task: undefined });
    });

    it("an unknown id links nothing", () => {
      const run = start("feat");
      expect(spawn("swarm-feat-coder", "task #987654")).toEqual({ run: run.id, task: undefined });
    });

    it("no reference at all links nothing", () => {
      const run = start("feat");
      addTasks(db, { root }, run, swarmOf("feat"), coord(), [{ title: "A", role: "coder" }]);
      expect(spawn("swarm-feat-coder", "write some code")).toEqual({
        run: run.id,
        task: undefined,
      });
      expect(spawn("swarm-feat-coder", "")).toEqual({ run: run.id, task: undefined });
    });

    it("only `task #N` counts: `task:N`, a bare `#N` and `tasks 3` do not", () => {
      expect(taskRefs("task:5 and #6, tasks 7, subtask #8x")).toEqual([]);
      expect(taskRefs("Task #12, TASK # 13 and task\t#14")).toEqual([12, 13, 14]);
      expect(taskRef("task #5")).toBe(5);
      expect(taskRef("task #5 and task #6")).toBeUndefined();
      expect(taskRef(undefined)).toBeUndefined();
      const run = start("feat");
      const [a, b] = addTasks(db, { root }, run, swarmOf("feat"), coord(), [
        { title: "A", role: "coder" },
        { title: "B", role: "coder" },
      ]);
      // `#b` is not a reference, so `task #a` is the only one
      expect(spawn("swarm-feat-coder", `${ref(a)}; also #${b!.id} and task:${b!.id}`)).toEqual({
        run: run.id,
        task: a!.id,
      });
    });
  });

  describe("topologies", () => {
    it("a mesh swarm links by role as well", () => {
      const run = start("meshy");
      const [a, b] = addTasks(db, { root }, run, swarmOf("meshy"), coord(), [
        { title: "A", role: "coder" },
        { title: "B", role: "tester" },
      ]);
      expect(spawn("swarm-meshy-coder", `${ref(a)} / ${ref(b)}`)).toEqual({
        run: run.id,
        task: a!.id,
      });
      expect(spawn("swarm-meshy-tester", `${ref(a)} / ${ref(b)}`)).toEqual({
        run: run.id,
        task: b!.id,
      });
    });

    it("a mesh swarm's role-less tasks are candidates too", () => {
      const run = start("meshy");
      const [a, any] = addTasks(db, { root }, run, swarmOf("meshy"), coord(), [
        { title: "A", role: "tester" },
        { title: "anyone" },
      ]);
      expect(spawn("swarm-meshy-coder", `${ref(a)} for the tester, ${ref(any)} for you`)).toEqual({
        run: run.id,
        task: any!.id,
      });
    });

    it("a pipeline swarm links by its own roles", () => {
      const run = start("line");
      const [p, b] = addTasks(db, { root }, run, swarmOf("line"), coord(), [
        { title: "plan", role: "plan" },
        { title: "build", role: "build" },
      ]);
      expect(spawn("swarm-line-build", `${ref(p)} was planned; build ${ref(b)}`)).toEqual({
        run: run.id,
        task: b!.id,
      });
    });
  });

  describe("fail open", () => {
    it("an unknown agent type is not a swarm spawn", () => {
      expect(
        reserveSpawn(db, cfg, { agentType: "general-purpose", prompt: "task #1 and task #2" }),
      ).toBeUndefined();
    });

    it("a denied spawn (role at capacity) still denies with several references", () => {
      const run = start("feat");
      const [a, b] = addTasks(db, { root }, run, swarmOf("feat"), coord(), [
        { title: "A", role: "coder" },
        { title: "B", role: "coder" },
      ]);
      for (let i = 0; i < 3; i++)
        reserveSpawn(db, cfg, {
          agentType: "swarm-feat-coder",
          sessionId: "S",
          toolUseId: `fill-${i}`,
        });
      const d = reserveSpawn(db, cfg, {
        agentType: "swarm-feat-coder",
        prompt: `${ref(a)} and ${ref(b)}`,
        sessionId: "S",
        toolUseId: "over",
      });
      expect(d?.decision).toBe("deny");
      for (let i = 0; i < 3; i++) releaseSpawn(db, `fill-${i}`);
    });

    it("requireRun with only finished runs' tasks named denies as no_run", () => {
      const old = start("feat", "old");
      const [a, b] = addTasks(db, { root }, old, swarmOf("feat"), coord(), [
        { title: "a", role: "coder" },
        { title: "b", role: "coder" },
      ]);
      finishRun(getContext(root), db, old, coord(), { status: "cancelled" });
      const d = reserveSpawn(db, cfg, {
        agentType: "swarm-feat-coder",
        prompt: `${ref(a)} and ${ref(b)}`,
        sessionId: "S",
        requireRun: true,
      });
      expect(d).toMatchObject({ decision: "deny", code: "no_run" });
    });

    it("a very long prompt naming many tasks does not throw", () => {
      const run = start("feat");
      const [a] = addTasks(db, { root }, run, swarmOf("feat"), coord(), [
        { title: "A", role: "coder" },
      ]);
      const filler = Array.from({ length: 300 }, (_, i) => `see task #${5000 + i}`).join("; ");
      expect(spawn("swarm-feat-coder", `${ref(a)}. ${filler}`)).toEqual({
        run: run.id,
        task: a!.id,
      });
    });
  });
});
