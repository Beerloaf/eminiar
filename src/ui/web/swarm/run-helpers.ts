// Pure helpers of the swarm run dashboard (#/swarm): no DOM, no fetch. The types below are
// the structural slices of ../api.ts these helpers read, declared here so the node build
// (tests/unit/swarm-run-helpers.test.ts) never loads api.ts and its browser globals.
import type { RunStatus as SwarmRunStatus, WorkerStatus } from "../../../swarm/types.js";

interface Segment {
  start: number;
  end: number;
  n: number;
}
interface Timeline {
  start: number;
  end: number;
  cut: boolean;
  from?: number | null;
  workers: Array<{ segments: Segment[] }>;
}
interface WorkerLike {
  status: WorkerStatus;
  spawned_at: number;
  last_ts: number;
}
interface TaskLike {
  agent_id: string | null;
  updated_at: number;
}
interface RunLike {
  status: SwarmRunStatus;
}

const MINUTE = 60_000;

/**
 * Activity of the run as events per minute, for the hero's sparkline. Built from the
 * timeline's per-worker segments (no extra request): each segment's events are spread over
 * the buckets it overlaps. Buckets are whole minutes, widened so there are at most `max`.
 */
export function activityPerMinute(
  timeline: Timeline,
  max = 30,
): { values: number[]; bucketMs: number; peak: number; total: number } {
  const from = timeline.cut && timeline.from ? timeline.from : timeline.start;
  const span = Math.max(0, timeline.end - from);
  const bucketMs = Math.max(MINUTE, Math.ceil(span / Math.max(1, max) / MINUTE) * MINUTE);
  const n = Math.max(1, Math.ceil(span / bucketMs));
  const counts = new Array<number>(n).fill(0);
  let total = 0;
  for (const w of timeline.workers)
    for (const s of w.segments) {
      if (s.n <= 0 || s.end < from) continue;
      total += s.n;
      const a = Math.max(from, s.start);
      const b = Math.max(a, Math.min(timeline.end, s.end));
      const first = Math.min(n - 1, Math.max(0, Math.floor((a - from) / bucketMs)));
      const last = Math.min(n - 1, Math.max(0, Math.floor((b - from) / bucketMs)));
      if (first === last || b === a) {
        counts[first]! += s.n;
        continue;
      }
      // Spread by overlap, so a long segment does not spike a single bucket.
      for (let i = first; i <= last; i++) {
        const lo = Math.max(a, from + i * bucketMs);
        const hi = Math.min(b, from + (i + 1) * bucketMs);
        counts[i]! += (s.n * Math.max(0, hi - lo)) / (b - a);
      }
    }
  const perMin = bucketMs / MINUTE;
  const values = counts.map((c) => Math.round((c / perMin) * 10) / 10);
  return { values, bucketMs, peak: Math.max(0, ...values), total };
}

/** Heartbeat of a worker: ms since its last event, and whether it has gone quiet. */
export function heartbeat(
  w: Pick<WorkerLike, "status" | "last_ts">,
  now: number,
  staleMs: number,
): { age: number; quiet: boolean } {
  const age = Math.max(0, now - w.last_ts);
  return { age, quiet: w.status === "stale" || (w.status === "running" && age > staleMs) };
}

const WORKER_ORDER: Record<WorkerStatus, number> = { running: 0, stale: 1, done: 2 };

/** Running first, then stale, then done; spawn order inside each group. */
export function sortWorkers<W extends WorkerLike>(workers: W[]): W[] {
  return [...workers].sort(
    (a, b) => WORKER_ORDER[a.status] - WORKER_ORDER[b.status] || a.spawned_at - b.spawned_at,
  );
}

/** The tasks a worker holds or has held, newest first. */
export function workerTasks<T extends TaskLike>(tasks: T[], agentId: string): T[] {
  return tasks.filter((t) => t.agent_id === agentId).sort((a, b) => b.updated_at - a.updated_at);
}

export type RunFilter = "all" | "active" | "done" | "failed";
export const RUN_FILTERS: RunFilter[] = ["all", "active", "done", "failed"];

const inFilter = (s: SwarmRunStatus, f: RunFilter): boolean =>
  f === "all" || (f === "failed" ? s === "failed" || s === "cancelled" : s === f);

/** Runs that pass a status filter chip; "failed" also covers cancelled runs. */
export const filterRuns = <R extends RunLike>(runs: R[], f: RunFilter): R[] =>
  runs.filter((r) => inFilter(r.status, f));

export function runFilterCounts(runs: RunLike[]): Record<RunFilter, number> {
  const out: Record<RunFilter, number> = { all: 0, active: 0, done: 0, failed: 0 };
  for (const r of runs) for (const f of RUN_FILTERS) if (inFilter(r.status, f)) out[f]++;
  return out;
}

/** Share of a run's tasks that closed (done), 0..1; 0 for a run with no tasks. */
export function progress(t: { done: number; total: number }): number {
  return t.total > 0 ? Math.min(1, t.done / t.total) : 0;
}

/** How many workers a configured swarm would run: Σ count, against max_agents. */
export function capacity(
  roles: Array<{ count: number }>,
  maxAgents: number,
): { total: number; max: number; over: boolean } {
  const total = roles.reduce((a, r) => a + Math.max(0, r.count), 0);
  return { total, max: maxAgents, over: maxAgents > 0 && total > maxAgents };
}

/** The Claude Code line that starts a run of a swarm. */
export const startCommand = (swarm: string, goal = "<goal>"): string =>
  `/eminiar:em-swarm ${swarm} ${goal}`;

/** Clip text for a preview: at most `max` characters, cut at a line end when one is near. */
export function clip(text: string, max: number): { text: string; clipped: boolean } {
  if (text.length <= max) return { text, clipped: false };
  const cut = text.lastIndexOf("\n", max);
  return { text: `${text.slice(0, cut > max * 0.6 ? cut : max).trimEnd()}…`, clipped: true };
}
