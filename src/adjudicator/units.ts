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
 *    into the last unit, so none is lost, and that unit is scored as its statements, each alone
 *    (joined they would add up again, or dilute a hard one). The highest complexity wins: the complexity,
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
 * `sum` is the complexity of the brief's work (its kept statements, boilerplate left out) before
 * the 0..4 clamp (what scoring them as one text adds up to) and `saturated` is sum > SATURATED_AT:
 * the brief names more work than its hardest statement scores, so a caller can present the effort
 * as informational. `roleConfidence` is the summed role table's confidence, for gating a "role
 * suggested" note.
 *
 * Pure and synchronous, no I/O: one feature pass over the kept statements plus one scoring per
 * unit, and one per statement of the last unit on a brief past the cap (bounded by UNIT_CHARS).
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
/** A complexity of the kept statements above this before the 0..4 clamp is `saturated`. */
export const SATURATED_AT = 4;
/** Part of the cache key of unit-scored verdicts (engine.cacheKeyFor): bump when this changes. */
export const UNITS_VERSION = "4";

/** How a brief was scored; on the engine's Adjudication and in the row's scores JSON (`units`). */
export interface BriefUnits {
  /**
   * Scorings, the first line first, boilerplate excluded: one per unit, at most UNIT_MAX; when
   * the brief is capped its last unit counts as the statements it was scored as, each alone, so
   * UNIT_MAX − 1 + skipped + 1.
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
  /** The kept work's complexity before the 0..4 clamp: what scoring it as one text adds up to. */
  sum: number;
  /** sum > SATURATED_AT: the brief names more work than its hardest statement scores. */
  saturated: boolean;
  /** The heuristic role table's confidence, 0.5 + (top − second) / 2: gate role notes on it. */
  roleConfidence: number;
}

