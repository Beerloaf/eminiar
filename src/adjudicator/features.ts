/**
 * Feature extraction for the adjudicator (docs/design/adjudicator.md §7.1). Pure and cheap
 * (well under 1 ms for a prompt): a handful of regexes over the lowercased text, no I/O.
 *
 * Intents come from an ordered lexicon. Multiword phrases run first and blank out the text they
 * match, so "what would break" counts as impact and not also as a lookup ("what"), "unit tests"
 * as test and not as a write, "is it safe" as recall and not as risk. Single stems run on what
 * is left. Generic stems (question words, "add", "write") are weaker evidence than specific
 * phrases, and the imperative lead word of a request ("refactor the ...", "commit ...") is the
 * strongest single cue, so a stem gets its full weight there and 70% of it elsewhere.
 */

import { classifyPrompt } from "../capture/classify.js";
import type { AdjudicationRequest, Features, Intent } from "./types.js";

interface Lexeme {
  intent: Intent;
  re: RegExp;
  /** Evidence strength 0..1. */
  w: number;
}

const p = (intent: Intent, re: RegExp, w = 1): Lexeme => ({ intent, re, w });

/** Multiword phrases: specific, matched first, and they mask what they match. */
const PHRASES: Lexeme[] = [
  // impact
  p("impact", /\bwhat (?:would|will|could|might) (?:break|change|fail)\b/),
  p("impact", /\bwhat breaks\b/),
  p("impact", /\b(?:what|who|which \w+) (?:else )?(?:depends? on|imports?|calls?|uses?)\b/),
  p(
    "impact",
    /\b(?:files?|modules?|code|callers?|places?) (?:that|which) (?:imports?|uses?|calls?|references?)\b/,
  ),
  p("impact", /\b(?:callers|usages?|references|dependents|consumers) of\b/),
  p("impact", /\b(?:blast radius|impact of|affected by)\b/),
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
  p("bigfile", /\b\d[\d,]*[- ]?(?:line|loc)\b/),
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
  // plan
  p("plan", /\b(?:split|break|divide) (?:\w+ ){0,3}(?:into|down)\b/),
  p(
    "plan",
    /\b(?:into (?:sub)?tasks|assign (?:\w+ )?(?:workers|tasks|agents|owners)|roll ?out|work breakdown)\b/,
  ),
  // review
  p("review", /\b(?:security|code|design) review\b/),
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
  p("plan", /\b(?:plan|split|assign|rollout|roadmap|milestones?)\b/, 0.9),
  p("edit_small", /\b(?:rename\w*|typos?|tidy|format\w*|bump\w*|reword|indent\w*)\b/),
  // Imperative and progressive forms only: "added" or "implementation" describe, not request.
  p(
    "implement",
    /\b(?:add|adding|implement|implementing|write|writing|create|creating|introduce|build out)\b/,
    0.8,
  ),
  p("refactor", /\b(?:refactor\w*|migrat\w*|rewrit\w*|restructur\w*|consolidat\w*)\b/),
  p("design", /\b(?:design\w*|architect\w*|subsystem)\b/),
  p("review", /\b(?:review\w*|audit\w*)\b/),
  p(
    "debug",
    /\b(?:why|debug\w*|fail\w*|slow|crash\w*|race|bug\w*|broken|leak\w*|hang\w*|flaky|error\w*)\b/,
    0.9,
  ),
  p("research", /\b(?:compar\w*|research\w*|providers?|evaluat\w*|benchmark\w*)\b/),
  p("test", /\b(?:tests?|verify|regression|coverage)\b/, 0.8),
  p("git", /\b(?:commit|push|rebase|branch|merge|cherry-pick|stash)\b/),
  p("ui", /\b(?:dashboard|css|component|view|layout|button|frontend|ui)\b/, 0.8),
];

/** Lead-position discount for stems elsewhere in the text. */
const NON_LEAD = 0.7;

