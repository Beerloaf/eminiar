/**
 * The heuristic scorer (docs/design/adjudicator.md §7.2-7.5): features in, a ScoreSet out.
 * Pure, synchronous and offline; it is the floor every other provider blends onto, so it must
 * generalise. Weights are tuned on principles, never on individual eval items.
 *
 * Default complexity weights (each overridable through `weights.features`, same keys):
 *
 * | key            | weight | why                                                            |
 * |----------------|--------|----------------------------------------------------------------|
 * | base           |  0.6   | an unknown request is a small one                              |
 * | chat           | −2.0   | greetings and acks need no model work                          |
 * | edit_small     | −0.6   | rename / typo / format: mechanical                             |
 * | lookup         | −0.3   | reading answers are cheaper than changes                       |
 * | history, docs  | −0.3   | the tool does the work; the model summarises                   |
 * | git            | −0.3   | mechanical (commit, push)                                      |
 * | impact         | +0.6   | impact analysis reasons over several files                     |
 * | bigfile        | +1.0   | a large file is a lot of context to digest                     |
 * | recall         | +0.6   | "is it safe / should we" is a judgement call                   |
 * | implement      | +1.0   | new behaviour; a specific verb (wire, optimize) alone reaches 2 |
 * | debug          | +1.0   | open-ended investigation                                       |
 * | review         | +1.2   | needs to model the whole change                                |
 * | plan           | +1.4   | decomposition across workers                                   |
 * | refactor       | +1.6   | touches many call sites                                        |
 * | design         | +2.4   | architecture; the biggest single cue                           |
 * | research, test | +0.6   | moderate, mostly bounded                                       |
 * | run, ui        |  0     | neutral: say what, not how hard                                |
 * | scope          | ×1.2   | whole / across / codebase (0..1)                               |
 * | risk           | ×0.8   | security / race / migration / data loss (0..1)                 |
 * | perf           | +0.8   | performance work with a measured number (800ms, 40kb, 50k docs) |
 * | paths          | ×0.3   | 0.3·log2(1+paths): more named files, more to touch (not reads) |
 * | words40/120    | +0.3/+0.6 | long prose carries more requirements (not cumulative); pasted |
 * |                |        | output never counts, and a bug report stops at words40         |
 * | stackTrace     | +0.4   | a crash to diagnose                                            |
 * | taskFiles      | +0.4   | plan task touching more than 3 files                           |
 * | taskDeps       | +0.2   | plan task with more than one dependency                        |
 * | taskFloor      |  2     | a swarm task title ("T7: ...") is a planned unit: c ≥ this     |
 * | investigateFloor | 2    | an investigation (why, figure out, look into, explain ...) of a |
 * |                |        | system-level subject or emergent symptom follows behaviour     |
 * |                |        | across modules: c ≥ this (one named symbol stays a lookup)     |
 * | crossCuttingFloor | 2   | threading a value through layers, or judging a change's impact |
 * |                |        | on its callers, touches every hop: c ≥ this                    |
 * | toolProvider   |  0     | blend weight of a provider's tool answer (§7.4); 0 = heuristic owns tools |
 * | asymmetry      |  2     | tier cost ratio: under-tiering costs a redo, so being c units   |
 * |                |        | above a tier's centre costs `asymmetry`× being c units below it |
 *
 * Read-only requests (no change, debug, review, plan or test-writing intent) are lookups: a
 * mention of tests, docs or a path there is the object of the question, so the test intent and
 * the paths term do not count, and scope counts half (the tool searches the breadth, not the
 * model).
 *
 * Tool routing (§7.4): a docs or history intent names where the answer is, so the generic question
 * words that come with it ("how does", "which") do not also vote for a code search; callers and
 * usages of a symbol are a references lookup (em_symbols), the effect of a change is impact
 * (em_graph_impact); several commands in one go (in parallel, or three or more listed) are one
 * em_batch_execute call; a URL, a fetch verb or "latest version" sends docs to em_fetch_and_index.
 * Bounded UI work (no refactor, not broad) confined to the UI is the ui role's change, not the
 * coder's. With risk, another layer named (an endpoint, the server, the CLI, a hook, the database,
 * a login) or the UI as one area of a list ("the server, CLI and dashboard") it is cross-layer and
 * the coder's, UI noun included.
 *
 * Asymmetric tier loss (§7.3): the tier logit is −asymmetry·max(0, c − centre) −
 * max(0, centre − c). Under-tiering costs a redo (the tokens of the failed attempt plus the
 * retry, more than the saving), so with the default 2:1 a request between two centres goes up
 * once it is a third of the way across: haiku→sonnet at c ≈ 1.07, sonnet→opus at c ≈ 2.47 for
 * centres 0.6 / 2.0 / 3.4. asymmetry = 1 is the old symmetric nearest-centre rule.
 */

