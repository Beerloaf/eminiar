import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adjudicateOne, cacheKeyFor, type EngineOptions } from "../../src/adjudicator/engine.js";
import { extractFeatures } from "../../src/adjudicator/features.js";
import { scoreHeuristic } from "../../src/adjudicator/heuristic.js";
import type { AdjudicationRequest, Features, ScoreSet } from "../../src/adjudicator/types.js";
import {
  briefUnitsOf,
  isBoilerplate,
  SATURATED_AT,
  scoreUnits,
  splitUnits,
  statements,
  UNIT_CHARS,
  UNIT_MAX,
  unitScored,
  withoutBoilerplate,
} from "../../src/adjudicator/units.js";
import { type AdjudicatorConfig, ConfigSchema } from "../../src/config.js";
import { SqliteAdapter } from "../../src/storage/sqlite/adapter.js";

const ROLES = [
  {
    name: "coder",
    description:
      "Implements one backend/CLI/hook task at a time with the smallest diff that works.",
  },
  { name: "tester", description: "Writes and runs tests for one behaviour at a time." },
  { name: "architect", description: "Designs before code is written." },
  { name: "researcher", description: "Finds out how things work and reports evidence." },
];
const CATALOGUE = { roles: ROLES };
const hints = (role?: string, files = 1, deps = 0): NonNullable<AdjudicationRequest["hints"]> => ({
  roles: ROLES,
  files,
  deps,
  ...(role ? { role } : {}),
});

// Two coder briefs of this repo's own swarm plan (run 20261104-672098, tasks #95 and #100); both
// end with the verification step that voted them over to the tester (design follow-up F1).
const BRIEF_95 = `Stop onPrompt from scoring subagent hand-backs and task notifications as user prompts
Bug: UserPromptSubmit fires for harness-injected turns. Decision 23 scored a prompt whose text starts with \`<agent-message from="...">\` ([Subagent hand-back] ...) and task-notification turns wrapped in \`<system-reminder>\`/\`<task-notification>\`. In src/adjudicator/hooks.ts onPrompt (line ~150), skip scoring (no row, no advice line, no cooldown tick, and do not mark the previous prompt row superseded) when the prompt text, after leading whitespace, starts with one of these harness envelopes: <agent-message, <task-notification, <system-reminder> (check the exact envelope shapes Claude Code uses; keep the matcher a small exported pure function, e.g. isHarnessEnvelope(text)). A real user prompt that merely mentions these tags mid-text must still be scored. Fail open. Run typecheck, lint and tests/unit/adjudicator-hooks.test.ts.`;
const BRIEF_100 = `Link a spawn to its task when the prompt names several task numbers
Bug (blackboard coordinator-task-link-finding): src/swarm/runtime.ts taskRef() returns undefined when a spawn prompt names more than one distinct 'task #N', so reserveSpawn (line ~728) links no task, the adjudicator's PreToolUse(Agent) note re-scores the prompt and disagrees with the plan line (rows 34, 37). Fix in reserveSpawn: from taskRefs(prompt), keep tasks that belong to an active run of this swarm (prefer the session's active run), are still open (pending, not done/failed/cancelled, not held by a live worker), and whose role equals this role (or have no role). Exactly one candidate → link it; zero or several → undefined as today. Keep taskRef's single-ref behaviour for the common case. Also check how src/adjudicator/hooks.ts onPreAgent obtains run/task for its row (rows 34/37 had run_id NULL even though a run was active) and report on blackboard "taskref-adjudicator-link" whether it uses the spawn decision; only edit hooks.ts if needed and coordinate (task #95 already edited it, now done). Run typecheck, lint, swarm + adjudicator unit tests.`;
// Many kinds of work, none of them huge: the sum saturates, the hardest statement does not.
const BRIEF_WIDE = `Rework the storage layer
Refactor the storage adapters. Migrate the schema. Design the new cache. Review the auth flow. Plan the rollout. Add a retry to the fetch helper. Write unit tests for the parser.`;
const BRIEFS = [BRIEF_95, BRIEF_100, BRIEF_WIDE];
const BOILERPLATE_TAIL =
  "Verify: npm run typecheck, npm run lint and npm test pass; report the exact counts. Run the tests and report any failures.";

