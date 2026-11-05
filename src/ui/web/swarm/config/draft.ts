// Pure draft operations of the Configuration Studio (#/swarm/config): no DOM, no fetch, and
// no import of ../../api.ts, so tests/unit/swarm-draft.test.ts runs them in node. The draft is
// the snake_case SwarmDoc mirror of .eminiar/swarm.yaml; every operation returns new objects
// and leaves its input untouched. The types come type-only from src/swarm/doc-types.ts, which
// has no runtime code (the bundle never loads a node module from src/swarm).
import type {
  DocTier,
  SwarmDoc,
  SwarmDocContext,
  SwarmDocModelRange,
  SwarmDocRename,
  SwarmDocRole,
  SwarmDocSwarm,
} from "../../../../swarm/doc-types.js";
import { capacity as slotCapacity } from "../run-helpers.js";

export type {
  DocTier,
  SwarmDoc,
  SwarmDocContext,
  SwarmDocModelRange,
  SwarmDocRename,
  SwarmDocRole,
  SwarmDocSwarm,
};

/** The model tiers lowest first (adjudicator TIERS). */
export const TIERS: readonly DocTier[] = ["haiku", "sonnet", "opus", "fable"];
/** What the server applies when a swarm sets no max_agents (edit.ts DEFAULT_MAX_AGENTS). */
export const DEFAULT_MAX_AGENTS = 4;
export const READ_ONLY_TOOLS = ["Edit", "Write", "NotebookEdit"];
/** config.ts NAME_RE / NAME_MAX: swarm and role names. */
const NAME_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const NAME_MAX = 32;

const isPlain = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

// --- generic paths --------------------------------------------------------------------

export function getIn(obj: unknown, path: readonly string[]): unknown {
  let cur = obj;
  for (const k of path) {
    if (!isPlain(cur) && !Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/**
 * A copy of `obj` with `value` at `path`; every map on the way is copied, missing maps are
 * created, and `undefined` removes the key. Key order is kept, so the YAML diff stays small.
 */
export function setIn<T>(obj: T, path: readonly string[], value: unknown): T {
  if (!path.length) return value as T;
  const [k, ...rest] = path as [string, ...string[]];
  const base: Record<string, unknown> = isPlain(obj) ? { ...obj } : {};
  const next = setIn(base[k], rest, value);
  if (next === undefined) delete base[k];
  else base[k] = next;
  return base as T;
}

/** Deep equality of drafts; a key holding `undefined` counts as absent (the server drops it). */
export function docEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => docEqual(x, b[i]));
  }
  if (isPlain(a) && isPlain(b)) {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined);
    const kb = Object.keys(b).filter((k) => b[k] !== undefined);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.hasOwn(b, k) && docEqual(a[k], b[k]));
  }
  return false;
}

/** Rebuild a map with key `from` renamed to `to`, in place in the key order. */
function renameKey<V>(map: Record<string, V>, from: string, to: string): Record<string, V> {
  const out: Record<string, V> = {};
  for (const [k, v] of Object.entries(map)) out[k === from ? to : k] = v;
  return out;
}

// --- names ----------------------------------------------------------------------------

/** Why a swarm or role name cannot be used, or undefined when it can. */
export function nameProblem(name: string, taken: readonly string[] = []): string | undefined {
  if (!name) return "a name is required";
  if (name.length > NAME_MAX) return `at most ${NAME_MAX} characters`;
  if (!NAME_RE.test(name))
    return "lowercase letters and digits in words joined by single hyphens, starting with a letter (e.g. code-review)";
  if (taken.includes(name)) return `"${name}" is already used`;
  return undefined;
}

