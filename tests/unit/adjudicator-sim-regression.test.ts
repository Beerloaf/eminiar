import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { blend } from "../../src/adjudicator/blend.js";
import { EVAL_SET } from "../../src/adjudicator/data/evalset.js";
import { type EvalItem, loadFixture, parseFixture } from "../../src/adjudicator/eval.js";
import {
  extractFeatures,
  extractIntents,
  type FeatureHints,
  isPackageName,
} from "../../src/adjudicator/features.js";
import { complexityBucket, scoreHeuristic } from "../../src/adjudicator/heuristic.js";
import {
  DEFAULT_ROLES,
  type Intent,
  type ScoreTable,
  TIERS,
  TOOL_IDS,
} from "../../src/adjudicator/types.js";
import { HELDOUT_SET } from "../fixtures/adjudicator-heldout.js";
import { HELDOUT_SET_2 } from "../fixtures/adjudicator-heldout-2.js";

/**
 * Regression set from adjudicator simulation run 20261104-90e129 (fixed in swarm run
 * 20261104-672098). The simulation found weak spots in the offline heuristic:
 *   1. a documentation question about an indexed library never picked em_docs;
 *   2. `format\w*` read "output formats" and "formatting" (nouns) as a small edit;
 *   3. `\bplan\b` matched names and modifiers ("plan-advice", "plan lines"), inflating complexity;
 *   4. real work was under-scored (a UI badge plus a chart exclusion scored 0.42 on haiku);
 * plus tool routing for callers (em_symbols), parallel commands (em_batch_execute), commits as
 * a subject (em_history, not Bash) and fetching docs (em_fetch_and_index).
 *
 * tests/fixtures/adjudicator-sim-regression.json holds the 13 prompts that exposed them. It is
 * also an eval fixture: `eminiar adjudicator eval --fixture <file> --replace` runs it (that
 * harness ignores `alsoOk`, so it scores item 9 on em_fetch_and_index alone). The checks here use
 * the path the adjudicator ships with no provider: scoreHeuristic, then blend()'s
 * low-confidence round-up.
 *
 *  - tool: exact; an item may list `alsoOk` alternatives in the fixture (only item 9 does)
 *  - tier: never below the label. The heuristic is asymmetric on purpose (under-tiering costs a
 *    redo, over-tiering only tokens), so an exact tier match is not asked for
 *  - complexity: within +-1 of the label after bucketing
 *  - intents: "formats"/"formatting" are not edit_small, "plan-advice"/"plan lines" are not plan
 * The `role` labels are carried for the eval harness and deliberately not asserted here: the role
 * rules are still being tuned for UI-adjacent backend work.
 *
 * The paraphrase tables pin the principle behind each fix on prompts that are not in the
 * fixture, so a rule cannot pass by memorising the 13 items. Known limit, deliberately not
 * asserted: a library named by a plain word with no "docs" cue ("how does zod handle unions")
 * is not detected as a docs question.
 */

const FIXTURE = join(__dirname, "../fixtures/adjudicator-sim-regression.json");

/** The file as written: the harness drops keys it does not know, so `alsoOk` is read from here. */
type SimItem = EvalItem & { alsoOk?: string[] };
const ITEMS = JSON.parse(readFileSync(FIXTURE, "utf8")) as SimItem[];

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const RANK: Record<string, number> = { haiku: 0, sonnet: 1, opus: 2, fable: 3 };

/** What the adjudicator returns with no provider: the heuristic, then blend()'s round-up. */
function ship(text: string, hints?: FeatureHints) {
  const features = extractFeatures(text, hints);
  const verdict = blend(
    scoreHeuristic(features),
    undefined,
    {},
    {},
    { key: "sim", provider: "heuristic" },
  );
  return { features, verdict, bucket: complexityBucket(verdict.complexity) };
}
const toolOf = (text: string) => ship(text).verdict.tool.choice;
const tierOf = (text: string) => ship(text).verdict.tier.choice;
const has = (text: string, intent: Intent) => (extractFeatures(text).intents[intent] ?? 0) > 0;
const intentsOf = (text: string) => JSON.stringify(extractFeatures(text).intents);
const top = (t: ScoreTable) =>
  t.entries
    .slice(0, 3)
    .map((e) => `${e.option} ${e.score.toFixed(2)}`)
    .join(", ");