// One genuinely hard statement (alone it is opus/max) among many small ones, plus a verification tail.
const HARD =
  "Redesign the storage layer across every adapter and migrate the schema without downtime, refactoring the concurrency model of src/storage/sqlite/adapter.ts and src/storage/pg/adapter.ts.";
const SMALL = [
  "Rename the flag in the config",
  "Update the docs for the flag.",
  "Add a retry to the fetch helper.",
  "Fix the typo in the README.",
  "Add a test for the parser.",
  "Bump the version in package.json.",
  "Tidy the imports in src/a.ts.",
  "Add a comment to the cache helper.",
];
const TIERS = ["haiku", "sonnet", "opus"];
const tierRank = (s: ScoreSet) => TIERS.indexOf(s.tier.choice);

const titleOf = (b: string) => b.slice(0, b.indexOf("\n"));
const detailOf = (b: string) => b.slice(b.indexOf("\n") + 1);
const whole = (text: string, h?: AdjudicationRequest["hints"]): ScoreSet =>
  scoreHeuristic(extractFeatures(text, h), {}, h?.roles ? CATALOGUE : {});
const unitSet = (text: string, h?: AdjudicationRequest["hints"]) =>
  scoreUnits(text, h, {}, h?.roles ? CATALOGUE : {});
/** The decisions a caller acts on. */
const decisions = (s: ScoreSet) => ({
  complexity: s.complexity,
  tier: s.tier.choice,
  effort: s.effort,
  role: s.role.choice,
  roleConfidence: s.role.confidence,
  tool: s.tool.choice,
});

describe("statements", () => {
  it("splits the first line, then every sentence and line, without list markers", () => {
    expect(
      statements(
        "Fix the cache\nIt returns stale rows. The TTL is ignored!\n- add a test\n2. update the docs",
      ),
    ).toEqual([
      "Fix the cache",
      "It returns stale rows.",
      "The TTL is ignored!",
      "add a test",
      "update the docs",
    ]);
  });

  it("keeps an abbreviation's period inside its sentence", () => {
    expect(statements("Pick a store, e.g. the cache. Then stop.")).toEqual([
      "Pick a store, e.g. the cache.",
      "Then stop.",
    ]);
  });

  it("joins pasted output to the statement before it; at the very start it stands alone", () => {
    expect(statements("The build fails with:\n```\nError: boom\n```\nFix it.")).toEqual([
      "The build fails with:\n```\nError: boom\n```",
      "Fix it.",
    ]);
    expect(
      statements(
        "It crashes:\nTypeError: x is undefined\n    at foo (src/a.ts:1:2)\n    at Array.map (<anonymous>)\nFind out why.",
      ),
    ).toEqual([
      "It crashes:\nTypeError: x is undefined\nat foo (src/a.ts:1:2)\nat Array.map (<anonymous>)",
      "Find out why.",
    ]);
    expect(
      statements("FAIL tests/a.test.ts > ranks\n  at tests/a.test.ts:52:30\nwhy is this failing"),
    ).toEqual(["FAIL tests/a.test.ts > ranks\nat tests/a.test.ts:52:30", "why is this failing"]);
  });

  it("reads only the first UNIT_CHARS characters", () => {
    const text = `Fix the cache.\n${"Some filler words here. ".repeat(Math.ceil(UNIT_CHARS / 20))}Hidden tail.`;
    const s = statements(text);
    expect(s[0]).toBe("Fix the cache.");
    expect(s).not.toContain("Hidden tail.");
  });
});