/** `base` made into a valid name that `taken` does not hold: code-review, code-review-2, … */
export function uniqueName(base: string, taken: readonly string[]): string {
  let stem =
    base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^[^a-z]+/, "")
      .replace(/-+$/, "")
      .slice(0, NAME_MAX)
      .replace(/-+$/, "") || "swarm";
  if (!taken.includes(stem)) return stem;
  for (let i = 2; i < 1000; i++) {
    const tail = `-${i}`;
    stem = stem.slice(0, NAME_MAX - tail.length).replace(/-+$/, "");
    if (!taken.includes(stem + tail)) return stem + tail;
  }
  return `${stem}-${Date.now() % 1000}`;
}

// --- renames --------------------------------------------------------------------------

export interface Draft {
  doc: SwarmDoc;
  /** Key renames against the file on disk, in order (comments of a renamed node survive). */
  renames: SwarmDocRename[];
}

/**
 * The swarm → role names of the file on disk once `renames` are applied: what a further
 * rename must name, and must not collide with.
 */
export function baseNames(
  base: SwarmDoc | null,
  renames: readonly SwarmDocRename[],
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [name, s] of Object.entries(base?.swarms ?? {}))
    out.set(name, new Set(Object.keys(isPlain(s) && isPlain(s.agents) ? s.agents : {})));
  for (const r of renames) {
    const roles = out.get(r.swarm);
    if (!roles) continue;
    if (r.role === undefined) {
      const m = new Map<string, Set<string>>();
      for (const [k, v] of out) m.set(k === r.swarm ? r.to : k, v);
      out.clear();
      for (const [k, v] of m) out.set(k, v);
    } else if (roles.has(r.role)) {
      roles.delete(r.role);
      roles.add(r.to);
    }
  }
  return out;
}

/**
 * Rename a swarm in the draft. It is recorded as a rename of the file's key (so its comments
 * stay) only when the old name is a swarm of the file and the new one is free there; otherwise
 * the server simply writes the difference.
 */
export function renameSwarm(d: Draft, base: SwarmDoc | null, from: string, to: string): Draft {
  if (from === to || !d.doc.swarms[from]) return d;
  const doc = { ...d.doc, swarms: renameKey(d.doc.swarms, from, to) };
  const names = baseNames(base, d.renames);
  const record = names.has(from) && !names.has(to);
  return { doc, renames: record ? [...d.renames, { swarm: from, to }] : d.renames };
}

/** Rename a role, and its entry in the swarm's pipeline stages. */
export function renameRole(
  d: Draft,
  base: SwarmDoc | null,
  swarm: string,
  from: string,
  to: string,
): Draft {
  const s = d.doc.swarms[swarm];
  if (!s || from === to || !s.agents[from]) return d;
  const next: SwarmDocSwarm = {
    ...s,
    agents: renameKey(s.agents, from, to),
    ...(s.stages ? { stages: s.stages.map((x) => (x === from ? to : x)) } : {}),
  };
  const doc = { ...d.doc, swarms: { ...d.doc.swarms, [swarm]: next } };
  const roles = baseNames(base, d.renames).get(swarm);
  const record = !!roles && roles.has(from) && !roles.has(to);
  return { doc, renames: record ? [...d.renames, { swarm, role: from, to }] : d.renames };
}

// --- swarms and roles -----------------------------------------------------------------

export function addSwarm(doc: SwarmDoc, name: string, swarm: SwarmDocSwarm): SwarmDoc {
  return { ...doc, swarms: { ...doc.swarms, [name]: structuredClone(swarm) } };
}

export function duplicateSwarm(doc: SwarmDoc, from: string, to: string): SwarmDoc {
  const s = doc.swarms[from];
  return s ? addSwarm(doc, to, s) : doc;
}

export function deleteSwarm(doc: SwarmDoc, name: string): SwarmDoc {
  const swarms = { ...doc.swarms };
  delete swarms[name];
  return { ...doc, swarms };
}

export function blankRole(): SwarmDocRole {
  return { description: "Describe what this worker does.", prompt: "" };
}