describe("simulation regression fixture", () => {
  it("is a fixture the eval harness loads, and alsoOk is the only key it drops", async () => {
    const keys = new Set(ITEMS.flatMap((it) => Object.keys(it)));
    expect([...keys].sort()).toEqual(["alsoOk", "complexity", "role", "text", "tier", "tool"]);
    const canonical = ITEMS.map(({ text, tool, tier, role, complexity }) => ({
      text,
      tool,
      tier,
      role,
      complexity,
    }));
    expect(parseFixture(ITEMS, "sim")).toEqual(canonical);
    expect(await loadFixture(FIXTURE)).toEqual(canonical);
  });

  it("has 13 uniquely worded, validly labelled items", () => {
    expect(ITEMS).toHaveLength(13);
    expect(new Set(ITEMS.map((it) => norm(it.text))).size).toBe(13);
    for (const it of ITEMS) {
      expect(TIERS as readonly string[]).toContain(it.tier);
      expect(TOOL_IDS as readonly string[]).toContain(it.tool);
      expect(DEFAULT_ROLES as readonly string[]).toContain(it.role);
      expect(Number.isInteger(it.complexity)).toBe(true);
      expect(it.complexity).toBeGreaterThanOrEqual(0);
      expect(it.complexity).toBeLessThanOrEqual(4);
    }
  });

  it("accepts a second tool for item 9 only, and only a registered one that differs", () => {
    const withAlt = ITEMS.flatMap((it, i) => (it.alsoOk ? [i + 1] : []));
    expect(withAlt).toEqual([9]);
    for (const it of ITEMS) {
      for (const alt of it.alsoOk ?? []) {
        expect(TOOL_IDS as readonly string[]).toContain(alt);
        expect(alt).not.toBe(it.tool);
      }
      expect(new Set(it.alsoOk ?? []).size).toBe((it.alsoOk ?? []).length);
    }
    expect(ITEMS[8]?.text).toMatch(/sub-agents docs page/);
    expect(ITEMS[8]?.alsoOk).toEqual(["em_docs"]);
  });

  it("stays disjoint from the held-out sets it must not leak into", () => {
    const seen = new Set([...HELDOUT_SET, ...HELDOUT_SET_2].map((it) => norm(it.text)));
    expect(ITEMS.filter((it) => seen.has(norm(it.text))).map((it) => it.text)).toEqual([]);
  });
});

describe("the 13 simulation prompts through the shipped scorer", () => {
  for (const [i, item] of ITEMS.entries()) {
    const n = i + 1;
    describe(`item ${n}: ${item.text.slice(0, 72)}`, () => {
      it(`routes to ${[item.tool, ...(item.alsoOk ?? [])].join(" or ")}`, () => {
        const { verdict } = ship(item.text);
        const ok = [item.tool, ...(item.alsoOk ?? [])];
        expect(ok, `got ${verdict.tool.choice} (${top(verdict.tool)})`).toContain(
          verdict.tool.choice,
        );
      });

      // A haiku label cannot be undershot, so only sonnet and up are checked.
      if ((RANK[item.tier] ?? 0) > 0)
        it(`is not tiered below ${item.tier}`, () => {
          const { verdict } = ship(item.text);
          expect(
            RANK[verdict.tier.choice] ?? -1,
            `got ${verdict.tier.choice} at complexity ${verdict.complexity.toFixed(2)}`,
          ).toBeGreaterThanOrEqual(RANK[item.tier] ?? 0);
        });

      it(`keeps complexity within +-1 of ${item.complexity}`, () => {
        const { verdict, bucket } = ship(item.text);
        expect(
          Math.abs(bucket - item.complexity),
          `got ${verdict.complexity.toFixed(2)} (bucket ${bucket})`,
        ).toBeLessThanOrEqual(1);
      });
    });
  }

  it("keeps items 11-13 off haiku (11 and 12 scored haiku before the fixes)", () => {
    for (const n of [11, 12, 13]) {
      const item = ITEMS[n - 1]!;
      expect(tierOf(item.text), `item ${n}`).not.toBe("haiku");
    }
  });
});

