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
 * A phrase that covers the lead word is the lead: the word after it is not read as an imperative.
 * A participle used as a selector ("the failing tests", "every failed field") names which things,
 * not a symptom, so it is not debug evidence; after a cause or reason ("the cause of failing
 * builds") it is the symptom again.
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
  /**
   * An open investigation of system behaviour: an investigation verb (why, figure out, look
   * into, investigate, root cause, explain ...) whose subject is a system (a cache, a job, the
   * build) or an emergent symptom (twice, intermittent, doubled), not one named symbol.
   */
  investigate: boolean;
  /** A cross-cutting change: a value threaded through several layers, or the impact of a change. */
  crossCutting: boolean;
  /**
   * Documentation to fetch rather than answer from the index: a URL, a fetch/download verb or
   * time-sensitive wording (latest version, release notes, changelog).
   */
  fetch: boolean;
  /** Several commands to run in one go: "in parallel", or three or more listed (no write intent). */
  batch: boolean;
  /** A question about the callers or usages of a symbol (a references lookup, not a change's impact). */
  refs: boolean;
  /**
   * A layer besides the UI is named (an API or endpoint, the server, the CLI, a hook, the database
   * or storage, auth or a login), or a UI surface is one item of a list of areas ("the server, CLI
   * and dashboard"): UI work there is cross-layer.
   */
  otherLayer: boolean;
}

interface Lexeme {
  intent: Intent;
  re: RegExp;
  /** Evidence strength 0..1. */
  w: number;
  /** Group 1 is a package name (PKG): a kebab-case one counts only when it is a known library. */
  pkg?: boolean;
}

const p = (intent: Intent, re: RegExp, w = 1): Lexeme => ({ intent, re, w });

/** The hyphen-only form of PKG ("tree-sitter", "agent-pin"): a package or a project's own name. */
const KEBAB_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/;
/**
 * Whether a PKG match names a package. The @scope/, node:, dotted and digit forms always do; a
 * kebab-case name only when `libraries` lists it, or when no list is known (review #98 F3).
 */
export function isPackageName(name: string, libraries?: readonly string[]): boolean {
  return !libraries || !KEBAB_NAME.test(name) || libraries.includes(name);
}

/**
 * A third-party package name: @scope/name, node:mod, dotted or hyphenated, or with a digit; never
 * a file, including one with several dots (vite.config.ts, index.d.ts).
 */
const PKG = String.raw`(?![\w.-]*\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|php|java|md|json|ya?ml|toml|sql|sh|css|html)\b)(?:@[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*|node:[a-z_]+|[a-z][a-z0-9]*(?:[-.][a-z0-9]+)+|[a-z]{2,}\d+[a-z]*)(?![\w./-])`;
/** A determiner that can open the object of a verb. */
const DET = "(?:the|a|an|its|their|our|this|that|these|those|my)";
/** Closed-class words (prepositions, conjunctions, auxiliaries): they end a noun phrase. */
const CLOSED =
  "(?:when|if|after|before|while|until|unless|once|on|at|in|into|onto|from|to|with|without|for|by|of|about|and|or|but|so|then|is|are|was|were|be|been|does|do|did|doesn't|don't|isn't|aren't|should|would|will|can|could|must|may|might|has|have|had|not|never)";
/** A modifier word inside a noun phrase (never a closed-class word). */
const NP_WORD = String.raw`(?!${CLOSED}\b)[\w@./:+-]+`;
/** Documentation as the head of a noun phrase; a page of results is pagination, not a docs page. */
const DOC_HEAD = String.raw`(?:docs?|documentation|readme|release notes|changelog|api reference|reference|manual|wiki|site|website|(?<!\b(?:next|previous|prev|first|last|each|every|another) )pages?(?! of\b))(?=\s*(?:$|[,.;:!?)])|\s+${CLOSED}\b)`;
/**
 * The object of a fetch verb when it means fetching documentation: a URL, a docs noun heading the
 * phrase, a package named as the whole object, or "the latest". A fetch verb that modifies a
 * noun ("download button", "crawl depth") or a fetch with another object ("download the CSV")
 * is code.
 */
