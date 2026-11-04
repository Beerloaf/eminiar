/**
 * The adjudicator's hook call-outs (docs/design/adjudicator.md §10–§11). These are the only
 * functions src/hooks/* call, and they import this module lazily and only while
 * `adjudicator.enabled` is on, so a disabled adjudicator costs one boolean check per hook.
 *
 *   onPrompt        UserPromptSubmit: one advice line, maybe a main-session note (cooldown)
 *   afterRouting    PreToolUse: Agent/Task → onPreAgent + withModel; other raw tools → onPreTool
 *   onPostAgent     PostToolUse Agent/Task: the exact dispatch → subagent link (agentId)
 *   onSessionStart  one line when enabled but degraded; the ollama keep-alive warm-up
 *   onSessionEnd    reconcile; drop the session's main-advice counter
 *
 * Rules that hold everywhere: never deny, never inject `effort` (it is not an Agent input),
 * respect CLAUDE_CODE_SUBAGENT_MODEL_FORCE, an explicit `model` and a frontmatter pin, skip
 * the Cursor client, and never throw (advice must not break a hook).
 */

import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { AdjudicatorConfig } from "../config.js";
import { getContext, type ProjectContext } from "../context.js";
import { hookLog } from "../hooks/log.js";
import type { HookInput, HookOutput } from "../hooks/types.js";
import type { StorageAdapter } from "../storage/adapter.js";
import { getStorage } from "../storage/index.js";
import type { AdjudicationInput, AdjudicationPatch } from "../storage/types.js";
import { coordinationRoot, type SwarmSpawnCheck } from "../swarm/hooks.js";
import type { TaskRow } from "../swarm/types.js";
import { type AsyncJob, spawnAsyncJob } from "./async.js";
import { resolveAdjudicator } from "./config.js";
import { adjudicateOne, cacheKeyFor, type EngineOptions } from "./engine.js";
import { extractFeatures } from "./features.js";
import { topIntent } from "./heuristic.js";
import { biasFor, reconcile } from "./learn.js";
import type { FetchLike } from "./providers/http.js";
import { isPinned, resolveBaseline, tierOf, tierRank } from "./savings.js";
import {
  type AdjudicationAction,
  type AdjudicationRequest,
  type AdjudicationRow,
  type AdjudicatorProvider,
  type Features,
  TIERS,
  type Tier,
  type Verdict,
} from "./types.js";

/** The UserPromptSubmit advice line. */
export const ADVICE_MAX = 220;
/** The SessionStart degraded line. */
export const DEGRADED_MAX = 200;
/** A prompt's tool hint is not given for calls this long after the prompt. */
export const HINT_WINDOW_MS = 30 * 60_000;
/** The Ollama keep-alive job's budget: loading a cold model takes seconds. */
export const WARMUP_BUDGET_MS = 10_000;

/** Native tools whose call may contradict the prompt's advised em_* tool. */
const RAW_TOOLS = new Set(["Bash", "Read", "Grep", "Glob", "WebFetch", "WebSearch"]);
const AGENT_TOOLS = new Set(["Agent", "Task"]);