describe("intents the simulation items must not carry (items 1, 11, 13)", () => {
  it("item 11: 'output formats' is not a small edit", () => {
    const text = ITEMS[10]!.text;
    expect(text).toMatch(/output formats/);
    expect(has(text, "edit_small"), intentsOf(text)).toBe(false);
  });

  it("item 13: 'formatting' of plan-advice is not a small edit", () => {
    const text = ITEMS[12]!.text;
    expect(text).toMatch(/plan-advice formatting/);
    expect(has(text, "edit_small"), intentsOf(text)).toBe(false);
  });

  it("item 13: 'plan-advice' and 'plan lines' are names, not a plan to make", () => {
    const text = ITEMS[12]!.text;
    expect(text).toMatch(/plan lines/);
    expect(has(text, "plan"), intentsOf(text)).toBe(false);
  });

  it("item 1: 'the failing tests' selects tests to show, it is not a debug symptom", () => {
    const text = ITEMS[0]!.text;
    expect(text).toMatch(/failing tests/);
    expect(has(text, "debug"), intentsOf(text)).toBe(false);
    expect(has(text, "run"), intentsOf(text)).toBe(true);
  });
});

// --- paraphrases: the principle behind each fix, on prompts that are not in the fixture -------

const DOCS_QUESTIONS = [
  "How does sqlite-vec handle cosine distance?",
  "does better-sqlite3 support async transactions?",
  "how do @huggingface/transformers pipelines cache models",
  "what do the zod docs say about refine?",
  "according to the tree-sitter docs, how are queries matched?",
  "read the vitest docs page on fake timers",
  "how does node:sqlite handle busy timeouts",
  "how does socket.io handle reconnects",
  "how does lodash.debounce treat leading calls",
];
/**
 * The `libraries` hint hooks.ts reads from this repo's em_docs manifest (.eminiar/docs.json):
 * source names plus their npm packages.
 */
const LIBS: FeatureHints = {
  libraries: [
    "better-sqlite3",
    "docs",
    "readme",
    "sqlite-vec",
    "transformers-js",
    "@huggingface/transformers",
    "tree-sitter",
    "zod",
  ],
};
/**
 * Kebab-case names of the project's own modules and terms (review #98 F3): with the library hint
 * they are not packages, so these are code questions, not docs ones.
 */
const PROJECT_NAME_QUESTIONS = [
  "how does agent-pin pick the model",
  "how does tool-hint expire in our hooks",
  "how does plan-advice work",
  "how does sim-regression load its fixture",
  "does agent-pin support custom models",
  "can tool-hint handle two tools at once",
  "how does mcp-server handle reconnect in our code",
];
/** Docs named only as a word: the cue outweighs the generic question words around it. */
const DOCS_CUES = [
  "tell me about the zod docs",
  "what is in the vitest documentation",
  "show the tree-sitter documentation",
];
const OWN_CODE_QUESTIONS = [
  "how does the hook handle timeouts",
  "how does loadConfig merge defaults",
  "how does em_search rank results",
  "how does server.ts handle shutdown",
  "how does vite.config.ts load plugins",
  "how does eminiar.config.schema.json get generated",
  "how does plan-advice formatting work",
  "the fetch wrapper drops the auth header",
];
const FETCH_REQUESTS = [
  "fetch https://zod.dev/api and summarize the refine section",
  "download the latest sqlite-vec release notes",
  "what is the latest version of sqlite-vec?",
  "read the docs page at https://vitest.dev/guide/mocking",
  "show me the changelog for zod",
  "crawl the tree-sitter documentation site",
  "scrape the better-sqlite3 readme",
  "fetch the release notes for zod 4",
  "check the release notes for vitest 3",
];
/**
 * A fetch verb that modifies a noun ("download button") or takes a non-docs object ("download the
 * CSV") is code: a bug report or feature work, not documentation to fetch (review #98 F5).
 */
const FETCH_VERB_AS_CODE = [
  "download button does nothing on Safari",
  "download the CSV when the user clicks export",
  "crawl depth should be configurable",
  "download progress bar stalls at 99%",
  "fetch timeout should default to 30 seconds",
  "download links break when the filename has spaces",
  "scrape interval is too short for the rate limiter",
  "crawl stops after the first page",
  "fetch the next page of results from the api",
  "fetch user-data when the dashboard loads",
];
/**
 * Documentation as the object of a write verb is writing, and a changelog to update is not one
 * to fetch (review #98 F6).
 */