const FETCH_OBJECT = String.raw`(?:${DET} )?(?:${NP_WORD} ){0,3}(?:https?:\/\/|${DOC_HEAD})|(?:${DET} )?${PKG}(?=\s*(?:$|[,.;:!?]|v?\d))|the latest\b`;
const FETCH_VERB = "(?:fetch|download|crawl|scrape)";
/** Documentation as the object of a write verb ("update the api page", "write release notes"). */
const WRITTEN_DOC = String.raw`(?:${DET} )?(?:docs|readme|documentation|changelog|release notes|help text|(?:[\w@./:+-]+ ){0,2}(?:docs?|documentation|reference|manual|man|help|wiki|api|readme|changelog) (?:page|site|section|entry|article)s?)\b`;
const EDIT_DOC_VERB = "(?:update|edit|fix|tweak|reword|touch up|expand|remove|correct|clean up)";
const WRITE_DOC_VERB = "(?:add|write|draft|create)";
const REWRITE_DOC_VERB = "(?:rewrite|restructure|reorgani[sz]e)";
/** Writing documentation (any write verb with a doc object): not documentation to fetch. */
const DOC_WRITE = new RegExp(
  String.raw`\b(?:${EDIT_DOC_VERB}|${WRITE_DOC_VERB}|${REWRITE_DOC_VERB}) ${WRITTEN_DOC}`,
  "g",
);
const FORMATTER = "(?:biome|prettier|dprint|ruff|black|gofmt|rustfmt|clang-format)";
/** UI surfaces something can be shown in or left out of. */
const UI_NOUN =
  "(?:view|page|dashboard|panel|tab|sidebar|chart|ui|screen|modal|dialog|card|header|footer|toolbar|menu|tooltip|legend|badge|widget|form|layout|status ?bar|status ?line)";
