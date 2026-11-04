/**
 * Feature extraction for the adjudicator (docs/design/adjudicator.md §7.1). Pure and cheap
 * (well under 1 ms for a prompt): a handful of regexes over the lowercased text, no I/O.
 *
 * Intents come from an ordered lexicon. Multiword phrases run first and blank out the text they
 * match, so "what would break" counts as impact and not also as a lookup ("what"), "unit tests"
 * as test and not as a write, "is it safe" as recall and not as risk. Single stems run on what
 * is left. Generic stems (question words, "add", "write") are weaker evidence than specific
 * phrases, and the imperative lead word of a request ("refactor the ...", "commit ...") is the
 * strongest single cue, so a stem gets its full weight there and 70% of it elsewhere. A swarm
 * task prefix ("T7: ...") is stripped first so the verb after it counts as the lead.
 *
 * Pasted material (fenced code, stack-trace and log/test-output lines) is evidence of a debug
 * task, not of breadth: intents, scope and risk are read from the prose around it, and the
 * length bonus counts prose words only (`proseWords`).
 */

import { classifyPrompt } from "../capture/classify.js";
import type { AdjudicationRequest, Features, Intent } from "./types.js";

/**
 * Signals beyond the shared `Features` shape. extractFeatures always sets them; they are
 * optional to the scorer so a plain `Features` (e.g. stored or hand-built) still scores.
 */
export interface FeatureExtras {
  /** Words outside fenced code and pasted trace/log lines (drives the length bonus). */
  proseWords: number;
  /** Paths named in that prose (stack frames in pasted output are not files to touch). */
  prosePaths: number;
  /** Pasted stack trace, log or test output: evidence of a debug task. */
  pasted: boolean;
  /** A planned swarm task title ("T7: ...", "task #3: ..."). */
  taskTitle: boolean;
  /** 0..1: performance work backed by a measured number ("800ms", "40kb", "50k docs"). */
  perf: number;
}

interface Lexeme {
  intent: Intent;
  re: RegExp;
  /** Evidence strength 0..1. */
  w: number;
}

const p = (intent: Intent, re: RegExp, w = 1): Lexeme => ({ intent, re, w });