const DOCS_WRITES = [
  "update the api page in docs",
  "fix the help page for em_swarm",
  "update the changelog for v0.12",
  "expand the reference section for em_recall",
  "remove the wiki page about the old cli",
  "rewrite the help page for em_docs",
  "edit the release notes for v0.11",
  "write release notes for v0.12",
  "update the docs for the swarm command",
  "fix the docs on hooks",
];
/** The verb after a lead that a docs phrase already covers is part of the question. */
const COVERED_LEADS = [
  "How does better-sqlite3 handle WAL checkpoints",
  "does sqlite-vec support filtered search",
  "how can better-sqlite3 handle backups",
];
const FORMAT_NOUNS = [
  "what format does loadConfig return",
  "what's the output format of em_search",
  "document the response format of the stats endpoint",
  "Where is the formatDate function defined?",
  "format code blocks in the markdown renderer",
  "format output as json",
  "format strings in the logger are wrong",
];
const FORMAT_ACTIONS = [
  "format the changed files with biome",
  "reformat src/cli.ts",
  "fix the formatting in README.md",
  "run biome format on src",
  // the lead with code as its object, or with a named formatter (review #98 F7)
  "format code",
  "format src",
  "format changed files",
  "format staged files with biome",
  "format src/adjudicator/",
  "format json files with prettier",
  "format modified files",
];
const PLAN_NAMES = [
  "Refactor plan.ts to use the new store",
  "the planner picks the wrong index",
  "update planAdvice to include effort",
  "check the plan output in the swarm status",
  "fix the plan lines so they wrap",
  "what does the plan-advice block show",
];
const PLAN_REQUESTS = [
  "plan the migration to ESM",
  "make a plan for the release",
  "let's plan how to split the server",
  "write a test plan for the importer",
  "we need a rollback plan for the schema change",
  "we need a release plan by Friday",
  "produce a remediation plan",
];
const UI_WORK = [
  "show the token count in the status line",
  "display a warning badge next to stale memories in the memory view",
  "hide archived runs from the swarm dashboard list",
];
const UI_LOOKUPS = [
  "show me the dashboard routes",
  "list the components in the dashboard",
  "where is the follow-rate chart rendered",
];
const HISTORY_QUESTIONS = [
  "which commit introduced the regression in recall?",
  "show the recent commits that touched features.ts",
  "show me the last commit",
  "what changed in the last two commits to recall.ts",
];
const GIT_ACTIONS = [
  "git commit the fix",
  "commit the fix and push it",
  "create a branch for the docs work",
  "rebase onto main and resolve conflicts",
  "amend the last commit",
  "squash the last 3 commits into one",
  "revert the commit that broke the build",
  "push the last commit",
  "push my last commit to origin",
];
const GIT_SUBCOMMANDS = [
  "git status",
  "git add the new files",
  "git diff main",
  "git clean the untracked files",
];
/** Git as a noun in the sentence, not something to run. */
const GIT_AS_A_NOUN = [
  "add git hooks support to the installer",
  "make the git root lookup faster",
  "how does eminiar find the git root",
  "is the git binary required at runtime",
];
const BRANCH_ACTIONS = [
  "switch to the main branch",
  "check out the release branch",
  "create a feature branch",
  "delete the stale branches",
  "rename the master branch to main",
  "rename the branch to main",
];
const CODE_BRANCHES = [
  "make the error branch return null",
  "delete the else branch in parseArgs",
  "rename the branch variable",
  "create a new branch of the decision tree",
  "make a new branch in the switch statement",
];
/** A new branch of the code is work to write: a redo if it lands on haiku. */
const CODE_BRANCH_WORK = [
  "create a new branch of the decision tree",
  "make a new branch in the switch statement",
];
/** amend and squash as code verbs: git only with a commit as the object. */
const AMEND_SQUASH_CODE = [
  "amend the error message to include the path",
  "amend the docstring",
  "squash these two helpers into one",
  "squash the whitespace in the output",
];
const NOT_GIT = [
  "what changed on this branch since main?",
  "what is the branch protection rule for main",
];
const CALLER_QUESTIONS = [
  "who calls foo",
  "what uses the session store",
  "find all callers of resolveAgentPin",
];
const IMPACT_QUESTIONS = [
  "which modules import the config loader",
  "what depends on src/config.ts",
  "what would break if I remove foo and who calls it",
];
const BATCH_RUNS = [
  "run these two in parallel: npm test and npm run lint",
  "run lint, typecheck and build",
  "run the unit tests and the e2e tests concurrently",
  "run lint and typecheck at once",
  "run both at once: npm test and npm run lint",
];
const SINGLE_RUNS = ["run the tests", "check lint and typecheck pass"];
/** "At once" names several commands only after a list; alone it means "now" (review #98 F8). */
const NOT_BATCH = [
  "parallelize the indexer",
  "fix all the lint errors at once",
  "run the build at once",
  "run the tests at once and tell me the result",
  "run the migrations all at once",
];
const REAL_SYMPTOMS = [
  "fix the failing test in tests/unit/parser.test.ts",
  "the build failed after the merge",
  "tests are failing on CI since yesterday",
];

