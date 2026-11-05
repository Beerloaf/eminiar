/**
 * Brief scoring by statement (docs/design/adjudicator.md §7; swarm run 20261104-672098, tasks #99
 * and #102): a planned task or an Agent dispatch is as hard as its hardest statement, not as hard
 * as everything it mentions added up.
 *
 * scoreComplexity SUMS intents, scope, risk, paths and length. That suits a prompt but saturates
 * on a brief: 40% of 672 real swarm tasks and 70% of 1044 real dispatch prompts sat on the 4.0
 * clamp, and appending a standard acceptance paragraph flipped the tier of 9% of tasks and the
 * role of 29% (blackboard model-switching-2). So the plan and agent surfaces (engine.ts) score a
 * brief as statements:
 *
 * 1. Units: the first line (the task title, the dispatch description), then every sentence or
 *    line of the rest, within the first UNIT_CHARS. A fenced block, or a run of pasted stack-trace
 *    and log lines, stays one unit; list markers and headings are stripped.
 * 2. Boilerplate is left out: the routine checks and the hand-in protocol a brief ends with ("Run
 *    npm run typecheck, lint and the tests", "Report the exact counts", "Claim it first: em_swarm
 *    {…}", "Post the numbers to blackboard key X"). They say how to hand the work in, not what the
 *    work is, and their run/test/plan words voted coder tasks over to the tester or the architect
 *    (design follow-up F1). Only routine checks qualify: "Check that every money path has a test"
 *    is the work of a review and stays. A clause is left out on its own ("Fix X; run the tests"
 *    keeps "Fix X"); the first unit always stays.
 * 3. At most UNIT_MAX units are scored, each with the shared scorer (extractFeatures +
 *    scoreHeuristic, with the request's hints); past the cap the remaining statements are joined
 *    into the last unit, so none is lost, and that unit is scored as its statements (joined they
 *    would add up again), in at most UNIT_MAX runs. The highest complexity wins: the complexity,
 *    its reasons, the tier table and the effort are that unit's. A tie goes to the riskier unit,
 *    then to the earlier one, so reordering the statements changes nothing.
 * 4. Role and tool are votes summed over the units (each unit's raw scores, read back from its
 *    table's reasons), normalised once. The plan's role (hints.role) is part of every unit's
 *    vote, so it stands unless most statements say otherwise.
 *
 * A text of one statement scores exactly as the whole-text scorer does. Appending boilerplate,
 * repeating the detail or reordering its sentences changes neither the tier, the effort nor the
 * role (tests/unit/adjudicator-units.test.ts).
 *
 * `sum` is the whole text's complexity before the 0..4 clamp (what scoring it as one text adds up
 * to) and `saturated` is sum > SATURATED_AT: the brief names more work than its hardest statement
 * scores, so a caller can present the effort as informational. `roleConfidence` is the summed
 * role table's confidence, for gating a "role suggested" note.
 *
 * Pure and synchronous, no I/O: one whole-text feature pass plus at most UNIT_MAX unit scorings,
 * 2 × UNIT_MAX − 1 on a brief past the cap.
 */

import { extractFeatures, type FeatureExtras } from "./features.js";
import {
  type Catalogue,
  DEFAULT_FEATURE_WEIGHTS,
  type HeuristicWeights,
  makeTable,
  scoreComplexity,
  scoreHeuristic,
} from "./heuristic.js";
import {
  type AdjudicationRequest,
  DEFAULT_ROLES,
  type Features,
  type Reason,
  type ScoreSet,
  type ScoreTable,
  type Surface,
  TOOL_IDS,
} from "./types.js";

/** Surfaces whose text is a brief (a planned task, an Agent dispatch): scored per statement. */
export const UNIT_SURFACES: readonly Surface[] = ["plan", "agent"];
/**
 * At most this many units are scored, the first line first; statements past the cap are joined
 * into the last unit, never dropped.
 */
