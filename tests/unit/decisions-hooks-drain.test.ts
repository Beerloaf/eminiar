/**
 * Mutation survivors of the correctness review (task #318): the hook-side wiring of the Jev
 * features that no test drove. The advice note reaches Claude through the UserPromptSubmit and
 * PostToolUse hooks and only once; a hook starts ONE detached job per event across all features;
 * the detached child re-checks the feature gate (consent withdrawn after the job was queued).
 * The feature registry is stubbed so two features share one hook and runJob is observable.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type AdjudicatorConfig, AdjudicatorConfigSchema, ConfigSchema } from "../../src/config.js";
import { getContext, type ProjectContext, resetContextCache } from "../../src/context.js";
import type { DecisionFeatureModule } from "../../src/decisions/feature.js";
import { decisionPreCompact, decisionPreToolUse } from "../../src/decisions/hooks.js";
import { runDecisionJob } from "../../src/decisions/run-job.js";
import type { DecisionCallInput, DecisionFeature } from "../../src/decisions/types.js";
import { postToolUse, userPromptSubmit } from "../../src/hooks/capture.js";
import type { StorageAdapter } from "../../src/storage/adapter.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";

const spawn = vi.hoisted(() => vi.fn(() => true));
vi.mock("../../src/decisions/job.js", async (orig) => ({
  ...(await orig<typeof import("../../src/decisions/job.js")>()),
  spawnDecisionJob: spawn,
}));

const runJob = vi.hoisted(() => vi.fn(async () => {}));
const registry = vi.hoisted(() => ({ hooks: true }));
vi.mock("../../src/decisions/registry.js", () => ({
  FEATURES: {},
  loadFeature: async (f: string): Promise<DecisionFeatureModule | undefined> => {
    if (f !== "commit" && f !== "docs") return undefined;
    const m: DecisionFeatureModule = { questionVersion: 1, runJob };
    if (registry.hooks) {
      m.preToolUse = () => ({ from: f });
      m.preCompact = () => ({ from: f });
    }
    return m;
  },
}));

let home: string;
let root: string;
let db: StorageAdapter;
let base: ProjectContext;

const adjudicator = (features: Record<string, unknown> = {}) => ({
  enabled: true,
  provider: "openai-compatible",
  openai: { preset: "ollama" },
  features: Object.fromEntries(
    Object.entries(features).map(([k, v]) => [k, { enabled: v, shadow: false }]),
  ),
});
const cfg = (features: Record<string, unknown>) =>
  AdjudicatorConfigSchema.parse(adjudicator(features)) as AdjudicatorConfig;
const ctxOf = (a: AdjudicatorConfig): ProjectContext => ({
  ...base,
  config: ConfigSchema.parse({ adjudicator: a }),
});
/** The personal config the hooks and the child read (project files cannot set features). */
function setHomeConfig(features: Record<string, unknown>) {
  writeFileSync(join(home, "config.json"), JSON.stringify({ adjudicator: adjudicator(features) }));
  resetContextCache();
}

const note = (over: Partial<DecisionCallInput> = {}): DecisionCallInput => ({
  ts: Date.now(),
  feature: "commit",
  context: "job",
  subject: "s",
  mode: "live",
  status: "ok",
  applied: true,
  note: "commit advice: check the diff",
  noteSession: "sess",
  ...over,
});

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "em-hd-home-"));
  process.env.EMINIAR_HOME = home;
  process.env.EMINIAR_EMBEDDINGS = "0";
  root = mkdtempSync(join(tmpdir(), "em-hd-"));
  writeFileSync(join(root, "package.json"), "{}");
  mkdirSync(join(root, ".eminiar"), { recursive: true });
  setHomeConfig({ commit: true, docs: true });
  base = getContext(root);
  db = getStorage(base, { vectors: false });
});
afterAll(() => {
  closeAllStorage();
  delete process.env.EMINIAR_HOME;
  delete process.env.EMINIAR_EMBEDDINGS;
});
beforeEach(() => {
  spawn.mockClear();
  runJob.mockClear();
  registry.hooks = true;
  setHomeConfig({ commit: true, docs: true });
  db.decisions.purge();
});

const hookInput = (over: Record<string, unknown> = {}) =>
  ({ cwd: root, session_id: "sess", ...over }) as never;
const ctxText = (r: unknown): string =>
  (r as { hookSpecificOutput?: { additionalContext?: string } } | undefined)?.hookSpecificOutput
    ?.additionalContext ?? "";