describe("weak spot 1: documentation questions about libraries", () => {
  it.each(DOCS_QUESTIONS)("%s -> em_docs", (text) => {
    expect(toolOf(text)).toBe("em_docs");
  });

  it.each(DOCS_CUES)("%s -> em_docs, not a symbol search", (text) => {
    expect(toolOf(text)).toBe("em_docs");
  });

  it.each(OWN_CODE_QUESTIONS)("%s -> not em_docs", (text) => {
    expect(toolOf(text)).not.toBe("em_docs");
  });

  it.each(FETCH_REQUESTS)("%s -> em_fetch_and_index", (text) => {
    expect(toolOf(text)).toBe("em_fetch_and_index");
  });

  it.each(COVERED_LEADS)("%s -> a question, not an implement request", (text) => {
    expect(has(text, "implement"), intentsOf(text)).toBe(false);
    expect(tierOf(text)).toBe("haiku");
  });

  it("writing docs is an edit, not a docs lookup", () => {
    expect(toolOf("update the docs page for the CLI")).toBe("Edit");
  });

  it.each(FETCH_VERB_AS_CODE)("%s -> not a docs fetch (the verb is code here)", (text) => {
    expect(has(text, "docs"), intentsOf(text)).toBe(false);
    expect(toolOf(text)).not.toBe("em_fetch_and_index");
    expect(ship(text).verdict.role.choice).not.toBe("researcher");
  });

  it("a fetch verb as the topic of a docs question does not make it a fetch", () => {
    const text = "what do the zod docs say about fetch retries";
    expect(extractFeatures(text).fetch).toBe(false);
    expect(toolOf(text)).toBe("em_docs");
  });

  it.each(DOCS_WRITES)("%s -> Edit, not a docs lookup or fetch", (text) => {
    // "in docs" may still count as a weak docs word; the written doc itself does not
    expect(toolOf(text)).toBe("Edit");
    expect(ship(text).verdict.role.choice).toBe("coder");
    expect(extractFeatures(text).intents.docs ?? 0, intentsOf(text)).toBeLessThan(0.7);
    expect(extractFeatures(text).fetch).toBe(false);
  });

  it("reading a docs page still goes to the docs", () => {
    expect(toolOf("read the api page for better-sqlite3")).toBe("em_docs");
  });

  describe("a kebab-case name is a package only when it is a known library (review #98 F3)", () => {
    it.each(PROJECT_NAME_QUESTIONS)("%s -> not em_docs with the library hint", (text) => {
      const { features, verdict } = ship(text, LIBS);
      expect(features.intents.docs ?? 0, JSON.stringify(features.intents)).toBe(0);
      expect(verdict.tool.choice).not.toBe("em_docs");
      expect(verdict.role.choice).not.toBe("researcher");
    });

    it.each([...DOCS_QUESTIONS, ...COVERED_LEADS])("%s -> still em_docs with the hint", (text) => {
      expect(ship(text, LIBS).verdict.tool.choice).toBe("em_docs");
    });

    it("an indexed library keeps its docs route; an unlisted one is read as the project's", () => {
      const text = "how does tree-sitter handle incremental parsing";
      expect(ship(text, LIBS).verdict.tool.choice).toBe("em_docs");
      expect(ship(text, { libraries: ["zod"] }).verdict.tool.choice).not.toBe("em_docs");
    });

    it("without a hint the lexical rule stands (no manifest: any kebab name may be a package)", () => {
      expect(toolOf("how does agent-pin pick the model")).toBe("em_docs");
      expect(ship("how does agent-pin pick the model", {}).verdict.tool.choice).toBe("em_docs");
    });

    it("the hint narrows only the kebab form; the other package forms always count", () => {
      const none: string[] = [];
      expect(isPackageName("agent-pin", none)).toBe(false);
      expect(isPackageName("agent-pin", ["agent-pin"])).toBe(true);
      expect(isPackageName("agent-pin")).toBe(true);
      for (const name of ["@huggingface/transformers", "node:sqlite", "socket.io", "es2015"])
        expect(isPackageName(name, none), name).toBe(true);
      expect(
        ship("how does node:sqlite handle busy timeouts", { libraries: none }).verdict.tool.choice,
      ).toBe("em_docs");
    });

    it("a fetch keeps the whole package pattern: fetching is how a library joins the list", () => {
      expect(extractFeatures("fetch tree-sitter", { libraries: ["zod"] }).fetch).toBe(true);
    });
  });

  it("a plain question about the project's own tool stays on haiku", () => {
    expect(tierOf("how does em_search rank results")).toBe("haiku");
  });
});