export const UNIT_MAX = 40;
/** Text past this is not split (features.ts scans the same first 4000 characters). */
export const UNIT_CHARS = 4000;
/** A whole-text complexity above this before the 0..4 clamp is `saturated`. */
export const SATURATED_AT = 4;
/** Part of the cache key of unit-scored verdicts (engine.cacheKeyFor): bump when this changes. */
export const UNITS_VERSION = "2";

/** How a brief was scored; on the engine's Adjudication and in the row's scores JSON (`units`). */
export interface BriefUnits {
  /**
   * Scorings, the first line first, boilerplate excluded: one per unit, at most UNIT_MAX; when
   * the brief is capped its last unit counts as the statements (or runs, at most UNIT_MAX) it
   * was scored as, so up to 2 × UNIT_MAX − 1.
   */
  scored: number;
  /** Boilerplate statements and clauses left out (routine checks, hand-in protocol). */
  dropped: number;
  /**
   * Statements past UNIT_MAX. They are not left out: with the UNIT_MAX-th they make up the last
   * unit, scored statement by statement (0 when the brief has at most UNIT_MAX statements).
   */
  skipped: number;
  /** Index among the scorings of the one that set the complexity (0 = first line). */
  winner: number;
  /** The whole text's complexity before the 0..4 clamp: what scoring it as one text adds up to. */
  sum: number;
  /** sum > SATURATED_AT: the brief names more work than its hardest statement scores. */
  saturated: boolean;
  /** The heuristic role table's confidence, 0.5 + (top − second) / 2: gate role notes on it. */
  roleConfidence: number;
}

export interface UnitScore {
  /** Complexity, tier and effort of the hardest statement; role and tool summed over all. */
  set: ScoreSet;
  /** Features of the whole text: stored on the row and read by the learned bias, as before. */
  features: Features & FeatureExtras;
  units: BriefUnits;
}

/** Whether requests on this surface are briefs, scored per statement. */
export function unitScored(surface: string): boolean {
  return (UNIT_SURFACES as readonly string[]).includes(surface);
}

// --- statements ------------------------------------------------------------------------------

const FENCE = /```[\s\S]*?(?:```|$)/g;
/**
 * A line of pasted output: an error header, a stack frame (with or without a position), a
 * traceback line, a test-runner mark, a timestamped log line. Case-sensitive, like the output.
 */