import { extractIntents, type FeatureExtras } from "./features.js";
import {
  DEFAULT_ROLES,
  type Effort,
  type Features,
  type Intent,
  type Reason,
  type ScoreEntry,
  type ScoreSet,
  type ScoreTable,
  TIERS,
  type Tier,
  TOOL_IDS,
} from "./types.js";

export const DEFAULT_FEATURE_WEIGHTS: Readonly<Record<string, number>> = Object.freeze({
  base: 0.6,
  chat: -2.0,
  edit_small: -0.6,
  lookup: -0.3,
  history: -0.3,
  docs: -0.3,
  git: -0.3,
  impact: 0.6,
  bigfile: 1.0,
  recall: 0.6,
  implement: 1.0,
  debug: 1.0,
  review: 1.2,
  plan: 1.4,
  refactor: 1.6,
  design: 2.4,
  research: 0.6,
  test: 0.6,
  run: 0,
  ui: 0,
  scope: 1.2,
  risk: 0.8,
  perf: 0.8,
  paths: 0.3,
  words40: 0.3,
  words120: 0.6,
  stackTrace: 0.4,
  taskFiles: 0.4,
  taskDeps: 0.2,
  taskFloor: 2,
  investigateFloor: 2,
  crossCuttingFloor: 2,
  toolProvider: 0,
  asymmetry: 2,
});

/** Default tier centres on the complexity axis (mirrors config `weights.tierCenters`). */
export const DEFAULT_TIER_CENTERS: Readonly<Record<string, number>> = Object.freeze({
  haiku: 0.6,
  sonnet: 2.0,
  opus: 3.4,
});

/** Softmax temperature of the tier table. */
const TAU = 0.5;
/** Complexity at which design or refactor work is worth delegating to an Agent. */
const AGENT_AT = 3.5;

export interface HeuristicWeights {
  tierCenters?: Record<string, number>;
  features?: Record<string, number>;
}

export interface Catalogue {
  /** Ordered ladder, smallest first (config `tiers`). */
  tiers?: readonly Tier[];
  /** Registered tools; intersected with TOOL_IDS. */
  tools?: readonly string[];
  /** The active swarm's roles; when given they are the only role options. */
  roles?: ReadonlyArray<{ name: string; description?: string }>;
}

export const DEFAULT_TIERS: readonly Tier[] = ["haiku", "sonnet", "opus"];

const r2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function complexityBucket(c: number): number {
  return clamp(Math.round(c), 0, 4);
}

/** Effort ladder from complexity; `max` only at the very top (c ≥ MAX_EFFORT_AT). */
export const MAX_EFFORT_AT = 3.75;

export function effortFor(c: number): Effort {
  if (c < 1.5) return "low";
  if (c < 2.5) return "medium";
  if (c < 3.5) return "high";
  if (c < MAX_EFFORT_AT) return "xhigh";
  return "max";
}

/** The strongest intent, or undefined when none fired. */
export function topIntent(f: Features): Intent | undefined {
  let best: Intent | undefined;
  for (const [i, v] of Object.entries(f.intents) as Array<[Intent, number]>)
    if (v > 0 && (best === undefined || v > (f.intents[best] ?? 0))) best = i;
  return best;
}