describe("weak spot 2: format is an action, or a noun", () => {
  it.each(FORMAT_NOUNS)("%s -> not edit_small", (text) => {
    expect(has(text, "edit_small"), intentsOf(text)).toBe(false);
  });

  it.each(FORMAT_ACTIONS)("%s -> edit_small", (text) => {
    expect(has(text, "edit_small"), intentsOf(text)).toBe(true);
  });

  it("still sends 'fix the formatting' and 'change the date format' to Edit", () => {
    expect(toolOf("fix the formatting in README.md")).toBe("Edit");
    expect(toolOf("change the date format in the CSV export")).toBe("Edit");
  });
});

describe("weak spot 3: plan is a verb or a thing to produce, not a name or modifier", () => {
  it.each(PLAN_NAMES)("%s -> not plan", (text) => {
    expect(has(text, "plan"), intentsOf(text)).toBe(false);
  });

  it.each(PLAN_REQUESTS)("%s -> plan", (text) => {
    expect(has(text, "plan"), intentsOf(text)).toBe(true);
  });

  it("a name that contains plan does not inflate complexity over its plain-word twin", () => {
    const named = ship("fix the plan lines so they wrap").verdict.complexity;
    const plain = ship("fix the status lines so they wrap").verdict.complexity;
    expect(named).toBeLessThanOrEqual(plain + 0.01);
  });
});

describe("an extraction into a helper is bounded work, a restructuring is not (item 13)", () => {
  it("refactor X into a helper function reads as implement, not a sweeping refactor", () => {
    const text = "refactor the billing code into a helper function";
    expect(has(text, "implement"), intentsOf(text)).toBe(true);
    expect(has(text, "refactor"), intentsOf(text)).toBe(false);
  });

  it("refactor X into its own service stays a refactor", () => {
    const text = "refactor the billing code into its own service";
    expect(has(text, "refactor"), intentsOf(text)).toBe(true);
  });

  it("scores the extraction below the restructuring of the same code", () => {
    const extraction = ship("refactor the billing code into a helper function").verdict;
    const restructuring = ship("refactor the billing code into its own service").verdict;
    expect(extraction.complexity).toBeLessThan(restructuring.complexity);
  });
});

describe("weak spot 4: showing or excluding something in a UI surface is work", () => {
  it.each(UI_WORK)("%s -> Edit", (text) => {
    expect(toolOf(text)).toBe("Edit");
    expect(has(text, "implement"), intentsOf(text)).toBe(true);
  });

  it("scores a status-line change above a lookup, so it is not a haiku one-liner", () => {
    expect(tierOf("show the token count in the status line")).not.toBe("haiku");
  });

  it.each(UI_LOOKUPS)("%s -> a lookup, not Edit", (text) => {
    expect(toolOf(text)).not.toBe("Edit");
  });
});