export function addRole(
  doc: SwarmDoc,
  swarm: string,
  name: string,
  role: SwarmDocRole = blankRole(),
): SwarmDoc {
  const s = doc.swarms[swarm];
  if (!s) return doc;
  const stages = s.topology === "pipeline" && s.stages ? [...s.stages, name] : s.stages;
  return setIn(doc, ["swarms", swarm], {
    ...s,
    ...(stages ? { stages } : {}),
    agents: { ...s.agents, [name]: structuredClone(role) },
  });
}

export function duplicateRole(doc: SwarmDoc, swarm: string, from: string, to: string): SwarmDoc {
  const r = doc.swarms[swarm]?.agents[from];
  return r ? addRole(doc, swarm, to, r) : doc;
}

/** Remove a role; its pipeline stage goes with it. */
export function deleteRole(doc: SwarmDoc, swarm: string, role: string): SwarmDoc {
  const s = doc.swarms[swarm];
  if (!s) return doc;
  const agents = { ...s.agents };
  delete agents[role];
  const next: SwarmDocSwarm = { ...s, agents };
  if (s.stages) next.stages = s.stages.filter((x) => x !== role);
  return setIn(doc, ["swarms", swarm], next);
}

/** Move the stage at `i` one place up (-1) or down (+1). */
export function moveStage(stages: readonly string[], i: number, dir: -1 | 1): string[] {
  const j = i + dir;
  const out = [...stages];
  if (i < 0 || j < 0 || i >= out.length || j >= out.length) return out;
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
}

/** Roles a pipeline's stages leave out (the server warns about them). */
export const missingStages = (s: SwarmDocSwarm): string[] =>
  Object.keys(s.agents).filter((r) => !(s.stages ?? []).includes(r));

/** A new file from a template: the starter's top-level settings plus the one swarm. */
export function docFromTemplate(name: string, swarm: SwarmDocSwarm): SwarmDoc {
  return {
    version: 1,
    enabled: true,
    sync: "auto",
    swarms: { [name]: structuredClone(swarm) },
  };
}

// --- capacity -------------------------------------------------------------------------

/** Σ count of a swarm's roles against its max_agents (count and max_agents defaults apply). */
export function capacity(s: SwarmDocSwarm): { total: number; max: number; over: boolean } {
  return slotCapacity(
    Object.values(s.agents).map((r) => ({ count: r?.count ?? 1 })),
    s.max_agents ?? DEFAULT_MAX_AGENTS,
  );
}

// --- issues and locked paths ----------------------------------------------------------

export interface PathIssue {
  path: string;
  message: string;
}

/** Issue messages by dotted path, for inline field errors. */
export function issuesByField(issues: readonly PathIssue[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const i of issues) {
    const list = out.get(i.path);
    if (list) list.push(i.message);
    else out.set(i.path, [i.message]);
  }
  return out;
}

const under = (path: string, prefix: string) =>
  !prefix || path === prefix || path.startsWith(`${prefix}.`);

/** Issues at `prefix` or anywhere inside it (a role card's badge). */
export const issuesUnder = <I extends PathIssue>(issues: readonly I[], prefix: string): I[] =>
  issues.filter((i) => under(i.path, prefix));

/** `path` is locked (an alias, merge key, x-* key or hooks), or inside a locked node. */
export const isLocked = (locked: readonly string[], path: string): boolean =>
  locked.some((l) => under(path, l));

/** Something inside `path` is locked, so replacing or deleting `path` as a whole would fail. */
export const lockedInside = (locked: readonly string[], path: string): boolean =>
  locked.some((l) => l !== path && under(l, path));

/**
 * Why `path` cannot be deleted from the form, or undefined. Deleting a node drops an anchor
 * (`&x`) under it that an alias elsewhere may still point at, which the server refuses (422).
 */
export function deleteBlock(locked: readonly string[], path: string): string | undefined {
  if (isLocked(locked, path)) return "it is an alias, anchor or merge key; delete it in raw mode";
  const inside = locked.filter((l) => l !== path && under(l, path));
  if (!inside.length) return undefined;
  // A role's hooks block is read-only on its own account, not because anything is shared.
  const isHooks = (l: string) => /^swarms\.[^.]+\.agents\.[^.]+\.hooks$/.test(l);
  if (inside.every(isHooks))
    return /^swarms\.[^.]+\.agents\.[^.]+$/.test(path)
      ? "this role has hooks, which are edited in raw YAML"
      : "a role in it has hooks, which are edited in raw YAML";
  return "an anchor or alias inside it is shared with another part of the file; delete it in raw mode";
}