/** Test seams; the hook call-outs pass none. */
export interface HookDeps {
  /** A ready provider (null forces the heuristic). */
  provider?: AdjudicatorProvider | null | undefined;
  fetch?: FetchLike | undefined;
  spawn?: ((job: AsyncJob) => boolean) | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  now?: (() => number) | undefined;
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

function log(line: string): void {
  hookLog("info", line);
}

/** Is this surface on for this hook call? Cursor never gets adjudicator output. */
function active(cfg: AdjudicatorConfig, input: Pick<HookInput, "client">): boolean {
  return cfg.enabled && input.client !== "cursor";
}

function engineOptions(db: StorageAdapter, cfg: AdjudicatorConfig, deps: HookDeps): EngineOptions {
  const o: EngineOptions = {
    config: cfg,
    store: db.adjudicator,
    context: "hook",
    log,
    bias: (_req, f, h) =>
      biasFor(db, cfg.learning, { complexity: h.complexity, intent: topIntent(f) ?? "none" }),
  };
  if (deps.env) o.env = deps.env;
  if (deps.now) o.now = deps.now;
  if (deps.provider !== undefined) o.provider = deps.provider;
  if (deps.fetch) o.deps = { fetch: deps.fetch };
  return o;
}

// --- UserPromptSubmit -----------------------------------------------------------------

export interface PromptAdvice {
  /** One line for Claude (additionalContext). */
  context?: string;
  /** Main-session advice for the user (advice.mainSession "user"). */
  systemMessage?: string;
}

/**
 * "eminiar adjudicator: complexity 1/4 (lookup) · start with em_symbols → em_search · if you
 * delegate: haiku, role explorer" (≤ ADVICE_MAX chars).
 */
export function adviceLine(v: Verdict, f: Features): string {
  const c = Math.round(v.complexity);
  const intent = topIntent(f);
  const parts = [`eminiar adjudicator: complexity ${c}/4${intent ? ` (${intent})` : ""}`];
  if (v.tool.choice !== "none") {
    const tools = v.tool.entries
      .filter((e, i) => e.option !== "none" && (i === 0 || e.score >= 0.1))
      .slice(0, 2)
      .map((e) => e.option);
    if (tools.length) parts.push(`start with ${tools.join(" → ")}`);
  }
  const role = v.role.choice && v.role.choice !== "none" ? `, role ${v.role.choice}` : "";
  parts.push(`if you delegate: ${v.tier.choice}${role}`);
  return clip(parts.join(" · "), ADVICE_MAX);
}

/**
 * Score the prompt: skipped below minPromptChars, for slash commands and chat-only input.
 * promptMode heuristic → no provider; async → a detached job; blocking → inline within promptMs.
 */
export async function onPrompt(
  ctx: ProjectContext,
  db: StorageAdapter,
  input: HookInput,
  sessionId: string,
  deps: HookDeps = {},
): Promise<PromptAdvice | undefined> {
  try {
    const cfg = ctx.config.adjudicator;
    if (!active(cfg, input) || !cfg.surfaces.prompt) return undefined;
    const text = (input.prompt ?? "").trim();
    if (text.length < cfg.minPromptChars || text.startsWith("/") || extractFeatures(text).chat) {
      // A skipped prompt still ends the previous prompt's tool hint.
      if (cfg.surfaces.tools) closeToolHint(db, sessionId);
      return undefined;
    }
    const opts = engineOptions(db, cfg, deps);
    opts.call =
      cfg.promptMode === "heuristic" ? "never" : cfg.promptMode === "async" ? "async" : "inline";
    if (opts.call === "async") {
      opts.spawn = deps.spawn ?? ((job) => spawnAsyncJob(job));
      opts.projectRoot = ctx.root;
    }
    if (sessionId && sessionId !== "unknown") opts.row = { sessionId };
    const a = await adjudicateOne({ key: "prompt", surface: "prompt", text }, opts);
    const out: PromptAdvice = { context: adviceLine(a.verdict, a.features) };
    const main = mainSessionAdvice(db, cfg, sessionId, a.verdict, (deps.now ?? Date.now)());
    if (main) {
      if (cfg.advice.mainSession === "user") out.systemMessage = main;
      else out.context = `${out.context}\n${main}`;
    }
    return out;
  } catch (err) {
    log(`adjudicator: onPrompt ${(err as Error)?.message ?? String(err)}`);
    return undefined;
  }
}

/**
 * Main-session advice: only when the session model (the latest main-thread api_calls row) is
 * at least 2 tiers above the advice, and at most once per cooldownPrompts prompts. The prompt
 * counter lives in meta `adjudicator:main:<session>` as {n, last}.
 */
function mainSessionAdvice(
  db: StorageAdapter,
  cfg: AdjudicatorConfig,
  sessionId: string,
  v: Verdict,
  now: number,
): string | undefined {
  if (cfg.advice.mainSession === "off" || !sessionId || sessionId === "unknown") return undefined;
  const key = `adjudicator:main:${sessionId}`;
  let st: { n: number; last?: number } = { n: 0 };
  try {
    const raw = db.metaGet(key);
    if (raw) st = JSON.parse(raw) as typeof st;
  } catch {
    // a bad counter restarts it
  }
  st.n = (Number(st.n) || 0) + 1;
  let line: string | undefined;
  if (st.last === undefined || st.n - st.last >= cfg.advice.cooldownPrompts) {
    const base = resolveBaseline(db, { sessionId, ts: now });
    const current = base.source === "session" ? tierOf(base.model) : undefined;
    const advice = v.tier.choice;
    if (current && tierRank(advice) >= 0 && tierRank(current) - tierRank(advice) >= 2) {
      const c = Math.round(v.complexity);
      line = `eminiar adjudicator: this prompt looks ${c <= 1 ? "small" : "moderate"} (complexity ${c}/4); /model ${advice} would be cheaper than ${current}`;
      st.last = st.n;
    }
  }
  db.metaSet(key, JSON.stringify(st));
  return line;
}

// --- PreToolUse -----------------------------------------------------------------------

/**
 * The model on an Agent call, merged into the ONE updatedInput routing returns: routing's own
 * updatedInput (enforce prefix) when there is one, else the full original input. A deny or ask
 * is never turned into an allow.
 */
export function withModel(
  out: HookOutput | undefined,
  input: Record<string, unknown>,
  model: string,
): HookOutput | undefined {
  const h = out?.hookSpecificOutput;
  if (h?.permissionDecision === "deny" || h?.permissionDecision === "ask") return out;
  return {
    ...out,
    hookSpecificOutput: {
      ...h,
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { ...(h?.updatedInput ?? input), model },
    },
  };
}

/** One more additionalContext line on a PreToolUse output. */
export function withNote(
  out: HookOutput | undefined,
  note: string | undefined,
): HookOutput | undefined {
  if (!note) return out;
  const h = out?.hookSpecificOutput;
  const cur = h?.additionalContext;
  return {
    ...out,
    hookSpecificOutput: {
      ...h,
      hookEventName: "PreToolUse",
      additionalContext: cur ? `${cur}\n${note}` : note,
    },
  };
}

/**
 * Called by routing after it decided: the Agent model (apply) or advice note, or a tool hint
 * for a raw tool. Returns routing's output, extended; never throws.
 */
export async function afterRouting(
  ctx: ProjectContext,
  input: HookInput,
  spawn: SwarmSpawnCheck | undefined,
  out: HookOutput | undefined,
  deps: HookDeps = {},
): Promise<HookOutput | undefined> {
  try {
    if (!active(ctx.config.adjudicator, input) || !input.tool_input) return out;
    if (AGENT_TOOLS.has(input.tool_name ?? "")) {
      const a = await onPreAgent(ctx, input, spawn, deps);
      if (!a) return out;
      const next = a.model ? withModel(out, input.tool_input, a.model) : out;
      return withNote(next, a.note);
    }
    return withNote(out, onPreTool(ctx, input, out, deps));
  } catch (err) {
    log(`adjudicator: afterRouting ${(err as Error)?.message ?? String(err)}`);
    return out;
  }
}

export interface AgentAdvice {
  /** Set only when apply mode applies a tier. */
  model?: Tier;
  note?: string;
  action: AdjudicationAction;
  rowId?: number;
}

/** The `model:` of `.claude/agents/<type>.md`, when the file exists and says one. */
export function frontmatterModel(root: string, agentType: string): string | undefined {
  if (!/^[A-Za-z0-9_.-]+$/.test(agentType)) return undefined; // plugin agents: unknown
  try {
    const text = readFileSync(join(root, ".claude", "agents", `${agentType}.md`), "utf8");
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
    return fm ? /^model:\s*["']?([^"'\s#]+)/m.exec(fm)?.[1] : undefined;
  } catch {
    return undefined;
  }
}

/** The tier within [floor, ceiling] on the haiku < sonnet < opus < fable ladder. */
export function clampTier(tier: string, floor: Tier, ceiling: Tier): Tier | undefined {
  const r = tierRank(tier);
  if (r < 0) return undefined;
  const lo = tierRank(floor);
  const hi = Math.max(lo, tierRank(ceiling));
  return TIERS[Math.min(hi, Math.max(lo, r))];
}

/** The swarm task of a worker dispatch: this project's ledger, else the coordination root's. */
function findTask(
  ctx: ProjectContext,
  db: StorageAdapter,
  runId: string,
  taskId: number,
): { db: StorageAdapter; task: TaskRow } | undefined {
  const t = db.swarm.taskGet(taskId);
  if (t && t.run_id === runId) return { db, task: t };
  const main = coordinationRoot(ctx.root);
  if (main === ctx.root) return undefined;
  const mdb = getStorage(getContext(main), { vectors: false });
  const m = mdb.swarm.taskGet(taskId);
  return m && m.run_id === runId ? { db: mdb, task: m } : undefined;
}

function forced(env: NodeJS.ProcessEnv): boolean {
  const v = env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE;
  return v !== undefined && v !== "" && v !== "0";
}

/**
 * An Agent/Task dispatch: plan row (run, task) → cache → heuristic; on a miss in apply mode the
 * provider within agentMs. Inserts one `agent` row (parent = plan row, model requested, baseline
 * model, action). Advise mode never calls the network.
 */
export async function onPreAgent(
  ctx: ProjectContext,
  input: HookInput,
  spawn: SwarmSpawnCheck | undefined,
  deps: HookDeps = {},
): Promise<AgentAdvice | undefined> {
  const cfg = ctx.config.adjudicator;
  if (!active(cfg, input) || !cfg.surfaces.agent) return undefined;
  if (!AGENT_TOOLS.has(input.tool_name ?? "")) return undefined;
  const ti = input.tool_input ?? {};
  const env = deps.env ?? process.env;
  const now = (deps.now ?? Date.now)();
  const worker = spawn?.kind === "worker" ? spawn : undefined;
  const agentType = str(ti.subagent_type) ?? "general-purpose";

  let db = getStorage(ctx, { vectors: false });
  let task: TaskRow | undefined;
  if (worker?.runId && typeof worker.taskId === "number") {
    try {
      const found = findTask(ctx, db, worker.runId, worker.taskId);
      if (found) ({ db, task } = found);
    } catch {
      // no task text: fall back to the dispatch's own
    }
  }
  const text = task
    ? `${task.title}\n${task.detail ?? ""}`
    : `${str(ti.description) ?? ""}\n${str(ti.prompt) ?? ""}`;
  if (!text.trim()) return undefined;

  let plan: AdjudicationRow | undefined;
  if (task && worker?.runId) {
    try {
      plan = db.adjudicator
        .forTask(worker.runId, task.id)
        .filter((r) => r.surface === "plan")
        .pop();
    } catch {
      // no plan verdict
    }
  }

  const explicit = str(ti.model);
  const pinned = frontmatterModel(ctx.root, agentType);
  const pinnedRespected = cfg.apply.respectFrontmatter && isPinned(pinned);
  const isForced = forced(env);
  const applyMode = cfg.mode === "apply";
  const inScope = cfg.apply.scope === "all" || !!worker;
  const mayApply = applyMode && inScope && !isForced && !explicit && !pinnedRespected;
  const sessionId =
    input.session_id && input.session_id !== "unknown" ? input.session_id : undefined;
  const baseline = resolveBaseline(db, { pinned, sessionId, ts: now });

  const row: Partial<AdjudicationInput> = {
    modelRequested: explicit ?? null,
    baselineModel: baseline.model,
  };
  if (sessionId) row.sessionId = sessionId;
  if (input.tool_use_id) row.toolUseId = input.tool_use_id;
  if (worker?.runId && task) {
    row.runId = worker.runId;
    row.taskId = task.id;
  }
  if (plan) {
    // The plan already scored this task: its verdict is the decision, no provider call.
    row.parentId = plan.id;
    for (const k of ["complexity", "tier", "effort", "tool", "role", "confidence"] as const)
      if (plan[k] !== undefined && plan[k] !== null) (row as Record<string, unknown>)[k] = plan[k];
  }

  const opts = engineOptions(db, cfg, deps);
  opts.call = mayApply && !plan ? "inline" : "never";
  opts.row = row;
  const req: AdjudicationRequest = { key: "agent", surface: "agent", text };
  if (task) {
    req.hints = { files: task.files.length, deps: task.deps.length };
    if (task.role) req.hints.role = task.role;
  }
  const a = await adjudicateOne(req, opts);
  const v = a.verdict;
  const tier = plan?.tier ?? v.tier.choice;
  const conf = plan?.confidence ?? v.tier.confidence;
  const c = Math.round(plan?.complexity ?? v.complexity);
  const effort = plan?.effort ?? v.effort;
  const role = plan?.role ?? v.role.choice;
  const clamped = clampTier(tier, cfg.apply.floor, cfg.apply.ceiling);

  let action: AdjudicationAction;
  let model: Tier | undefined;
  let modelFinal: string | null;
  if (!applyMode || !inScope) {
    action = "advised";
    modelFinal = explicit ?? null;
  } else if (isForced || explicit || pinnedRespected) {
    action = "respected";
    modelFinal =
      explicit ??
      (isForced ? (str(env.CLAUDE_CODE_SUBAGENT_MODEL) ?? null) : null) ??
      (isPinned(pinned) ? pinned : null);
  } else if (clamped && conf >= cfg.apply.minConfidence) {
    action = "applied";
    model = clamped;
    modelFinal = clamped;
  } else {
    action = "advised";
    modelFinal = null;
  }
  if (a.rowId !== undefined) {
    try {
      db.adjudicator.update(a.rowId, { action, modelFinal });
    } catch {
      // the row keeps its verdict without the action
    }
  }

  const why = `complexity ${c}, conf ${conf.toFixed(2)}`;
  const extras = [`suggested effort ${effort}`];
  if (role && role !== "none") extras.push(`role ${role}`);
  let note: string;
  if (action === "applied") {
    note = `adjudicator: model ${model} applied (${why}); ${extras.join(", ")}`;
  } else if (
    action === "advised" &&
    !explicit &&
    clamped &&
    clamped !== (tierOf(baseline.model) ?? baseline.model)
  ) {
    note = `adjudicator: model ${clamped} would do (${why}): pass model:'${clamped}'; ${extras.join(", ")}`;
  } else {
    note = `adjudicator: ${extras.join(", ")}`;
  }
  const out: AgentAdvice = { action, note: clip(note, ADVICE_MAX) };
  if (model) out.model = model;
  if (a.rowId !== undefined) out.rowId = a.rowId;
  return out;
}

// --- PostToolUse ----------------------------------------------------------------------

/** How far back onPostAgent looks for the dispatch row (a foreground agent can run for hours). */
export const POST_AGENT_LOOKBACK_MS = 24 * 3_600_000;

/**
 * The subagent an Agent/Task call started, from its PostToolUse payload. Claude Code passes the
 * tool's structured output as `tool_response` (the transcript's toolUseResult): both the
 * foreground `completed` and the background `async_launched` shapes carry `agentId` (the id
 * sidechain transcript entries, so api_calls.agent_id, use) and `resolvedModel` (the model the
 * subagent started on). Without an agentId, the session's subagents/agent-<id>.meta.json whose
 * `toolUseId` matches is the fallback.
 */
export function agentLinkOf(
  input: Pick<HookInput, "tool_response" | "tool_use_id" | "transcript_path">,
): { agentId: string; resolvedModel?: string } | undefined {
  const r = input.tool_response;
  const o = r && typeof r === "object" && !Array.isArray(r) ? (r as Record<string, unknown>) : {};
  const resolvedModel = str(o.resolvedModel);
  const agentId = str(o.agentId) ?? agentFromMeta(input.transcript_path, input.tool_use_id);
  if (!agentId) return undefined;
  return resolvedModel ? { agentId, resolvedModel } : { agentId };
}

/** The agent id whose `<session>/subagents/agent-<id>.meta.json` names this tool_use_id. */
function agentFromMeta(
  transcriptPath: string | undefined,
  toolUseId: string | undefined,
): string | undefined {
  if (!transcriptPath || !toolUseId) return undefined;
  const dir = join(dirname(transcriptPath), basename(transcriptPath, ".jsonl"), "subagents");
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => /^agent-[A-Za-z0-9_-]+\.meta\.json$/.test(n));
  } catch {
    return undefined;
  }
  for (const n of names) {
    try {
      const m = JSON.parse(readFileSync(join(dir, n), "utf8")) as { toolUseId?: unknown };
      if (m?.toolUseId === toolUseId) return n.slice("agent-".length, -".meta.json".length);
    } catch {
      // an unreadable meta file is skipped
    }
  }
  return undefined;
}

