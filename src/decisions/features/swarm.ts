import { createHash } from "node:crypto";
import { join } from "node:path";
import { resolveAdjudicator } from "../../adjudicator/config.js";
import { type AdjudicatorConfig, loadConfig } from "../../config.js";
import type { ProjectContext } from "../../context.js";
import type { StorageAdapter } from "../../storage/adapter.js";
import type { SwarmEventRow, TaskRow } from "../../swarm/types.js";
import { pluginRoot } from "../../version.js";
import { decisionFeatureActive, decisionFeatureConfig } from "../config.js";
import type { DecisionFeatureModule } from "../feature.js";
import { claimJobSlot, providerAllowsJob, releaseJobSlot, spawnDecisionJob } from "../job.js";
import {
  clears,
  DECISION_USABLE,
  type Decision,
  type DecisionClient,
  type DecisionJob,
  type DecisionQuestionSpec,
} from "../types.js";

/**
 * Feature "swarm" (docs/design/jev-integration-options.md, option E): typed checks on a task's
 * trail, asked by a detached job so the reply never waits. The verdicts surface only as a badge
 * with its probability on `em_swarm status`; nothing acts on them, and nothing is released.
 * Shadow, off, unsupported and an open breaker leave the status text byte-identical to before.
 */

const QUESTIONS: Record<string, DecisionQuestionSpec> = {
  stalled: {
    name: "stalled",
    kind: "yes_no",
    instructions:
      "Does the trail of {item} show a task that has stalled: no real progress lately although it is not finished?",
  },
  looping: {
    name: "looping",
    kind: "yes_no",
    instructions:
      "Does the trail of {item} show a worker looping: repeating the same steps or failures without getting closer to done?",
  },
  needs_human: {
    name: "needs_human",
    kind: "yes_no",
    instructions:
      "Does the trail of {item} show that the task needs a human decision or input before it can continue?",
  },
  done_claims_match_evidence: {
    name: "done_claims_match_evidence",
    kind: "yes_no",
    instructions:
      "Do the result and the trail of {item} support the claim that the task is finished as stated?",
  },
};

/** Statuses that close a task; only a done claim is checked against its evidence. */
const CLOSED = new Set(["done", "failed", "blocked"]);
const MAX_TASKS = 10;
const TRAIL_EVENTS = 8;
/** One spawn per task per window in this process. */
const IN_FLIGHT_MS = 30_000;
/** A task whose last attempt failed is not tried again for this long. */
const RETRY_AFTER_FAIL_MS = 5 * 60_000;
/** A verdict older than this is not shown. */
const BADGE_MAX_AGE_MS = 30 * 60_000;
const inFlight = new Map<string, number>();

interface SwarmPayload {
  run: string;
  tasks: number[];
}

const firstLine = (s: string) => s.trim().split("\n")[0] ?? "";

function questionsFor(t: TaskRow) {
  const qs = [QUESTIONS.stalled!, QUESTIONS.looping!, QUESTIONS.needs_human!];
  if (t.status === "done") qs.push(QUESTIONS.done_claims_match_evidence!);
  return qs;
}

/** The events that tell a task's story: its own plus its holder's, without tool calls. */
function trailOf(t: TaskRow, events: SwarmEventRow[]): SwarmEventRow[] {
  return events
    .filter(
      (e) =>
        e.kind !== "tool" &&
        e.kind !== "tool_error" &&
        (e.task_id === t.id || (t.agent_id !== null && e.agent_id === t.agent_id)),
    )
    .slice(-TRAIL_EVENTS);
}

/** Changes whenever the trail does; the verdict is asked again only then. */
export function trailHash(t: TaskRow, events: SwarmEventRow[]): string {
  const h = createHash("sha256");
  h.update(`${t.id}|${t.status}|${t.updated_at}|${t.result ?? ""}`);
  for (const e of trailOf(t, events)) h.update(`|${e.id}`);
  return h.digest("hex").slice(0, 12);
}

