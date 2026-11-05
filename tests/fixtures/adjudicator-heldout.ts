/**
 * Held-out labelled set for the adjudicator heuristic (task #22, swarm run 20261104-483f39).
 *
 * 60 realistic coding requests written and labelled BEFORE the tester read src/adjudicator/
 * heuristic.ts or features.ts, so neither the phrasings nor the labels were shaped by the scorer's
 * rules. Labels follow the guidance of blackboard `research-local-3` (and the rubric the 40-item
 * src/adjudicator/data/evalset.ts uses): haiku for lookups, one-line edits, chat and plain command
 * runs; sonnet for ordinary implementation, debugging, tests and explanation of large files; opus
 * for architecture, migrations across the codebase, and security-critical or very broad work.
 * Complexity 0..4 on the same scale; role and tool as in the eval set. Several labels are
 * debatable (marked `// debatable`): inter-labeller agreement is part of the test, and this set
 * is one tester's judgement.
 *
 * Phrasings deliberately mix terse commands, questions, long multi-paragraph reports, pasted
 * stack traces, file paths, swarm-style task titles and non-English or shorthand text. The set
 * must stay disjoint from EVAL_SET and EXEMPLARS (the test asserts it). Do not tune the heuristic
 * by special-casing any item here; if the set is ever used for tuning it stops being held out and
 * a fresh one must be written.
 */

import type { EvalItem } from "../../src/adjudicator/data/evalset.js";
import type { Tier } from "../../src/adjudicator/types.js";

const item = (
  text: string,
  tool: string,
  tier: Tier,
  role: string,
  complexity: number,
): EvalItem => ({ text, tool, tier, role, complexity });