/**
 * PostToolUse for an Agent/Task call: the dispatch row PreToolUse wrote (same tool_use_id) gets
 * the subagent's agentId, and its resolvedModel as actualModel until reconcile prices the
 * subagent's own calls. An exact link, so parallel same-tier dispatches that the window
 * matcher must leave ambiguous are linked too; reconcile already prefers row.agentId. A row
 * that has an agent id keeps it. Returns the row id it linked; never throws.
 */
export function onPostAgent(
  ctx: ProjectContext,
  db: StorageAdapter,
  input: HookInput,
  deps: Pick<HookDeps, "now"> = {},
): number | undefined {
  try {
    const cfg = ctx.config.adjudicator;
    if (!active(cfg, input) || !cfg.surfaces.agent) return undefined;
    if (!AGENT_TOOLS.has(input.tool_name ?? "") || !input.tool_use_id) return undefined;
    const link = agentLinkOf(input);
    if (!link) return undefined;
    const since = (deps.now ?? Date.now)() - POST_AGENT_LOOKBACK_MS;
    // A worker's dispatch row may live in the coordination root's ledger (onPreAgent findTask).
    const dbs = [db];
    const main = coordinationRoot(ctx.root);
    if (main !== ctx.root) dbs.push(getStorage(getContext(main), { vectors: false }));
    for (const d of dbs) {
      // One indexed lookup (adjudications_tool_use), not a scan of recent rows.
      const row = d.adjudicator.byToolUseId(input.tool_use_id, { surface: "agent", since });
      if (!row) continue;
      if (row.agentId) {
        if (row.agentId !== link.agentId)
          log(
            `adjudicator: row ${row.id} keeps agent ${row.agentId}, dispatch says ${link.agentId}`,
          );
        return undefined;
      }
      const patch: AdjudicationPatch = { agentId: link.agentId };
      if (link.resolvedModel && !row.actualModel) patch.actualModel = link.resolvedModel;
      d.adjudicator.update(row.id, patch);
      return row.id;
    }
    return undefined;
  } catch (err) {
    log(`adjudicator: onPostAgent ${(err as Error)?.message ?? String(err)}`);
    return undefined;
  }
}