const CHAT =
  /^(?:hi|hello|hey|yo|thanks|thank you|thx|ty|ok|okay|yes|yep|no|nope|sure|cool|great|nice|perfect|got it|that works|sounds good|lgtm|good|done)\b[\s\w,.!']*$/;
const POLITE =
  /^\s*(?:(?:please|pls|can you|could you|would you|let'?s|i want to|i'?d like to|help me|now|ok(?:ay)?|so)[\s,]+)+/;

const STRONG_SCOPE =
  /\b(?:whole|entire|codebase|across|everywhere|repo-wide|system-wide|project-wide|end-to-end|every (?:module|file|package|service))\b/g;
/** Quantifiers and architectural units (a "layer" or "subsystem" is broad by definition). */
const WEAK_SCOPE =
  /\b(?:all|every|system|framework|platform|layer|subsystem|pipeline|architecture|monorepo)\b/g;

const RISK =
  /\b(?:secur\w*|vulnerab\w*|race conditions?|races?|migrat\w*|data loss|concurren\w*|production|prod|auth\w*|credentials?|secrets?|permissions?|delet\w*|drop (?:table|column)|backfill\w*|payments?|encrypt\w*|injection)\b/g;

const PATH_RE = /[\w./-]+\.(?:ts|tsx|js|py|go|rs|md|json|ya?ml|sql|php)\b/g;
const SYMBOL_RE =
  /`[^`\n]+`|\b[a-z][a-z0-9]*[A-Z]\w*\b|\b[A-Z][a-z0-9]+[A-Z]\w*\b|\b[a-z0-9]+_[a-z0-9_]+\b/g;
const STACK_RE = /^\s*at .+\(?[^\s()]+:\d+(?::\d+)?\)?\s*$|Traceback \(most recent call last\)/m;

/** Text beyond this is not scanned for intents (counts still use the whole text). */
const SCAN_CHARS = 4000;

const count = (re: RegExp, s: string): number => s.match(re)?.length ?? 0;

/** Intent scores 0..1 of a text, with the phrase-masking and lead rules above. */
export function extractIntents(text: string): Partial<Record<Intent, number>> {
  let s = text.slice(0, SCAN_CHARS).toLowerCase().replace(POLITE, "");
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
  for (const l of STEMS) {
    const re = new RegExp(l.re.source, "g");
    for (const m of s.matchAll(re)) put(l.intent, (m.index ?? 0) < leadEnd ? l.w : l.w * NON_LEAD);
  }
  return out;
}

/** The features of one request (§7.1). `hints` come from the plan and agent surfaces. */
export function extractFeatures(text: string, hints?: AdjudicationRequest["hints"]): Features {
  const trimmed = text.trim();
  const lower = trimmed.slice(0, SCAN_CHARS).toLowerCase();
  const words = trimmed ? trimmed.split(/\s+/).length : 0;
  const intents = extractIntents(trimmed);
  const chat = words <= 8 && CHAT.test(lower) && Object.keys(intents).length === 0;
  if (chat) intents.chat = 1;

  const scope = Math.min(1, count(STRONG_SCOPE, lower) + 0.5 * count(WEAK_SCOPE, lower));
  const risk = Math.min(1, 0.5 * count(RISK, lower));
  const classify = classifyPrompt(trimmed.slice(0, SCAN_CHARS)).find(
    (d) => d.category !== "user_prompt" && d.category !== "intent",
  )?.category;

  const f: Features = {
    words,
    chars: trimmed.length,
    lines: trimmed ? trimmed.split("\n").length : 0,
    paths: count(PATH_RE, trimmed),
    symbols: count(SYMBOL_RE, trimmed.replace(PATH_RE, " ")),
    codeBlock: trimmed.includes("```"),
    stackTrace: STACK_RE.test(trimmed),
    intents,
    scope,
    risk,
    chat,
    slash: trimmed.startsWith("/"),
  };
  if (classify) f.classify = classify;
  if (hints && (hints.role || hints.files !== undefined || hints.deps !== undefined)) {
    f.task = { files: hints.files ?? 0, deps: hints.deps ?? 0 };
    if (hints.role) f.task.role = hints.role;
  }
  return f;
}
