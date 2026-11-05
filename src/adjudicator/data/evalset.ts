/**
 * The labelled eval set of the adjudicator (docs/design/adjudicator.md §19): 40 coding requests
 * from blackboard `research-local-3` (swarm run 20261104-483f39), labelled by one researcher.
 * Several labels are debatable (the tool for "summarize the output of npm audit", the role for
 * "audit the hook timeouts"), so agreement between labellers is part of the test. The heuristic
 * must never special-case these items; tune features on principles, and grow the set from real
 * prompts (hashes + labels, not text) before tuning thresholds.
 *
 * Majority baselines: tier haiku 0.475, complexity 0 0.30, role coder 0.30, tool Edit 0.225.
 */

import type { Tier } from "../types.js";

export interface EvalItem {
  text: string;
  /** A tool name; may fall outside TOOL_IDS (e.g. em_graph_query), which then never matches. */
  tool: string;
  tier: Tier;
  role: string;
  /** 0..4 */
  complexity: number;
}

export const EVAL_SET: readonly EvalItem[] = [
  {
    text: "what does the loadConfig function return",
    tool: "em_symbols",
    tier: "haiku",
    role: "explorer",
    complexity: 0,
  },
  {
    text: "where is the PreToolUse hook registered",
    tool: "em_search",
    tier: "haiku",
    role: "explorer",
    complexity: 0,
  },
  {
    text: "rename variable foo to bar in utils.ts",
    tool: "Edit",
    tier: "haiku",
    role: "coder",
    complexity: 0,
  },
  {
    text: "fix the typo in the README heading",
    tool: "Edit",
    tier: "haiku",
    role: "coder",
    complexity: 0,
  },
  {
    text: "list all files that import src/paths.ts",
    tool: "em_graph_impact",
    tier: "haiku",
    role: "explorer",
    complexity: 1,
  },
  {
    text: "what would break if I change the StorageAdapter interface",
    tool: "em_graph_impact",
    tier: "sonnet",
    role: "architect",
    complexity: 2,
  },
  {
    text: "run the test suite and tell me what fails",
    tool: "em_execute",
    tier: "haiku",
    role: "tester",
    complexity: 1,
  },
  {
    text: "summarize the output of npm audit",
    tool: "em_execute",
    tier: "haiku",
    role: "reviewer",
    complexity: 1,
  },
  {
    text: "fetch the zod docs for discriminated unions and summarize",
    tool: "em_fetch_and_index",
    tier: "haiku",
    role: "researcher",
    complexity: 1,
  },
  {
    text: "why was the swarm enforcement added, check history",
    tool: "em_history",
    tier: "haiku",
    role: "researcher",
    complexity: 1,
  },
  {
    text: "add a --json flag to the usage CLI command",
    tool: "Edit",
    tier: "sonnet",
    role: "coder",
    complexity: 2,
  },
  {
    text: "write unit tests for the routing precision change",
    tool: "Edit",
    tier: "sonnet",
    role: "tester",
    complexity: 2,
  },
  {
    text: "implement a new em_ tool that lists stale memories",
    tool: "Edit",
    tier: "sonnet",
    role: "coder",
    complexity: 3,
  },
  {
    text: "refactor the hooks dispatcher to share the config load across events",
    tool: "Edit",
    tier: "sonnet",
    role: "coder",
    complexity: 3,
  },
  {
    text: "design an opt-in adjudicator subsystem that routes work to model sizes",
    tool: "Agent",
    tier: "opus",
    role: "architect",
    complexity: 4,
  },
  {
    text: "review this PR for security issues and race conditions",
    tool: "Agent",
    tier: "opus",
    role: "reviewer",
    complexity: 3,
  },
  {
    text: "debug why the sqlite-vec index returns duplicate rows after reindex",
    tool: "em_execute",
    tier: "sonnet",
    role: "coder",
    complexity: 3,
  },
  {
    text: "migrate the storage layer from better-sqlite3 to node:sqlite",
    tool: "Agent",
    tier: "opus",
    role: "architect",
    complexity: 4,
  },
  {
    text: "research providers for tiny hosted classification models and compare cost",
    tool: "em_fetch_and_index",
    tier: "sonnet",
    role: "researcher",
    complexity: 2,
  },
  {
    text: "search the codebase for where session ids are generated",
    tool: "em_search",
    tier: "haiku",
    role: "explorer",
    complexity: 0,
  },
  {
    text: "show me the git blame for the config parser",
    tool: "em_history",
    tier: "haiku",
    role: "explorer",
    complexity: 0,
  },
  {
    text: "split this feature into tasks and assign workers",
    tool: "em_swarm",
    tier: "sonnet",
    role: "architect",
    complexity: 3,
  },
  {
    text: "find dead code candidates in src/graph",
    tool: "em_graph_query",
    tier: "haiku",
    role: "explorer",
    complexity: 1,
  },
  {
    text: "explain how the FTS5 ranking and vector rerank are combined",
    tool: "em_search",
    tier: "sonnet",
    role: "explorer",
    complexity: 2,
  },
  {
    text: "update the docs to mention the new config key",
    tool: "Edit",
    tier: "haiku",
    role: "coder",
    complexity: 1,
  },
  {
    text: "add retries with backoff to the model download",
    tool: "Edit",
    tier: "sonnet",
    role: "coder",
    complexity: 2,
  },
  {
    text: "audit the hook timeouts and propose a latency budget",
    tool: "Agent",
    tier: "sonnet",
    role: "reviewer",
    complexity: 3,
  },
  {
    text: "rewrite the whole dashboard in a different framework",
    tool: "Agent",
    tier: "opus",
    role: "architect",
    complexity: 4,
  },
  {
    text: "check lint and typecheck pass",
    tool: "em_execute",
    tier: "haiku",
    role: "tester",
    complexity: 0,
  },
  {
    text: "read the 3000 line server.ts and tell me what each section does",
    tool: "em_execute_file",
    tier: "sonnet",
    role: "explorer",
    complexity: 2,
  },
  {
    text: "what is the latest version of onnxruntime-node",
    tool: "em_fetch_and_index",
    tier: "haiku",
    role: "researcher",
    complexity: 0,
  },
  {
    text: "write a migration that adds a column to api_calls and backfills it",
    tool: "Edit",
    tier: "sonnet",
    role: "coder",
    complexity: 3,
  },
  {
    text: "is it safe to delete the legacy memories directory",
    tool: "em_recall",
    tier: "sonnet",
    role: "reviewer",
    complexity: 2,
  },
  {
    text: "plan the rollout of the adjudicator across hooks, MCP and CLI",
    tool: "em_swarm",
    tier: "opus",
    role: "architect",
    complexity: 4,
  },
  { text: "hi", tool: "none", tier: "haiku", role: "none", complexity: 0 },
  { text: "thanks, that works", tool: "none", tier: "haiku", role: "none", complexity: 0 },
  { text: "commit these changes", tool: "Bash", tier: "haiku", role: "coder", complexity: 0 },
  {
    text: "find why the dashboard memory view is slow with 5000 memories",
    tool: "em_execute",
    tier: "sonnet",
    role: "coder",
    complexity: 3,
  },
  {
    text: "verify the fix with a regression test and run the suite",
    tool: "em_execute",
    tier: "sonnet",
    role: "tester",
    complexity: 2,
  },
  {
    text: "tidy imports and apply biome formatting",
    tool: "Bash",
    tier: "haiku",
    role: "coder",
    complexity: 0,
  },
];
