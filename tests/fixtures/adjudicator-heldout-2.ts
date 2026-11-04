import type { Tier } from "../../src/adjudicator/types.js";

/**
 * Second blind held-out set (task #24): 60 coding requests written and labelled BEFORE the tier-bias
 * change in the heuristic (task #23) was read, to validate that change on fresh data. Written
 * without reading heuristic.ts, features.ts or the first held-out fixture. Labels are the judgement
 * of the author: tier is the smallest model that would do the work without a redo; complexity 0..4.
 * Shape: ~10 opus, ~20 sonnet, ~25 haiku, 5 edge cases (marked in the comment).
 */
export interface HeldoutItem {
  text: string;
  tool: string;
  tier: Tier;
  role: string;
  /** 0..4 */
  complexity: number;
}

const i = (
  text: string,
  tool: string,
  tier: Tier,
  role: string,
  complexity: number,
): HeldoutItem => ({ text, tool, tier, role, complexity });

export const HELDOUT_SET_2: readonly HeldoutItem[] = [
  // ---- opus: epics, migrations, security reviews, cross-cutting refactors, architecture ----
  i(
    "Design a multi-tenant architecture for the billing service: tenant isolation at the database level, per-tenant rate limits, a migration path for the 40 existing customers without downtime, and a rollback plan",
    "Agent", "opus", "architect", 4,
  ),
  i(
    "Migrate the whole persistence layer from raw SQL strings to a typed query builder across every package, keeping the public repository interfaces stable and shipping it in reviewable stages",
    "em_graph_impact", "opus", "architect", 4,
  ),
  i(
    "Do a security review of the authentication flow: session fixation, token storage, CSRF on the admin routes, password reset token entropy and the OAuth callback validation, and write up severity-ranked findings",
    "em_search", "opus", "reviewer", 4,
  ),
  i(
    "Refactor error handling across the entire codebase so every module returns a typed Result instead of throwing, updating all call sites and the tests that assert on exceptions",
    "em_graph_impact", "opus", "coder", 4,
  ),
  i(
    "Plan and implement an event-sourcing rewrite of the order lifecycle: define the event schema, projections, snapshotting, replay tooling and a dual-write cutover strategy",
    "Agent", "opus", "architect", 4,
  ),
  i(
    "Upgrade the monorepo from React 17 to 19 and from webpack to vite, resolving every breaking change in the shared component library and all five apps that consume it",
    "em_docs", "opus", "coder", 4,
  ),
  i(
    "We are seeing data corruption under concurrent writes that only reproduces in production. Investigate the locking strategy across the job queue, the cache invalidation path and the write-behind worker, find the race and propose a fix that does not regress throughput",
    "em_search", "opus", "researcher", 4,
  ),
  i(
    "Design the plugin system for the compiler: stable extension points, sandboxing of third-party code, versioned APIs, and how existing built-in passes get ported onto it",
    "Agent", "opus", "architect", 3,
  ),
  i(
    "Audit the whole repository for injection and deserialization vulnerabilities, trace every untrusted input to its sink, and produce a remediation plan ordered by exploitability",
    "em_search", "opus", "reviewer", 4,
  ),
  i(
    "Break the monolith's notifications module out into its own service: define the contract, extract the data it owns, handle the shared transactions it currently participates in, and plan the traffic shift",
    "em_graph_impact", "opus", "architect", 4,
  ),
  // ---- sonnet: ordinary feature, bug and test work ----
  i(
    "Add a --json flag to the export command that prints the same rows as structured JSON, and cover it with a test",
    "Edit", "sonnet", "coder", 2,
  ),
  i(
    "The pagination helper returns one page too few when the total is an exact multiple of the page size. Find the off-by-one and fix it",
    "em_symbols", "sonnet", "coder", 2,
  ),
  i(
    "Write unit tests for the retry wrapper covering success on the third attempt, exhaustion, and a non-retryable error that must not be retried",
    "Edit", "sonnet", "tester", 2,
  ),
  i(
    "Review this diff for the new rate limiter and tell me if the sliding window logic has any edge cases that would let bursts through",
    "em_history", "sonnet", "reviewer", 2,
  ),
  i(
    "Implement debounce on the search input so we only hit the API after 300ms of inactivity, and cancel in-flight requests when a newer one starts",
    "Edit", "sonnet", "ui", 2,
  ),
  i(
    "Which modules would be affected if I change the signature of parseConfig to accept an options object? List them and what each would need",
    "em_graph_impact", "sonnet", "explorer", 2,
  ),
  i(
    "Add input validation to the signup endpoint: email format, password length of at least 12, and a clear 400 response listing every failed field",
    "Edit", "sonnet", "coder", 2,
  ),
  i(
    "Our nightly job sometimes processes the same record twice. Look at how the lease is acquired and tell me where the duplicate could come from",
    "em_search", "sonnet", "researcher", 3,
  ),
  i(
    "Convert the user settings form from class components to hooks without changing its behaviour, and make sure the existing tests still pass",
    "Edit", "sonnet", "ui", 2,
  ),
  i(
    "Add a flaky-test quarantine: tests listed in a JSON file are retried twice and reported separately in the summary",
    "Edit", "sonnet", "tester", 3,
  ),
  i(
    "Explain how the cache invalidation works between the product service and the search indexer, and point at the files involved",
    "em_search", "sonnet", "explorer", 2,
  ),
  i(
    "Write a migration that adds a nullable archived_at column to documents, backfills it from the status field, and then adds an index",
    "Edit", "sonnet", "coder", 2,
  ),
  i(
    "Compare the two caching libraries we are considering for the API gateway on memory use, TTL control and cluster support, and recommend one",
    "em_docs", "sonnet", "researcher", 2,
  ),
  i(
    "The dark mode toggle resets on page reload. Persist the choice, respect the system preference on first visit, and avoid the flash of the wrong theme",
    "Edit", "sonnet", "ui", 2,
  ),
  i(
    "Find every place we build SQL by string concatenation in the reporting module and replace it with parameterised queries",
    "em_search", "sonnet", "coder", 3,
  ),
  i(
    "Add structured logging with a request id to the HTTP middleware and thread it through the three service calls the handler makes",
    "Edit", "sonnet", "coder", 3,
  ),
  i(
    "Why did the build time double last month? Look through recent history for changes to the bundler config or dependencies",
    "em_history", "sonnet", "researcher", 2,
  ),
  i(
    "Write integration tests for the webhook receiver: valid signature, bad signature, replayed delivery and a malformed body",
    "Edit", "sonnet", "tester", 3,
  ),
  i(
    "Review the error handling in the file upload path: are partial uploads cleaned up, are size limits enforced before buffering, and is the mime type trusted?",
    "em_search", "sonnet", "reviewer", 3,
  ),
  i(
    "Add keyboard navigation to the dropdown menu: arrow keys move focus, enter selects, escape closes, and the ARIA roles are correct",
    "Edit", "sonnet", "ui", 3,
  ),
  // ---- haiku: lookups, one-line edits, trivial chores ----
  i("Where is the formatDate function defined?", "em_symbols", "haiku", "explorer", 0),
  i("Rename the variable tmp to buffer in utils/io.ts", "Edit", "haiku", "coder", 0),
  i("Show me the last 5 commits on this branch", "em_history", "haiku", "none", 0),
  i("What does the HTTP 429 status code mean?", "none", "haiku", "none", 0),
  i("Fix the typo 'recieve' in the README", "Edit", "haiku", "coder", 0),
  i("Run the linter and tell me if it passes", "Bash", "haiku", "none", 0),
  i("List the files in the src/routes directory", "Bash", "haiku", "explorer", 0),
  i("Bump the version in package.json to 2.4.1", "Edit", "haiku", "coder", 0),
  i("Find usages of the deprecated getUser helper", "em_symbols", "haiku", "explorer", 1),
  i("What did we decide about the retry backoff last week?", "em_recall", "haiku", "none", 1),
  i("Add a trailing newline to config/defaults.json", "Edit", "haiku", "coder", 0),
  i("Remove the unused import of lodash from the cart module", "Edit", "haiku", "coder", 0),
  i("What is the signature of the createClient function?", "em_symbols", "haiku", "explorer", 0),
  i("Change the default port from 3000 to 8080", "Edit", "haiku", "coder", 0),
  i("Summarise this 4000 line test output and tell me only which tests failed", "em_execute_file", "haiku", "none", 1),
  i("Look up how to use the zod refine method", "em_docs", "haiku", "researcher", 1),
  i("Does a file called docker-compose.yml exist at the root?", "Bash", "haiku", "explorer", 0),
  i("Add a comment above the retry loop explaining why it caps at five attempts", "Edit", "haiku", "coder", 0),
  i("Who last changed the rate limit constant?", "em_history", "haiku", "none", 1),
  i("Make the page title say Dashboard instead of Home", "Edit", "haiku", "ui", 0),
  i("Print the current git branch name", "Bash", "haiku", "none", 0),
  i("Read the docs page at https://example.com/api/changelog and keep it for later", "em_fetch_and_index", "haiku", "researcher", 1),
  i("Delete the commented-out block at the bottom of server.ts", "Edit", "haiku", "coder", 0),
  i("What was the name of the helper that wraps fetch with a timeout?", "em_search", "haiku", "explorer", 1),
  i("Change the button label from Submit to Save", "Edit", "haiku", "ui", 0),
  // ---- edge cases ----
  i("thanks, that looks good", "none", "haiku", "none", 0),
  i(
    "TypeError: Cannot read properties of undefined (reading 'id')\n    at mapOrder (src/orders/map.ts:41:19)\n    at Array.map (<anonymous>)\n    at buildReport (src/orders/report.ts:88:30)\n    at async handler (src/routes/report.ts:17:5)",
    "em_search", "sonnet", "coder", 2,
  ),
  i(
    "Add an audit log feature.\n\nRequirements:\n- record who changed what and when for users, roles and API keys\n- write entries in the same transaction as the change\n- expose a paginated read endpoint for admins only\n- retain entries for 400 days, then purge",
    "Edit", "sonnet", "coder", 3,
  ),
  i("ok go ahead", "none", "haiku", "none", 0),
  i(
    "Look into why the checkout page feels slow on mobile and see whether anything in the bundle, the images or the API calls explains it",
    "em_search", "sonnet", "researcher", 3,
  ),
];
