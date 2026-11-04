/**
 * Swarm plan advice (docs/design/adjudicator.md §16): after `em_swarm plan` adds its tasks, ONE
 * batched adjudication scores them all, stores a `plan` row per task keyed by (run, task), and
 * returns one suggestion line per task for the coordinator: the agent to spawn, the `model` to
 * pass on the Agent call and the effort (advice only), plus a note when the scorer would pick a
 * different role than the plan did.
 *
 * Everything here is a no-op while the adjudicator is off or `surfaces.plan` is false, and it
 * never throws: the plan is already committed when this runs, so a scoring failure costs the
 * advice, never the plan.
 */

import type { Config } from "../config.js";
import type { ProjectContext } from "../context.js";
import type { StorageAdapter } from "../storage/adapter.js";
import type { RunRow, SwarmSpec, TaskRow } from "../swarm/types.js";
import { type Adjudication, adjudicate, type EngineOptions } from "./engine.js";
import { subagentModelForced } from "./env.js";
import { complexityBucket, topIntent } from "./heuristic.js";
import { biasFromRows, type LearningConfig } from "./learn.js";
import { type AdjudicationRequest, type AdjudicatorProvider, TIERS, type Tier } from "./types.js";

/** Text of one task sent to the scorer (title + detail), before redaction and the provider cap. */
const TASK_TEXT_MAX = 4000;

/** Plan advice runs: the adjudicator is enabled and its plan surface is on. */
export function planAdviceEnabled(config: Pick<Config, "adjudicator">): boolean {
  const a = config.adjudicator;
  return !!a?.enabled && a.surfaces.plan !== false;
}

/** The env flag that makes Claude Code ignore `model` on the Agent call (Claude Code's on/off rule). */
export function modelForced(env: NodeJS.ProcessEnv = process.env): boolean {
  return subagentModelForced(env);
}

export interface PlanAdvice {
  taskId: number;
  /** The planned role, if any. */
  role?: string | undefined;
  /** The scorer's role, when it is a role of the swarm. */
  suggestedRole?: string | undefined;
  /** subagent_type to spawn: the planned role's agent, else the suggested role's. */
  agentType?: string | undefined;
  /** Always one of the Agent `model` values (haiku | sonnet | opus | fable), or undefined. */
  model?: Tier | undefined;
  effort: string;
  complexity: number;
  confidence: number;
  rowId?: number | undefined;
}

export interface PlanOptions {
  /** Test seam / long-lived instance; null forces the heuristic. */
  provider?: AdjudicatorProvider | null | undefined;
  sessionId?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  now?: (() => number) | undefined;
  log?: ((line: string) => void) | undefined;
}

/** The request for one planned task. */
export function taskRequest(task: TaskRow, swarm: SwarmSpec): AdjudicationRequest {
  const text = [task.title, task.detail ?? ""].join("\n").trim().slice(0, TASK_TEXT_MAX);
  const hints: NonNullable<AdjudicationRequest["hints"]> = {
    roles: swarm.roles.map((r) => ({ name: r.role, description: r.description })),
    files: task.files.length,
    deps: task.deps.length,
  };
  if (task.role) hints.role = task.role;
  return { key: `#${task.id}`, surface: "plan", text, hints };
}

/**
 * The engine's per-request bias from the learned buckets (learn.ts), read once per batch;
 * undefined when learning is off or nothing has been learned yet.
 */
export function learnedBias(db: StorageAdapter, cfg: Config["adjudicator"]): EngineOptions["bias"] {
  if (!cfg.learning.enabled) return undefined;
  let rows: ReturnType<StorageAdapter["adjudicator"]["biasAll"]>;
  try {
    rows = db.adjudicator.biasAll();
  } catch {
    return undefined;
  }
  if (!rows.length) return undefined;
  const learning = cfg.learning as LearningConfig;
  return (_req, f, h) =>
    biasFromRows(rows, learning, { complexity: h.complexity, intent: topIntent(f) ?? "none" });
}