export function tierCenter(tier: string, index: number, centers: Record<string, number>): number {
  return centers[tier] ?? 0.6 + 1.4 * index;
}

/** Confidence of a table: 0.5 + (top − second)/2. */
export function tableConfidence(entries: ScoreEntry[]): number {
  return 0.5 + ((entries[0]?.score ?? 0) - (entries[1]?.score ?? 0)) / 2;
}

/** Normalises raw scores into a table that sums to 1, sorted descending (stable by option order). */
export function makeTable(
  dimension: ScoreTable["dimension"],
  options: readonly string[],
  raw: Map<string, { s: number; reasons: Reason[] }>,
  fallback: string,
): ScoreTable {
  let total = 0;
  for (const o of options) total += Math.max(0, raw.get(o)?.s ?? 0);
  const fb = options.includes(fallback) ? fallback : options[0];
  const entries: ScoreEntry[] = options.map((o) => {
    const e = raw.get(o);
    const score = total > 0 ? Math.max(0, e?.s ?? 0) / total : o === fb ? 1 : 0;
    const reasons = e?.reasons ?? [];
    if (total <= 0 && o === fb)
      reasons.push({ feature: "fallback", weight: 1, note: `no signal; default ${fb}` });
    return { option: o, score, reasons };
  });
  entries.sort((a, b) => b.score - a.score);
  return {
    dimension,
    entries,
    choice: entries[0]?.option ?? fallback,
    confidence: tableConfidence(entries),
  };
}

function add(
  raw: Map<string, { s: number; reasons: Reason[] }>,
  option: string,
  weight: number,
  feature: string,
  note: string,
) {
  if (!weight) return;
  const e = raw.get(option) ?? { s: 0, reasons: [] };
  e.s += weight;
  e.reasons.push({ feature, weight: r2(weight), note });
  raw.set(option, e);
}

// --- complexity (§7.2) ----------------------------------------------------

/** Intents that change or plan the code; scope counts in full only next to one of them. */
const CHANGES: Intent[] = [
  "implement",
  "edit_small",
  "refactor",
  "design",
  "plan",
  "review",
  "debug",
  "test",
  "ui",
];
const READ_SCOPE = 0.5;
/** Intents that make a request more than a lookup (the read-only rule above). */
const WORK: Intent[] = [
  "implement",
  "edit_small",
  "refactor",
  "design",
  "plan",
  "review",
  "debug",
  "ui",
];
/** Intents that turn a long request into a design brief rather than a symptom report. */
const BROAD: Intent[] = ["design", "plan", "refactor", "implement"];

