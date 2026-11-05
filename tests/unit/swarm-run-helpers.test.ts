import { describe, expect, it } from "vitest";
import { parseHash, routeHash } from "../../src/ui/web/route.js";
import {
  activityPerMinute,
  capacity,
  clip,
  filterRuns,
  heartbeat,
  progress,
  runFilterCounts,
  sortWorkers,
  startCommand,
  workerTasks,
} from "../../src/ui/web/swarm/run-helpers.js";

type Timeline = Parameters<typeof activityPerMinute>[0];

const MIN = 60_000;

function timeline(
  start: number,
  end: number,
  segs: Array<[number, number, number]>,
  extra: Partial<Timeline> = {},
): Timeline {
  return {
    start,
    end,
    cut: false,
    workers: [{ segments: segs.map(([s, e, n]) => ({ start: s, end: e, n })) }],
    ...extra,
  };
}

function worker(id: string, status: "running" | "done" | "stale", spawned: number) {
  return {
    run_id: "r",
    agent_id: id,
    agent_type: "swarm-feature-coder",
    role: "coder",
    status,
    task_id: null,
    prompt: null,
    session_id: null,
    spawned_at: spawned,
    last_ts: spawned,
    ended_at: null,
    tool_calls: 0,
    errors: 0,
    last_tool: null,
    summary: null,
  };
}

function run(id: string, status: "active" | "done" | "failed" | "cancelled") {
  const tasks = { pending: 0, active: 0, done: 0, failed: 0, blocked: 0, total: 0 };
  return {
    id,
    swarm: "feature",
    goal: "g",
    status,
    topology: "hierarchical",
    created_at: 0,
    updated_at: 0,
    ended_at: null,
    counts: { tasks, workers: { running: 0, done: 0, stale: 0 } },
  };
}

describe("router: sub-paths", () => {
  it("parses a view, its sub-path and params", () => {
    expect(parseHash("#/swarm/config?swarm=feature&role=ui")).toEqual({
      view: "swarm",
      sub: "config",
      params: { swarm: "feature", role: "ui" },
    });
  });
  it("keeps existing links: no sub-path is null", () => {
    expect(parseHash("#/swarm?run=20261105-12d798")).toEqual({
      view: "swarm",
      sub: null,
      params: { run: "20261105-12d798" },
    });
    expect(parseHash("#/explore?file=src/x.ts")).toMatchObject({ view: "explore", sub: null });
  });
  it("drops an unknown sub-path, and a sub-path on a view that has none", () => {
    expect(parseHash("#/swarm/nope").sub).toBeNull();
    expect(parseHash("#/usage/config").sub).toBeNull();
    expect(parseHash("#/nowhere/config")).toEqual({ view: "overview", sub: null, params: {} });
    expect(parseHash("")).toEqual({ view: "overview", sub: null, params: {} });
  });
  it("builds hashes that parse back, without empty params", () => {
    const h = routeHash("swarm/config", { swarm: "feature", role: undefined });
    expect(h).toBe("/swarm/config?swarm=feature");
    expect(parseHash(`#${h}`)).toEqual({
      view: "swarm",
      sub: "config",
      params: { swarm: "feature" },
    });
    expect(routeHash("swarm")).toBe("/swarm");
  });
});