// --- models ---------------------------------------------------------------------------

/** The tier of a model alias or Claude model id, or undefined (inherit, opusplan, unknown). */
export function tierOf(model: string | undefined): DocTier | undefined {
  if (!model) return undefined;
  const m = /(haiku|sonnet|opus|fable)/.exec(model);
  if (!m || model.startsWith("opusplan")) return undefined;
  return m[1] as DocTier;
}

const rank = (t: DocTier) => TIERS.indexOf(t);
const hasBounds = (r: SwarmDocModelRange | undefined): r is SwarmDocModelRange =>
  !!r && (!!r.floor || !!r.ceiling);

/**
 * How a role's model is chosen:
 * - `pin`: always the fallback model (no range, or `model_range: {}` against a default range)
 * - `range`: the adjudicator picks a tier per task between floor and ceiling
 * - `default`: the role follows defaults.model_range
 */
export type PolicyMode = "pin" | "range" | "default";

export interface ModelPolicy {
  mode: PolicyMode;
  /** The model the agent file pins and the worker falls back on. */
  model: string | undefined;
  /** Where that model comes from. */
  modelFrom: "role" | "defaults" | "none";
  tier: DocTier | undefined;
  /** The effective bounds (an unset bound is the fallback's tier); undefined when pinned. */
  floor: DocTier | undefined;
  ceiling: DocTier | undefined;
}

export function modelPolicy(doc: SwarmDoc, role: SwarmDocRole): ModelPolicy {
  const d = doc.defaults;
  const model = role.model ?? d?.model;
  const modelFrom =
    role.model !== undefined ? "role" : d?.model !== undefined ? "defaults" : "none";
  const tier = tierOf(model);
  const spec = role.model_range ?? d?.model_range;
  const mode: PolicyMode = !hasBounds(spec) ? "pin" : role.model_range ? "range" : "default";
  if (mode === "pin") return { mode, model, modelFrom, tier, floor: undefined, ceiling: undefined };
  const floor = spec?.floor ?? tier;
  const ceiling = spec?.ceiling ?? tier;
  return { mode, model, modelFrom, tier, floor, ceiling };
}

/**
 * The role with its model policy switched. Pinning against a default range writes
 * `model_range: {}` (how a role opts out); a new range starts from the default range or
 * one tier either side of the fallback.
 */
export function withPolicy(doc: SwarmDoc, role: SwarmDocRole, mode: PolicyMode): SwarmDocRole {
  const defaultRange = hasBounds(doc.defaults?.model_range);
  const next = { ...role };
  if (mode === "default") delete next.model_range;
  else if (mode === "pin") {
    if (defaultRange) next.model_range = {};
    else delete next.model_range;
  } else {
    const p = modelPolicy(doc, role);
    const t = p.tier ?? "sonnet";
    const i = rank(t);
    next.model_range = hasBounds(role.model_range)
      ? role.model_range
      : defaultRange
        ? { ...doc.defaults?.model_range }
        : { floor: TIERS[Math.max(0, i - 1)], ceiling: TIERS[Math.min(TIERS.length - 1, i + 1)] };
  }
  return next;
}