describe("boilerplate", () => {
  it.each([
    "Run npm run typecheck, lint and the adjudicator tests.",
    "Run typecheck, lint and tests/unit/adjudicator-hooks.test.ts.",
    "Run the changed specs + full jest.",
    "Then run `npx vitest run tests/unit/swarm-core.test.ts`.",
    'Typecheck, lint, adjudicator tests; post before/after saturation stats to blackboard "units-stats".',
    "Verify: `npx tsc --noEmit` and the full `npx jest` must pass.",
    "Verify with npm run build and a hook selftest.",
    "Make sure lint and the tests still pass.",
    "Keep the full suite, typecheck and lint green.",
    "Report the exact counts.",
    "Report back (concise, concrete, with file:line refs):",
    "Report evalset.ts numbers and the held-out numbers before/after.",
    'Claim it first: em_swarm {action:"claim", task:102}.',
    "Claim it and do exactly what the task detail says.",
    'Post the design under blackboard key "design", then report the task done.',
    "Put the exact results in your update.",
    "Record with em_swarm update and return it.",
    "Close the task with the passing/failing counts.",
    "End every commit message with: `Co-Authored-By: Claude <noreply@anthropic.com>`.",
    "Return: a verdict (APPROVE or REQUEST_CHANGES), then findings.",
    "Lead with the outcome, then the files you changed.",
    "Test command: cd repo && npx jest test/unit/a.spec.ts.",
    // a routine follow-up to the checks is still a hand-in step (review #109 F2)
    "Run the tests and fix any failures.",
    "Run npm test and fix them.",
    "Make sure lint passes and fix any type errors.",
  ])("leaves out %j", (s) => {
    expect(isBoilerplate(s)).toBe(true);
  });

  it.each([
    "Check that every money-path behaviour has a test.",
    "Check that tests don't depend on things a CI runner won't have.",
    "Verify each round-1 finding is really fixed by re-running the probes.",
    "Run every form through all three readers and assert they agree.",
    "Run the benchmark against the old build.",
    "Add tests for the empty input.",
    "Write unit tests for the parser.",
    "Test with the repro.",
    "Claim: the Summary now returns users plus activity null.",
    "Claim and complete task #190: audit the admin front-end code behind /journal/accounts.",
    "Claim it, read its detail on the board, review the PR.",
    "`claim` → `claimTask` and return the task + `taskBrief`.",
    "Report generation is slow for large tenants.",
    "Update the em_swarm plan action to return the brief.",
    "Return `memoryError` and show it in the FinishForm result.",
    "End-to-end test of the npx path from a clean location.",
    "Close confirm and closed page stop promising a history the app can't show.",
    "Note any route present in one doc but not the other.",
    // a step that opens on a check or report verb but carries the work (review #109 F2)
    "Run the build under Node 18 and fix the ESM import errors in the server bundle.",
    "Make sure the build passes on Windows by fixing the path separators in the module loader.",
    "Verify with the test suite that the payment ledger never double-charges after a retry, and redesign the retry path if it does.",
    "Check that the CI build is green on all three platforms after migrating the database layer.",
    "Report which endpoints leak personal data and patch each of them.",
    "Run the load test against the staging cluster and find the cause of the p99 latency regression.",
  ])("keeps %j", (s) => {
    expect(isBoilerplate(s)).toBe(false);
  });

  it("leaves out a boilerplate clause and keeps the rest of the statement", () => {
    expect(withoutBoilerplate("Fix the parser; run the tests.")).toBe("Fix the parser");
    expect(
      withoutBoilerplate("Implement the cache, then run npm test and report the counts."),
    ).toBe("Implement the cache");
    expect(
      withoutBoilerplate(
        "Record baseline numbers for the built-in set using the eval harness, then post them to blackboard key baseline-eval.",
      ),
    ).toBe("Record baseline numbers for the built-in set using the eval harness");
    const work = "Refactor the store, then wire it through the CLI.";
    expect(withoutBoilerplate(work)).toBe(work);
  });

  it("stays fast on long text that almost matches", () => {
    const near = [
      `Run the ${"a ".repeat(190)}tests`,
      `${"typecheck, lint, ".repeat(22)}deploy`,
      `Verify ${"the tests and ".repeat(28)}green`,
      `Post ${"x ".repeat(190)} to the blackboard`,
    ];
    const t0 = performance.now();
    for (const s of near) withoutBoilerplate(s);
    splitUnits(near.join("\n").repeat(3));
    expect(performance.now() - t0).toBeLessThan(250);
  });
});