describe("tool routing exposed by the simulation", () => {
  it.each(HISTORY_QUESTIONS)("%s -> em_history", (text) => {
    expect(toolOf(text)).toBe("em_history");
  });

  it.each(GIT_ACTIONS)("%s -> Bash", (text) => {
    expect(toolOf(text)).toBe("Bash");
  });

  it.each(NOT_GIT)("%s -> not Bash", (text) => {
    expect(toolOf(text)).not.toBe("Bash");
  });

  it.each(GIT_SUBCOMMANDS)("%s -> Bash", (text) => {
    expect(toolOf(text)).toBe("Bash");
  });

  it.each(GIT_AS_A_NOUN)("%s -> not Bash (git is a noun here)", (text) => {
    expect(toolOf(text)).not.toBe("Bash");
  });

  it.each(BRANCH_ACTIONS)("%s -> Bash", (text) => {
    expect(toolOf(text)).toBe("Bash");
  });

  it.each(CODE_BRANCHES)("%s -> not Bash (a branch of the code)", (text) => {
    expect(toolOf(text)).not.toBe("Bash");
  });

  it.each(CODE_BRANCH_WORK)("%s -> not haiku (code to write)", (text) => {
    expect(tierOf(text)).not.toBe("haiku");
  });

  it.each(AMEND_SQUASH_CODE)("%s -> not Bash (a code verb here)", (text) => {
    expect(toolOf(text)).not.toBe("Bash");
  });

  it.each(CALLER_QUESTIONS)("%s -> em_symbols", (text) => {
    expect(toolOf(text)).toBe("em_symbols");
  });

  it.each(IMPACT_QUESTIONS)("%s -> em_graph_impact", (text) => {
    expect(toolOf(text)).toBe("em_graph_impact");
  });

  it.each(BATCH_RUNS)("%s -> em_batch_execute", (text) => {
    expect(toolOf(text)).toBe("em_batch_execute");
  });

  it.each(SINGLE_RUNS)("%s -> em_execute", (text) => {
    expect(toolOf(text)).toBe("em_execute");
  });

  it.each(NOT_BATCH)("%s -> not em_batch_execute", (text) => {
    expect(toolOf(text)).not.toBe("em_batch_execute");
  });

  it.each(REAL_SYMPTOMS)("%s -> still a debug task", (text) => {
    expect(has(text, "debug"), intentsOf(text)).toBe(true);
  });
});

describe("scoring cost", () => {
  it("scores a simulation prompt or paraphrase in under 2 ms at p95", () => {
    const texts = [
      ...ITEMS.map((it) => it.text),
      ...DOCS_QUESTIONS,
      ...OWN_CODE_QUESTIONS,
      ...FORMAT_NOUNS,
      ...PLAN_NAMES,
      ...UI_WORK,
      ...GIT_ACTIONS,
      ...BATCH_RUNS,
    ];
    // Wall-clock on a loaded machine includes preemption and GC pauses that say nothing about the
    // scorer, so each prompt is timed as the best of 3 back-to-back runs (noise only adds time).
    const best: number[] = [];
    for (let rep = 0; rep < 5; rep++)
      for (const text of texts) {
        let min = Number.POSITIVE_INFINITY;
        for (let k = 0; k < 3; k++) {
          const t0 = performance.now();
          ship(text);
          min = Math.min(min, performance.now() - t0);
        }
        best.push(min);
      }
    best.sort((a, b) => a - b);
    expect(best[Math.floor(best.length * 0.95)]).toBeLessThan(2);
  });

  it("keeps the new phrase patterns linear on long adversarial input", () => {
    // 4000 characters is the scan limit of extractIntents; every shape below sits on a pattern
    // added for these fixes. Typical cost is 0.2 ms; the bound is far above that and far below a
    // stall (a quadratic pattern over 4000 characters costs tens of ms).
    const chain = (unit: string) => unit.repeat(Math.ceil(4000 / unit.length));
    const hostile: Record<string, string> = {
      "package name chain": `how does ${chain("a-")}b`,
      "dotted package chain": `how do ${chain("a.")}b`,
      "does + hyphen chain": `does ${chain("ab-")} support`,
      "scoped names": `how do ${chain("@a/b ")}`,
      "show without a ui place": `show ${chain("word ")}`,
      "show then a place far away": `show ${chain("w ")} in the ${chain("x ")} view`,
      "exclude without from": `exclude ${chain("w ")}`,
      "refactor without into": `refactor ${chain("w ")}`,
      "refactor with paths": `refactor ${chain("a/b.ts ")} into a module`,
      "plan repeated": chain("plan "),
      "a plan repeated": chain("a plan "),
      "make a repeated": chain("make a "),
      "read the repeated": chain("read the "),
      "format repeated": chain("format the "),
      "commits repeated": chain("last commits "),
      "branch repeated": chain("create a new "),
      "fetch the repeated": chain("fetch the "),
      "fetch then words": `download ${chain("w ")}docs`,
      "write then docs words": `update the ${chain("api ")}page`,
      "format then words": `format ${chain("x ")}with biome`,
      "and ... at once": `run ${chain("a and ")}at once`,
    };
    for (const [name, text] of Object.entries(hostile)) {
      let min = Number.POSITIVE_INFINITY;
      for (let k = 0; k < 3; k++) {
        const t0 = performance.now();
        extractIntents(text);
        min = Math.min(min, performance.now() - t0);
      }
      expect(min, name).toBeLessThan(50);
    }
  });
});