export function scoreComplexity(
  f: Features & Partial<FeatureExtras>,
  w: Record<string, number>,
): { complexity: number; reasons: Reason[] } {
  const reasons: Reason[] = [];
  let c = 0;
  const term = (feature: string, weight: number, note: string) => {
    if (!weight) return;
    c += weight;
    reasons.push({ feature, weight: r2(weight), note });
  };
  const has = (i: Intent) => (f.intents[i] ?? 0) > 0;
  // Test work is a phrase or the lead verb (≥ 0.8); a passing mention is the object of a read.
  const readOnly = !WORK.some(has) && (f.intents.test ?? 0) < 0.8;
  term("base", w.base ?? 0, "base");
  for (const [i, v] of Object.entries(f.intents) as Array<[Intent, number]>) {
    if (!(v > 0)) continue;
    if (readOnly && i === "test") continue; // "which tests cover X" is a lookup
    term(`intent.${i}`, (w[i] ?? 0) * v, `${i} ${r2(v)} × ${w[i] ?? 0}`);
  }
  if (f.scope > 0) {
    // Breadth makes a change bigger; for a read it is the tool's job (search the whole codebase).
    const changes = CHANGES.some((i) => (f.intents[i] ?? 0) > 0);
    term(
      "scope",
      (w.scope ?? 0) * f.scope * (changes ? 1 : READ_SCOPE),
      `scope ${r2(f.scope)}${changes ? "" : " (read only, halved)"}`,
    );
  }
  if (f.risk > 0) term("risk", (w.risk ?? 0) * f.risk, `risk ${r2(f.risk)}`);
  if (f.perf) term("perf", (w.perf ?? 0) * f.perf, "performance work with a measured number");
  const paths = f.prosePaths ?? f.paths;
  if (paths > 0 && !readOnly)
    term("paths", (w.paths ?? 0) * Math.log2(1 + paths), `${paths} path(s) named`);
  // Length counts prose only; a symptom report's length describes the bug, not the fix.
  const words = f.proseWords ?? f.words;
  const report = has("debug") && !BROAD.some(has);
  if (words > 120 && !report) term("words120", w.words120 ?? 0, `${words} words`);
  else if (words > 40) term("words40", w.words40 ?? 0, `${words} words`);
  if (f.stackTrace) term("stackTrace", w.stackTrace ?? 0, "stack trace");
  if (f.task && f.task.files > 3)
    term("taskFiles", w.taskFiles ?? 0, `task touches ${f.task.files} files`);
  if (f.task && f.task.deps > 1) term("taskDeps", w.taskDeps ?? 0, `${f.task.deps} deps`);
  // Investigations and cross-cutting changes are sized by what they touch, not by their wording.
  const invFloor = w.investigateFloor ?? 0;
  if (f.investigate && c < invFloor)
    term("investigate", invFloor - c, `investigates system behaviour: floor ${invFloor}`);
  const ccFloor = w.crossCuttingFloor ?? 0;
  if (f.crossCutting && c < ccFloor)
    term("crossCutting", ccFloor - c, `cross-cutting change: floor ${ccFloor}`);
  const floor = w.taskFloor ?? 0;
  if (f.taskTitle && c < floor) term("taskFloor", floor - c, `swarm task title: floor ${floor}`);
  return { complexity: clamp(c, 0, 4), reasons };
}

// --- tier (§7.3) ----------------------------------------------------------

/**
 * The tier table. `asymmetry` (≥ 1) is the under/over-tiering cost ratio from the header;
 * the default 1 is the symmetric nearest-centre rule, scoreHeuristic passes `weights.features.asymmetry`.
 */
export function scoreTier(
  c: number,
  f: Pick<Features, "risk" | "chat">,
  ladder: readonly Tier[],
  centers: Record<string, number>,
  asymmetry = 1,
): ScoreTable {
  const a = Math.max(1, Number.isFinite(asymmetry) ? asymmetry : 1);
  const sonnetAt = ladder.indexOf("sonnet");
  const riskFrom = sonnetAt >= 0 ? sonnetAt : 1;
  const logits = ladder.map((t, i) => {
    const center = tierCenter(t, i, centers);
    // Below the request (c > centre) this tier risks a redo: that gap costs `a` times more.
    const under = c > center;
    let s = -(under ? a : 1) * Math.abs(c - center);
    const reasons: Reason[] = [
      {
        feature: "complexity",
        weight: r2(s),
        note: `c ${r2(c)} vs centre ${center}${under && a !== 1 ? ` (under-tier ×${r2(a)})` : ""}`,
      },
    ];
    if (f.risk > 0 && i >= riskFrom) {
      s += 0.4 * f.risk;
      reasons.push({ feature: "risk", weight: r2(0.4 * f.risk), note: `risk ${r2(f.risk)}` });
    }
    if (f.chat && i === 0) {
      s += 1;
      reasons.push({ feature: "chat", weight: 1, note: "chat" });
    }
    return { t, s, reasons };
  });
  const max = Math.max(...logits.map((l) => l.s));
  const raw = new Map<string, { s: number; reasons: Reason[] }>();
  for (const l of logits) raw.set(l.t, { s: Math.exp((l.s - max) / TAU), reasons: l.reasons });
  return makeTable("tier", ladder, raw, ladder[0] ?? "haiku");
}

// --- tool (§7.4) ----------------------------------------------------------

const WRITES: Intent[] = ["implement", "edit_small", "refactor"];