describe("splitUnits", () => {
  it("keeps the first statement even when it is boilerplate", () => {
    const s = splitUnits(
      "Run the tests and report the counts\nRun npm run lint.\nReport the numbers.",
    );
    expect(s.units).toEqual(["Run the tests and report the counts"]);
    expect(s.dropped).toBe(2);
  });

  it("counts a repeated statement once", () => {
    expect(splitUnits("Add a retry\nCache the result.\ncache  the result.").units).toEqual([
      "Add a retry",
      "Cache the result.",
    ]);
  });

  it(`makes at most UNIT_MAX (${UNIT_MAX}) units and joins every later statement into the last`, () => {
    const text = [
      "Add the field",
      ...Array.from({ length: 49 }, (_, i) => `Step ${i} adds a field.`),
    ];
    const s = splitUnits(text.join("\n"));
    expect(s.units).toHaveLength(UNIT_MAX);
    expect(s.skipped).toBe(50 - UNIT_MAX);
    expect(s.units[0]).toBe("Add the field");
    // Nothing is left out (review #109 F1): the tail is the statements from UNIT_MAX − 1 on.
    expect(s.tail).toEqual(text.slice(UNIT_MAX - 1));
    expect(s.units[UNIT_MAX - 1]).toBe(s.tail.join("\n"));
    const fits = splitUnits(text.slice(0, UNIT_MAX).join("\n"));
    expect(fits).toMatchObject({ skipped: 0, tail: [] });
    expect(fits.units).toEqual(text.slice(0, UNIT_MAX));
  });
});