const TRACE_LINE =
  /^\s*(?:at\s.+:\d+(?::\d+)?\)?\s*$|at\s[\w$.<>[\] ]+\s\(.*\)\s*$|(?:[A-Z]\w*)?(?:Error|Exception)(?::|\s+\[)|File ".+", line \d+|Traceback \(most recent call last\)|(?:FAIL|PASS|ERR!|×|✗|✓|✔)\s|npm (?:ERR|WARN)|\[?\d{4}-\d\d-\d\d[T ]\d\d:\d\d)/;
/** List markers, headings, quotes and checkboxes, then leading emphasis. */
const MARKER = /^\s*(?:(?:[-*+•>]|#{1,6}|\d{1,3}[.)]|\[[ xX]\])\s+)*(?:\*\*|__)?/;
/** A sentence ends at . ! or ? (perhaps closed by a quote or bracket) before whitespace. */
const SENTENCE_END = /(?<=[.!?]|[.!?]["'”’)\]])\s+(?=\S)/;
/** Abbreviations whose period does not end the sentence ("e.g. a cache"). */
const ABBREV =
  /(?:^|[\s(])(?:e\.g|i\.e|vs|cf|approx|incl|esp|resp|viz|al|fig|eq|ref|sec|vol|ca)\.$/i;
const WORDY = /[\p{L}\p{N}]/u;

/**
 * Every statement of a text, in order and before boilerplate is left out: each sentence or line
 * of the first UNIT_CHARS. Pasted material (a fenced block, a run of trace or log lines) is
 * evidence for the statement before it ("The build fails with: …") and joins it.
 */
export function statements(text: string): string[] {
  const s = text.slice(0, UNIT_CHARS);
  const out: string[] = [];
  let at = 0;
  for (const m of s.matchAll(FENCE)) {
    const i = m.index ?? 0;
    prose(s.slice(at, i), out);
    pasted(m[0].trim(), out);
    at = i + m[0].length;
  }
  prose(s.slice(at), out);
  return out;
}

/** Pasted material joins the statement before it; at the very start it stands alone. */
function pasted(block: string, out: string[]): void {
  if (!WORDY.test(block)) return;
  const last = out.length - 1;
  if (last >= 0) out[last] = `${out[last]}\n${block}`;
  else out.push(block);
}

function prose(chunk: string, out: string[]): void {
  let trace: string[] = [];
  const flush = () => {
    if (trace.length) pasted(trace.join("\n"), out);
    trace = [];
  };
  for (const line of chunk.split(/\r?\n/)) {
    if (TRACE_LINE.test(line)) {
      trace.push(line.trim());
      continue;
    }
    flush();
    const body = line.replace(MARKER, "").trim();
    if (!WORDY.test(body)) continue;
    let prev: string | undefined;
    for (const piece of body.split(SENTENCE_END)) {
      if (prev !== undefined && ABBREV.test(prev)) {
        prev = `${prev} ${piece}`;
        continue;
      }
      if (prev !== undefined && WORDY.test(prev)) out.push(prev);
      prev = piece;
    }
    if (prev !== undefined && WORDY.test(prev)) out.push(prev);
  }
  flush();
}

// --- boilerplate -----------------------------------------------------------------------------

/** Clauses of a statement that can be left out on their own ("Fix X; run the tests"). */
const CLAUSE = /;\s+|,?\s+(?:and\s+)?then\s+/;
/** Longer clauses are never boilerplate (and the bounded patterns below stay cheap). */
const CLAUSE_MAX = 400;
/** "Then", "Finally,", "Before reporting," and the like ahead of the verb. */
const LEAD_IN =
  /^(?:(?:then|finally|also|and|afterwards|after that|next|lastly|last|please|always|first|at the end|once (?:done|finished|it passes|that passes)|when (?:you(?:'re| are) )?(?:done|finished)|before (?:you )?(?:report(?:ing)?|finish(?:ing)?|clos(?:e|ing)|commit(?:ting)?|hand(?:ing)? (?:it )?(?:back|off)))[\s,:;-]+)+/;
/** A routine check: the type checker, the linter, a test run, the build. */
const CHECK = String.raw`(?:npm (?:run [\w:-]+|test|t|ci)|npx (?:tsc|vitest|biome|jest|eslint|prettier|mocha|playwright)|(?:pnpm|yarn)(?: run)? [\w:-]+|type-?check\w*|tsc|lint\w*|biome|eslint|prettier|vitest|jest|pytest|go (?:test|vet)|cargo (?:test|check|clippy)|tests?|specs?|test ?suites?|suites?|build|ci)`;
/**
 * One check in a list: "the adjudicator unit tests", "npx vitest run tests/unit/x.test.ts". The
 * words before it name which checks (never a verb: "add tests" is work); after it come only
 * flags, paths and words like "only" or "again".
 */
const CHECK_ITEM = String.raw`(?:(?:the|all|all the) )?(?:(?!(?:add|write|create|update|fix|cover|extend|implement|change|remove|delete|rewrite|refactor|make|keep|test)\b)[\w./:@+*-]+ ){0,2}?${CHECK}(?: (?:--?[\w-]+(?:=\S+)?|[\w@+-]*[./*:][\w./:@+*=-]*|only|again|too|first|alone|there|here|as well)){0,4}?`;
/** Nouns that make a leading "report" the subject ("Report generation is slow"). */
const REPORT_NOUN =
  "generation|generator|rows?|pages?|builder|templates?|exports?|service|views?|endpoints?|api|jobs?|schema|module|component|card|tab|screen|quer(?:y|ies)|model|pdf|csv|ui|dashboard";

/** Nothing but checks: "Typecheck, lint, adjudicator tests", "npm test && npm run lint pass". */
const CHECKS_ONLY = new RegExp(
  String.raw`^${CHECK_ITEM}(?:\s*(?:,|\+|&&?|/|\band\b|\bor\b)\s*${CHECK_ITEM}){0,8}(?:\s+(?:must |should |all |still )*(?:pass(?:es)?|be green|stay green|succeed|exits? 0|exit cleanly|(?:is|are) clean))?(?:\s+if [\w\s'-]{1,30})?\s*[.!]?$`,
);

/** Steps by their lead verb. */
const PROTOCOL: readonly RegExp[] = [
  // run the checks: "Run npm run typecheck, lint and the adjudicator tests"
  new RegExp(
    String.raw`^(?:re-?run|run|execute)\s+(?:(?:the|all|every|each|your|our|both|once|again|first|these|those|its|their)\s+)*(?:[\w./:@+*-]+\s+){0,3}?${CHECK}\b`,
  ),
  // the checks must pass: "Make sure typecheck and lint still pass"
  new RegExp(
    String.raw`^(?:verify|check|confirm|ensure|make sure|double-check|keep)\b.{0,80}?\b${CHECK}\b.{0,60}?\b(?:pass(?:es|ing)?|green|succeed\w*|clean|still (?:pass|work)\w*)\b`,
  ),
  // verify by the checks: "Verify with npm run build", "Verify: npx tsc --noEmit"
  new RegExp(
    String.raw`^(?:verify|check|confirm|validate|test)(?:\s*:\s*|\s+(?:it |this |them |that |everything )?(?:with|using|by running|via)\s+)(?:the |a )?${CHECK}\b`,
  ),
  // reporting back: "Report the exact counts", "Report back (concise):"
  new RegExp(String.raw`^report\b(?!\s+(?:${REPORT_NOUN})\b)`),
  // closing the task: "Close the task with the counts", "End with a compact table"
  /^(?:close|finish|complete|wrap up|end)\s+(?:(?:the|this|your|each|every)\s+)?(?:tasks?|it|them|each|with|up|run)\b/,
  /^end (?:the |every |each |your |all )?(?:(?:pr|commit|reply|comment) )?(?:body|messages?|commits?|description|reply|comment|report)s? with\b/,
  /^(?:co-authored-by|🤖 generated with)\b/,
  // swarm protocol: "Claim it first: em_swarm {…}", "Mark it done with em_swarm update"; not a
  // claim with the work after it ("Claim it, read …, review …", "Claim: the PR now returns …")
  /^claim\b(?:[^:,]*|.*?[:(]\s*em_swarm\b.*)$/,
  /^(?:mark|update|use)\b.{0,80}?\bem_swarm\s*(?:\{|update\b)/,
  // handing results in: "Post the numbers to blackboard key X", "Put the counts in your update"
  // (a short object, then where it goes: "Record baseline numbers for … and post them" is work)
  /^(?:post|put|share|publish|include|give|state|list|record|log|leave|note|mention|summari[sz]e)\b(?:\s+\S+){0,12}?\s+(?:to|on|under|in|into|as|with|via|onto)\s+(?:the\s+|your\s+)?(?:blackboard|em_swarm|em_remember|(?:task\s+)?(?:update|result|results|report|final (?:message|report|answer)|reply|summary|hand-?off)\b|key\b)/,
  // the shape of the answer: "Return: a verdict, then findings", "Lead with the outcome"
  /^return(?:\s*:|\s+(?:in|as|only|at most|under|<=?)\s|\s+(?:(?:a|an|the|your)\s+)?(?:(?:dense|structured|short|concise|brief|compact|plain|one-line|final|markdown|json)\s+)*(?:report|summary|verdict|list|table|findings|results?|answer|overview)\b)/,
  /^lead with\b/,
  /^(?:test|check|lint|build|verify|verification) (?:commands?|steps?)\b/,
];

/**
 * Work carried by a step that opens on a check or report verb (review #109 F2): "Run the build
 * under Node 18 and fix the ESM import errors", "Make sure the build passes on Windows by
 * rewriting the path handling", "Check that CI is green after migrating the database layer",
 * "Report which endpoints leak personal data and patch each of them". The PROTOCOL patterns are
 * anchored on the lead verb, so without this the whole statement, work and all, was left out. A
 * routine follow-up ("and fix any failures", "and fix them") is still a hand-in step.
 */
const WORK_TAIL =
  /(?:,?\s+and|\s+by|\s+after)\s+(?:then\s+)?(?:fix(?:es|ing)?|patch(?:es|ing)?|redesign(?:s|ing)?|rewrit(?:e|es|ing)|refactor(?:s|ing)?|migrat(?:e|es|ing)|implement(?:s|ing)?|repair(?:s|ing)?|resolv(?:e|es|ing)|debug(?:s|ging)?|investigat(?:e|es|ing)|diagnos(?:e|es|ing)|port(?:s|ing)?|find(?:s|ing)?)\b(?!\s+(?:(?:any|all|the|every|each|those|these)\s+)?(?:(?:type|lint|test|tsc|build|ci|new|remaining|resulting|reported)\s+)?(?:failures?|failing\b|errors?|issues?|problems?|regressions?|breakages?|findings?|what\b|them\b|it\b|those\b|these\b|anything\b|everything\b|out\b))/;

function boilerplateClause(clause: string): boolean {
  const lead = clause
    .toLowerCase()
    .replace(/\*\*/g, "")
    .replace(/^[\s("'“]+/, "")
    .replace(LEAD_IN, "");
  const c = lead.replace(/`/g, "").trim();
  if (!c || c.length > CLAUSE_MAX) return false;
  if (CHECKS_ONLY.test(c)) return true;
  // A clause that opens on a code identifier ("`claim` → `claimTask` …") names code, not a step.
  return !lead.startsWith("`") && PROTOCOL.some((re) => re.test(c)) && !WORK_TAIL.test(c);
}

/**
 * A clause that continues the one before it rather than starting a step: under three words, or
 * opening on a determiner or a noun of a hand-in list ("Return: a verdict, then findings").
 */
const CONTINUATION =
  /^\s*(?:(?:the|a|an|any|all|each|every|its|their|your|our|this|these|those|which|what|whether|how|findings|results|counts|numbers|verdict|summary|list|table)\b|(?:\S+\s+)?\S+\s*[.!]?\s*$)/i;

/** A statement without its boilerplate clauses, and how many clauses were left out. */
function trimBoilerplate(statement: string): { kept: string; removed: number } {
  const clauses = statement.split(CLAUSE);
  const drop: boolean[] = [];
  for (const [i, c] of clauses.entries())
    drop.push(boilerplateClause(c) || (i > 0 && !!drop[i - 1] && CONTINUATION.test(c)));
  const kept = clauses.filter((_, i) => !drop[i]);
  if (kept.length === clauses.length) return { kept: statement, removed: 0 };
  return { kept: kept.join("; ").trim(), removed: clauses.length - kept.length };
}

/**
 * A statement without its boilerplate clauses: "" when it is all boilerplate, the statement
 * itself when none is. Kept clauses are joined with "; ".
 */
export function withoutBoilerplate(statement: string): string {
  return trimBoilerplate(statement).kept;
}

/** A routine check or hand-in step: says how to hand the work in, not what the work is. */
export function isBoilerplate(statement: string): boolean {
  return trimBoilerplate(statement).kept === "";
}

/**
 * The units of a brief: its statements without boilerplate (the first one always stays whole
 * when it is nothing else), each distinct one once (a repeat adds no evidence), at most UNIT_MAX
 * of them. Nothing past the cap is lost (review #109 F1: a brief whose hard statement came after
 * forty file lines scored as haiku): the first UNIT_MAX − 1 statements are units of their own and
 * every statement after them joins ONE last unit; `tail` lists the statements of that unit
 * (empty when there is no cap to apply). `dropped` counts the boilerplate statements and clauses
 * left out; `skipped` the statements past UNIT_MAX, which make up that last unit with the
 * UNIT_MAX-th (scoreUnits scores it statement by statement).
 */
export function splitUnits(text: string): {
  units: string[];
  dropped: number;
  skipped: number;
  tail: string[];
} {
  const units: string[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const [i, s] of statements(text).entries()) {
    const t = trimBoilerplate(s);
    const unit = t.kept || (i === 0 ? s : "");
    if (unit !== s) dropped += t.removed;
    if (!unit) continue;
    const key = unit.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) continue;
    seen.add(key);
    units.push(unit);
  }
  if (units.length <= UNIT_MAX) return { units, dropped, skipped: 0, tail: [] };
  const tail = units.splice(UNIT_MAX - 1);
  units.push(tail.join("\n"));
  return { units, dropped, skipped: tail.length - 1, tail };
}

/** `items` in at most `n` runs, in order: each alone when they fit, else joined runs. */
function runsOf(items: readonly string[], n: number): string[] {
  if (items.length <= n) return [...items];
  const size = Math.ceil(items.length / n);
  const out: string[] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size).join("\n"));
  return out;
}

// --- scoring ---------------------------------------------------------------------------------

const EPS = 1e-9;
const r2 = (n: number) => Math.round(n * 100) / 100;
const sumOf = (reasons: readonly Reason[]) => r2(reasons.reduce((s, r) => s + r.weight, 0));

/**
 * Score a brief per statement (see the header). `hints` go to every unit, as they would to the
 * whole text; `weights` and `catalogue` are scoreHeuristic's.
 */
export function scoreUnits(
  text: string,
  hints: AdjudicationRequest["hints"],
  weights: HeuristicWeights = {},
  catalogue: Catalogue = {},
): UnitScore {
  const features = extractFeatures(text, hints);
  const { units: parts, dropped, skipped, tail } = splitUnits(text);
  if (parts.length <= 1 && dropped === 0) {
    // One statement: the brief is that text, scored as before.
    const set = scoreHeuristic(features, weights, catalogue);
    const sum = sumOf(set.complexityReasons);
    return {
      set,
      features,
      units: briefOf(parts.length, 0, skipped, 0, sum, set.role.confidence),
    };
  }
  const w = { ...DEFAULT_FEATURE_WEIGHTS, ...(weights.features ?? {}) };
  const sum = sumOf(scoreComplexity(features, w).reasons);
  const risks: number[] = [];
  const score = (u: string): ScoreSet => {
    const f = extractFeatures(u, hints);
    risks.push(f.risk);
    return scoreHeuristic(f, weights, catalogue);
  };
  // The last unit of a capped brief is scored as its statements, not as the joined text: joined
  // statements add up the way a whole text does (14 of the 35 capped real dispatch prompts went
  // sonnet → opus that way), and a small edit among them pulls a hard one down (edit_small
  // weighs negative). Alone while they fit in UNIT_MAX runs, so the work stays bounded.
  const scoredParts = tail.length ? [...parts.slice(0, -1), ...runsOf(tail, UNIT_MAX)] : parts;
  const sets = scoredParts.map(score);
  const win = hardest(sets, risks);
  const top = sets[win] as ScoreSet;
  const role =
    sets.length === 1
      ? top.role
      : summed(
          "role",
          sets.map((s) => s.role),
          roleOptions(catalogue),
          top.role,
        );
  const tool =
    sets.length === 1
      ? top.tool
      : summed(
          "tool",
          sets.map((s) => s.tool),
          toolOptions(catalogue),
          top.tool,
        );
  const set: ScoreSet = {
    complexity: top.complexity,
    complexityReasons: top.complexityReasons,
    tool,
    tier: top.tier,
    role,
    effort: top.effort,
  };
  return {
    set,
    features,
    units: briefOf(sets.length, dropped, skipped, win, sum, role.confidence),
  };
}

/** The index of the hardest set: the highest complexity, a tie to the riskier, then the earlier. */
function hardest(sets: readonly ScoreSet[], risks: readonly number[]): number {
  let win = 0;
  for (let i = 1; i < sets.length; i++) {
    const c = (sets[i] as ScoreSet).complexity;
    const best = (sets[win] as ScoreSet).complexity;
    if (c > best + EPS || (c > best - EPS && (risks[i] ?? 0) > (risks[win] ?? 0))) win = i;
  }
  return win;
}

function briefOf(
  scored: number,
  dropped: number,
  skipped: number,
  winner: number,
  sum: number,
  roleConfidence: number,
): BriefUnits {
  return {
    scored,
    dropped,
    skipped,
    winner,
    sum,
    saturated: sum > SATURATED_AT,
    roleConfidence: r2(roleConfidence),
  };
}

/** The role options scoreRole uses for this catalogue, in its order. */
function roleOptions(catalogue: Catalogue): readonly string[] {
  return catalogue.roles?.length ? catalogue.roles.map((r) => r.name) : DEFAULT_ROLES;
}

/** The tool options scoreTool uses for this catalogue, in its order. */
function toolOptions(catalogue: Catalogue): readonly string[] {
  const tools = catalogue.tools ?? TOOL_IDS;
  return TOOL_IDS.filter((t) => tools.includes(t));
}

/**
 * One table from the units' tables: every unit's raw votes (its reasons, the fallback note
 * aside) summed per option and normalised once, so a unit with little to say adds little. Equal
 * reasons merge ("implement → coder (3 statements)"). With no vote at all: `fallback`.
 */
function summed(
  dimension: ScoreTable["dimension"],
  tables: readonly ScoreTable[],
  options: readonly string[],
  fallback: ScoreTable,
): ScoreTable {
  const votes = new Map<string, Map<string, Reason & { n: number }>>();
  let total = 0;
  for (const t of tables)
    for (const e of t.entries)
      for (const r of e.reasons) {
        if (r.feature === "fallback" || !(r.weight > 0)) continue;
        total += r.weight;
        let byReason = votes.get(e.option);
        if (!byReason) {
          byReason = new Map();
          votes.set(e.option, byReason);
        }
        const k = `${r.feature}\n${r.note}`;
        const m = byReason.get(k);
        if (m) {
          m.weight += r.weight;
          m.n++;
        } else byReason.set(k, { ...r, n: 1 });
      }
  if (!(total > 0)) return fallback;
  const raw = new Map<string, { s: number; reasons: Reason[] }>();
  for (const [option, byReason] of votes) {
    let s = 0;
    const reasons: Reason[] = [];
    for (const m of byReason.values()) {
      s += m.weight;
      reasons.push({
        feature: m.feature,
        weight: r2(m.weight),
        note: m.n > 1 ? `${m.note} (${m.n} statements)` : m.note,
      });
    }
    reasons.sort((a, b) => b.weight - a.weight);
    raw.set(option, { s, reasons });
  }
  return makeTable(dimension, options, raw, fallback.choice);
}

/** The `units` of a stored row's scores JSON (engine.verdictColumns), when it has them. */
export function briefUnitsOf(scores: string | null | undefined): BriefUnits | undefined {
  if (!scores) return undefined;
  try {
    const u = (JSON.parse(scores) as { units?: unknown } | null)?.units;
    if (!u || typeof u !== "object") return undefined;
    const o = u as Record<string, unknown>;
    const n = (k: string) => {
      const v = o[k];
      return typeof v === "number" && Number.isFinite(v) ? v : undefined;
    };
    const [scored, dropped, skipped, winner, sum, roleConfidence] = [
      n("scored"),
      n("dropped"),
      n("skipped"),
      n("winner"),
      n("sum"),
      n("roleConfidence"),
    ];
    if (
      scored === undefined ||
      dropped === undefined ||
      winner === undefined ||
      sum === undefined ||
      roleConfidence === undefined ||
      typeof o.saturated !== "boolean"
    )
      return undefined;
    return {
      scored,
      dropped,
      skipped: skipped ?? 0,
      winner,
      sum,
      saturated: o.saturated,
      roleConfidence,
    };
  } catch {
    return undefined;
  }
}
