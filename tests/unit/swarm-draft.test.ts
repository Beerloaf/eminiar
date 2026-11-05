import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderSwarmDoc } from "../../src/swarm/edit.js";
import {
  addRole,
  addSwarm,
  baseNames,
  capacity,
  compactContext,
  contextCount,
  type Draft,
  deleteBlock,
  deleteRole,
  deleteSwarm,
  docEqual,
  docFromTemplate,
  duplicateRole,
  duplicateSwarm,
  getIn,
  isLocked,
  issuesByField,
  issuesUnder,
  lockedInside,
  missingStages,
  modelPolicy,
  moveStage,
  nameProblem,
  rangeProblem,
  rawEntry,
  renameRole,
  renameSwarm,
  type SwarmDoc,
  setIn,
  studioDirty,
  tierOf,
  tierSpan,
  toolsSummary,
  uniqueName,
  withPolicy,
} from "../../src/ui/web/swarm/config/draft.js";

const doc = (): SwarmDoc => ({
  version: 1,
  enabled: true,
  defaults: { model: "sonnet", model_range: { floor: "haiku", ceiling: "opus" } },
  swarms: {
    feature: {
      description: "Build features.",
      topology: "pipeline",
      max_agents: 3,
      stages: ["architect", "coder", "tester"],
      agents: {
        architect: { description: "Designs.", model: "opus" },
        coder: { description: "Codes.", count: 2 },
        tester: { description: "Tests.", model: "haiku", model_range: {} },
      },
    },
    review: {
      description: "Review.",
      agents: { correctness: { description: "Finds bugs." } },
    },
  },
});

const draftOf = (d: SwarmDoc): Draft => ({ doc: d, renames: [] });

describe("setIn / getIn", () => {
  it("copies every map on the path and leaves the input untouched", () => {
    const a = doc();
    const before = JSON.stringify(a);
    const b = setIn(a, ["swarms", "feature", "max_agents"], 5);
    expect(JSON.stringify(a)).toBe(before);
    expect(b.swarms.feature!.max_agents).toBe(5);
    expect(b.swarms.review).toBe(a.swarms.review);
    expect(b.swarms.feature!.agents).toBe(a.swarms.feature!.agents);
  });
  it("creates missing maps and removes a key set to undefined, keeping key order", () => {
    const a = doc();
    const b = setIn(a, ["swarms", "review", "context", "memories"], 3);
    expect(getIn(b, ["swarms", "review", "context", "memories"])).toBe(3);
    const c = setIn(b, ["swarms", "feature", "topology"], undefined);
    expect("topology" in c.swarms.feature!).toBe(false);
    expect(Object.keys(c.swarms.feature!)).toEqual([
      "description",
      "max_agents",
      "stages",
      "agents",
    ]);
  });
  it("getIn returns undefined through a missing or scalar step", () => {
    expect(getIn(doc(), ["swarms", "nope", "agents"])).toBeUndefined();
    expect(getIn(doc(), ["version", "x"])).toBeUndefined();
  });
});