function itemText(
  db: StorageAdapter,
  t: TaskRow,
  events: SwarmEventRow[],
  now: number,
  max: number,
): string {
  const w = t.agent_id
    ? db.swarm.workers(t.run_id).find((x) => x.agent_id === t.agent_id)
    : undefined;
  const age = (ts: number) => `${Math.max(0, Math.round((now - ts) / 60_000))}m ago`;
  const lines = [
    `task #${t.id}: ${t.title}`,
    `status: ${t.status}${t.auto_closed ? " (auto-closed: the worker never reported)" : ""}`,
    ...(t.result ? [`result: ${firstLine(t.result)}`] : []),
    ...(w
      ? [
          `worker: ${w.role}, ${w.tool_calls} tool calls, ${w.errors} failed, last seen ${age(w.last_ts)}`,
        ]
      : []),
    "trail (oldest first):",
    ...trailOf(t, events).map(
      (e) => `${age(e.ts)} ${e.kind}${e.text ? ` ${firstLine(e.text)}` : ""}`,
    ),
  ];
  return lines.join("\n").slice(0, max);
}

/** Child side: judge the named tasks and record one row per task. Never throws. */
async function runJob(job: DecisionJob, client: DecisionClient, db: StorageAdapter) {
  const p = job.payload as Partial<SwarmPayload> | undefined;
  if (!p || typeof p.run !== "string" || !Array.isArray(p.tasks)) return;
  const run = p.run;
  if (!client.active()) return;
  const events = db.swarm.events(run, { limit: 1000 });
  const now = Date.now();
  let bgMs = 3000;
  let maxChars = 1500;
  let flagAbove = 0.7;
  try {
    const sc = loadConfig(job.projectRoot).adjudicator.features.swarm;
    flagAbove = sc.flagAbove;
    bgMs = sc.bgMs;
    maxChars = sc.maxChars;
  } catch {
    // keep the defaults
  }
  for (const id of p.tasks.filter((n) => Number.isInteger(n)).slice(0, MAX_TASKS)) {
    const t = db.swarm.taskGet(id);
    if (!t || t.run_id !== run) continue;
    const hash = trailHash(t, events);
    const qs = questionsFor(t);
    try {
      await client.ask(
        {
          feature: "swarm",
          subject: `run:${run}/task:${id}`,
          context: "Judge a swarm task from its title, status, result and trail.",
          items: [{ id: `task:${id}`, text: itemText(db, t, events, now, maxChars) }],
          questions: qs,
          baseline: { task: id, flags: [] },
          budgetMs: bgMs,
          ...(job.sessionId ? { sessionId: job.sessionId } : {}),
          questionVersion: feature.questionVersion,
        },
        (a): Decision => {
          const item = a[`task:${id}`];
          const flags = qs.flatMap((q) => {
            const x = item?.[q.name];
            if (x?.kind !== "yes_no") return [];
            // done_claims_match_evidence flags when the claim does NOT hold.
            return q.name === "done_claims_match_evidence"
              ? [{ q: "claim_unsupported", p: 1 - x.p, c: x.calibrated }]
              : [{ q: q.name, p: x.p, c: x.calibrated }];
          });
          // changed counts the flags that would show as a badge (clear flagAbove), so agreement
          // with the baseline (no flags) and "applied" mean what the dashboard says they mean.
          const shown = flags.filter((f) =>
            clears({ kind: "yes_no", p: f.p, calibrated: f.c }, flagAbove),
          ).length;
          return { decision: { task: id, hash, flags }, changed: shown };
        },
      );
    } catch {
      // the client never throws; belt and braces for a background job
    }
  }
}

export const feature: DecisionFeatureModule = {
  questionVersion: 1,
  runJob,
};

// --- MCP side (em_swarm) -----------------------------------------------------------------

function swarmCfg(cfg: AdjudicatorConfig | undefined) {
  return cfg && decisionFeatureActive(cfg, "swarm")
    ? decisionFeatureConfig(cfg, "swarm")
    : undefined;
}

/**
 * Start the background judge for `tasks` of `run`. Fire and forget: the caller's reply does not
 * wait. Skipped when the feature is not active; a task is skipped while a judge for it started a
 * moment ago, after a failed attempt for a few minutes, or while it has a verdict of this mode.
 */