describe("one detached job per hook event", () => {
  it("PreToolUse: two features that both queue a job start one process", async () => {
    await decisionPreToolUse(ctxOf(cfg({ commit: true, docs: true })), db, {} as never, "sess");
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("PreCompact: two features that both queue a job start one process", async () => {
    await decisionPreCompact(ctxOf(cfg({ commit: true, docs: true })), db, "sess", 7);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("the second feature is not starved of its own event: each event may spawn once", async () => {
    const c = ctxOf(cfg({ commit: true, docs: true }));
    await decisionPreToolUse(c, db, {} as never, "sess-a");
    await decisionPreToolUse(c, db, {} as never, "sess-b");
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("a feature that is off is not asked, so the other one spawns", async () => {
    await decisionPreToolUse(ctxOf(cfg({ commit: false, docs: true })), db, {} as never, "sess");
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]).toMatchObject([{ feature: "docs" }]);
  });
});

describe("advice notes reach Claude through the hooks, once", () => {
  it("UserPromptSubmit delivers a pending note once", async () => {
    db.decisions.insertCall(note());
    const first = await userPromptSubmit(hookInput({ prompt: "please refactor the parser" }));
    expect(ctxText(first)).toContain("commit advice: check the diff");
    const second = await userPromptSubmit(hookInput({ prompt: "please refactor the parser" }));
    expect(ctxText(second)).not.toContain("commit advice");
  });

  it("PostToolUse delivers a pending note once, as PostToolUse context", async () => {
    db.decisions.insertCall(note({ note: "late advice" }));
    const first = await postToolUse(hookInput({ tool_name: "Read", tool_input: {} }));
    expect(first).toEqual({
      hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "late advice" },
    });
    expect(await postToolUse(hookInput({ tool_name: "Read", tool_input: {} }))).toBeUndefined();
  });

  it("a note queued for another session is not delivered here", async () => {
    db.decisions.insertCall(note({ noteSession: "other" }));
    expect(await postToolUse(hookInput({ tool_name: "Read", tool_input: {} }))).toBeUndefined();
    expect(db.decisions.pendingNotes("other", Date.now())).toHaveLength(1);
  });

  it("with every feature off the hooks do not touch the notes", async () => {
    setHomeConfig({});
    db.decisions.insertCall(note());
    expect(await postToolUse(hookInput({ tool_name: "Read", tool_input: {} }))).toBeUndefined();
    expect(db.decisions.pendingNotes("sess", Date.now())).toHaveLength(1);
  });
});

describe("runDecisionJob re-checks the gate in the child", () => {
  const job = (feature: DecisionFeature = "commit") =>
    JSON.stringify({ v: 1, feature, projectRoot: root, sessionId: "sess", payload: {} });

  it("runs the feature's job while it is on", async () => {
    expect(await runDecisionJob(job(), { db, env: {} })).toEqual({ ok: true });
    expect(runJob).toHaveBeenCalledTimes(1);
  });

  it("a kill switch set after the job was queued stops it before any model call", async () => {
    const r = await runDecisionJob(job(), { db, env: { EMINIAR_ADJUDICATOR_FEATURES: "0" } });
    expect(r).toEqual({ ok: false, reason: "off" });
    expect(runJob).not.toHaveBeenCalled();
    const r2 = await runDecisionJob(job(), { db, env: { EMINIAR_ADJUDICATOR: "0" } });
    expect(r2).toEqual({ ok: false, reason: "off" });
    expect(runJob).not.toHaveBeenCalled();
  });

  it("a feature switched off in the config after the job was queued stops it", async () => {
    setHomeConfig({ docs: true });
    expect(await runDecisionJob(job("commit"), { db, env: {} })).toEqual({
      ok: false,
      reason: "off",
    });
    expect(runJob).not.toHaveBeenCalled();
    expect((await runDecisionJob(job("docs"), { db, env: {} })).ok).toBe(true);
  });

  it("rejects garbage and an unknown feature without running anything", async () => {
    expect(await runDecisionJob("not json", { db, env: {} })).toEqual({
      ok: false,
      reason: "invalid job",
    });
    expect(await runDecisionJob(job("nope" as never), { db, env: {} })).toEqual({
      ok: false,
      reason: "invalid job",
    });
    expect(runJob).not.toHaveBeenCalled();
  });

  it("a feature module without a job handler is reported, and a throwing job never throws", async () => {
    setHomeConfig({ recall: true, commit: true });
    expect(await runDecisionJob(job("recall"), { db, env: {} })).toEqual({
      ok: false,
      reason: "no job handler",
    });
    runJob.mockRejectedValueOnce(new Error("boom"));
    expect(await runDecisionJob(job(), { db, env: {} })).toEqual({ ok: false, reason: "error" });
  });
});