export interface UnitScore {
  /** Complexity, tier and effort of the hardest statement; role and tool summed over all. */
  set: ScoreSet;
  /**
   * Features of the brief's work: of the whole text when it is one statement with nothing left
   * out, else of the kept units joined, so boilerplate ("run the tests, report the counts") never
   * becomes its top intent. Stored on the row and read by the learned bias.
   */
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
/** A check by its tool or command (not a generic "tests", "build"): "npm test", "typecheck", "lint". */
const TOOL_CHECK = String.raw`(?:npm (?:run [\w:-]+|test|t|ci)|npx (?:tsc|vitest|biome|jest|eslint|prettier|mocha|playwright)(?: run)?|(?:pnpm|yarn)(?: run)? [\w:-]+|type-?check\w*|tsc|lint\w*|biome|eslint|prettier|vitest|jest|pytest|go (?:test|vet)|cargo (?:test|check|clippy))`;
const CHECK = `(?:${TOOL_CHECK}|tests?|specs?|test ?suites?|suites?|build|ci)`;
/** What may follow a check: flags, paths and words like "only" or "again". */
const CHECK_SUFFIX = String.raw`(?: (?:--?[\w-]+(?:=\S+)?|[\w@+-]*[./*:][\w./:@+*=-]*|only|again|too|first|alone|there|here|as well)){0,4}?`;
/**
 * One check in a list: "the adjudicator unit tests", "npx vitest run tests/unit/x.test.ts". The
 * words before it name which checks (never a verb: "add tests" is work); after it come only
 * flags, paths and words like "only" or "again".
 */
const CHECK_ITEM = String.raw`(?:(?:the|all|all the) )?(?:(?!(?:add|write|create|update|fix|cover|extend|implement|change|remove|delete|rewrite|refactor|make|keep|test)\b)[\w./:@+*-]+ ){0,2}?${CHECK}${CHECK_SUFFIX}`;
/**
 * One routine check: a whole command ("npm run lint", "the full npx jest", "npx vitest run
 * tests/unit/x.test.ts") or a generic one ("the tests", "the whole suite"). No other word may
 * name it: a tool word used as a description ("the typechecker regression tests", "the eslint
 * plugin specs", "the ci-workflow tests") names a deliverable (review2 R2-1).
 */
const ROUTINE_ITEM = `(?:(?:the|all|full|whole|entire) ){0,3}(?:${TOOL_CHECK}|test ?suites?|tests?|specs?|suites?|build|ci)`;
/** After a label a routine check may say where it is: "Verify: the specs under tests/unit". */
const AT_PATH = String.raw`(?: (?:in|under) [\w@+-]*[./*][\w./:@+*=-]+)?`;
/** Nouns that make a leading "report" the subject ("Report generation is slow"). */
const REPORT_NOUN =
  "generation|generator|rows?|pages?|builder|templates?|exports?|service|views?|endpoints?|api|jobs?|schema|module|component|card|tab|screen|quer(?:y|ies)|model|pdf|csv|ui|dashboard";

const PASSES = "(?:pass(?:es)?|be green|stay green|succeed|exits? 0|exit cleanly|(?:is|are) clean)";
const IS_GREEN = "(?:is|are) (?:all )?(?:clean|green)";
const LIST_SEP = String.raw`\s*(?:,|\+|&&?|/|\band\b|\bor\b)\s*`;
/** A list of checks (each an `item`), then perhaps what they must do. */
const checkList = (item: string, verdict: string, sep = LIST_SEP) =>
  new RegExp(
    String.raw`^${item}(?:${sep}${item}){0,8}(?:\s+(?:must |should |all |still |both )*${verdict})?(?:\s+if [\w\s'-]{1,30})?\s*[.!]?$`,
  );
/** Nothing but checks: "Typecheck, lint, adjudicator tests", "npm test && npm run lint pass". */
const CHECKS_ONLY = checkList(CHECK_ITEM, PASSES);
/**
 * Nothing but routine checks, each one checked on its own (review2 R2-1): "Done when typecheck,
 * lint and the tests are green". One command in the list clears no other item: "the migration
 * tests, the rollback specs and typecheck pass" names work. The only checks after a label.
 */
const ROUTINE_CHECKS = checkList(
  `${ROUTINE_ITEM}${AT_PATH}${CHECK_SUFFIX}`,
  `(?:${PASSES}|${IS_GREEN})`,
  String.raw`\s*(?:,\s*(?:and|or)\b|,|\+|&&?|/|\band\b|\bor\b)\s*`,
);
/**
 * Without a label, only routine checks "are green": "Typecheck and lint are green" is a check,
 * "The migration tests and the rollback specs are green" names work (review2 R2-1 c).
 */
const ROUTINE_GREEN = checkList(`${ROUTINE_ITEM}${CHECK_SUFFIX}`, IS_GREEN);

/**
 * A label ahead of the checks: "Verification: npm run typecheck && npm run lint", "Done when
 * the tests pass", "Verify: npx tsc --noEmit". The noun labels need their colon. After a label
 * only ROUTINE_CHECKS is boilerplate (review1 F3/F4, review2 R2-1/R2-3): "Acceptance: unit tests
 * for A-E assert X", "Definition of done: the migration tests and the rollback specs", "Verify:
 * npm test covers the new retry path" and "Verify: the tests cover the retry path" are work.
 */
const CHECK_LABEL =
  /^(?:(?:verification|verify|validation|validate|confirm|acceptance(?: criteria)?|checks?|gates?|definition of done|done when|tests?)\s*:\s*|(?:done (?:when|once|if)|finished when)\s+)/;
/** A bare heading for the checks or the hand-in: "Verify:", "Then check:" (the colon is required). */
const LABEL_ONLY =
  /^(?:verification|verify|validation|validate|confirm|acceptance(?: criteria)?|checks?|gates?|tests?|definition of done|done when|hand-?in|deliverables?)\s*:\s*$/;

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
  // verify by the checks: "Verify with npm run build". The colon form ("Verify: npx tsc
  // --noEmit") goes through CHECK_LABEL, where every item must be a routine check (review2 R2-3).
  new RegExp(
    String.raw`^(?:verify|check|confirm|validate|test)\s+(?:it |this |them |that |everything )?(?:with|using|by running|via)\s+(?:the |a )?${CHECK}\b`,
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
 * Work carried by a step that opens on a check or report verb (review #109 F2, pre-PR review F2):
 * "Run the build under Node 18 and fix the ESM import errors", "Make sure the build passes on
 * Windows by replacing the path handling", "Verify CI is green after converting the monorepo to
 * ESM", "Report which endpoints leak personal data and add authorization checks to each". The
 * PROTOCOL patterns are anchored on the lead verb, so without this the whole statement, work and
 * all, was left out.
 *
 * A tail is ", and" + a work verb in its base form ("and changes" is a noun: "Copilot rounds and
 * changes"), or " by" / " after" + any gerund but a check or hand-in one ("by running npm test"). It is work unless it is a routine
 * follow-up: a repair verb whose routine object ENDS the clause ("and fix any failures", "and fix
 * them", "and fix the failing tests"; not "and fix the failing auth flow in the gateway"), a verb
 * with no object ("and fix"), or an object that is the hand-in ("and add the counts to your
 * update").
 */
const TAIL_LEAD = /(,?\s+and|\s+by|\s+after)\s+(?:then\s+)?([a-z][a-z-]*)\b/g;
/** Work verbs in the base form, for a tail after "and" ("and add …"). */
const WORK_VERBS = new Set(
  (
    "fix patch redesign rewrite refactor migrate implement reimplement repair resolve debug " +
    "investigate diagnose port find add update upgrade downgrade convert replace remove " +
    "delete rename move extract split merge introduce create write change modify wire " +
    "integrate harden optimize optimise restructure rework swap adopt bump configure enable " +
    "disable extend document deprecate encrypt sanitize secure address correct design"
  ).split(" "),
);
/** Repair verbs: their routine object ("any failures", "them") makes the tail a hand-in step. */
const REPAIR_VERB = new Set(
  (
    "fix fixing patch patching repair repairing resolve resolving debug debugging investigate " +
    "investigating diagnose diagnosing find finding address addressing correct correcting"
  ).split(" "),
);
/** Gerunds that are a check or the hand-in, not work ("by running npm test", "after reporting"). */
const NON_WORK_GERUND =
  /^(?:re-?running|running|executing|checking|re-?checking|verifying|confirming|ensuring|testing|re-?testing|linting|building|re-?building|type-?checking|reporting|posting|committing|pushing|claiming|closing|finishing|completing|marking|following|using|doing|making|keeping|passing|reading|looking|reviewing|editing|starting|getting|having|being|calling|invoking|merging|rebasing|pulling|fetching|installing|saving|switching)$/;
/** Words ending in -ing that are not gerunds. */
const NOT_GERUND = /thing$|^(?:string|during|pending|morning|evening|ceiling|nothing|spring)$/;
/**
 * Who reports the problems in a routine follow-up ("what the linter reports", "any failures the
 * e2e suite reports", "whatever tsc reports"): a closed list, so "whatever the scanner reports"
 * stays work (review1 F1). Never `the \w+`.
 */
const ROUTINE_SUBJECT =
  "(?:it|they|you|tsc|eslint|biome|vitest|jest|lint|ci|the (?:linter|compiler|(?:type ?)?checker|tool|runner|build|ci|tsc|eslint|(?:(?:e2e|unit|integration|full|test) )?(?:tests?|specs?|suites?|test ?suites?)))";
const REPORT_VERB =
  "(?:reports?|reported|finds?|found|prints?|shows?|says?|flags?|returns?|emits?|outputs?|surfaces?|raises?|raised|throws?|threw|fail(?:s|ed)?|breaks?)";
/**
 * Problems that turn up on their own: "any failures that show up", "whatever is broken", "any
 * tests that now fail", "whatever needs fixing" (review2 R2-2, closed lists).
 */
const EMERGE =
  "(?:shows? up|comes? up|turns? up|pops? up|appears?|remains?|(?:is|are) (?:left|broken|failing|reported|flagged)|(?:get|gets|got) (?:reported|flagged)|(?:now|still) fail(?:s|ed)?|starts? failing|comes? back|you (?:see|find|hit)|needs? fixing|goes red|(?:doesn['’]t|does not|don['’]t|do not) pass)";
/**
 * A routine object that ends the clause: "any failures", "the failing tests", "them", "the type
 * errors". Only the routine qualifiers may sit before the noun: a specific object ("the ESM
 * import errors", "the flaky concurrency failures") is real work and must not match.
 */
const ROUTINE_OBJECT = new RegExp(
  String.raw`^(?:\s+(?:up|out))?(?:\s+(?:any|all|the|every|each|those|these|its|their|your|whatever|remaining|new|resulting|reported|other))*(?:\s+(?:type|types|lint|linter|typecheck|tsc|eslint|compile|compiler|compilation|build|ci|test|unit|vitest|jest|failing|failed|broken|outstanding)){0,3}\s+(?:failures?|failing|fails|errors?|issues?|problems?|regressions?|breakages?|findings?|warnings?|complaints?|tests?|specs?|checks?|them|it|those|these|that|anything|everything|what(?:ever)?\s+(?:${ROUTINE_SUBJECT}\s+${REPORT_VERB}|fail(?:s|ed)?|breaks?|broke|errors?|${EMERGE}))(?:\s+(?:if any|as needed|as necessary|you find|found|reported|first|again|too|along the way|before (?:reporting|you report|finishing|you finish|handing in|you hand in|you are done|you're done|moving on)|(?:(?:that|which) (?:${ROUTINE_SUBJECT} )?|${ROUTINE_SUBJECT} )${REPORT_VERB}|(?:that|which) ${EMERGE}))?\s*[.!]?$`,
);
/** The object is the hand-in ("add the counts to your update", "update the task via em_swarm"). */
const HANDIN_OBJECT =
  /\b(?:em_swarm|em_remember|blackboard)\b|\b(?:to|in|into|on|under)\s+(?:the\s+|your\s+)?(?:task\s+)?(?:update|result|results|report|final (?:message|report|answer)|reply|summary|hand-?off)\s*[.!]?$/;

function workTail(clause: string): boolean {
  for (const m of clause.matchAll(TAIL_LEAD)) {
    const verb = m[2] as string;
    // After "and" a base form ("and add …"); after "by" / "after" only a gerund ("by replacing").
    const gerund =
      /^\w{3,}ing$/.test(verb) && !NON_WORK_GERUND.test(verb) && !NOT_GERUND.test(verb);
    const work = (m[1] as string).endsWith("and") ? WORK_VERBS.has(verb) : gerund;
    if (!work) continue;
    const rest = clause.slice((m.index ?? 0) + m[0].length);
    if (!/[\p{L}\p{N}]/u.test(rest)) continue; // no object: "and fix"
    if (HANDIN_OBJECT.test(rest)) continue;
    if (REPAIR_VERB.has(verb) && ROUTINE_OBJECT.test(rest)) continue;
    return true;
  }
  return false;
}

/**
 * Whether a clause is boilerplate, and how: "label" for checks after a label ("Done when the
 * tests pass"), which nothing after it continues; "step" for any other routine check or hand-in
 * step; false for work.
 */
function boilerplateClause(clause: string): false | "label" | "step" {
  const lead = clause
    .toLowerCase()
    .replace(/\*\*/g, "")
    .replace(/^[\s("'“]+/, "")
    .replace(LEAD_IN, "");
  const c = lead.replace(/`/g, "").trim();
  if (!c || c.length > CLAUSE_MAX) return false;
  if (LABEL_ONLY.test(c)) return "step";
  const rest = c.replace(CHECK_LABEL, "");
  if (rest !== c) return ROUTINE_CHECKS.test(rest) ? "label" : false;
  if (CHECKS_ONLY.test(c) || ROUTINE_GREEN.test(c)) return "step";
  // A clause that opens on a code identifier ("`claim` → `claimTask` …") names code, not a step.
  return !lead.startsWith("`") && PROTOCOL.some((re) => re.test(c)) && !workTail(c)
    ? "step"
    : false;
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
  // A step left out takes the clauses continuing it along ("Return: a verdict, then findings");
  // checks after a label do not: "Done when the tests pass; the cache must survive a restart"
  // keeps the cache (review2 R2-1 d).
  let carry = false;
  for (const c of clauses) {
    const kind = boilerplateClause(c);
    const continued: boolean = !kind && carry && CONTINUATION.test(c);
    drop.push(!!kind || continued);
    carry = kind === "step" || continued;
  }
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
  const { units: parts, dropped, skipped, tail } = splitUnits(text);
  if (parts.length <= 1 && dropped === 0 && statements(text).length <= 1) {
    // One statement: the brief is that text, scored as before. A statement said twice is not
    // one statement: it takes the units path like any brief with more than one, so appended
    // boilerplate cannot move it (review1 F5). The marker is stripped as the units path strips
    // it, so "- Fix X." scores the same alone and with a protocol line appended (review2 R2-4).
    const features = extractFeatures(text.replace(MARKER, ""), hints);
    const set = scoreHeuristic(features, weights, catalogue);
    const sum = sumOf(set.complexityReasons);
    return {
      set,
      features,
      units: briefOf(parts.length, 0, skipped, 0, sum, set.role.confidence),
    };
  }
  // The features are the kept units', not the whole text's (boilerplate would count as work).
  const features = extractFeatures(parts.join("\n"), hints);
  const w = { ...DEFAULT_FEATURE_WEIGHTS, ...(weights.features ?? {}) };
  const sum = sumOf(scoreComplexity(features, w).reasons);
  const risks: number[] = [];
  const score = (u: string): ScoreSet => {
    const f = extractFeatures(u, hints);
    risks.push(f.risk);
    return scoreHeuristic(f, weights, catalogue);
  };
  // The last unit of a capped brief is scored as its statements, each alone, not as the joined
  // text or joined runs of it: joined statements add up the way a whole text does (14 of the 35
  // capped real dispatch prompts went sonnet → opus that way), and a small edit among them pulls
  // a hard one down (edit_small weighs negative: "Migrate the auth tokens to the new encrypted
  // store." scored opus alone, sonnet in a run of renames; pre-PR review F3). The work stays
  // bounded: statements come from the first UNIT_CHARS characters only.
  const scoredParts = tail.length ? [...parts.slice(0, -1), ...tail] : parts;
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