describe("activityPerMinute", () => {
  it("buckets events per minute over the run", () => {
    const t0 = 1_000_000;
    const a = activityPerMinute(
      timeline(t0, t0 + 3 * MIN, [
        [t0 + 1000, t0 + 2000, 6],
        [t0 + 2 * MIN + 1000, t0 + 2 * MIN + 2000, 3],
      ]),
    );
    expect(a.bucketMs).toBe(MIN);
    expect(a.values).toEqual([6, 0, 3]);
    expect(a.peak).toBe(6);
    expect(a.total).toBe(9);
  });
  it("widens the buckets to stay under the cap and reports the rate per minute", () => {
    const t0 = 0;
    const a = activityPerMinute(timeline(t0, t0 + 60 * MIN, [[t0 + 1000, t0 + 1000, 10]]), 30);
    expect(a.bucketMs).toBe(2 * MIN);
    expect(a.values).toHaveLength(30);
    // 10 events in a 2-minute bucket is 5 a minute
    expect(a.values[0]).toBe(5);
  });
  it("spreads a long segment over the buckets it overlaps", () => {
    const a = activityPerMinute(timeline(0, 4 * MIN, [[0, 4 * MIN, 8]]));
    expect(a.values).toEqual([2, 2, 2, 2]);
    expect(a.total).toBe(8);
  });
  it("starts at `from` when the timeline was cut, skipping older segments", () => {
    const a = activityPerMinute(
      timeline(
        0,
        10 * MIN,
        [
          [MIN, MIN + 10, 50],
          [9 * MIN, 9 * MIN + 10, 4],
        ],
        {
          cut: true,
          from: 8 * MIN,
        },
      ),
    );
    expect(a.values).toEqual([0, 4]);
    expect(a.total).toBe(4);
  });
  it("is one zero bucket for an empty run", () => {
    const a = activityPerMinute(timeline(5, 5, []));
    expect(a.values).toEqual([0]);
    expect(a.peak).toBe(0);
  });
});

describe("workers", () => {
  it("heartbeat: quiet when stale, or running past staleMs", () => {
    expect(heartbeat({ status: "running", last_ts: 1000 }, 2000, 5000)).toEqual({
      age: 1000,
      quiet: false,
    });
    expect(heartbeat({ status: "running", last_ts: 0 }, 6000, 5000).quiet).toBe(true);
    expect(heartbeat({ status: "stale", last_ts: 1000 }, 1000, 5000).quiet).toBe(true);
    expect(heartbeat({ status: "done", last_ts: 0 }, 1e9, 5000).quiet).toBe(false);
    expect(heartbeat({ status: "running", last_ts: 5000 }, 1000, 5000).age).toBe(0);
  });
  it("sorts running, then stale, then done, in spawn order", () => {
    const ids = sortWorkers([
      worker("d1", "done", 1),
      worker("r2", "running", 5),
      worker("s1", "stale", 2),
      worker("r1", "running", 3),
    ]).map((w) => w.agent_id);
    expect(ids).toEqual(["r1", "r2", "s1", "d1"]);
  });
  it("lists a worker's tasks, newest first", () => {
    const t = (id: number, agent: string | null, updated: number) => ({
      id,
      agent_id: agent,
      updated_at: updated,
    });
    expect(workerTasks([t(1, "a", 5), t(2, "b", 9), t(3, "a", 7)], "a").map((x) => x.id)).toEqual([
      3, 1,
    ]);
  });
});

describe("runs and swarms", () => {
  const runs = [run("1", "active"), run("2", "done"), run("3", "failed"), run("4", "cancelled")];
  it("filters runs; failed covers cancelled", () => {
    expect(filterRuns(runs, "all")).toHaveLength(4);
    expect(filterRuns(runs, "failed").map((r) => r.id)).toEqual(["3", "4"]);
    expect(runFilterCounts(runs)).toEqual({ all: 4, active: 1, done: 1, failed: 2 });
  });
  it("progress is 0..1 and 0 without tasks", () => {
    expect(progress({ done: 3, total: 4 })).toBe(0.75);
    expect(progress({ done: 0, total: 0 })).toBe(0);
  });
  it("capacity flags more slots than max_agents", () => {
    expect(capacity([{ count: 2 }, { count: 3 }], 4)).toEqual({ total: 5, max: 4, over: true });
    expect(capacity([{ count: 1 }], 4).over).toBe(false);
  });
  it("start command and clip", () => {
    expect(startCommand("feature")).toBe("/eminiar:em-swarm feature <goal>");
    expect(clip("short", 10)).toEqual({ text: "short", clipped: false });
    const c = clip("line one is here\nline two goes on and on", 20);
    expect(c).toEqual({ text: "line one is here…", clipped: true });
  });
});