export function scoreTool(
  f: Features & Partial<FeatureExtras>,
  c: number,
  tools: readonly string[],
): ScoreTable {
  const raw = new Map<string, { s: number; reasons: Reason[] }>();
  const i = f.intents;
  const rule = (intent: Intent, tool: string, w: number, extra = "") => {
    const v = i[intent] ?? 0;
    if (v > 0) add(raw, tool, w * v, `intent.${intent}`, `${intent} → ${tool}${extra}`);
  };
  // A docs or history question names where the answer is; its question words are not a code search.
  const lookup = Math.max(0, (i.lookup ?? 0) - Math.max(i.docs ?? 0, i.history ?? 0));
  if (lookup > 0) {
    add(raw, "em_symbols", 0.6 * lookup, "intent.lookup", "lookup → em_symbols");
    add(raw, "em_search", 0.4 * lookup, "intent.lookup", "lookup → em_search");
  }
  rule("impact", f.refs ? "em_symbols" : "em_graph_impact", 1, f.refs ? " (callers/usages)" : "");
  rule("history", "em_history", 1);
  const run = f.batch ? "em_batch_execute" : "em_execute";
  rule("run", run, 1);
  // Tests next to a write intent are tests to write; on their own, tests to run.
  if (WRITES.some((w) => (i[w] ?? 0) > 0)) rule("test", "Edit", 1, " (write tests)");
  else rule("test", run, 1);
  rule("bigfile", "em_execute_file", 1);
  rule("docs", f.fetch ? "em_fetch_and_index" : "em_docs", 0.6);
  rule("docs", f.fetch ? "em_docs" : "em_fetch_and_index", 0.4);
  rule("research", "em_fetch_and_index", 0.6);
  rule("research", "em_search", 0.3);
  rule("recall", "em_recall", 1);
  rule("plan", "em_swarm", 1);
  rule("edit_small", "Edit", 1);
  rule("implement", "Edit", 1);
  rule("git", "Bash", 1);
  rule("debug", "em_execute", 0.6, " (reproduce)");
  rule("debug", "em_search", 0.3);
  rule("chat", "none", 1);
  if (c >= AGENT_AT) {
    rule("design", "Agent", 1.5, ` (c ≥ ${AGENT_AT})`);
    rule("refactor", "Agent", 1.5, ` (c ≥ ${AGENT_AT})`);
    rule("review", "Agent", 1, ` (c ≥ ${AGENT_AT})`);
  } else {
    rule("design", "em_recall", 0.5, " (check past decisions)");
    rule("refactor", "Edit", 0.8);
    rule("review", "Agent", 0.6);
    rule("review", "em_search", 0.3);
  }
  if (f.symbols > 0 || f.paths > 0) {
    const v = Math.min(1, (f.symbols + f.paths) / 2);
    add(raw, "em_symbols", 0.2 * v, "symbols", "symbols or paths named");
    add(raw, "em_graph_impact", 0.1 * v, "symbols", "symbols or paths named");
  }
  const options = TOOL_IDS.filter((t) => tools.includes(t));
  return makeTable("tool", options, raw, f.chat ? "none" : "em_search");
}

// --- role (§7.5) ----------------------------------------------------------

const ROLE_MAP: Partial<Record<Intent, Record<string, number>>> = {
  lookup: { explorer: 1 },
  impact: { explorer: 1 },
  bigfile: { explorer: 1 },
  history: { explorer: 0.5, researcher: 0.5 },
  docs: { researcher: 1 },
  research: { researcher: 1 },
  recall: { reviewer: 0.6, architect: 0.4 },
  implement: { coder: 1 },
  edit_small: { coder: 1 },
  refactor: { coder: 1 },
  debug: { coder: 1 },
  git: { coder: 1 },
  test: { tester: 1.2 },
  run: { tester: 1 },
  review: { reviewer: 1.2 },
  design: { architect: 1.2 },
  plan: { architect: 1.2 },
  ui: { ui: 0.8 },
  chat: { none: 1 },
};

