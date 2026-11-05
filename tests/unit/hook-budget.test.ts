import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getContext, resetContextCache } from "../../src/context.js";
import {
  budgetFor,
  budgetLeft,
  clearBudget,
  HOOK_BUDGET_MS,
  hasBudget,
  startBudget,
} from "../../src/hooks/budget.js";
import { dispatch, ranLate } from "../../src/hooks/dispatch.js";
import { handlers } from "../../src/hooks/index.js";
import type { HookHandler, HookInput, HookOutput } from "../../src/hooks/types.js";
import { write } from "../../src/memory/store.js";
import { closeAllStorage, getStorage, setStorageBusyTimeout } from "../../src/storage/index.js";

let root: string;
const ctxText = (out: HookOutput | undefined) => out?.hookSpecificOutput?.additionalContext ?? "";

beforeAll(() => {
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-home-"));
  root = mkdtempSync(join(tmpdir(), "em-budget-"));
  writeFileSync(join(root, "package.json"), "{}");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "eminiar.config.json"),
    JSON.stringify({ routing: { mode: "enforce", deferToContextMode: false } }),
  );
  resetContextCache();
  const ctx = getContext(root);
  write(ctx, getStorage(ctx, { vectors: false }), {
    name: "decision/sqlite-connection-pool",
    kind: "decision",
    content:
      "The SQLite connection pool is capped at one writer; WAL mode handles concurrent readers.",
  });
});
afterEach(() => {
  clearBudget();
  setStorageBusyTimeout(undefined);
});
afterAll(() => {
  closeAllStorage();
  delete process.env.EMINIAR_HOME;
});

describe("run budget", () => {
  it("sits under each event's hooks.json timeout", () => {
    // 5 s hooks, then the longer ones
    expect(budgetFor("UserPromptSubmit")).toBe(HOOK_BUDGET_MS);
    expect(budgetFor("PreToolUse")).toBe(HOOK_BUDGET_MS);
    expect(budgetFor("Stop")).toBe(HOOK_BUDGET_MS);
    expect(budgetFor(undefined)).toBe(HOOK_BUDGET_MS);
    expect(HOOK_BUDGET_MS).toBeLessThan(5000);
    expect(budgetFor("SessionStart")).toBeLessThan(10_000);
    expect(budgetFor("PostToolUse")).toBeLessThan(10_000);
    expect(budgetFor("PreCompact")).toBeLessThan(15_000);
  });
  it("counts down from the start and never goes negative", () => {
    startBudget(1000, 5000);
    expect(budgetLeft(5000)).toBe(1000);
    expect(budgetLeft(5400)).toBe(600);
    expect(hasBudget(600, 5400)).toBe(true);
    expect(hasBudget(601, 5400)).toBe(false);
    expect(budgetLeft(9000)).toBe(0);
  });
  it("is unlimited when no run has started, so a handler called directly is not cut short", () => {
    clearBudget();
    expect(budgetLeft()).toBe(Number.POSITIVE_INFINITY);
    expect(hasBudget(60_000)).toBe(true);
  });
});

describe("dispatch deadline", () => {
  const payload = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "b1", cwd: root, ...over });

  it("answers {} at the budget when the handler has not, and says it ran late", async () => {
    const saved = handlers.UserPromptSubmit as HookHandler;
    handlers.UserPromptSubmit = () => new Promise<HookOutput>(() => {});
    try {
      const t = Date.now();
      const out = await dispatch(payload({ prompt: "hello there" }), [], { budgetMs: 60 });
      expect(out).toBe("{}");
      expect(Date.now() - t).toBeLessThan(1500);
      expect(ranLate()).toBe(true);
    } finally {
      handlers.UserPromptSubmit = saved;
    }
  });
  it("a run that finishes in time is not late, and clears its budget", async () => {
    const saved = handlers.UserPromptSubmit as HookHandler;
    handlers.UserPromptSubmit = async () => ({ systemMessage: "ok" });
    try {
      const out = await dispatch(payload({ prompt: "hello there" }), [], { budgetMs: 5000 });
      expect(JSON.parse(out)).toEqual({ systemMessage: "ok" });
      expect(ranLate()).toBe(false);
      expect(budgetLeft()).toBe(Number.POSITIVE_INFINITY);
    } finally {
      handlers.UserPromptSubmit = saved;
    }
  });
  it("a late run leaves its budget spent so the abandoned handler skips optional stages", async () => {
    const saved = handlers.UserPromptSubmit as HookHandler;
    handlers.UserPromptSubmit = () => new Promise<HookOutput>(() => {});
    try {
      await dispatch(payload({ prompt: "hello there" }), [], { budgetMs: 20 });
      expect(budgetLeft()).toBe(0);
    } finally {
      handlers.UserPromptSubmit = saved;
    }
  });
});

describe("UserPromptSubmit while another process holds the write lock", () => {
  it("still returns the recall, and fast, with a short lock wait", async () => {
    closeAllStorage();
    setStorageBusyTimeout(100);
    const ctx = getContext(root);
    // another process: it holds the write lock for the whole call
    const other = new Database(ctx.dbPath);
    other.exec("BEGIN IMMEDIATE");
    try {
      const input: HookInput = {
        session_id: "b-locked",
        cwd: root,
        hook_event_name: "UserPromptSubmit",
        prompt: "Should the SQLite connection pool allow concurrent writers?",
      };
      const t = Date.now();
      const out = await handlers.UserPromptSubmit?.(input);
      const took = Date.now() - t;
      // one locked write (~100 ms) ends the bookkeeping; the read-only recall is not blocked
      expect(took).toBeLessThan(1500);
      expect(ctxText(out)).toContain("memory decision/sqlite-connection-pool");
    } finally {
      other.exec("ROLLBACK");
      other.close();
    }
  });
  it("records the prompt as before when the database is free", async () => {
    closeAllStorage();
    const ctx = getContext(root);
    const db = getStorage(ctx, { vectors: false });
    await handlers.UserPromptSubmit?.({
      session_id: "b-free",
      cwd: root,
      hook_event_name: "UserPromptSubmit",
      prompt: "Should the SQLite connection pool allow concurrent writers?",
    });
    const row = db.sessionGet?.("b-free");
    expect(row?.last_prompt).toContain("SQLite connection pool");
  });
});