describe("no held-out regression", () => {
  // Measured on HEAD fc4aa21, before these fixes (swarm blackboard "baseline-eval"), through the
  // same path as ship(). Tier, complexity and tool may only stay or improve; under-tiering (a
  // redo) may only stay or drop; opus requests must still reach opus. Role is printed, not
  // asserted: the role rules are still being tuned. The sets are static fixtures, so a changed
  // length means the baseline no longer describes them.
  const SETS = [
    {
      name: "built-in",
      items: EVAL_SET,
      base: {
        n: 40,
        tier: 37,
        under: 1,
        opus: 5,
        opusN: 5,
        cxExact: 18,
        cxWithin: 39,
        role: 35,
        tool: 31,
      },
    },
    {
      name: "held-out",
      items: HELDOUT_SET,
      base: {
        n: 60,
        tier: 50,
        under: 1,
        opus: 5,
        opusN: 5,
        cxExact: 32,
        cxWithin: 57,
        role: 39,
        tool: 36,
      },
    },
    {
      name: "held-out-2",
      items: HELDOUT_SET_2,
      base: {
        n: 60,
        tier: 47,
        under: 3,
        opus: 10,
        opusN: 10,
        cxExact: 35,
        cxWithin: 57,
        role: 38,
        tool: 29,
      },
    },
  ] as const;

  function measure(items: readonly EvalItem[]) {
    const m = { tier: 0, under: 0, opus: 0, opusN: 0, cxExact: 0, cxWithin: 0, role: 0, tool: 0 };
    for (const it of items) {
      const { verdict, bucket } = ship(it.text);
      if (verdict.tier.choice === it.tier) m.tier++;
      if ((RANK[verdict.tier.choice] ?? 0) < (RANK[it.tier] ?? 0)) m.under++;
      if (it.tier === "opus") {
        m.opusN++;
        if (verdict.tier.choice === "opus") m.opus++;
      }
      if (bucket === it.complexity) m.cxExact++;
      if (Math.abs(bucket - it.complexity) <= 1) m.cxWithin++;
      if (verdict.role.choice === it.role) m.role++;
      if (verdict.tool.choice === it.tool) m.tool++;
    }
    return m;
  }

  it.each(SETS)("$name: nothing is worse than before the fixes", ({ name, items, base }) => {
    expect(items, `${name}: the baseline was measured on ${base.n} items`).toHaveLength(base.n);
    const m = measure(items);
    console.log(
      `${name.padEnd(10)} tier ${m.tier}/${base.n} (was ${base.tier})  under ${m.under} (was ${base.under})  opus ${m.opus}/${m.opusN}  cx exact ${m.cxExact} (was ${base.cxExact})  cx+-1 ${m.cxWithin} (was ${base.cxWithin})  role ${m.role} (was ${base.role}, not asserted)  tool ${m.tool} (was ${base.tool})`,
    );
    const worse: string[] = [];
    const atLeast = (what: string, got: number, was: number) => {
      if (got < was) worse.push(`${what} ${got} < ${was}`);
    };
    atLeast("tier", m.tier, base.tier);
    atLeast("opus recall", m.opus, base.opus);
    atLeast("complexity exact", m.cxExact, base.cxExact);
    atLeast("complexity +-1", m.cxWithin, base.cxWithin);
    atLeast("tool", m.tool, base.tool);
    if (m.under > base.under) worse.push(`under-tiered ${m.under} > ${base.under}`);
    expect(m.opusN, `${name}: opus items`).toBe(base.opusN);
    expect(worse, name).toEqual([]);
  });
});