/** Multiword phrases: specific, matched first, and they mask what they match. */
const PHRASES: Lexeme[] = [
  // impact: judging the effect of a change is reasoning; listing dependents is a graph lookup
  p("impact", /\bwhat (?:would|will|could|might) (?:break|change|fail)\b/),
  p("impact", /\bwhat breaks\b/),
  p("impact", /\b(?:blast radius|impact of|affected by)\b/),
  p("impact", /\b(?:what|who|which \w+) (?:else )?(?:depends? on|imports?|calls?|uses?)\b/, 0.5),
  p(
    "impact",
    /\b(?:files?|modules?|code|callers?|places?) (?:that|which) (?:imports?|uses?|calls?|references?)\b/,
    0.5,
  ),
  p("impact", /\b(?:callers|usages?|references|dependents|consumers) of\b/, 0.5),
  // refactor: migrations and platform moves touch every module that uses the old thing
  p("refactor", /\b(?:esm|cjs|commonjs|typescript|ts|async|python ?3)[- ]only\b/),
  p(
    "refactor",
    /\bdrop (?:the |our )?(?:[\w.-]+ ){0,2}(?:build|support|dependency|runtime|fallback)\b/,
  ),
  p(
    "refactor",
    /\bupgrade (?:[\w.-]+ ){0,3}to (?:the )?(?:next |latest )?(?:major|v?\d+(?:\.x)?)\b/,
  ),
  p(
    "refactor",
    /\b(?:major (?:version )?(?:upgrade|bump)|bump (?:\w+ ){0,3}to (?:the )?next major)\b/,
  ),
  // "from X to Y" between named things, not numbers ("change the port from 3000 to 8080")
  p("refactor", /\b(?:port|move|switch|migrate) (?:[\w./-]+ ){0,5}from [a-z][\w./:-]* to\b/),
  p("refactor", /^\s*port (?:[\w./-]+ ){0,5}to (?=[a-z])/),
  p("refactor", /\breplace (?:[\w./-]+ ){0,5}with\b/),
  // history
  p("history", /\bwhy (?:was|were|did)\b(?! we\b)/),
  p("history", /\bwhen (?:was|were|did)\b/),
  p("history", /\b(?:git blame|git log|commit history|check (?:the )?history)\b/),
  p("history", /\bwho (?:wrote|changed|added|removed)\b/),
  // recall (judgement against past decisions); before "why did" style history
  p(
    "recall",
    /\b(?:should we|is it safe|is it ok(?:ay)?|safe to|did we (?:decide|agree|choose|pick)|what did we decide|why did we)\b/,
  ),
  // run
  p("run", /\b(?:the )?test suite\b/),
  p("run", /\brun (?:the |all (?:the )?)?tests?\b/),
  p("run", /\bnpm (?:audit|run \w+|test|ci)\b/),
  p("run", /\btype ?check(?:s|ing)?\b/),
  // bigfile
  p("bigfile", /\b\d[\d,.]*k?[- ]?(?:lines?|loc)\b/),
  p("bigfile", /\b(?:whole|entire|full) file\b/),
  // docs: reading documentation of something else
  p("docs", /\b(?:docs?|documentation|readme) (?:for|on|about|of)\b/),
  p("docs", /\b(?:latest|current|newest) version\b/),
  p("docs", /\b(?:api reference|release notes|changelog for)\b/),
  // writing docs is a small edit, not a docs lookup
  p(
    "edit_small",
    /\b(?:update|edit|fix|tweak|reword|touch up) (?:the |our |a )?(?:docs|readme|documentation|comments?|changelog|help text)\b/,
  ),
  p("edit_small", /\bfix (?:the |a )?typos?\b/),
  // adding a comment or annotation is mechanical, not new behaviour
  p(
    "edit_small",
    /\badd (?:a |an |some )?(?:short |brief |one-line |small )?(?:comments?|docstrings?|jsdoc|log lines?|type annotations?|todo)\b/,
  ),
  // plan
  p("plan", /\b(?:split|break|divide) (?:\w+ ){0,3}(?:into|down)\b/),
  p(
    "plan",
    /\b(?:into (?:sub)?tasks|assign (?:\w+ )?(?:workers|tasks|agents|owners)|roll ?out|work breakdown)\b/,
  ),
  // review
  p("review", /\b(?:security|code|design) (?:review|audit)\b/),
  p("review", /\breview (?:this|the|my|our) (?:pr|diff|change|patch|branch)\b/),
  // test
  p("test", /\b(?:unit|regression|integration|e2e|end-to-end|snapshot) tests?\b/),
  p("test", /\b(?:test coverage|write (?:a |some )?tests?)\b/),
  // git
  p(
    "git",
    /\b(?:commit (?:these|the|my|all)? ?changes|open a pr|git (?:push|pull|rebase|merge))\b/,
  ),
  // debug: symptoms
  p(
    "debug",
    /\b(?:does ?n[o']?t work|not working|is (?:too )?slow|returns? (?:duplicate|wrong|empty|stale)|stack ?trace)\b/,
  ),
  p("debug", /\bwhy (?:is|are|does|do|doesn't|isn't|would)\b/),
  // design
  p("design", /\b(?:design (?:a|an|the)|architecture (?:for|of))\b/),
  // research
  p("research", /\b(?:trade-?offs?|alternatives to|pros and cons)\b/),
  // lookup
  p("lookup", /\b(?:how does|how do|tell me|what is|what are|where is|where are)\b/, 0.7),
];

/** Single stems on the text left after the phrases. `w` is the weight at the lead position. */
const STEMS: Lexeme[] = [
  p(
    "lookup",
    /\b(?:what|where|which|show|list|explain|find|search|summari[sz]e|describe|locate)\b/,
    0.6,
  ),
  p("impact", /\b(?:depend\w*|affect\w*|impact\w*)\b/, 0.8),
  p("history", /\b(?:blame|history|histor\w+)\b/),
  p("run", /\b(?:run|lint|linter|typecheck)\b/, 0.9),
  p("docs", /\b(?:docs|documentation|fetch)\b/, 0.7),
  p("recall", /\b(?:decided|decision|convention|agreed)\b/, 0.7),
  p(
    "plan",
    /\b(?:plan|split|assign|rollout|roadmap|milestones?|coordinat\w*|orchestrat\w*)\b/,
    0.9,
  ),
  p("edit_small", /\b(?:rename\w*|typos?|tidy|format\w*|bump\w*|reword|indent\w*)\b/),
  // Imperative and progressive forms only: "added" or "implementation" describe, not request.
  p("implement", /\b(?:add|adding|write|writing|create|creating|introduce|build out)\b/, 0.8),
  // Specific implement verbs name real work on their own (never complexity ≤ 1).
  p(
    "implement",
    /\b(?:implement|implementing|optimi[sz]e|optimi[sz]ing|wire|wiring|convert|converting|extract|extracting|integrate|integrating|plumb|parallel[iy][sz]e|deduplicate)\b/,
  ),
  p("refactor", /\b(?:refactor\w*|migrat\w*|rewrit\w*|restructur\w*|consolidat\w*|overhaul\w*)\b/),
  p("design", /\b(?:design\w*|redesign\w*|re-?architect\w*|architect\w*|subsystem)\b/),
  p("review", /\b(?:review\w*|audit\w*)\b/),
  p(
    "debug",
    /\b(?:why|debug\w*|fail\w*|slow|crash\w*|race|bug\w*|broken|leak\w*|hang\w*|flaky|error\w*|fix|fixing|deadlock\w*|regressed)\b/,
    0.9,
  ),
  p("research", /\b(?:compar\w*|research\w*|providers?|evaluat\w*|benchmark\w*)\b/),
  p("test", /\b(?:tests?|verify|regression|coverage)\b/, 0.8),
  p("git", /\b(?:commit|push|rebase|branch|merge|cherry-pick|stash)\b/),
  p("ui", /\b(?:dashboard|css|component|view|layout|button|frontend|ui)\b/, 0.8),
];

/**
 * Verbs that request work only as the lead word of a request ("make the cache expire ...",
 * "store the access time ..."); elsewhere they are too common to mean anything.
 */
const LEAD_ONLY: Lexeme[] = [
  p(
    "implement",
    /^(?:make|build|port|handle|store|support|expose|persist|track|enable|ensure|allow|teach|cache|upgrade|harden|speed)\b/,
    0.8,
  ),
  // Generic change verbs: a small edit by default, but a change (so breadth counts in full).
  p("edit_small", /^(?:update|change|modify|adjust|tweak)\b/, 0.3),
  p("design", /^(?:propose|model)\b/, 0.8),
  p("plan", /^(?:coordinate|orchestrate)\b/),
];

/** Lead-position discount for stems elsewhere in the text. */
const NON_LEAD = 0.7;

const CHAT =
  /^(?:hi|hello|hey|yo|thanks|thank you|thx|ty|ok|okay|yes|yep|no|nope|sure|cool|great|nice|perfect|got it|that works|sounds good|lgtm|good|done)\b[\s\w,.!']*$/;
const POLITE =
  /^\s*(?:(?:please|pls|can you|could you|would you|let'?s|i want to|i'?d like to|help me|now|ok(?:ay)?|so)[\s,]+)+/;
/** A planned swarm task title: "T7: ...", "T12b) ...", "task #3: ...". */
const TASK_TITLE = /^\s*(?:t\d+[a-z]?|task\s*#?\d+)\s*[:.)\]-]\s+/i;

const STRONG_SCOPE =
  /\b(?:whole|entire|codebase|code base|across|everywhere|throughout|globally|repo-wide|system-wide|project-wide|end-to-end|every (?:module|file|package|service)|(?:all|every|each) (?:the |of the |its |their )?call[- ]?sites?|all (?:the )?\d+|(?:\d{2,}|three|four|five|six|seven|eight|nine|ten|dozens? of|hundreds of) (?:[\w-]+ )?(?:files|modules|packages|services|hooks|handlers|endpoints|call sites|callers|components|tables|commands|tools|routes|repos))\b/g;
/** Quantifiers and architectural units (a "layer" or "subsystem" is broad by definition). */
const WEAK_SCOPE =
  /\b(?:all|every|system|framework|platform|layer|subsystem|pipeline|architecture|monorepo|monolith\w*|call[- ]?sites?)\b/g;
/** An enumeration of three or more areas ("the server, CLI and dashboard") is breadth too. */
const ENUM3 = /\b[\w.-]+(?: [\w.-]+)?, (?:the )?[\w.-]+(?: [\w.-]+)?,? (?:and|&) (?:the )?[\w.-]+/g;

const RISK =
  /\b(?:secur\w*|vulnerab\w*|race conditions?|races?|migrat\w*|data loss|concurren\w*|production|prod|auth\w*|o?auth2?|oidc|pkce|sso|saml|jwt|csrf|xss|sandbox\w*|privilege\w*|multi-?tenan\w*|deadlock\w*|credentials?|secrets?|permissions?|delet\w* (?:\w+ ){0,2}(?:data|rows?|records?|tables?|users?|accounts?|database|db|buckets?|backups?|director(?:y|ies)|folders?)|drop (?:table|column)|backfill\w*|payments?|encrypt\w*|injection)\b/g;

/** Performance work: a perf word plus a measured number makes it a concrete, deep task. */
const PERF =
  /\b(?:optimi[sz]\w*|perf\w*|latency|throughput|slow\w*|faster|speed\w*|bundle size|memory|cpu|p9\d|scal(?:e|es|ing)|takes|went up|grew|regress\w*)\b/;
const MEASURE =
  /\b\d[\d,.]*\s?(?:ms|µs|us|s|secs?|seconds?|minutes?|mins?|kb|mb|gb|tb|x|%|rps|qps)\b|\b(?:\d{4,}|\d[\d,.]*\s?[km]|\d{1,3}(?:,\d{3})+|a (?:million|billion|thousand))\s?[a-z]*\b/;

const PATH_RE = /[\w./-]+\.(?:ts|tsx|js|py|go|rs|md|json|ya?ml|sql|php)\b/g;
const SYMBOL_RE =
  /`[^`\n]+`|\b[a-z][a-z0-9]*[A-Z]\w*\b|\b[A-Z][a-z0-9]+[A-Z]\w*\b|\b[a-z0-9]+_[a-z0-9_]+\b/g;
const STACK_RE = /^\s*at .+\(?[^\s()]+:\d+(?::\d+)?\)?\s*$|Traceback \(most recent call last\)/m;
/** One line of pasted output: a stack frame, a log line or a test runner line. */
const PASTED_LINE =
  /^\s*(?:at .+:\d+|File ".+", line \d+|\[?\d{4}-\d\d-\d\d[T ]\d\d:\d\d|\[(?:error|warn(?:ing)?|info|debug|trace|fatal)\]|(?:ERROR|WARN(?:ING)?|INFO|DEBUG|TRACE|FATAL)\b|(?:error|warn(?:ing)?|fatal):|(?:FAIL|PASS|ERR!|×|✗|✓|✔)\s|(?:[A-Z]\w*)?(?:Error|Exception)\b|(?:Expected|Received|AssertionError)\b|npm (?:ERR|WARN)|\$ |> )/;
const FENCE = /```[\s\S]*?(?:```|$)/g;

/** Text beyond this is not scanned for intents (counts still use the whole text). */
const SCAN_CHARS = 4000;

const count = (re: RegExp, s: string): number => s.match(re)?.length ?? 0;
const wordCount = (s: string): number => {
  const t = s.trim();
  return t ? t.split(/\s+/).length : 0;
};

/** Intent scores 0..1 of a text, with the phrase-masking and lead rules above. */
export function extractIntents(text: string): Partial<Record<Intent, number>> {
  let s = text.slice(0, SCAN_CHARS).toLowerCase().replace(TASK_TITLE, "").replace(POLITE, "");
  const out: Partial<Record<Intent, number>> = {};
  const put = (i: Intent, v: number) => {
    if (v > (out[i] ?? 0)) out[i] = Math.min(1, v);
  };
  for (const l of PHRASES) {
    const re = new RegExp(l.re.source, "g");
    s = s.replace(re, (m) => {
      put(l.intent, l.w);
      return " ".repeat(m.length);
    });
  }
  const lead = /^\s*(\S+)/.exec(s);
  const leadEnd = lead ? lead[0].length : 0;
  if (lead?.[1]) for (const l of LEAD_ONLY) if (l.re.test(lead[1])) put(l.intent, l.w);
  for (const l of STEMS) {
    const re = new RegExp(l.re.source, "g");
    for (const m of s.matchAll(re)) put(l.intent, (m.index ?? 0) < leadEnd ? l.w : l.w * NON_LEAD);
  }
  return out;
}

/**
 * Splits a request into its prose and pasted material (fenced blocks, trace and log lines).
 * `pastedLines` counts output-looking lines in and out of fences; fenced code that is not
 * output (a snippet to change) is dropped from the prose without counting.
 */
function splitPasted(text: string): { prose: string; pastedLines: number } {
  let pastedLines = 0;
  const unfenced = text.replace(FENCE, (block) => {
    for (const line of block.split("\n")) if (PASTED_LINE.test(line)) pastedLines++;
    return "\n";
  });
  const kept: string[] = [];
  for (const line of unfenced.split("\n")) {
    if (PASTED_LINE.test(line)) pastedLines++;
    else kept.push(line);
  }
  return { prose: kept.join("\n"), pastedLines };
}

/** The features of one request (§7.1). `hints` come from the plan and agent surfaces. */
export function extractFeatures(
  text: string,
  hints?: AdjudicationRequest["hints"],
): Features & FeatureExtras {
  const trimmed = text.trim();
  const words = wordCount(trimmed);
  const stackTrace = STACK_RE.test(trimmed);
  const { prose, pastedLines } = splitPasted(trimmed.slice(0, SCAN_CHARS));
  // Pasted output: a trace, or two or more log/test-output lines (a fenced block alone may be
  // code to change, so it counts only through the output lines inside it).
  const pasted = stackTrace || pastedLines >= 2;
  // A request that is all pasted output still has its words read.
  const body = prose.trim() ? prose : trimmed.slice(0, SCAN_CHARS);
  const lower = body.toLowerCase();
  const intents = extractIntents(body);
  if (pasted) intents.debug = Math.max(intents.debug ?? 0, 0.8);
  const chat = words <= 8 && CHAT.test(lower) && Object.keys(intents).length === 0;
  if (chat) intents.chat = 1;

  const scope = Math.min(
    1,
    count(STRONG_SCOPE, lower) + 0.5 * (count(WEAK_SCOPE, lower) + count(ENUM3, lower)),
  );
  const risk = Math.min(1, 0.5 * count(RISK, lower));
  const perf = PERF.test(lower) && MEASURE.test(lower) ? 1 : 0;
  const classify = classifyPrompt(trimmed.slice(0, SCAN_CHARS)).find(
    (d) => d.category !== "user_prompt" && d.category !== "intent",
  )?.category;

  const f: Features & FeatureExtras = {
    words,
    chars: trimmed.length,
    lines: trimmed ? trimmed.split("\n").length : 0,
    paths: count(PATH_RE, trimmed),
    symbols: count(SYMBOL_RE, trimmed.replace(PATH_RE, " ")),
    codeBlock: trimmed.includes("```"),
    stackTrace,
    intents,
    scope,
    risk,
    chat,
    slash: trimmed.startsWith("/"),
    proseWords: Math.min(words, wordCount(prose)),
    prosePaths: count(PATH_RE, body),
    pasted,
    taskTitle: TASK_TITLE.test(trimmed),
    perf,
  };
  if (classify) f.classify = classify;
  if (hints && (hints.role || hints.files !== undefined || hints.deps !== undefined)) {
    f.task = { files: hints.files ?? 0, deps: hints.deps ?? 0 };
    if (hints.role) f.task.role = hints.role;
  }
  return f;
}