/** config.ts roleRange's checks, worded for the form: why the range cannot work. */
export function rangeProblem(
  model: string | undefined,
  range: SwarmDocModelRange | undefined,
): string | undefined {
  if (!hasBounds(range)) return undefined;
  if (range.floor && range.ceiling && rank(range.floor) > rank(range.ceiling))
    return `the floor must not be above the ceiling (${TIERS.join(" < ")})`;
  if (!model) return "a range needs a fallback model inside it: set the model";
  if (model === "inherit")
    return "inherit cannot be the fallback of a range: the main session's model is not known in advance";
  const t = tierOf(model);
  if (!t) return `${model} has no single tier, so it cannot be the fallback of a range`;
  const floor = range.floor ?? t;
  const ceiling = range.ceiling ?? t;
  if (rank(t) < rank(floor))
    return `${model} is below the floor ${floor}: the fallback must lie inside the range`;
  if (rank(t) > rank(ceiling))
    return `${model} is above the ceiling ${ceiling}: the fallback must lie inside the range`;
  return undefined;
}

/** The tiers a range spans, inclusive (for the range bar). */
export function tierSpan(floor: DocTier | undefined, ceiling: DocTier | undefined): DocTier[] {
  if (!floor || !ceiling) return [];
  return TIERS.filter((t) => rank(t) >= rank(floor) && rank(t) <= rank(ceiling));
}

// --- tools ----------------------------------------------------------------------------

/** One line for a role card: "read-only", "all tools", "5 tools", "all but Bash". */
export function toolsSummary(role: SwarmDocRole): string {
  const deny = role.disallowed_tools ?? [];
  if (deny.includes("Edit") && deny.includes("Write")) return "read-only";
  if (role.tools?.length) return `${role.tools.length} tool${role.tools.length === 1 ? "" : "s"}`;
  if (deny.length) return `all but ${deny.slice(0, 2).join(", ")}${deny.length > 2 ? "…" : ""}`;
  return "all tools";
}

// --- context --------------------------------------------------------------------------

/** A context override with unset fields dropped; undefined when nothing is overridden. */
export function compactContext(c: SwarmDocContext | undefined): SwarmDocContext | undefined {
  if (!c) return undefined;
  const out: SwarmDocContext = {};
  for (const [k, v] of Object.entries(c))
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return Object.keys(out).length ? out : undefined;
}

/** How many context fields an override sets. */
export const contextCount = (c: SwarmDocContext | undefined): number =>
  c ? Object.values(c).filter((v) => v !== undefined).length : 0;

// --- unsaved work ---------------------------------------------------------------------

/**
 * Whether the studio holds unsaved work. In raw mode the visual draft is still kept (leaving
 * raw mode brings it back), so it counts there too: a raw text equal to the file must not hide
 * form edits from the leave guard.
 */
export function studioDirty(s: {
  /** The raw YAML being edited, or null in the visual editor. */
  raw: string | null;
  baseText: string | null;
  /** The visual draft differs from the file (or there is no file yet). */
  visual: boolean;
}): boolean {
  return s.visual || (s.raw !== null && s.raw !== (s.baseText ?? ""));
}

/** Why the latest render of the draft is not available. */
export type StaleReason = "conflict" | "render" | "invalid" | "error";

/** What Raw YAML may open, given the state of the draft's validation. */
export type RawEntry =
  /** The draft equals the file: open the file's text. */
  | { kind: "base" }
  /** The last render is of the current draft: open it. */
  | { kind: "render" }
  /** No render of the current draft yet (debounce or request in flight): render it first. */
  | { kind: "wait" }
  /** The current draft cannot be rendered now: only the last good render (or the file) can
   * open, without the later form edits, and the user has to agree to that. */
  | { kind: "stale"; reason: StaleReason };

export function rawEntry(s: {
  /** The visual draft differs from the file. */
  dirty: boolean;
  /** The last settled check (result or failure) is of the current draft. */
  current: boolean;
  /** That check failed, and why. */
  failure?: StaleReason | undefined;
  /** A 409 is unresolved (validation is paused until Reload or Keep mine). */
  conflict: boolean;
}): RawEntry {
  if (!s.dirty) return { kind: "base" };
  if (s.conflict) return { kind: "stale", reason: "conflict" };
  if (!s.current) return { kind: "wait" };
  return s.failure ? { kind: "stale", reason: s.failure } : { kind: "render" };
}