/**
 * A raw tool call that contradicts the prompt's advised em_* tool: one hint per prompt, only
 * when routing said nothing. Exactly one SELECT (the session's latest prompt row); the prompt
 * row's tool_use_id marks that its hint was given.
 */
export function onPreTool(
  ctx: ProjectContext,
  input: HookInput,
  out: HookOutput | undefined,
  deps: HookDeps = {},
): string | undefined {
  const cfg = ctx.config.adjudicator;
  if (!active(cfg, input) || !cfg.surfaces.tools) return undefined;
  if (!RAW_TOOLS.has(input.tool_name ?? "") || !input.session_id) return undefined;
  const h = out?.hookSpecificOutput;
  if (h?.additionalContext || h?.permissionDecision) return undefined;
  try {
    const db = getStorage(ctx, { vectors: false });
    const row = db.adjudicator.latestForSession(input.session_id, "prompt");
    if (!row || row.toolUseId || !row.tool?.startsWith("em_")) return undefined;
    if ((deps.now ?? Date.now)() - row.ts > HINT_WINDOW_MS) return undefined;
    db.adjudicator.update(row.id, { toolUseId: input.tool_use_id || "hinted" });
    const c = Math.round(row.complexity ?? 0);
    return clip(
      `eminiar adjudicator: this prompt was scored for ${row.tool} (complexity ${c}/4); ${input.tool_name} works, but ${row.tool} usually answers it with less context.`,
      ADVICE_MAX,
    );
  } catch {
    return undefined;
  }
}