describe("docEqual", () => {
  it("treats a key holding undefined as absent", () => {
    expect(docEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(docEqual({ a: [1, { x: undefined }] }, { a: [1, {}] })).toBe(true);
  });
  it("tells apart arrays, order of items and values", () => {
    expect(docEqual({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
    expect(docEqual({ a: {} }, { a: [] })).toBe(false);
    expect(docEqual({ a: 1 }, { a: "1" })).toBe(false);
    expect(docEqual(doc(), doc())).toBe(true);
  });
});

describe("names", () => {
  it("nameProblem mirrors the schema's name rule and catches duplicates", () => {
    expect(nameProblem("code-review")).toBeUndefined();
    expect(nameProblem("")).toMatch(/required/);
    expect(nameProblem("Code")).toMatch(/lowercase/);
    expect(nameProblem("a--b")).toMatch(/lowercase/);
    expect(nameProblem("1a")).toMatch(/lowercase/);
    expect(nameProblem("a".repeat(33))).toMatch(/32/);
    expect(nameProblem("coder", ["coder"])).toMatch(/already used/);
  });
  it("uniqueName sanitises and numbers", () => {
    expect(uniqueName("Code Review!", [])).toBe("code-review");
    expect(uniqueName("coder", ["coder"])).toBe("coder-2");
    expect(uniqueName("coder", ["coder", "coder-2"])).toBe("coder-3");
    expect(uniqueName("123", [])).toBe("swarm");
    const long = uniqueName("a".repeat(40), ["a".repeat(32)]);
    expect(long.length).toBeLessThanOrEqual(32);
    expect(nameProblem(long)).toBeUndefined();
  });
});

describe("renames", () => {
  it("renames a swarm in place and records it against the file", () => {
    const base = doc();
    const d = renameSwarm(draftOf(base), base, "review", "audit");
    expect(Object.keys(d.doc.swarms)).toEqual(["feature", "audit"]);
    expect(d.renames).toEqual([{ swarm: "review", to: "audit" }]);
    // A second rename names the swarm as the first one left it.
    const e = renameSwarm(d, base, "audit", "check");
    expect(e.renames).toEqual([
      { swarm: "review", to: "audit" },
      { swarm: "audit", to: "check" },
    ]);
    expect(baseNames(base, e.renames).has("check")).toBe(true);
  });
  it("does not record a rename of a swarm the file does not have, or onto a name it has", () => {
    const base = doc();
    const added = draftOf(addSwarm(base, "fresh", { description: "x", agents: {} }));
    expect(renameSwarm(added, base, "fresh", "newer").renames).toEqual([]);
    const deleted = draftOf(deleteSwarm(base, "review"));
    const r = renameSwarm(deleted, base, "feature", "review");
    expect(Object.keys(r.doc.swarms)).toEqual(["review"]);
    expect(r.renames).toEqual([]);
  });
  it("renames a role, its stage entry, and records it", () => {
    const base = doc();
    const d = renameRole(draftOf(base), base, "feature", "coder", "builder");
    const s = d.doc.swarms.feature!;
    expect(Object.keys(s.agents)).toEqual(["architect", "builder", "tester"]);
    expect(s.stages).toEqual(["architect", "builder", "tester"]);
    expect(d.renames).toEqual([{ swarm: "feature", role: "coder", to: "builder" }]);
  });
  it("records a role rename inside a renamed swarm under the swarm's new name", () => {
    const base = doc();
    let d = renameSwarm(draftOf(base), base, "feature", "build");
    d = renameRole(d, base, "build", "coder", "dev");
    expect(d.renames).toEqual([
      { swarm: "feature", to: "build" },
      { swarm: "build", role: "coder", to: "dev" },
    ]);
  });
  it("is a no-op for an unknown name or the same name", () => {
    const base = doc();
    const d = draftOf(base);
    expect(renameSwarm(d, base, "nope", "x")).toBe(d);
    expect(renameRole(d, base, "feature", "coder", "coder")).toBe(d);
  });
});

describe("swarm and role operations", () => {
  it("duplicates a swarm as a deep copy", () => {
    const a = duplicateSwarm(doc(), "review", "review-copy");
    expect(a.swarms["review-copy"]).toEqual(a.swarms.review);
    expect(a.swarms["review-copy"]).not.toBe(a.swarms.review);
  });
  it("adds a role to a pipeline's stages and removes it with its stage", () => {
    let a = addRole(doc(), "feature", "docs");
    expect(a.swarms.feature!.stages).toEqual(["architect", "coder", "tester", "docs"]);
    expect(a.swarms.feature!.agents.docs!.description).toBeTruthy();
    a = deleteRole(a, "feature", "coder");
    expect(a.swarms.feature!.stages).toEqual(["architect", "tester", "docs"]);
    expect(Object.keys(a.swarms.feature!.agents)).toEqual(["architect", "tester", "docs"]);
  });
  it("adds a role to a non-pipeline swarm without inventing stages", () => {
    const a = addRole(doc(), "review", "security");
    expect(a.swarms.review!.stages).toBeUndefined();
  });
  it("duplicates a role", () => {
    const a = duplicateRole(doc(), "feature", "tester", "tester-2");
    expect(a.swarms.feature!.agents["tester-2"]).toEqual(a.swarms.feature!.agents.tester);
  });
  it("moves stages and lists the roles they leave out", () => {
    expect(moveStage(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
    expect(moveStage(["a", "b", "c"], 2, -1)).toEqual(["a", "c", "b"]);
    expect(moveStage(["a", "b"], 0, -1)).toEqual(["a", "b"]);
    const s = { ...doc().swarms.feature!, stages: ["coder"] };
    expect(missingStages(s)).toEqual(["architect", "tester"]);
  });
  it("builds a new file from a template", () => {
    const d = docFromTemplate("team", doc().swarms.review!);
    expect(d).toMatchObject({ version: 1, enabled: true, sync: "auto" });
    expect(Object.keys(d.swarms)).toEqual(["team"]);
  });
});

describe("capacity", () => {
  it("sums counts (default 1) against max_agents (default 4)", () => {
    expect(capacity(doc().swarms.feature!)).toEqual({ total: 4, max: 3, over: true });
    expect(capacity(doc().swarms.review!)).toEqual({ total: 1, max: 4, over: false });
  });
});

describe("issues and locked paths", () => {
  const issues = [
    { path: "swarms.feature.agents.coder.model", message: "a" },
    { path: "swarms.feature.agents.coder.model", message: "b" },
    { path: "swarms.feature.agents.coderx.tools", message: "c" },
    { path: "enforce", message: "d" },
  ];
  it("groups messages by path", () => {
    const m = issuesByField(issues);
    expect(m.get("swarms.feature.agents.coder.model")).toEqual(["a", "b"]);
    expect(m.get("enforce")).toEqual(["d"]);
  });
  it("matches a prefix on whole path segments only", () => {
    expect(issuesUnder(issues, "swarms.feature.agents.coder")).toHaveLength(2);
    expect(issuesUnder(issues, "swarms.feature")).toHaveLength(3);
    expect(issuesUnder(issues, "")).toHaveLength(4);
  });
  it("deleteBlock refuses a node that is, or holds, a locked anchor or alias", () => {
    const locked = ["swarms.alpha.agents.coder", "swarms.beta.agents.coder.model"];
    expect(deleteBlock(locked, "swarms.alpha")).toMatch(/shared/);
    expect(deleteBlock(locked, "swarms.beta.agents.coder")).toMatch(/shared/);
    expect(deleteBlock(locked, "swarms.alpha.agents.coder")).toMatch(/alias, anchor/);
    expect(deleteBlock(locked, "swarms.gamma")).toBeUndefined();
  });

  it("deleteBlock blames a role's hooks, not a shared anchor", () => {
    const locked = ["swarms.feature.agents.coder.hooks", "swarms.feature.agents.ui.hooks"];
    expect(deleteBlock(locked, "swarms.feature.agents.coder")).toBe(
      "this role has hooks, which are edited in raw YAML",
    );
    expect(deleteBlock(locked, "swarms.feature")).toMatch(/a role in it has hooks/);
    expect(deleteBlock(locked, "swarms.feature.agents.tester")).toBeUndefined();
    // a hooks lock mixed with a real anchor still reports the shared anchor
    const mixed = [...locked, "swarms.feature.agents.coder.model"];
    expect(deleteBlock(mixed, "swarms.feature.agents.coder")).toMatch(/shared/);
  });

  it("isLocked covers the path and everything inside; lockedInside the reverse", () => {
    const locked = ["swarms.feature.agents.coder.hooks", "x-base"];
    expect(isLocked(locked, "swarms.feature.agents.coder.hooks")).toBe(true);
    expect(isLocked(locked, "swarms.feature.agents.coder.hooks.PostToolUse")).toBe(true);
    expect(isLocked(locked, "swarms.feature.agents.coder")).toBe(false);
    expect(isLocked(locked, "x-based")).toBe(false);
    expect(lockedInside(locked, "swarms.feature.agents.coder")).toBe(true);
    expect(lockedInside(locked, "swarms.feature.agents.tester")).toBe(false);
  });
});

describe("model policy", () => {
  it("reads tiers from aliases and model ids", () => {
    expect(tierOf("opus")).toBe("opus");
    expect(tierOf("sonnet[1m]")).toBe("sonnet");
    expect(tierOf("claude-haiku-4-5")).toBe("haiku");
    expect(tierOf("us.anthropic.claude-opus-4-1")).toBe("opus");
    expect(tierOf("opusplan")).toBeUndefined();
    expect(tierOf("inherit")).toBeUndefined();
    expect(tierOf(undefined)).toBeUndefined();
  });
  it("tells pinned, own-range and default-range roles apart", () => {
    const d = doc();
    const a = d.swarms.feature!.agents;
    expect(modelPolicy(d, a.architect!)).toMatchObject({
      mode: "default",
      model: "opus",
      modelFrom: "role",
      floor: "haiku",
      ceiling: "opus",
    });
    expect(modelPolicy(d, a.coder!)).toMatchObject({
      mode: "default",
      model: "sonnet",
      modelFrom: "defaults",
    });
    expect(modelPolicy(d, a.tester!)).toMatchObject({
      mode: "pin",
      model: "haiku",
      floor: undefined,
    });
    const own = { description: "x", model: "sonnet", model_range: { ceiling: "fable" as const } };
    // An unset bound is the fallback's tier.
    expect(modelPolicy(d, own)).toMatchObject({ mode: "range", floor: "sonnet", ceiling: "fable" });
    const plain: SwarmDoc = { swarms: {} };
    expect(modelPolicy(plain, { description: "x" })).toMatchObject({
      mode: "pin",
      modelFrom: "none",
    });
  });
  it("switches policy: pin writes {} against a default range, nothing without one", () => {
    const d = doc();
    const coder = d.swarms.feature!.agents.coder!;
    expect(withPolicy(d, coder, "pin").model_range).toEqual({});
    expect("model_range" in withPolicy(d, d.swarms.feature!.agents.tester!, "default")).toBe(false);
    expect(withPolicy(d, coder, "range").model_range).toEqual({ floor: "haiku", ceiling: "opus" });
    const plain: SwarmDoc = { swarms: {} };
    const r = { description: "x", model: "opus", model_range: { floor: "sonnet" as const } };
    expect("model_range" in withPolicy(plain, r, "pin")).toBe(false);
    // A new range without a default spans one tier either side of the fallback.
    expect(withPolicy(plain, { description: "x", model: "sonnet" }, "range").model_range).toEqual({
      floor: "haiku",
      ceiling: "opus",
    });
    expect(withPolicy(plain, { description: "x", model: "fable" }, "range").model_range).toEqual({
      floor: "opus",
      ceiling: "fable",
    });
  });
  it("rangeProblem mirrors roleRange: the fallback must lie inside the range", () => {
    expect(rangeProblem("sonnet", { floor: "haiku", ceiling: "opus" })).toBeUndefined();
    expect(rangeProblem("sonnet", {})).toBeUndefined();
    expect(rangeProblem("haiku", { floor: "sonnet" })).toMatch(/below the floor sonnet/);
    expect(rangeProblem("fable", { ceiling: "opus" })).toMatch(/above the ceiling opus/);
    expect(rangeProblem("sonnet", { floor: "opus", ceiling: "haiku" })).toMatch(
      /floor must not be above/,
    );
    expect(rangeProblem(undefined, { floor: "haiku" })).toMatch(/fallback model/);
    expect(rangeProblem("inherit", { floor: "haiku" })).toMatch(/inherit/);
    expect(rangeProblem("opusplan", { floor: "haiku" })).toMatch(/no single tier/);
  });
  it("tierSpan lists the tiers of a range", () => {
    expect(tierSpan("haiku", "opus")).toEqual(["haiku", "sonnet", "opus"]);
    expect(tierSpan("opus", "opus")).toEqual(["opus"]);
    expect(tierSpan(undefined, "opus")).toEqual([]);
  });
});

describe("tools and context", () => {
  it("summarises tools for a card", () => {
    expect(toolsSummary({ description: "x" })).toBe("all tools");
    expect(
      toolsSummary({ description: "x", disallowed_tools: ["Edit", "Write", "NotebookEdit"] }),
    ).toBe("read-only");
    expect(toolsSummary({ description: "x", tools: ["Read"] })).toBe("1 tool");
    expect(toolsSummary({ description: "x", disallowed_tools: ["Bash", "WebFetch", "Task"] })).toBe(
      "all but Bash, WebFetch…",
    );
  });
  it("compacts context overrides", () => {
    expect(compactContext({ memories: undefined })).toBeUndefined();
    expect(compactContext({ memories: 2, docs: undefined })).toEqual({ memories: 2 });
    expect(contextCount({ memories: 2, history: false, docs: undefined })).toBe(2);
  });
});

describe("renames against the real renderer", () => {
  // Read-only: the project's own swarm file is the base text, never written.
  const text = readFileSync(join(process.cwd(), ".eminiar/swarm.yaml"), "utf8");
  const exists = text.includes("swarms:");
  it.runIf(exists)(
    "a recorded role rename keeps the role's comment and renders valid",
    async () => {
      const Y = await import("yaml");
      const base = Y.parse(text, { merge: true }) as SwarmDoc;
      const swarm = Object.keys(base.swarms)[0]!;
      const role = Object.keys(base.swarms[swarm]!.agents).find((r) =>
        text.split("\n").some((l) => l.trim().startsWith(`${r}:`) && /#/.test(l) === false),
      )!;
      const d = renameRole(draftOf(base), base, swarm, role, `${role}-x`);
      expect(d.renames).toHaveLength(1);
      const r = renderSwarmDoc(text, d.doc, d.renames);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.result.state).toBe("ok");
      expect(r.text).toContain(`${role}-x:`);
      // Every comment of the file survives a rename (trailing ones may be re-aligned).
      const comments = (t: string) =>
        t
          .split("\n")
          .map((l) => /(?:^|\s)#\s?(.*)$/.exec(l)?.[1]?.trim())
          .filter((c): c is string => !!c);
      for (const c of comments(text)) expect(r.text).toContain(c);
    },
  );
  it.runIf(exists)("an unchanged draft renders byte-identical", async () => {
    const Y = await import("yaml");
    const base = Y.parse(text, { merge: true }) as SwarmDoc;
    const r = renderSwarmDoc(text, structuredClone(base), []);
    expect(r.ok && r.text).toBe(text);
  });
});

describe("unsaved work", () => {
  it("studioDirty counts the visual draft kept under raw mode", () => {
    expect(studioDirty({ raw: null, baseText: "a", visual: false })).toBe(false);
    expect(studioDirty({ raw: null, baseText: "a", visual: true })).toBe(true);
    expect(studioDirty({ raw: "a", baseText: "a", visual: false })).toBe(false);
    expect(studioDirty({ raw: "b", baseText: "a", visual: false })).toBe(true);
    // The raw text equals the file, but the form edits are still kept: still dirty.
    expect(studioDirty({ raw: "a", baseText: "a", visual: true })).toBe(true);
    expect(studioDirty({ raw: "", baseText: null, visual: false })).toBe(false);
  });

  it("rawEntry never opens a render that predates the draft without asking", () => {
    const e = (s: Partial<Parameters<typeof rawEntry>[0]>) =>
      rawEntry({ dirty: true, current: true, conflict: false, ...s });
    expect(e({ dirty: false, current: false, conflict: true })).toEqual({ kind: "base" });
    expect(e({})).toEqual({ kind: "render" });
    // Debounce or request in flight, or a failure of an older draft: render first.
    expect(e({ current: false })).toEqual({ kind: "wait" });
    expect(e({ current: false, failure: "render" })).toEqual({ kind: "wait" });
    expect(e({ failure: "render" })).toEqual({ kind: "stale", reason: "render" });
    expect(e({ failure: "error" })).toEqual({ kind: "stale", reason: "error" });
    expect(e({ conflict: true })).toEqual({ kind: "stale", reason: "conflict" });
    expect(e({ current: false, conflict: true })).toEqual({ kind: "stale", reason: "conflict" });
  });
});