export function kickSwarmJudge(
  ctx: ProjectContext,
  db: StorageAdapter,
  run: string,
  tasks: TaskRow[],
  sessionId?: string,
  now = Date.now(),
): boolean {
  const cfg = ctx.config.adjudicator;
  if (!swarmCfg(cfg) || !tasks.length) return false;
  const fc = swarmCfg(cfg)!;
  const mode = fc.shadow ? "shadow" : "live";
  const events = db.swarm.events(run, { limit: 1000 });
  // Active and closed tasks are asked again only when the trail changed since their last verdict
  // of the current mode (a shadow verdict does not hide the live one; the answer is cached).
  const seen = new Map<number, string>();
  const decided = new Set<number>();
  const failed = new Set<number>();
  for (const r of db.decisions.latestBySubject("swarm", `run:${run}/`, 100)) {
    const m = /\/task:(\d+)$/.exec(r.subject);
    const tid = m ? Number(m[1]) : undefined;
    if (tid !== undefined && !decided.has(tid)) {
      decided.add(tid);
      if (!DECISION_USABLE.includes(r.status) && now - r.ts < RETRY_AFTER_FAIL_MS) failed.add(tid);
    }
    const d = r.decision as { task?: number; hash?: string } | null;
    if (r.mode === mode && d?.task !== undefined && d.hash && !seen.has(d.task))
      seen.set(d.task, d.hash);
  }
  const todo = tasks
    .filter((t) => {
      if (t.status !== "active" && !CLOSED.has(t.status)) return false;
      if (failed.has(t.id)) return false;
      const last = inFlight.get(`${run}/${t.id}`);
      if (last !== undefined && now - last < IN_FLIGHT_MS) return false;
      return seen.get(t.id) !== trailHash(t, events);
    })
    .slice(0, MAX_TASKS);
  if (!todo.length) return false;
  // The same gate as the hooks: a down/capped/unsupported provider or a judge in flight spawns nothing.
  if (!providerAllowsJob(cfg, db, "swarm", now)) return false;
  const payload: SwarmPayload = { run, tasks: todo.map((t) => t.id) };
  const job: DecisionJob = {
    v: 1,
    feature: "swarm",
    projectRoot: ctx.root,
    ...(sessionId ? { sessionId } : {}),
    payload,
  };
  if (!claimJobSlot(db, job, now)) return false;
  const ok = spawnDecisionJob(job, { script: join(pluginRoot(), "dist", "hook.js") });
  if (!ok) releaseJobSlot(db, job);
  if (ok) for (const t of todo) inFlight.set(`${run}/${t.id}`, now);
  return ok;
}

const LABEL: Record<string, string> = {
  stalled: "maybe stalled",
  looping: "maybe looping",
  needs_human: "may need a human",
  claim_unsupported: "done claim may not match the evidence",
};

/**
 * Badges for `em_swarm status`: task id → text. Empty unless the feature is active and live,
 * and only for fresh, usable verdicts whose probability reaches flagAbove.
 */
export function swarmBadges(
  cfg: AdjudicatorConfig | undefined,
  db: StorageAdapter,
  run: string,
  now = Date.now(),
): Map<number, string> {
  const out = new Map<number, string>();
  const fc = swarmCfg(cfg);
  if (!fc || fc.shadow) return out;
  const flagAbove = (fc as { flagAbove?: number }).flagAbove ?? 0.7;
  // A verdict is shown only while it is the active provider's and that provider is reachable.
  let active: string | undefined;
  try {
    active = resolveAdjudicator(cfg as AdjudicatorConfig, { context: "server" }).provider;
  } catch {
    active = cfg?.provider;
  }
  if (active) {
    const ps = db.adjudicator?.providerState(active);
    const soon = ps?.retryAt !== null && ps?.retryAt !== undefined && now < ps.retryAt;
    if (soon && (ps?.state === "open" || ps?.state === "half_open" || ps?.state === "slow"))
      return out;
  }
  const seen = new Set<number>();
  for (const r of db.decisions.latestBySubject("swarm", `run:${run}/`, 100)) {
    const d = r.decision as {
      task?: number;
      flags?: Array<{ q: string; p: number; c?: boolean }>;
    } | null;
    if (d?.task === undefined || seen.has(d.task)) continue;
    seen.add(d.task);
    if (r.provider && active && r.provider !== active) continue;
    if (r.mode !== "live" || !DECISION_USABLE.includes(r.status) || now - r.ts > BADGE_MAX_AGE_MS)
      continue;
    const top = (d.flags ?? [])
      .filter(
        (f) =>
          LABEL[f.q] && clears({ kind: "yes_no", p: f.p, calibrated: f.c === true }, flagAbove),
      )
      .sort((a, b) => b.p - a.p)[0];
    if (top) out.set(d.task, `${LABEL[top.q]} (${top.p.toFixed(2)})`);
  }
  return out;
}