/** Mark the session's latest prompt row as hinted, so a skipped prompt does not inherit its hint. */
function closeToolHint(db: StorageAdapter, sessionId: string): void {
  try {
    const row = db.adjudicator.latestForSession(sessionId, "prompt");
    if (row && !row.toolUseId) db.adjudicator.update(row.id, { toolUseId: "superseded" });
  } catch {
    // hints are optional
  }
}

// --- SessionStart / SessionEnd ------------------------------------------------------------

/**
 * One line (≤ DEGRADED_MAX) only when the adjudicator is on but degraded: no key, no consent,
 * misconfigured, breaker open or slow, apply not taking effect. No network inline; with the
 * ollama preset it spawns an async keep-alive job.
 */
export function onSessionStart(
  ctx: ProjectContext,
  db: StorageAdapter,
  input: Pick<HookInput, "client">,
  deps: HookDeps = {},
): string | undefined {
  try {
    const cfg = ctx.config.adjudicator;
    if (!active(cfg, input)) return undefined;
    const env = deps.env ?? process.env;
    const now = (deps.now ?? Date.now)();
    const r = resolveAdjudicator(cfg, { context: "hook", env });
    const issues: string[] = [];
    if (r.degraded === "no_key") issues.push(`no key for ${r.configured}`);
    else if (r.degraded === "no_consent")
      issues.push(`${r.configured} is remote and has no consent`);
    else if (r.degraded && r.degraded !== "hook_context")
      // misconfigured, or a reason added later: hooks use the heuristic + cached verdicts.
      issues.push(
        `${r.configured}: ${String(r.degraded).replace(/_/g, " ")}${r.detail ? ` (${r.detail})` : ""}`,
      );
    if (r.provider !== "heuristic") {
      const s = db.adjudicator.providerState(r.provider);
      if (s && s.state !== "closed" && s.retryAt !== null && s.retryAt > now)
        issues.push(`${r.provider} ${s.state === "slow" ? "is slow" : "breaker open"}`);
    }
    if (cfg.mode === "apply") {
      const sum = db.adjudicator.summary(now - 7 * 86_400_000);
      if (sum.applyIneffective > 0)
        issues.push(
          `apply did not take effect on ${sum.applyIneffective} of ${sum.applyChecked} dispatches: use advise`,
        );
    }
    if (
      r.provider === "openai-compatible" &&
      r.preset === "ollama" &&
      cfg.promptMode !== "heuristic"
    )
      warmUp(ctx, cfg, r, deps);
    if (!issues.length) return undefined;
    return clip(
      `eminiar adjudicator: ${issues.join("; ")}; \`eminiar adjudicator status\` explains.`,
      DEGRADED_MAX,
    );
  } catch {
    return undefined;
  }
}