const profiles = new Map<string, Partial<Record<Intent, number>>>();
function profile(name: string, description: string): Partial<Record<Intent, number>> {
  const k = `${name}\n${description}`;
  let p = profiles.get(k);
  if (!p) {
    p = extractIntents(`${name} ${description}`);
    if (profiles.size > 256) profiles.clear();
    profiles.set(k, p);
  }
  return p;
}

export function scoreRole(
  f: Features & Partial<FeatureExtras>,
  catalogue?: Catalogue["roles"],
  c = 0,
): ScoreTable {
  const raw = new Map<string, { s: number; reasons: Reason[] }>();
  const options = catalogue?.length ? catalogue.map((r) => r.name) : [...DEFAULT_ROLES];
  const known = new Set(options);
  // Bounded UI work (no refactor, not broad) confined to the UI is the ui role's change. With risk
  // or another layer named (an endpoint, the CLI, a login, one area of a list) it is one change
  // across layers: the coder's, and the UI noun's own vote goes to the coder too.
  const bounded = !(f.intents.refactor ?? 0) && f.scope < 1;
  const crossLayer = bounded && (f.risk > 0 || f.otherLayer === true);
  const uiWork = known.has("ui") && (f.intents.ui ?? 0) > 0 && bounded && !crossLayer;
  for (const [intent, v] of Object.entries(f.intents) as Array<[Intent, number]>) {
    if (!(v > 0)) continue;
    const edit = intent === "implement" || intent === "edit_small";
    for (const [r, w] of Object.entries(ROLE_MAP[intent] ?? {})) {
      const role =
        uiWork && edit && r === "coder"
          ? "ui"
          : crossLayer && r === "ui" && known.has("coder")
            ? "coder"
            : r;
      if (known.has(role)) add(raw, role, w * v, `intent.${intent}`, `${intent} → ${role}`);
    }
  }
  // Custom roles: overlap between the request's intents and the role description's intents.
  for (const r of catalogue ?? []) {
    if (!r.description) continue;
    const prof = profile(r.name, r.description);
    let overlap = 0;
    for (const [intent, v] of Object.entries(f.intents) as Array<[Intent, number]>)
      overlap += v * (prof[intent] ?? 0);
    if (overlap > 0) add(raw, r.name, 0.5 * overlap, "description", "matches the role description");
  }
  // A rewrite big enough to delegate is architecture work before it is coding.
  const refactor = f.intents.refactor ?? 0;
  if (c >= AGENT_AT && refactor > 0 && known.has("architect"))
    add(
      raw,
      "architect",
      1.2 * refactor,
      "intent.refactor",
      `large refactor (c ≥ ${AGENT_AT}) → architect`,
    );
  if (f.task?.role && known.has(f.task.role))
    add(raw, f.task.role, 1, "task.role", "role assigned by the plan");
  const fallback = f.chat || Object.keys(f.intents).length === 0 ? "none" : "explorer";
  return makeTable("role", options, raw, known.has(fallback) ? fallback : (options[0] ?? "none"));
}

// --- the whole set ----------------------------------------------------------

export function scoreHeuristic(
  f: Features,
  weights: HeuristicWeights = {},
  catalogue: Catalogue = {},
): ScoreSet {
  const w = { ...DEFAULT_FEATURE_WEIGHTS, ...(weights.features ?? {}) };
  const centers = { ...DEFAULT_TIER_CENTERS, ...(weights.tierCenters ?? {}) };
  const ladder = (catalogue.tiers?.length ? catalogue.tiers : DEFAULT_TIERS).filter((t) =>
    (TIERS as readonly string[]).includes(t),
  );
  const { complexity, reasons } = scoreComplexity(f, w);
  return {
    complexity,
    complexityReasons: reasons,
    tool: scoreTool(f, complexity, catalogue.tools ?? TOOL_IDS),
    tier: scoreTier(complexity, f, ladder, centers, w.asymmetry),
    role: scoreRole(f, catalogue.roles, complexity),
    effort: effortFor(complexity),
  };
}