describe("scoreUnits", () => {
  it("scores a one-statement text exactly as the whole-text scorer does", () => {
    for (const [text, h] of [
      ["refactor the storage layer across every adapter and migration", undefined],
      ["Fix the typo in the README", hints("coder")],
      ["Write integration tests for the new migration path", hints("tester", 4, 2)],
      ["", undefined],
    ] as const) {
      const u = unitSet(text, h);
      expect(u.set).toEqual(whole(text, h));
      expect(u.features).toEqual(extractFeatures(text, h));
      expect(u.units).toMatchObject({ dropped: 0, skipped: 0, winner: 0 });
      expect(u.units.scored).toBe(text ? 1 : 0);
    }
  });

  it("takes complexity, tier, effort and reasons from the hardest statement", () => {
    const text =
      "Rename the flag\nRedesign the storage layer across every adapter and service.\nUpdate the docs.";
    const u = unitSet(text);
    const parts = splitUnits(text).units.map((s) => whole(s));
    const best = parts[1] as ScoreSet;
    expect(Math.max(...parts.map((p) => p.complexity))).toBe(best.complexity);
    expect(u.units.winner).toBe(1);
    expect(u.set.complexity).toBe(best.complexity);
    expect(u.set.complexityReasons).toEqual(best.complexityReasons);
    expect(u.set.tier).toEqual(best.tier);
    expect(u.set.effort).toBe(best.effort);
  });

  it("sums the role and tool votes over the statements", () => {
    const text =
      "Add a retry to the fetch helper\nAdd a timeout to the fetch helper.\nWrite unit tests for both.";
    const u = unitSet(text, hints("coder"));
    expect(u.set.role.choice).toBe("coder");
    const coder = u.set.role.entries.find((e) => e.option === "coder");
    expect(coder?.reasons.some((r) => r.note === "role assigned by the plan (3 statements)")).toBe(
      true,
    );
    expect(u.units.roleConfidence).toBe(Math.round(u.set.role.confidence * 100) / 100);
    const total = u.set.role.entries.reduce((s, e) => s + e.score, 0);
    expect(total).toBeCloseTo(1, 9);
  });

  it("keeps the planned role against the verification steps a brief ends with (F1)", () => {
    for (const brief of [BRIEF_95, BRIEF_100]) {
      const u = unitSet(brief, hints("coder"));
      expect(u.set.role.choice).toBe("coder");
      expect(u.units.dropped).toBeGreaterThan(0);
      expect(u.set.complexity).toBeLessThan(whole(brief, hints("coder")).complexity);
    }
    const short =
      "Add a retry to the fetch helper\nRun npm run typecheck, lint and the adjudicator tests. Report the exact counts.";
    const u = unitSet(short, hints("coder"));
    expect(u.units).toMatchObject({ scored: 1, dropped: 2 });
    expect(u.set.role.choice).toBe("coder");
  });

  it("is not moved by appended boilerplate, a repeated detail or reordered statements", () => {
    for (const brief of BRIEFS)
      for (const h of [undefined, hints("coder")]) {
        const base = unitSet(brief, h);
        const appended = unitSet(`${brief}\n${BOILERPLATE_TAIL}`, h);
        expect(appended.set).toEqual(base.set);
        const repeated = `${brief}\n${detailOf(brief)}`;
        expect(repeated.length).toBeLessThan(UNIT_CHARS);
        expect(unitSet(repeated, h).set).toEqual(base.set);
        const shuffled = [titleOf(brief), ...statements(detailOf(brief)).reverse()].join("\n");
        expect(decisions(unitSet(shuffled, h).set)).toEqual(decisions(base.set));
      }
  });

  it("reports `saturated` when the whole text sums past the clamp its hardest statement stays under", () => {
    const u = unitSet(BRIEF_WIDE, hints("architect", 6, 2));
    expect(u.units.sum).toBeGreaterThan(SATURATED_AT);
    expect(u.units.saturated).toBe(true);
    expect(u.set.complexity).toBeLessThan(4);
    const small = unitSet("Rename the flag\nUpdate the docs.", hints("coder"));
    expect(small.units.saturated).toBe(false);
  });

  it("keeps a long brief whose hardest statement is small below opus, however much it adds up to", () => {
    const small = `${SMALL.join("\n")}\n${BOILERPLATE_TAIL}`;
    const many = [
      "Add the field",
      ...Array.from({ length: 60 }, (_, i) => `Step ${i} adds a field to the config.`),
    ];
    for (const h of [undefined, hints("coder")]) {
      for (const text of [small, many.join("\n")]) {
        const u = unitSet(text, h);
        expect(u.set.tier.choice).not.toBe("opus");
        expect(u.set.complexity).toBeLessThan(2.47);
      }
    }
    // Sixty-one lines pass UNIT_MAX and say so; the ones past it are scored one by one, not dropped.
    const capped = unitSet(many.join("\n")).units;
    expect(capped).toMatchObject({ scored: many.length, skipped: many.length - UNIT_MAX });
  });

  it("still reaches opus when one statement of a long brief is genuinely hard (no under-tiering)", () => {
    expect(unitSet(HARD).set.tier.choice).toBe("opus");
    const at = (i: number) => [...SMALL.slice(0, i), HARD, ...SMALL.slice(i)].join("\n");
    for (const h of [undefined, hints("coder")])
      for (const i of [0, 3, SMALL.length]) {
        for (const text of [
          at(i),
          `${at(i)}\n${BOILERPLATE_TAIL}`,
          `${BOILERPLATE_TAIL}\n${at(i)}`,
        ]) {
          const u = unitSet(text, h);
          expect(u.set.tier.choice).toBe("opus");
          expect(u.set.complexity).toBe(unitSet(HARD, h).set.complexity);
          expect(u.set.effort).toBe(unitSet(HARD, h).set.effort);
          if (text.includes(BOILERPLATE_TAIL)) expect(u.units.dropped).toBeGreaterThan(0);
          else expect(u.units.dropped).toBe(0);
        }
      }
    // The hard statement is found anywhere inside the first UNIT_MAX statements.
    const filler = Array.from(
      { length: UNIT_MAX - 2 },
      (_, i) => `Step ${i} adds a field to the config.`,
    );
    const last = unitSet(["Add the field", ...filler, HARD].join("\n"));
    expect(last.units).toMatchObject({ scored: UNIT_MAX, skipped: 0, winner: UNIT_MAX - 1 });
    expect(last.set.tier.choice).toBe("opus");
  });

  it("finds the hard statement past UNIT_MAX: a file list no longer hides it (review #109 F1)", () => {
    const hard =
      "Migrate the session store from memory to SQLite across every adapter, with a schema migration and rollback, and audit the auth flow for security regressions.";
    const files = Array.from({ length: 40 }, (_, n) => `- src/feature/part${n}.ts`);
    const text = `Session storage work\nFiles in scope:\n${files.join("\n")}\n${hard}`;
    for (const h of [undefined, hints("coder")]) {
      const u = unitSet(text, h);
      expect(u.units.skipped).toBe(3);
      expect(u.set.tier.choice).toBe("opus");
      expect(u.set.complexity).toBe(unitSet(hard, h).set.complexity);
      expect(u.set.effort).toBe(unitSet(hard, h).set.effort);
    }
  });

  it("scores the statements past the cap on their own: joined they would add up, or dilute", () => {
    const filler = Array.from(
      { length: UNIT_MAX - 2 },
      (_, i) => `Step ${i} adds a field to the config.`,
    );
    const capped = (tail: string[]) => unitSet(["Add the field", ...filler, ...tail].join("\n"));
    // Joined, these four sum to opus; each alone is sonnet at most.
    const adds = [
      "Add a retry to the fetch helper.",
      "Write unit tests for the parser.",
      "Review the auth flow.",
      "Plan the rollout.",
    ];
    expect(whole(adds.join("\n")).tier.choice).toBe("opus");
    const best = Math.max(...adds.map((t) => whole(t).complexity));
    const u = capped(adds);
    expect(u.set.complexity).toBe(best);
    expect(u.set.tier.choice).toBe("sonnet");
    expect(u.units).toMatchObject({ scored: UNIT_MAX - 1 + adds.length, skipped: adds.length - 1 });
    expect(u.units.winner).toBeGreaterThanOrEqual(UNIT_MAX - 1);
    // Joined, small edits pull a design statement down (edit_small weighs negative); alone not.
    const design = "Design the new cache.";
    const renames = Array.from({ length: 6 }, (_, i) => `Item ${i} renames a flag.`);
    expect(whole([design, ...renames].join("\n")).complexity).toBeLessThan(
      whole(design).complexity,
    );
    expect(capped([design, ...renames]).set.complexity).toBe(whole(design).complexity);
  });

  it("bounds the work on a very long tail: at most UNIT_MAX runs of it are scored", () => {
    const filler = Array.from({ length: UNIT_MAX - 2 }, (_, i) => `Step ${i} adds a field.`);
    const tail = [
      "Design the new cache.",
      ...Array.from({ length: 3 * UNIT_MAX }, (_, i) => `Item ${i} renames a flag.`),
    ];
    const u = unitSet(["Add the field", ...filler, ...tail].join("\n"));
    expect(u.units.skipped).toBe(tail.length - 1);
    expect(u.units.scored).toBeLessThanOrEqual(2 * UNIT_MAX - 1);
    expect(u.units.winner).toBe(UNIT_MAX - 1);
    expect(u.set.tier.choice).toBe(whole("Design the new cache.").tier.choice);
  });

  it("keeps a check-verb statement that carries the work, and its tier (review #109 F2)", () => {
    const work =
      "Make sure the build passes on Windows by rewriting the path handling in the module loader, the sandbox and the graph indexer.";
    const u = unitSet(`Windows support\n${work}`);
    expect(u.units).toMatchObject({ scored: 2, dropped: 0, winner: 1 });
    expect(u.set.tier.choice).toBe("opus");
    expect(u.set.complexity).toBe(whole(work).complexity);
  });

  it("never rates a brief below its hardest statement alone, whatever surrounds it", () => {
    for (const brief of [...BRIEFS, [...SMALL, HARD].join("\n")])
      for (const h of [undefined, hints("coder")]) {
        const u = unitSet(brief, h);
        for (const part of splitUnits(brief).units) {
          const p = whole(part, h);
          expect(u.set.complexity).toBeGreaterThanOrEqual(p.complexity);
          expect(tierRank(u.set)).toBeGreaterThanOrEqual(tierRank(p));
        }
      }
  });

  it("does not hide a hard statement behind boilerplate wording", () => {
    // A hard sentence that also mentions tests must not be taken for a verification step.
    const hard =
      "Redesign the storage layer across every adapter, then run the tests and report the counts.";
    expect(isBoilerplate(hard)).toBe(false);
    expect(withoutBoilerplate(hard)).toMatch(/Redesign the storage layer across every adapter/);
    expect(unitSet(`${SMALL.join("\n")}\n${hard}`).set.complexity).toBeGreaterThan(
      unitSet(SMALL.join("\n")).set.complexity,
    );
  });

  it("scores a full-length brief in a few milliseconds", () => {
    const text = `${BRIEF_100}\n${BRIEF_95}\n${BRIEF_WIDE}`.slice(0, UNIT_CHARS);
    unitSet(text, hints("coder"));
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) unitSet(text, hints("coder"));
    expect((performance.now() - t0) / 20).toBeLessThan(25);
  });
});