const UI_PLACE = `${UI_NOUN}s?`;

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
  // An extraction into a function or module is bounded (like "extract"), not a sweeping refactor.
  p(
    "implement",
    /\brefactor (?:[\w./'-]+ ){1,8}into (?:a |an |one |its own |their own |separate |shared )?(?:[\w-]+ ){0,2}(?:function|helper|method|hook|module|class|component|utility|util)s?\b/,
  ),
  // history
  p("history", /\bwhy (?:was|were|did)\b(?! we\b)/),
  p("history", /\bwhen (?:was|were|did)\b/),
  p("history", /\b(?:git (?:blame|log|show|history)|commit history|check (?:the )?history)\b/),
  p("history", /\bwho (?:wrote|changed|added|removed)\b/),
  // A git verb with commits as its object is doing git; commits as the subject of a question are history.
  p(
    "git",
    /\b(?:amend|squash|revert|reword|undo|reset|drop|cherry-pick|rebase|push) (?:the |my |our |these |those )?(?:last |previous |latest |recent )?(?:\w+ )?commits?\b/,
  ),
  p("history", /\b(?:which|what|whose|last|recent|latest|previous|past) (?:\w+ ){0,2}commits?\b/),
  p("history", /\bcommits? (?:that|which|touching)\b|\bcommits (?:on|in|since|from|by|between)\b/),
  p(
    "history",
    /\b(?:later|subsequently|eventually) (?:needed|required|got|had|took) (?:a |an |to be )?(?:fix|revert|patch|hotfix)\w*|\b(?:riskiest|most (?:risky|fragile|churned)|(?:bug|fix)-prone)\b/,
  ),
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
  // writing docs is an edit, not a docs lookup; it runs before the docs phrases so a doc that is
  // the object of a write verb ("update the api page", "write release notes for v2") is masked
  p(
    "edit_small",
    new RegExp(String.raw`\b${EDIT_DOC_VERB} (?:(?:the |our |a )?comments?\b|${WRITTEN_DOC})`),
  ),
  p("implement", new RegExp(String.raw`\b${WRITE_DOC_VERB} ${WRITTEN_DOC}`), 0.8),
  p("refactor", new RegExp(String.raw`\b${REWRITE_DOC_VERB} ${WRITTEN_DOC}`)),
  // docs: a fetch verb leads only with documentation to fetch as its object
  p("docs", new RegExp(String.raw`^\s*${FETCH_VERB} (?=${FETCH_OBJECT})`), 0.7),
  // docs: reading documentation of something else
  p("docs", /\b(?:docs?|documentation|readme) (?:for|on|about|of)\b/),
  p("docs", /\b(?:latest|current|newest) version\b/),
  p("docs", /\b(?:api reference|release notes|changelog for)\b/),
  p("edit_small", /\bfix (?:the |a )?typos?\b/),
  // adding a comment or annotation is mechanical, not new behaviour
  p(
    "edit_small",
    /\badd (?:a |an |some )?(?:short |brief |one-line |small )?(?:comments?|docstrings?|jsdoc|log lines?|type annotations?|todo)\b/,
  ),
  // docs: documentation named as the source (after writing docs, which is an edit)
  p(
    "docs",
    /\b(?:docs?|documentation|reference|manual|man|help|wiki|api) (?:page|pages|site|section|entry|article)\b/,
  ),
  p(
    "docs",
    /\b(?:read|check|see|consult|search|open|browse|skim|look (?:at|in|through)|go through) (?:the |its |their |our )?(?:[\w@./:+-]+ ){0,3}(?:docs|documentation|api reference|reference docs|manual)\b/,
  ),
  p(
    "docs",
    /\b(?:what|how) (?:do|does) (?:the |its |their )?(?:[\w@./:+-]+ ){0,2}(?:docs|documentation|readme|spec|reference) (?:say|recommend|suggest|describe|mention|cover|list)\b|\baccording to (?:the |its |their )?(?:[\w@./:+-]+ ){0,2}(?:docs|documentation|spec|readme)\b/,
  ),
  // docs: how a third-party package (named like one, never a file) behaves; a kebab-case name
  // that is not a known library is the project's own ("how does agent-pin pick the model")
  {
    ...p(
      "docs",
      new RegExp(
        String.raw`\bhow (?:does|do|can|should|would|will) (${PKG})(?= (?![a-z]+ing\b)[a-z])`,
      ),
    ),
    pkg: true,
  },
  {
    ...p(
      "docs",
      new RegExp(
        String.raw`\b(?:does|do|can|will) (${PKG}) (?:support|handle|allow|provide|offer|expose|have|ship|include|accept|work with)\b`,
      ),
    ),
    pkg: true,
  },
  // formatting as an action (a format, or the formatting of something, is a noun): the lead
  // takes code to format as its object (a determiner, a file or dir, code, src, changed or staged
  // files) or names the formatter ("format X with biome"); "format code blocks" is a noun phrase
  p(
    "edit_small",
    new RegExp(
      String.raw`^\s*format (?=(?:the|this|these|those|all|our|my|it|them|everything|code(?! ?(?:blocks?|snippets?|spans?|fences?)\b)|src|files?|changed|staged|modified)\b|[\w./-]+\.[a-z]{1,4}\b|[\w.-]+\/|(?:[\w./-]+ ){0,3}with ${FORMATTER}\b)`,
    ),
  ),
  p(
    "edit_small",
    new RegExp(
      String.raw`\b(?:apply|run|fix|check|redo|enforce|use) (?:the |our |a |all )?(?:[\w-]+ )?(?:formatting|formatter)\b|\b${FORMATTER} (?:format|fmt|--write)\b`,
    ),
  ),
  // ui: showing something in a UI surface builds it ("show me X" is a lookup); so does leaving
  // something out of what a view, chart or report counts
  p(
    "implement",
    new RegExp(
      String.raw`\b(?:show|display|render|surface|highlight)(?= (?!me\b|us\b|you\b|how\b|what\b|where\b|which\b|why\b)(?:[\w'.-]+ ){1,8}(?:in|on|inside|within|under|next to|beside) (?:the |a |an |each |every |our |its |their )?(?:[\w-]+ ){0,3}${UI_PLACE}\b)`,
    ),
  ),
  p(
    "implement",
    new RegExp(
      String.raw`\b(?:exclude|hide|filter out|omit|leave out)(?= (?:[\w'.-]+ ){0,4}(?:from|in|on) (?:the |a |an |each |every |our |its |their )?(?:[\w-]+ ){0,3}(?:${UI_PLACE}|(?:lists?|tables?|totals?|counts?|rates?|metrics?|stats|summary|summaries|results|reports?|exports?))\b)`,
    ),
  ),
  // plan: the verb, or a plan to produce; never a modifier ("plan lines") or part of a name ("plan-advice")
  p("plan", /^\s*plan(?=\s)/, 0.9),
  p(
    "plan",
    /\bplan (?:the|a|an|out|how|for|our|this|these|its|it|them|which|what|ahead|and)\b/,
    0.63,
  ),
  p(
    "plan",
    /\b(?:a|an|(?:make|write|draft|create|prepare|produce|need|propose|outline) (?:the|me a|us a)) (?:[\w-]+ ){0,2}plan\b(?![-./]\w)/,
    0.63,
  ),
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
  // git: doing git (commit, push, rebase, branch off), not a branch or commits as a subject; a
  // git subcommand, not git as a noun ("the git root", "git hooks"); a named branch ("switch to
  // the main branch"), not a control-flow one ("make the error branch return null", "the branch
  // variable", "a branch of the decision tree", "a branch in the switch")
  p(
    "git",
    /\b(?:commit|push|stash|rebase) (?:these|the|this|my|all|our|it|them|everything|those|your|changes)\b/,
  ),
  p(
    "git",
    /\b(?:git (?:add|am|apply|bisect|branch|checkout|cherry-pick|clean|clone|commit|config|describe|diff|fetch|gc|grep|init|merge|mv|pull|push|rebase|reflog|remote|reset|restore|revert|rm|shortlog|stash|status|submodule|switch|tag)|open a (?:pr|pull request)|cherry-pick\w*|force[- ]push)\b/,
  ),
  p(
    "git",
    /\b(?:create|cut|make|open|start|switch to|check ?out|delete|rename|new) (?:a |the |new |this |that |my )*(?:(?!(?:if|else|error|catch|default|fallback|true|false|happy|dead|case)\b)[\w./-]+ )?branch(?:es)?\b(?! (?:variable|var|logic|condition|statement|coverage|details)\b| (?:of|in|inside|within) (?!(?:the |this |our |my )?(?:git|repo|repository|remote|origin|github|main|master|develop|trunk)\b))|\bbranch (?:off|from|out)\b/,
  ),
  p(
    "git",
    /\b(?:merge|rebase) (?:\S+ )?(?:into|onto)\b|\b(?:merge|rebase) (?:main|master|develop|the branch)\b|\bresolve (?:the |these |all )?(?:merge )?conflicts?\b/,
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
  p("docs", /\b(?:docs|documentation)\b/, 0.7),
  p("recall", /\b(?:decided|decision|convention|agreed)\b/, 0.7),
  p("plan", /\b(?:split|assign|rollout|roadmap|milestones?|coordinat\w*|orchestrat\w*)\b/, 0.9),
  p("edit_small", /\b(?:rename\w*|typos?|tidy|reformat\w*|bump\w*|reword|indent\w*)\b/),
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
  p("git", /\b(?:rebase|stash)\b/),
  p(
    "ui",
    /\b(?:dashboard|css|component|view|layout|button|frontend|ui|charts?|badges?|tooltips?|modals?|sidebar|widgets?)\b/,
    0.8,
  ),
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
  // amend and squash are code verbs too ("amend the docstring"); they mean git only with a commit
  // as the object, which the commits-object phrase covers.
  p("git", /^(?:commit|push|merge|rebase|stash)\b/),
  // fetch/download/crawl/scrape are a docs lead only with a docs object: a phrase (FETCH_OBJECT)
];

/** Lead-position discount for stems elsewhere in the text. */
const NON_LEAD = 0.7;
/**
 * A participle after a determiner selects things ("the failing tests"); it is not a symptom. After
 * a cause or reason ("the cause of failing builds") it is the symptom being asked about.
 */
const SELECTOR =
  /\b(?<!\b(?:caus(?:e|es|ed|ing)|reasons?|sources?|origins?) (?:of |for )?)(?:the|every|each|all|any|only|of|no|some|which|those|these|its|their) (fail(?:ed|ing)) (?=[a-z])/g;

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
/**
 * An enumeration of three or more areas ("the server, CLI and dashboard") is breadth too.
 *
 * ENUM3 and LIST3 start at the start of a [\w.-] run, not at any \b inside it ("a.b.c" has one
 * at every letter, and each retry rescanned the run: quadratic). The first item must reach the
 * run's end either way, so a run matches from its first word character exactly when it matches
 * from its start. The leading [.-]* keeps a run with no word character unmatched (as \b did) and
 * only prefixes a "." or "-" (".env, .npmrc and .gitignore") to the first item.
 */
const ENUM3 =
  /(?<![\w.-])[.-]*\b[\w.-]+(?: [\w.-]+)?, (?:the )?[\w.-]+(?: [\w.-]+)?,? (?:and|&) (?:the )?[\w.-]+/g;
/** ENUM3's shape, with the last item up to two words too ("..., the token chart and the cost chart"). */
const LIST3 =
  /(?<![\w.-])[.-]*\b[\w.-]+(?: [\w.-]+)?, (?:the |a |an )?[\w.-]+(?: [\w.-]+)?,? (?:and|&|or) (?:the |a |an )?[\w.-]+(?: [\w.-]+)?/g;
const LIST_SEP = /,? (?:and|&|or) |, /;
/** UI surfaces and the parts they are built from: a list of these is UI work, not a list of areas. */
const UI_PART = new RegExp(
  String.raw`\b(?:${UI_PLACE}|css|components?|buttons?|frontend|links?|inputs?|fields?|columns?|rows?|tables?|lists?|icons?|labels?|titles?|headings?|fonts?|colou?rs?|themes?|styles?|borders?|nav(?:bar)?s?|breadcrumbs?|toasts?|dropdowns?|checkbox(?:es)?|box(?:es)?|bars?|toggles?|sliders?|spinners?|banners?|popovers?|drawers?|avatars?|logos?|images?|grids?|filters?|graphs?|gauges?)\b`,
);
/**
 * Layers besides the UI. A Preact hook ("a custom hook", "the useStats hook") and browser storage
 * are UI; a --flag is the CLI.
 */
const OTHER_LAYER =
  /\b(?:apis?|endpoints?|servers?|back[- ]?end|cli|command[- ]line|(?<!\b(?:custom|preact|react|use\w+) )hooks?|databases?|db|sqlite|sql|mcp|web ?sockets?|logins?|log-in|log ?into|log in (?:to|with|via|using|as)|sign[- ]?(?:in|on)|auth(?:n|z|enticat\w*|ori[sz]\w*)?)\b|(?<!\b(?:local|session) )\bstorage\b|(?:^|\s)--[a-z]/;

const RISK =
  /\b(?:secur\w*|vulnerab\w*|race conditions?|races?|migrat\w*|data loss|concurren\w*|production|prod|auth\w*|o?auth2?|oidc|pkce|sso|saml|jwt|csrf|xss|sandbox\w*|privilege\w*|multi-?tenan\w*|deadlock\w*|credentials?|secrets?|permissions?|delet\w* (?:\w+ ){0,2}(?:data|rows?|records?|tables?|users?|accounts?|database|db|buckets?|backups?|director(?:y|ies)|folders?)|drop (?:table|column)|backfill\w*|payments?|encrypt\w*|injection)\b/g;

/** Performance work: a perf word plus a measured number makes it a concrete, deep task. */
const PERF =
  /\b(?:optimi[sz]\w*|perf\w*|latency|throughput|slow\w*|faster|speed\w*|bundle size|memory|cpu|p9\d|scal(?:e|es|ing)|takes|went up|grew|regress\w*)\b/;
const MEASURE =
  /\b\d[\d,.]*\s?(?:ms|µs|us|s|secs?|seconds?|minutes?|mins?|kb|mb|gb|tb|x|%|rps|qps)\b|\b(?:\d{4,}|\d[\d,.]*\s?[km]|\d{1,3}(?:,\d{3})+|a (?:million|billion|thousand))\s?[a-z]*\b/;

/**
 * Investigation verbs. How big the work is depends on the subject: "why is the port 3000" is a
 * lookup, "figure out why the job runs twice" means following behaviour across modules.
 * "explain" counts only without a named symbol or path (explaining one function is a read).
 */
const INVESTIGATE =
  /\b(?:why|figure out|look into|investigat\w*|root[- ]?caus\w*|track down|get to the bottom of|diagnos\w*|dig into)\b/;
const EXPLAIN = /\b(?:explain|walk (?:me )?through)\b/;
/** System-level subjects: behaviour that emerges from several modules working together. */
const SYSTEM_SUBJECT =
  /\b(?:cach(?:e|es|ing)|invalidat\w*|builds?|pipelines?|jobs?|queues?|workers?|schedul\w*|cron|checkout|requests?|sessions?|startup|boot\w*|sync(?:ing|hroni[sz]\w*)?|replicat\w*|retr(?:y|ies)|lifecycle|concurren\w*|locking|index(?:ing|er)|ingest\w*|render(?:ing)?|deploy\w*|memory|latency|throughput|services?|server|database|transactions?|event loop|events|consistency|ordering|timeouts?|expiry|routing|middleware|webhooks?|connection pool|rate limit\w*|garbage collect\w*|token refresh)\b/;
/** Symptoms of emergent behaviour: they say "follow it across the system", whatever the noun. */
const EMERGENT =
  /\b(?:twice|duplicat\w*|intermittent\w*|sometimes|randomly|occasionally|doubl(?:e|ed|es|ing)|tripl\w*|spik\w*|keeps? growing|over time|under load|feels? (?:slow|sluggish|laggy))\b/;
/** A value threaded through layers ("plumb the signal through ...") touches every hop. */
const THREAD =
  /\b(?:thread|plumb|propagat|pass|carry|forward)(?:s|es|ed|e|ing)? (?:[\w.'-]+ ){1,6}(?:all the way )?through\b/;
/** Judging the effect of a change (not listing dependents) reasons over every caller. */
const IMPACT_OF_CHANGE =
  /\b(?:impact|effect|consequences?|blast radius) of (?:changing|renaming|removing|dropping|moving|splitting|deleting|replacing|reordering|making)\b|\bwhat (?:would|will) happen if (?:we |i )?(?:change|rename|remove|drop|move|split|delete|replace|make)\b/;

/**
 * Fetching, not the index: a URL, a fetch verb with documentation as its object, or time-sensitive
 * wording. It is tested with written docs (DOC_WRITE) blanked: a changelog to update is not one
 * to fetch.
 */
const FETCH = new RegExp(
  String.raw`https?:\/\/\S+|\b${FETCH_VERB} (?:${FETCH_OBJECT})|\b(?:latest|current|newest) (?:version|release)s?\b|\brelease notes\b|\bchangelog\b`,
);
/**
 * Several commands in one go. "At once" names several only after a list ("lint and typecheck at
 * once", "both at once"); on its own ("run the build at once") it means "now".
 */
const PARALLEL =
  /\b(?:in parallel|concurrently|at the same time|simultaneously|both at once|side by side|in one go|in a single (?:call|batch|run))\b|\b(?:and|&) (?:[\w.:-]+ ){1,4}(?:all |both )?at once\b/;
/** Callers or usages of a symbol (the impact phrases' references half, not imports or dependents). */
const REFS =
  /\b(?:what|who|which \w+) (?:else )?(?:calls?|uses?)\b|\b(?:code|callers?|places?) (?:that|which) (?:uses?|calls?|references?)\b|\b(?:callers|usages?|references) of\b/;
/** The effect of a change, which stays an impact question even when callers are mentioned. */
const CHANGE_IMPACT =
  /\bwhat (?:would|will|could|might) (?:break|change|fail)\b|\bwhat breaks\b|\b(?:blast radius|impact of|affected by)\b/;
const WRITE_INTENTS: Intent[] = ["implement", "edit_small", "refactor"];

/**
 * A path starts at a token boundary. Without the lookbehind the engine retried every offset of
 * a long token that has no extension and rescanned the rest of it each time (quadratic: a 32 KB
 * blob took 1.6 s). The matches are the same: a path found mid-token would also be found from the
 * token's start, and a token holds at most one match because `[\w./-]+` runs to its last extension.
 */
const PATH_RE = /(?<![\w./-])[\w./-]+\.(?:ts|tsx|js|py|go|rs|md|json|ya?ml|sql|php)\b/g;
const SYMBOL_RE =
  /`[^`\n]+`|\b[a-z][a-z0-9]*[A-Z]\w*\b|\b[A-Z][a-z0-9]+[A-Z]\w*\b|\b[a-z0-9]+_[a-z0-9_]+\b/g;
/**
 * A stack frame line ("at fn (file.js:3:7)") or a Python traceback header. It runs on the whole
 * text, so it stays linear: `.+\(?[^\s()]+:` is written `.+[^\s()]:` (the same lines match, but the
 * old form tried every split of a long "at ..." line), and the whitespace around the frame does
 * not cross lines (each line start is tried anyway, and a run of blank lines was rescanned from
 * every one of them).
 */
const STACK_RE =
  /^[^\S\n\r]*at .+[^\s()]:\d+(?::\d+)?\)?[^\S\n\r]*$|Traceback \(most recent call last\)/m;
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
/** A plural UI noun that ends a list ("the sessions, memories and stats views"). */
const SHARED_UI_NOUN = new RegExp(String.raw`\b${UI_NOUN}s$`);
/** A list item with its own article ("the CLI"), so a trailing noun is not shared. */
const OWN_ARTICLE = /^(?:the|a|an) /;
/**
 * A UI surface listed with things that are not UI ("the server, CLI and dashboard"). A plural UI
 * noun after the last item names every item ("the runs, tasks and events tabs" is three tabs),
 * unless a later item has its own article ("the server, the CLI and the dashboard views").
 */
const uiAmongAreas = (s: string): boolean => {
  for (const m of s.matchAll(LIST3)) {
    const items = m[0].split(LIST_SEP);
    const last = items[items.length - 1] ?? "";
    if (SHARED_UI_NOUN.test(last) && !items.slice(1).some((x) => OWN_ARTICLE.test(x))) continue;
    const ui = items.filter((x) => UI_PART.test(x)).length;
    if (ui > 0 && ui < items.length) return true;
  }
  return false;
};

/** Intent scores 0..1 of a text, with the phrase-masking and lead rules above. */
export function extractIntents(
  text: string,
  libraries?: readonly string[],
): Partial<Record<Intent, number>> {
  let s = text.slice(0, SCAN_CHARS).toLowerCase().replace(TASK_TITLE, "").replace(POLITE, "");
  const out: Partial<Record<Intent, number>> = {};
  const put = (i: Intent, v: number) => {
    if (v > (out[i] ?? 0)) out[i] = Math.min(1, v);
  };
  const first = /^\s*\S+/.exec(s)?.[0].length ?? 0;
  for (const l of PHRASES) {
    const re = new RegExp(l.re.source, "g");
    s = s.replace(re, (m, name: unknown) => {
      if (l.pkg && typeof name === "string" && !isPackageName(name, libraries)) return m;
      put(l.intent, l.w);
      return " ".repeat(m.length);
    });
  }
  // A phrase that covered the lead word was the lead; the next word is not an imperative.
  const lead = s.slice(0, first).trim() ? /^\s*(\S+)/.exec(s) : null;
  s = s.replace(SELECTOR, (m, w: string) => m.replace(w, " ".repeat(w.length)));
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

/**
 * Request hints as features reads them: the plan and agent surfaces' task hints, plus `libraries`,
 * the project's indexed documentation names in lower case (the em_docs manifest; hooks.ts passes
 * them). Without `libraries` any kebab-case name may be a package.
 */
export type FeatureHints = NonNullable<AdjudicationRequest["hints"]> & {
  libraries?: readonly string[];
};

/** The features of one request (§7.1). `hints` come from the plan and agent surfaces. */
export function extractFeatures(text: string, hints?: FeatureHints): Features & FeatureExtras {
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
  const intents = extractIntents(body, hints?.libraries);
  if (pasted) intents.debug = Math.max(intents.debug ?? 0, 0.8);
  const chat = words <= 8 && CHAT.test(lower) && Object.keys(intents).length === 0;
  if (chat) intents.chat = 1;

  const scope = Math.min(
    1,
    count(STRONG_SCOPE, lower) + 0.5 * (count(WEAK_SCOPE, lower) + count(ENUM3, lower)),
  );
  const risk = Math.min(1, 0.5 * count(RISK, lower));
  const perf = PERF.test(lower) && MEASURE.test(lower) ? 1 : 0;
  const prosePaths = count(PATH_RE, body);
  const named = prosePaths > 0 || count(SYMBOL_RE, body.replace(PATH_RE, " ")) > 0;
  const systemic = SYSTEM_SUBJECT.test(lower) || EMERGENT.test(lower);
  const investigate = systemic && (INVESTIGATE.test(lower) || (!named && EXPLAIN.test(lower)));
  const crossCutting = THREAD.test(lower) || IMPACT_OF_CHANGE.test(lower);
  const writes = WRITE_INTENTS.some((i) => (intents[i] ?? 0) > 0);
  const fetch = FETCH.test(lower.replace(DOC_WRITE, " "));
  const batch =
    (intents.run ?? 0) >= 0.9 &&
    (intents.debug ?? 0) < 0.9 &&
    !writes &&
    (PARALLEL.test(lower) || count(ENUM3, lower) > 0);
  const refs = REFS.test(lower) && !CHANGE_IMPACT.test(lower) && !crossCutting && !writes;
  const otherLayer = OTHER_LAYER.test(lower) || uiAmongAreas(lower);
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
    prosePaths,
    pasted,
    taskTitle: TASK_TITLE.test(trimmed),
    perf,
    investigate,
    crossCutting,
    fetch,
    batch,
    refs,
    otherLayer,
  };
  if (classify) f.classify = classify;
  if (hints && (hints.role || hints.files !== undefined || hints.deps !== undefined)) {
    f.task = { files: hints.files ?? 0, deps: hints.deps ?? 0 };
    if (hints.role) f.task.role = hints.role;
  }
  return f;
}
