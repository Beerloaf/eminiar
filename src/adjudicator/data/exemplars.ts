/**
 * Labelled exemplars for the embedding provider (docs/design/adjudicator.md §8): k-NN over
 * bge-small vectors of these texts gives a tier Dist and a complexity estimate. Research
 * (blackboard `research-local`) found ~15-30 exemplars per class are needed, and that
 * nearest-neighbour carries signal for tier and complexity but none for the tool, so only those
 * two labels are kept.
 *
 * These must stay disjoint from the eval set (data/evalset.ts): no shared or near-identical
 * request, or the eval would measure memorisation. A unit test enforces it. Changing any text
 * changes the vector cache key, so the exemplars are re-embedded once on the next run.
 */

import type { Tier } from "../types.js";

export interface Exemplar {
  text: string;
  tier: Tier;
  /** 0..4, on the rubric of prompt.ts COMPLEXITY_CRITERIA. */
  complexity: number;
}

export const EXEMPLARS: readonly Exemplar[] = [
  // haiku: lookups, one-line edits, chat
  { text: "what type does the parseArgs helper return", tier: "haiku", complexity: 0 },
  { text: "where is the database connection opened", tier: "haiku", complexity: 0 },
  { text: "show the signature of the hashFile function", tier: "haiku", complexity: 0 },
  { text: "change the default port constant from 3000 to 8080", tier: "haiku", complexity: 0 },
  { text: "correct the spelling mistake in the CLI help text", tier: "haiku", complexity: 0 },
  { text: "which file defines the Logger class", tier: "haiku", complexity: 0 },
  { text: "run the linter and show me the errors", tier: "haiku", complexity: 1 },
  { text: "bump the version number in package.json to 1.4.2", tier: "haiku", complexity: 0 },
  { text: "what does the --verbose flag do in this tool", tier: "haiku", complexity: 0 },
  { text: "list the npm scripts defined in this project", tier: "haiku", complexity: 0 },
  { text: "remove the unused lodash import from helpers.ts", tier: "haiku", complexity: 0 },
  { text: "add a short comment explaining the retry constant", tier: "haiku", complexity: 1 },
  { text: "how many tests are in the storage test file", tier: "haiku", complexity: 0 },
  { text: "rename the README section Setup to Installation", tier: "haiku", complexity: 0 },
  { text: "print the current git branch and the last three commits", tier: "haiku", complexity: 0 },
  { text: "look up the docs for Array.prototype.flatMap", tier: "haiku", complexity: 1 },
  { text: "good morning", tier: "haiku", complexity: 0 },
  { text: "ok great, thank you", tier: "haiku", complexity: 0 },
  { text: "delete the commented-out block in config.ts", tier: "haiku", complexity: 0 },
  { text: "update the copyright year in the LICENSE file", tier: "haiku", complexity: 0 },

  // sonnet: a feature or fix in one area, tests, focused debugging
  { text: "add pagination to the list memories endpoint", tier: "sonnet", complexity: 2 },
  { text: "write tests covering the edge cases of the date parser", tier: "sonnet", complexity: 2 },
  {
    text: "fix the off-by-one error in the chunker when the file ends without a newline",
    tier: "sonnet",
    complexity: 2,
  },
  {
    text: "add a --limit option to the search command and wire it through to the query",
    tier: "sonnet",
    complexity: 2,
  },
  { text: "make the cache expire entries after a configurable TTL", tier: "sonnet", complexity: 2 },
  {
    text: "investigate why the watcher fires twice for every file save",
    tier: "sonnet",
    complexity: 3,
  },
  {
    text: "extract the duplicated validation logic in the two handlers into a shared helper",
    tier: "sonnet",
    complexity: 2,
  },
  { text: "implement a dark mode toggle for the settings page", tier: "sonnet", complexity: 2 },
  {
    text: "add structured logging to the indexer with a log level setting",
    tier: "sonnet",
    complexity: 2,
  },
  { text: "convert the callback-based file reader to async/await", tier: "sonnet", complexity: 2 },
  {
    text: "handle a missing config file gracefully and print a helpful error",
    tier: "sonnet",
    complexity: 1,
  },
  {
    text: "write an integration test that starts the server and calls the health route",
    tier: "sonnet",
    complexity: 2,
  },
  { text: "add input validation with zod to the import command", tier: "sonnet", complexity: 2 },
  {
    text: "the build fails on Windows because of path separators, fix it",
    tier: "sonnet",
    complexity: 3,
  },
  {
    text: "explain how a request flows from the hook into the storage layer",
    tier: "sonnet",
    complexity: 2,
  },
  {
    text: "store the last access time for each entry and use it to sort results",
    tier: "sonnet",
    complexity: 3,
  },
  { text: "optimize the slow query that loads graph neighbours", tier: "sonnet", complexity: 3 },
  { text: "port the bash install script to a node script", tier: "sonnet", complexity: 2 },

  // opus: architecture, cross-cutting changes, hard multi-subsystem debugging
  {
    text: "design a plugin system so third parties can add their own tools",
    tier: "opus",
    complexity: 4,
  },
  {
    text: "re-architect the indexing pipeline to run incrementally in a worker pool",
    tier: "opus",
    complexity: 4,
  },
  {
    text: "replace the custom auth layer with OAuth across the server, CLI and dashboard",
    tier: "opus",
    complexity: 4,
  },
  {
    text: "do a full security audit of the sandbox and its escape paths",
    tier: "opus",
    complexity: 4,
  },
  {
    text: "propose and implement multi-tenant support in the storage schema",
    tier: "opus",
    complexity: 4,
  },
  {
    text: "find and fix the intermittent deadlock between the hook process and the MCP server",
    tier: "opus",
    complexity: 4,
  },
  {
    text: "split the monolithic server module into separate packages with a clear public API",
    tier: "opus",
    complexity: 4,
  },
  {
    text: "design the data model and sync protocol for sharing memories between machines",
    tier: "opus",
    complexity: 4,
  },
  {
    text: "plan a move from REST to an event-driven architecture for the backend",
    tier: "opus",
    complexity: 4,
  },
  {
    text: "evaluate three vector databases and redesign retrieval around the best one",
    tier: "opus",
    complexity: 4,
  },
  {
    text: "build an end-to-end offline mode with conflict resolution",
    tier: "opus",
    complexity: 4,
  },
  {
    text: "overhaul the query planner so hybrid search scales to a million documents",
    tier: "opus",
    complexity: 4,
  },
  {
    text: "trace the memory leak that appears after a day of uptime and redesign the cache behind it",
    tier: "opus",
    complexity: 3,
  },
  {
    text: "introduce a typed schema migration framework and convert every existing migration",
    tier: "opus",
    complexity: 3,
  },
  {
    text: "review the overall architecture and propose a roadmap to halve latency",
    tier: "opus",
    complexity: 4,
  },
  {
    text: "design cross-platform sandboxing that works on macOS, Linux and Windows",
    tier: "opus",
    complexity: 4,
  },
  {
    text: "move the whole test suite from jest to vitest and fix every failing test",
    tier: "opus",
    complexity: 3,
  },
  {
    text: "coordinate a multi-agent refactor of the graph, search and storage subsystems",
    tier: "opus",
    complexity: 4,
  },
];