function warmUp(
  ctx: ProjectContext,
  cfg: AdjudicatorConfig,
  r: ReturnType<typeof resolveAdjudicator>,
  deps: HookDeps,
): void {
  const request: AdjudicationRequest = { key: "warmup", surface: "test", text: "warm up" };
  const job: AsyncJob = {
    v: 1,
    projectRoot: ctx.root,
    request,
    // The same key the child computes (no hints or catalogues: just the config's ladder and weights).
    cacheKey: cacheKeyFor(request, r, { config: cfg }),
    config: cfg,
    context: "hook",
    budgetMs: WARMUP_BUDGET_MS,
  };
  (deps.spawn ?? ((j: AsyncJob) => spawnAsyncJob(j)))(job);
}

/** Link outcomes, tokens and savings for the rows this session left behind. */
export function onSessionEnd(
  ctx: ProjectContext,
  db: StorageAdapter,
  input: Pick<HookInput, "client" | "session_id">,
): void {
  try {
    if (!active(ctx.config.adjudicator, input)) return;
    // The main-session advice counter (mainSessionAdvice) is per session; drop it with the session.
    if (input.session_id) db.metaDelete(`adjudicator:main:${input.session_id}`);
    reconcile(db, { limit: 200, config: ctx.config });
  } catch (err) {
    log(`adjudicator: reconcile ${(err as Error)?.message ?? String(err)}`);
  }
}