describe("briefUnitsOf", () => {
  it("reads `units` back from a row's scores JSON and rejects anything else", () => {
    const { units } = unitSet(BRIEF_100, hints("coder"));
    expect(briefUnitsOf(JSON.stringify({ complexity: 3, units }))).toEqual(units);
    expect(briefUnitsOf(undefined)).toBeUndefined();
    expect(briefUnitsOf("not json")).toBeUndefined();
    expect(briefUnitsOf(JSON.stringify({ complexity: 3 }))).toBeUndefined();
    expect(briefUnitsOf(JSON.stringify({ units: { ...units, saturated: "yes" } }))).toBeUndefined();
    expect(briefUnitsOf(JSON.stringify({ units: { ...units, sum: null } }))).toBeUndefined();
  });
});

describe("engine: briefs are scored per statement", () => {
  let dir: string;
  const adapters: SqliteAdapter[] = [];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "em-adj-units-"));
    process.env.EMINIAR_HOME = dir;
  });
  afterEach(() => {
    for (const a of adapters.splice(0)) a.close();
    delete process.env.EMINIAR_HOME;
  });

  const cfg = (over: Record<string, unknown> = {}): AdjudicatorConfig =>
    ConfigSchema.parse({ adjudicator: { enabled: true, provider: "heuristic", ...over } })
      .adjudicator;
  const weightsOf = (c: AdjudicatorConfig) => ({
    tierCenters: c.weights.tierCenters,
    features: c.weights.features,
  });
  const engine = (c: AdjudicatorConfig, o: Partial<EngineOptions> = {}): EngineOptions => ({
    config: c,
    provider: null,
    ...o,
  });

  it("plan and agent requests carry `units`; prompts are scored as one text", async () => {
    const c = cfg();
    for (const surface of ["plan", "agent"] as const) {
      expect(unitScored(surface)).toBe(true);
      const a = await adjudicateOne(
        { key: "k", surface, text: BRIEF_100, hints: hints("coder") },
        engine(c),
      );
      const u = scoreUnits(BRIEF_100, hints("coder"), weightsOf(c), {
        tiers: c.tiers,
        roles: ROLES,
      });
      expect(a.units).toEqual(u.units);
      expect(a.verdict.complexity).toBe(u.set.complexity);
      expect(a.verdict.heuristicComplexity).toBe(u.set.complexity);
      expect(a.verdict.role.choice).toBe(u.set.role.choice);
      expect(a.features).toEqual(extractFeatures(BRIEF_100, hints("coder")));
    }
    expect(unitScored("prompt")).toBe(false);
    const p = await adjudicateOne({ key: "k", surface: "prompt", text: BRIEF_100 }, engine(c));
    expect(p.units).toBeUndefined();
    expect(p.verdict.complexity).toBe(
      scoreHeuristic(extractFeatures(BRIEF_100), weightsOf(c), { tiers: c.tiers }).complexity,
    );
  });

  it("units: false scores a brief as one text", async () => {
    const c = cfg();
    const a = await adjudicateOne(
      { key: "k", surface: "plan", text: BRIEF_100, hints: hints("coder") },
      engine(c, { units: false }),
    );
    expect(a.units).toBeUndefined();
    expect(a.verdict.complexity).toBe(
      scoreHeuristic(extractFeatures(BRIEF_100, hints("coder")), weightsOf(c), {
        tiers: c.tiers,
        roles: ROLES,
      }).complexity,
    );
  });

  it("scores prompts (and units: false) over the whole text, so a wide brief rates higher there", async () => {
    const c = cfg();
    const req = { key: "k", text: BRIEF_WIDE, hints: hints("architect") };
    const plan = await adjudicateOne({ ...req, surface: "plan" }, engine(c));
    const prompt = await adjudicateOne({ ...req, surface: "prompt" }, engine(c));
    const flat = await adjudicateOne({ ...req, surface: "plan" }, engine(c, { units: false }));
    const wholeScore = scoreHeuristic(
      extractFeatures(BRIEF_WIDE, hints("architect")),
      weightsOf(c),
      {
        tiers: c.tiers,
        roles: ROLES,
      },
    );
    expect(prompt.verdict.complexity).toBe(wholeScore.complexity);
    expect(flat.verdict.complexity).toBe(wholeScore.complexity);
    expect(plan.units?.saturated).toBe(true);
    expect(plan.verdict.complexity).toBeLessThan(prompt.verdict.complexity);
  });

  it("stores `units` in the row's scores JSON", async () => {
    const db = new SqliteAdapter(join(dir, "eminiar.db"), { vectors: false });
    adapters.push(db);
    const a = await adjudicateOne(
      { key: "k", surface: "plan", text: BRIEF_WIDE, hints: hints("architect") },
      engine(cfg(), { store: db.adjudicator }),
    );
    expect(a.rowId).toBeDefined();
    const row = db.adjudicator.get(a.rowId as number);
    expect(briefUnitsOf(row?.scores)).toEqual(a.units);
    expect(briefUnitsOf(row?.scores)?.saturated).toBe(true);
    expect(row?.complexity).toBe(a.verdict.complexity);
  });

  it("feeds the learned bias the whole text's features and the brief's complexity", async () => {
    const c = cfg({ learning: { enabled: true } });
    let seen: { f: Features; h: ScoreSet } | undefined;
    const a = await adjudicateOne(
      { key: "k", surface: "agent", text: BRIEF_95, hints: hints("coder") },
      engine(c, {
        bias: (_req, f, h) => {
          seen = { f, h };
          return {};
        },
      }),
    );
    expect(seen?.f).toEqual(extractFeatures(BRIEF_95, hints("coder")));
    expect(seen?.h.complexity).toBe(a.verdict.heuristicComplexity);
    expect(a.units?.scored).toBeGreaterThan(1);
  });

  it("keys a brief's cache entry by how it was scored, and leaves prompt keys alone", () => {
    const r = { configured: "typesafe" as const, model: "m" };
    for (const surface of ["plan", "agent"] as const) {
      const req = { surface, text: BRIEF_100 };
      expect(cacheKeyFor(req, r)).not.toBe(cacheKeyFor(req, r, { units: false }));
      expect(cacheKeyFor(req, r, { units: true })).toBe(cacheKeyFor(req, r));
    }
    const prompt = { surface: "prompt" as const, text: BRIEF_100 };
    expect(cacheKeyFor(prompt, r)).toBe(cacheKeyFor(prompt, r, { units: false }));
  });
});