const asTier = (s: string | undefined): Tier | undefined =>
  (TIERS as readonly string[]).includes(s ?? "") ? (s as Tier) : undefined;

function adviceOf(a: Adjudication, task: TaskRow, swarm: SwarmSpec): PlanAdvice {
  const v = a.verdict;
  const roles = new Map(swarm.roles.map((r) => [r.role, r]));
  const suggested = roles.has(v.role.choice) ? v.role.choice : undefined;
  const planned = task.role ?? undefined;
  const agentType = roles.get(planned ?? suggested ?? "")?.agentType;
  return {
    taskId: task.id,
    role: planned,
    suggestedRole: suggested,
    agentType,
    model: asTier(v.tier.choice),
    effort: v.effort,
    complexity: v.complexity,
    confidence: v.tier.confidence,
    rowId: a.rowId,
  };
}

/**
 * Score the tasks one plan call added, in ONE engine call (one batched provider request within
 * `timeouts.planMs`; the heuristic on any failure), and store a `plan` row per task by
 * (run, task). Returns [] when plan advice is off or nothing could be scored.
 */
export async function adjudicatePlan(
  ctx: Pick<ProjectContext, "config" | "root">,
  db: StorageAdapter,
  run: RunRow,
  swarm: SwarmSpec,
  tasks: readonly TaskRow[],
  opts: PlanOptions = {},
): Promise<PlanAdvice[]> {
  if (!tasks.length || !planAdviceEnabled(ctx.config)) return [];
  try {
    const cfg = ctx.config.adjudicator;
    const reqs = tasks.map((t) => taskRequest(t, swarm));
    const engine: EngineOptions = {
      config: cfg,
      store: db.adjudicator,
      context: "server",
      call: "inline",
      budgetMs: cfg.timeouts.planMs,
      row: {
        runId: run.id,
        sessionId: opts.sessionId ?? run.session_id ?? null,
        action: "advised",
      },
      rows: tasks.map((t) => ({ taskId: t.id })),
      roles: swarm.roles.map((r) => ({ name: r.role, description: r.description })),
      bias: learnedBias(db, cfg),
      projectRoot: ctx.root,
    };
    if (opts.provider !== undefined) engine.provider = opts.provider;
    if (opts.env) engine.env = opts.env;
    if (opts.now) engine.now = opts.now;
    if (opts.log) engine.log = opts.log;
    const out = await adjudicate(reqs, engine);
    return out.map((a, i) => adviceOf(a, tasks[i] as TaskRow, swarm));
  } catch (err) {
    opts.log?.(`adjudicator: plan advice skipped: ${(err as Error)?.message ?? String(err)}`);
    return [];
  }
}

const r2 = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

/** One line per task, e.g. "#5 → swarm-feature-coder · model haiku · effort low (complexity 1, conf 0.82)". */
export function planLines(advice: readonly PlanAdvice[]): string[] {
  return advice.map((a) => {
    const parts = [
      a.agentType ?? "any role",
      ...(a.model ? [`model ${a.model}`] : []),
      `effort ${a.effort}`,
    ];
    let line = `#${a.taskId} → ${parts.join(" · ")} (complexity ${complexityBucket(a.complexity)}, conf ${r2(a.confidence)})`;
    if (a.suggestedRole && a.role && a.suggestedRole !== a.role)
      line += `; role suggested: ${a.suggestedRole} (planned: ${a.role})`;
    else if (a.suggestedRole && !a.role) line += `; role suggested: ${a.suggestedRole}`;
    return line;
  });
}

/** The advice block `em_swarm plan` appends; "" when there is no advice. */
export function planAdviceBlock(
  advice: readonly PlanAdvice[],
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!advice.length) return "";
  const head = modelForced(env)
    ? "Adjudicator suggestions (CLAUDE_CODE_SUBAGENT_MODEL_FORCE is set, so Claude Code ignores `model` on the Agent call; informational only):"
    : "Adjudicator suggestions: pass the model as `model` on each Agent call (effort is advice; it is set only in the agent file):";
  return [head, ...planLines(advice)].join("\n");
}
