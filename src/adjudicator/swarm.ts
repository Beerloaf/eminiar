/**
 * Swarm plan advice (docs/design/adjudicator.md §16): after `em_swarm plan` adds its tasks, ONE
 * batched adjudication scores them all, stores a `plan` row per task keyed by (run, task), and
 * returns one suggestion line per task for the coordinator: the agent to spawn, the `model` and
 * `effort` to pass on the Agent call, plus a note when the scorer would pick a different role than
 * the plan did. An agent whose definition pins a model (or whose pin cannot be read) keeps it, like
 * apply mode: the line names the pin and what the adjudicator would pick, never a model to pass.
 *
 * Everything here is a no-op while the adjudicator is off or `surfaces.plan` is false, and it
 * never throws: the plan is already committed when this runs, so a scoring failure costs the
 * advice, never the plan.
 */

import type { Config } from "../config.js";
import type { ProjectContext } from "../context.js";
import type { StorageAdapter } from "../storage/adapter.js";
import type { RunRow, SwarmSpec, TaskRow } from "../swarm/types.js";
import { type AgentPin, resolveAgentPin } from "./agent-pin.js";
import { type Adjudication, adjudicate, type EngineOptions } from "./engine.js";
import { subagentModelForced } from "./env.js";
import { complexityBucket, topIntent } from "./heuristic.js";
import { biasFromRows, type LearningConfig } from "./learn.js";
import { isPinned, tierOf } from "./savings.js";
import {
  type AdjudicationRequest,
  type AdjudicatorProvider,
  AGENT_EFFORT_SINCE,
  TIERS,
  type Tier,
} from "./types.js";

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

/**
 * The agent's model pin as plan advice respects it: `pinned` (with the model) or `unknown` (the
 * definition cannot be read with certainty). Absent when the agent is unpinned or
 * apply.respectFrontmatter is off; then the model is advised as usual.
 */
export interface PlanPin {
  status: "pinned" | "unknown";
  model?: string | undefined;
  source?: AgentPin["source"];
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
  /** Set when the agent's model pin is respected: the line then names it instead of `model`. */
  pin?: PlanPin | undefined;
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

/** The pin plan advice respects for `agentType`, or undefined (unpinned / not respected). */
export function respectedPin(
  agentType: string | undefined,
  respectFrontmatter: boolean,
  lookup: (type: string) => AgentPin,
): PlanPin | undefined {
  if (!agentType || !respectFrontmatter) return undefined;
  const pin = lookup(agentType);
  if (pin.status === "pinned" && isPinned(pin.model))
    return { status: "pinned", model: pin.model, source: pin.source };
  if (pin.status === "unknown") return { status: "unknown", source: pin.source };
  return undefined;
}

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
    // One pin lookup per agent type (the swarm's generated agents, usually a handful).
    const env = opts.env ?? process.env;
    const pins = new Map<string, AgentPin>();
    const lookup = (type: string): AgentPin => {
      let p = pins.get(type);
      if (!p) {
        p = resolveAgentPin(type, { root: ctx.root, cwd: ctx.root, env });
        pins.set(type, p);
      }
      return p;
    };
    return out.map((a, i) => {
      const advice = adviceOf(a, tasks[i] as TaskRow, swarm);
      const pin = respectedPin(advice.agentType, cfg.apply.respectFrontmatter, lookup);
      if (pin) advice.pin = pin;
      return advice;
    });
  } catch (err) {
    opts.log?.(`adjudicator: plan advice skipped: ${(err as Error)?.message ?? String(err)}`);
    return [];
  }
}

const r2 = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

/** Where to remove a respected pin: swarm.yaml for the project agents eminiar generates. */
function pinHome(pin: PlanPin): string {
  return pin.source === "project" || pin.source === undefined
    ? "remove the pin in swarm.yaml"
    : `remove the ${pin.source} agent's model pin`;
}

/** "pinned opus (adjudicator would pick haiku; remove the pin in swarm.yaml to let it choose)". */
export function pinnedPart(pin: PlanPin, model: Tier | undefined, fix = pinHome(pin)): string {
  if (pin.status === "unknown")
    return `model pin is unknown (${model ? `adjudicator would pick ${model}; ` : ""}not overridden while the agent's definition cannot be read)`;
  const pinned = pin.model ?? "?";
  if (!model || (tierOf(pinned) ?? pinned) === model)
    return `pinned ${pinned} (matches the adjudicator's pick)`;
  return `pinned ${pinned} (adjudicator would pick ${model}; ${fix} to let it choose)`;
}

/**
 * One line per task, e.g. "#5 → swarm-feature-coder · model haiku · effort low (complexity 1,
 * conf 0.82)", or "#5 → swarm-feature-coder · pinned opus (adjudicator would pick haiku; …) ·
 * effort low (…)" for an agent whose pin is respected.
 */
export function planLines(advice: readonly PlanAdvice[]): string[] {
  return advice.map((a) => {
    const parts = [
      a.agentType ?? "any role",
      ...(a.pin ? [pinnedPart(a.pin, a.model)] : a.model ? [`model ${a.model}`] : []),
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
  return [planAdviceHead(advice, env), ...planLines(advice)].join("\n");
}

/** CLAUDE_CODE_EFFORT_LEVEL outranks the Agent call's `effort` (and the agent file's). */
export function effortForced(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.CLAUDE_CODE_EFFORT_LEVEL?.trim();
  return !!v;
}

/** The block's first line: what to pass on the Agent call, given FORCE, the effort env and pins. */
export function planAdviceHead(
  advice: readonly PlanAdvice[],
  env: NodeJS.ProcessEnv = process.env,
): string {
  const effortSet = effortForced(env);
  const effortNote = "CLAUDE_CODE_EFFORT_LEVEL is set and outranks `effort`";
  const pins = advice.some((a) => a.pin) ? "; a pinned agent keeps its model: pass no `model`" : "";
  if (modelForced(env))
    return `Adjudicator suggestions (CLAUDE_CODE_SUBAGENT_MODEL_FORCE is on, so Claude Code ignores \`model\` on the Agent call; the model is informational; ${
      effortSet
        ? `${effortNote}, so effort is too`
        : `pass the effort as \`effort\` (Claude Code ${AGENT_EFFORT_SINCE} or later)`
    }):`;
  const pass = effortSet
    ? `pass the model as \`model\` on each Agent call (effort is informational: ${effortNote})`
    : `pass the model as \`model\` and the effort as \`effort\` on each Agent call (\`effort\` needs Claude Code ${AGENT_EFFORT_SINCE} or later)`;
  return `Adjudicator suggestions: ${pass}${pins}:`;
}