export const HELDOUT_SET: readonly EvalItem[] = [
  // terse
  item("fix the flaky test", "em_execute", "sonnet", "tester", 2), // debatable
  item("lol where do we parse the yaml config", "em_search", "haiku", "explorer", 0),
  item("bump version to 0.11.0 in package.json", "Edit", "haiku", "coder", 0),
  item("git status", "Bash", "haiku", "coder", 0),
  item("push it", "Bash", "haiku", "coder", 0),
  item("ok", "none", "haiku", "none", 0),
  item("yes go ahead", "none", "haiku", "none", 0),
  item("npm test", "em_execute", "haiku", "tester", 0),
  item("find all TODO comments", "em_search", "haiku", "explorer", 0),
  item("list exports of src/paths.ts", "em_symbols", "haiku", "explorer", 0),
  item("remove the unused import in src/cli.ts", "Edit", "haiku", "coder", 0),
  item("fix typo: recieve -> receive in comments", "Edit", "haiku", "coder", 0),
  item("update CHANGELOG with the adjudicator entry", "Edit", "haiku", "coder", 0),
  item("change the button color to blue", "Edit", "haiku", "ui", 0),
  item("can you explain what a closure is", "none", "haiku", "none", 0),
  item("where's the docs for configuring the adjudicator", "em_search", "haiku", "explorer", 0),
  item("what's the difference between em_search and em_recall?", "none", "haiku", "none", 0), // debatable

  // questions and small lookups with a little reasoning
  item("show me the last 5 commits touching src/storage", "em_history", "haiku", "explorer", 0),
  item(
    "who changed the retry logic in downloader.ts and why",
    "em_history",
    "haiku",
    "researcher",
    1,
  ),
  item("does anything else call parseArgs()", "em_graph_impact", "haiku", "explorer", 1),
  item("what depends on src/adjudicator/types.ts", "em_graph_impact", "haiku", "explorer", 1),
  item("look up how to use vitest fake timers", "em_docs", "haiku", "researcher", 1),
  item(
    "check the better-sqlite3 docs for how prepared statements get cached",
    "em_docs",
    "haiku",
    "researcher",
    1,
  ),
  item("what did we decide about the swarm scope last week", "em_recall", "haiku", "researcher", 1),
  item(
    "run the integration tests for the dashboard and summarize failures",
    "em_execute",
    "haiku",
    "tester",
    1,
  ),
  item("summarize src/hooks/dispatch.ts", "em_execute_file", "haiku", "explorer", 1),
  item(
    "is this regex safe from catastrophic backtracking: /^(a+)+$/",
    "none",
    "haiku",
    "reviewer",
    1,
  ),
  item("rename getUser to fetchUser everywhere", "Edit", "haiku", "coder", 1), // debatable
  item("add a unit test for the empty input case in the chunker", "Edit", "haiku", "tester", 1),
  item("add a loading spinner to the memory list", "Edit", "haiku", "ui", 1),
  item(
    "T15: document the adjudicator config keys in docs/design/adjudicator.md",
    "Edit",
    "haiku",
    "coder",
    1,
  ),

  // ordinary implementation, debugging and tests
  item("add a --dry-run flag to the purge command", "Edit", "sonnet", "coder", 2),
  item("pls add types to the any's in src/usage/aggregate.ts", "Edit", "sonnet", "coder", 2),
  item("convert callbacks to async/await in src/sandbox/runner.ts", "Edit", "sonnet", "coder", 2),
  item(
    "extract the retry helper into its own module and update all call sites",
    "Edit",
    "sonnet",
    "coder",
    2,
  ),
  item(
    "make the dashboard sidebar collapsible on mobile, css plus a toggle button",
    "Edit",
    "sonnet",
    "ui",
    2,
  ),
  item("increase test coverage for src/graph/impact.ts to 90%", "Edit", "sonnet", "tester", 2),
  item("write an ADR for choosing sqlite-vec over hnswlib", "Edit", "sonnet", "architect", 2),
  item("review my diff", "em_history", "sonnet", "reviewer", 2), // debatable
  item(
    "explain what src/graph/builder.ts does, it's like 2k lines",
    "em_execute_file",
    "sonnet",
    "explorer",
    2,
  ),
  item(
    "fetch https://nodejs.org/api/sqlite.html and tell me which functions we would need",
    "em_fetch_and_index",
    "sonnet",
    "researcher",
    2,
  ),
  item(
    "TypeError: Cannot read properties of undefined (reading 'map')\n" +
      "    at renderRows (src/ui/table.ts:88:21)\n" +
      "    at Object.<anonymous> (src/ui/index.ts:14:3)\n" +
      "can you fix this",
    "Edit",
    "sonnet",
    "coder",
    2,
  ),
  item(
    "FAIL tests/unit/memory.test.ts > recall > ranks pinned first\n" +
      "AssertionError: expected 'b' to be 'a'\n" +
      "  at tests/unit/memory.test.ts:52:30\n" +
      "why is this failing",
    "em_execute",
    "sonnet",
    "coder",
    2,
  ),
  item("arregla el bug del login, el token expira antes de tiempo", "Edit", "sonnet", "coder", 2),
  item("tests r failing on ci, no idea why", "em_execute", "sonnet", "coder", 2), // debatable
  item(
    "T12: write tests for blend.ts covering timeout and fail-open",
    "Edit",
    "sonnet",
    "tester",
    2,
  ),

  // harder implementation and debugging
  item(
    "T7: wire adjudicator verdict into the PreToolUse hook (src/hooks/pretooluse.ts)",
    "Edit",
    "sonnet",
    "coder",
    3,
  ),
  item(
    "bundle size went up 40kb after the last PR, figure out why",
    "em_execute",
    "sonnet",
    "coder",
    3,
  ),
  item("add dark mode support to the dashboard", "Edit", "sonnet", "ui", 3),
  item("optimize the FTS query, it takes 800ms on 50k docs", "em_execute", "sonnet", "coder", 3),
  item(
    "why is memory usage growing in the long-running mcp server? i see rss going from 200mb to 2gb over a day",
    "em_execute",
    "sonnet",
    "coder",
    3,
  ),
  item(
    "So users are reporting that after they resume a session the memory recall returns stale results.\n\n" +
      "I looked and the index is rebuilt on SessionStart but the embeddings cache seems to be keyed by " +
      "path, not content hash. Not sure if that is the cause.\n\n" +
      "Can you dig in, find the root cause, and fix it? Please add a regression test.",
    "em_execute",
    "sonnet",
    "coder",
    3,
  ),
  item(
    "compare three embedding libraries for node: transformers.js, onnxruntime-node and llama.cpp bindings, speed memory license",
    "em_fetch_and_index",
    "sonnet",
    "researcher",
    3,
  ),
  item(
    "should we use a queue or direct writes for the usage ingest? think through the tradeoffs",
    "none",
    "sonnet",
    "architect",
    3,
  ), // debatable
  item(
    "spin up a swarm to implement the settings page, one coder per route",
    "em_swarm",
    "sonnet",
    "architect",
    3,
  ),

  // opus: architecture, security, broad changes
  item(
    "break down the multi-tenant support epic into tasks with dependencies",
    "em_swarm",
    "opus",
    "architect",
    4,
  ),
  item(
    "make the whole codebase ESM-only and drop the CJS build, including the hook bundle and the CLI shim",
    "Agent",
    "opus",
    "architect",
    4,
  ),
  item(
    "migrate all 14 hooks from callbacks to the new middleware pattern, keeping behaviour identical, " +
      "behind a feature flag, and write a rollout plan",
    "Agent",
    "opus",
    "architect",
    4,
  ),
  item(
    "security review of the sandbox: can untrusted code escape the cwd restriction or read env secrets? be thorough",
    "Agent",
    "opus",
    "reviewer",
    4,
  ),
  item(
    "implement oauth2 PKCE login flow for the cli with token refresh and secure storage in the keychain, including tests and docs",
    "Agent",
    "opus",
    "coder",
    4,
  ),
];
