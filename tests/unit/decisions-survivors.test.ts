/**
 * Mutation survivors of the correctness review (task #318): one-line mutants of the Jev feature
 * code that no existing test broke. Each describe names the behaviour that was unpinned. A few
 * survivors (the recall sort tiebreak) are equivalent mutants and have no test.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "../../src/adjudicator/providers/http.js";
import type { HttpExchange } from "../../src/adjudicator/types.js";
import {
  type AdjudicatorConfig,
  AdjudicatorConfigSchema,
  ConfigSchema,
  featuresWanted,
} from "../../src/config.js";
import { getContext, type ProjectContext, resetContextCache } from "../../src/context.js";
import { decisionCacheKey } from "../../src/decisions/cache.js";
import { createDecisionClient } from "../../src/decisions/client.js";
import { hasFeatureConsent } from "../../src/decisions/consent.js";
import { feature as commitFeature } from "../../src/decisions/features/commit.js";
import {
  feature as compactionFeature,
  triageOutput,
} from "../../src/decisions/features/compaction.js";
import { applyDocsScores } from "../../src/decisions/features/docs.js";
import { suggestMemoryHygiene } from "../../src/decisions/features/memory.js";
import { decideRecall } from "../../src/decisions/features/recall.js";
import { swarmBadges } from "../../src/decisions/features/swarm.js";
import { spawnDecisionJob } from "../../src/decisions/job.js";
import type { DecisionProvider } from "../../src/decisions/providers/types.js";
import {
  type Answers,
  choiceClears,
  clears,
  DECISION_FEATURES,
  type DecisionAnswer,
  type DecisionCallInput,
  type DecisionFeature,
  type DecisionJob,
  type DecisionQuestionSpec,
} from "../../src/decisions/types.js";
import { write } from "../../src/memory/store.js";
import type { SearchResponse } from "../../src/search/pipeline.js";
import { guideSections, renderGuide } from "../../src/session/guide.js";
import type { StorageAdapter } from "../../src/storage/adapter.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";
import { SqliteAdapter } from "../../src/storage/sqlite/adapter.js";
import { errors, stateTitle } from "../../src/ui/web/views/features-helpers.js";

/** The provider triageOutput's own client uses: set per test. */
const injected = vi.hoisted(() => ({ provider: undefined as unknown }));
vi.mock("../../src/decisions/client.js", async (orig) => {
  const m = await orig<typeof import("../../src/decisions/client.js")>();
  return {
    ...m,
    createDecisionClient: (f: never, deps: never) =>
      m.createDecisionClient(f, {
        ...(deps as object),
        ...(injected.provider ? { provider: injected.provider } : {}),
      } as never),
  };
});

const NOENV = {} as NodeJS.ProcessEnv;
const ORIGIN = "https://api.typesafe.ai";

/** A local (loopback) provider: no consent, no key. */
function local(features: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return AdjudicatorConfigSchema.parse({
    enabled: true,
    provider: "openai-compatible",
    openai: { preset: "ollama" },
    features,
    ...extra,
  }) as AdjudicatorConfig;
}
const live = (name: string, extra: Record<string, unknown> = {}) => ({
  [name]: { enabled: true, shadow: false, ...extra },
});

type Ask = DecisionProvider["ask"];
function stub(ask: Ask, over: Partial<DecisionProvider> = {}): DecisionProvider {
  return {
    id: "openai-compatible",
    remote: false,
    model: "m",
    maxPairs: 100,
    maxRequests: 2,
    supports: () => true,
    ask,
    ...over,
  };
}
const answerAll =
  (per: (itemId: string, text: string) => Record<string, DecisionAnswer>): Ask =>
  async (batch) => ({
    answers: Object.fromEntries(batch.items.map((i) => [i.id, per(i.id, i.text)])),
    tokensIn: 1,
    costUsd: 0,
    latencyMs: 1,
    model: "m",
  });
const score = (value: number, calibrated = true): DecisionAnswer => ({
  kind: "score",
  value,
  confidence: 1,
  calibrated,
});

const Q: DecisionQuestionSpec = {
  name: "helps",
  kind: "yes_no",
  instructions: "Does {item} help?",
};
const input = (over: Record<string, unknown> = {}) => ({
  feature: "recall" as const,
  subject: "prompt:abc",
  context: "the prompt",
  items: [{ id: "memory:a", text: "body of a" }],
  questions: [Q],
  baseline: { shown: ["memory:a"] },
  budgetMs: 2000,
  ...over,
});

let db: SqliteAdapter;
let home: string;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "em-sv-home-"));
  process.env.EMINIAR_HOME = home;
  process.env.EMINIAR_EMBEDDINGS = "0";
});
afterAll(() => {
  closeAllStorage();
  delete process.env.EMINIAR_HOME;
  delete process.env.EMINIAR_EMBEDDINGS;
});
beforeEach(() => {
  injected.provider = undefined;
  db = new SqliteAdapter(join(mkdtempSync(join(tmpdir(), "em-sv-")), "e.db"), { vectors: false });
});
afterEach(() => db.db.close());

describe("compaction: the replaced snapshot is consumed", () => {
  it("after a live rewrite nothing but the new snapshot is left to replay", async () => {
    const SID = "s1";
    const ev = (category: string, priority: 1 | 2 | 3 | 4, payload: Record<string, unknown>) =>
      db.eventInsert({ sessionId: SID, category, priority, payload });
    ev("user_prompt", 1, { text: "fix the login redirect" });
    ev("files", 2, { path: "src/login.ts" });
    ev("git", 3, { command: "git status" });
    ev("mcp_tool", 4, { tool: "em_search" });
    const old = db.snapshotInsert({ sessionId: SID, trigger: "auto", body: renderGuide(db, SID) });
    expect(guideSections(db, SID).length).toBeGreaterThan(1);
    const config = local(live("compaction"));
    const client = createDecisionClient("compaction", {
      config,
      db,
      context: "job",
      env: NOENV,
      provider: stub(
        answerAll((_id, text) => ({
          useful: score(text.includes("**Files Modified**") ? 0 : 1),
        })),
      ),
    });
    const job: DecisionJob = {
      v: 1,
      feature: "compaction",
      projectRoot: tmpdir(),
      sessionId: SID,
      payload: { sessionId: SID, snapshotId: old },
    };
    await compactionFeature.runJob?.(job, client, db);
    const next = db.snapshotLatestUnconsumed(SID);
    expect(next?.id).not.toBe(old);
    // consuming the new one must leave no older snapshot to be replayed at the next SessionStart
    db.snapshotMarkConsumed(next!.id);
    expect(db.snapshotLatestUnconsumed(SID)).toBeUndefined();
  });
});

describe("output triage keeps the hits it did not score", () => {
  const hit = (ord: number) =>
    ({
      chunk: { ord, document: { id: 1, title: "t", uri: "u" }, text: `line ${ord}` },
      snippet: `line ${ord}`,
      score: 1,
    }) as unknown as SearchResponse["hits"][number];

  it("hits past the candidate cap follow the scored ones, in place of being dropped", async () => {
    const hits = Array.from({ length: 14 }, (_, i) => hit(i));
    const responses = [{ query: "q", hits }] as unknown as SearchResponse[];
    // the first twelve are candidates; c3 is useless, the rest useful
    injected.provider = stub(answerAll((id) => ({ useful: score(id === "i3" ? 0 : 1) })));
    const ctx = { config: ConfigSchema.parse({ adjudicator: local(live("compaction")) }) };
    const out = await triageOutput(db, ctx as unknown as ProjectContext, "intent", 1, responses);
    expect(out).toBeDefined();
    const ords = out![0]!.hits.map((h) => h.chunk.ord);
    expect(ords).not.toContain(3);
    // the two uncandidated hits (ord 12, 13) stay, after the scored ones
    expect(ords.slice(-2)).toEqual([12, 13]);
    expect(ords).toHaveLength(13);
  });
});

describe("uncalibrated answers face the conservative 0.85 bar", () => {
  const yn = (p: number, calibrated: boolean): DecisionAnswer => ({
    kind: "yes_no",
    p,
    calibrated,
  });
  const ch = (
    probs: Record<string, number>,
    c: string,
    confidence: number,
    cal: boolean,
  ): DecisionAnswer => ({
    kind: "choice",
    choice: c,
    probs,
    confidence,
    calibrated: cal,
  });

  it("clears: calibrated compares to min, uncalibrated to max(min, 0.85)", () => {
    expect(clears(yn(0.7, true), 0.6)).toBe(true);
    expect(clears(yn(0.7, false), 0.6)).toBe(false);
    expect(clears(yn(0.85, false), 0.6)).toBe(true);
    expect(clears(yn(0.9, false), 0.95)).toBe(false);
    expect(clears(undefined, 0.1)).toBe(false);
  });

  it("choiceClears: the same bar; an uncalibrated pick without a probability needs confidence", () => {
    expect(choiceClears(ch({ a: 0.7 }, "a", 0.7, true), "a", 0.6)).toBe(true);
    expect(choiceClears(ch({ a: 0.7 }, "a", 0.7, false), "a", 0.6)).toBe(false);
    expect(choiceClears(ch({ a: 0.9 }, "a", 0.9, false), "a", 0.6)).toBe(true);
    expect(choiceClears(ch({}, "a", 0.7, false), "a", 0.6)).toBe(false);
    expect(choiceClears(ch({}, "a", 0.9, false), "a", 0.6)).toBe(true);
    expect(choiceClears(ch({}, "a", 0.9, true), "a", 0.6)).toBe(true);
    expect(choiceClears(ch({ a: 0.9 }, "b", 0.9, true), "a", 0.6)).toBe(false);
  });

  describe("memory hygiene", () => {
    let root: string;
    let ctx: ProjectContext;
    let sdb: StorageAdapter;
    const ENV = { TYPESAFE_API_KEY: "sk-test-key-0123456789" } as NodeJS.ProcessEnv;
    const cfg = (provider: string, minProb: number): AdjudicatorConfig =>
      AdjudicatorConfigSchema.parse({
        enabled: true,
        provider,
        ...(provider === "typesafe"
          ? {
              remoteConsent: true,
              remoteConsentOrigins: [ORIGIN],
              featureConsent: [`memory@${ORIGIN}`],
            }
          : { openai: { preset: "ollama" } }),
        features: { memory: { enabled: true, shadow: false, minProb } },
      }) as AdjudicatorConfig;

    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), "em-sv-mem-"));
      writeFileSync(join(root, "package.json"), "{}");
      resetContextCache();
      ctx = getContext(root);
      sdb = getStorage(ctx);
      write(ctx, sdb, {
        name: "auth/tokens",
        kind: "decision",
        content: "Session tokens are stored in redis with a one hour expiry",
      });
      write(ctx, sdb, {
        name: "auth/tokens-old",
        kind: "decision",
        content: "Session tokens are kept in memcached with a one hour expiry",
      });
      write(ctx, sdb, {
        name: "auth/tokens-new",
        kind: "decision",
        content: "Session tokens are stored in redis with a two hour expiry",
        supersedes: "auth/tokens-old",
      });
    });

    const NEW = "Session tokens are stored in postgres with a one day expiry";
    const run = (config: AdjudicatorConfig, p: DecisionProvider, name: string) => {
      ctx.config.adjudicator = config;
      return suggestMemoryHygiene(
        ctx,
        sdb,
        { name, content: `${NEW} ${name}` },
        { env: ENV, provider: p },
      );
    };

    it("a choice answer without a calibrated probability needs 0.85 even above minProb", async () => {
      const answer = (conf: number) =>
        stub(
          answerAll((_id, text) => {
            const hit = text.includes("redis with a one hour");
            return {
              memory_relation: ch(
                hit ? { duplicate: conf } : {},
                hit ? "duplicate" : "unrelated",
                conf,
                false,
              ),
            };
          }),
          { id: "typesafe" },
        );
      expect(await run(cfg("typesafe", 0.6), answer(0.7), "x/one")).toBeUndefined();
      expect(await run(cfg("typesafe", 0.6), answer(0.9), "x/two")).toContain(
        "duplicate of auth/tokens",
      );
    });

    it("the duplicate yes/no form of a local provider needs 0.85 even above minProb", async () => {
      const answer = (p: number) =>
        stub(
          answerAll((_id, text) => ({
            memory_duplicate: yn(text.includes("redis with a one hour") ? p : 0, false),
          })),
        );
      expect(await run(cfg("openai-compatible", 0.6), answer(0.7), "x/three")).toBeUndefined();
      expect(await run(cfg("openai-compatible", 0.6), answer(0.9), "x/four")).toContain(
        "duplicate of auth/tokens",
      );
    });

    it("a superseded neighbour is never suggested", async () => {
      // only the superseded memory (memcached) is called a duplicate, with full confidence
      const p = stub(
        answerAll((_id, text) => {
          const old = text.includes("memcached");
          return {
            memory_relation: ch({ duplicate: 0.97 }, old ? "duplicate" : "unrelated", 0.97, true),
          };
        }),
        { id: "typesafe" },
      );
      expect(await run(cfg("typesafe", 0.6), p, "x/five")).toBeUndefined();
    });
  });
});

describe("Features panel helpers", () => {
  const by = (o: Record<string, number>) => ({ byStatus: o }) as never;

  it("errors counts exactly the provider failure statuses", () => {
    for (const s of ["error", "timeout", "http_error", "rate_limited", "invalid", "auth_failed"])
      expect(errors(by({ [s]: 2 }))).toBe(2);
    for (const s of [
      "ok",
      "partial",
      "cached",
      "unsupported",
      "no_consent",
      "disabled",
      "breaker_open",
      "skipped",
    ])
      expect(errors(by({ [s]: 5 }))).toBe(0);
    expect(errors(by({ error: 1, timeout: 2, auth_failed: 4, ok: 9 }))).toBe(7);
  });

  it("stateTitle explains no consent differently from any other blocked state", () => {
    expect(stateTitle({ inactive: null })).toBeUndefined();
    expect(stateTitle({ inactive: "no_consent" })).toMatch(/consent/);
    expect(stateTitle({ inactive: "disabled" })).toMatch(/heuristic|switched off/);
    expect(stateTitle({ inactive: "disabled" })).not.toMatch(/consent/);
  });
});

describe("the cache key", () => {
  const base = {
    feature: "recall" as DecisionFeature,
    mode: "live" as "live" | "shadow",
    provider: "typesafe",
    model: "m1",
    questionVersion: 1,
    question: Q,
    context: "ctx",
    itemId: "a",
    itemText: "text",
  };

  it("changes with every part and is stable otherwise", () => {
    const k = decisionCacheKey(base);
    expect(decisionCacheKey({ ...base })).toBe(k);
    const variants: Array<Partial<typeof base>> = [
      { feature: "memory" },
      { mode: "shadow" },
      { provider: "openai-compatible" },
      { model: "m2" },
      { questionVersion: 2 },
      { question: { ...Q, name: "other" } },
      { question: { ...Q, instructions: "Is {item} good?" } },
      { context: "ctx2" },
      { itemId: "b" },
      { itemText: "text2" },
    ];
    const keys = new Set([k, ...variants.map((v) => decisionCacheKey({ ...base, ...v }))]);
    expect(keys.size).toBe(variants.length + 1);
  });
});

describe("decision store", () => {
  it("cacheGet honours the ttl, boundary included", () => {
    db.decisions.cachePut("k", "recall", { a: 1 }, 1000);
    expect(db.decisions.cacheGet("k", 1500, 1000)).toEqual({ a: 1 });
    expect(db.decisions.cacheGet("k", 2000, 1000)).toEqual({ a: 1 });
    expect(db.decisions.cacheGet("k", 2001, 1000)).toBeUndefined();
    expect(db.decisions.cacheGet("missing", 1500, 1000)).toBeUndefined();
  });

  it("callsToday counts only the calls that reached the provider, from today's UTC midnight", () => {
    const now = Date.UTC(2026, 10, 6, 12, 0, 0);
    const row = (status: DecisionCallInput["status"], ts = now): DecisionCallInput => ({
      ts,
      feature: "commit",
      context: "job",
      subject: "s",
      mode: "live",
      status,
    });
    for (const s of ["ok", "partial", "timeout", "http_error", "rate_limited", "invalid"] as const)
      db.decisions.insertCall(row(s));
    for (const s of [
      "cached",
      "no_key",
      "breaker_open",
      "slow_guard",
      "over_budget",
      "auth_failed",
      "feature_cap",
      "disabled",
      "no_consent",
      "skipped",
      "unsupported",
      "error",
    ] as const)
      db.decisions.insertCall(row(s));
    db.decisions.insertCall(row("ok", Date.UTC(2026, 10, 5, 23, 59, 59)));
    db.decisions.insertCall({ ...row("ok"), feature: "memory" });
    expect(db.decisions.callsToday("commit", now)).toBe(6);
  });
});

describe("client: half-open trial and exchange capture", () => {
  it("a failed trial call of a half-open breaker re-opens it at once", async () => {
    const config = local(live("recall"), { breaker: { failures: 5 } });
    db.adjudicator.saveProviderState("openai-compatible", {
      state: "open",
      retryAt: Date.now() - 1000,
    });
    const c = createDecisionClient("recall", {
      config,
      db,
      context: "server",
      env: NOENV,
      provider: stub(async () => {
        throw new ProviderError("http_error", "500", { status: 500 });
      }),
    });
    const r = await c.ask(input(), () => ({ decision: [], changed: 0 }));
    expect(r.status).toBe("http_error");
    expect(db.adjudicator.providerState("openai-compatible")?.state).toBe("open");
  });

  const exchange = (): HttpExchange => ({
    method: "POST",
    target: "localhost:11434/v1/chat/completions",
    sentAt: Date.now(),
    deadlineMs: 1000,
    attempts: 1,
    retryWaitMs: 0,
    ttfbMs: 3,
    durationMs: 5,
    status: 200,
    outcome: "ok",
    request: { text: "{}", json: true, bytes: 2, truncated: false },
    response: { text: "{}", json: true, bytes: 2, truncated: false },
    error: null,
  });
  const capturing = stub(async (batch, o) => {
    o.exchange?.(exchange());
    return {
      answers: Object.fromEntries(
        batch.items.map((i) => [i.id, { helps: { kind: "yes_no", p: 0.9, calibrated: true } }]),
      ),
      tokensIn: 1,
      costUsd: 0,
      latencyMs: 1,
      model: "m",
    } as never;
  });
  const ask = (captureExchanges: boolean) =>
    createDecisionClient("recall", {
      config: local(live("recall"), { privacy: { captureExchanges } }),
      db,
      context: "server",
      env: NOENV,
      provider: capturing,
    }).ask(input(), () => ({ decision: ["x"], changed: 1 }));

  it("with captureExchanges on, the HTTP exchange is stored and linked from the row", async () => {
    const r = await ask(true);
    expect(r.status).toBe("ok");
    const stored = db.adjudicator.exchangeList();
    expect(stored.rows ?? stored).toHaveLength(1);
    const row = db.decisions.list({ feature: "recall" })[0];
    expect(row?.exchangeId).toBeTypeOf("number");
    expect(row?.exchangeId).not.toBeNull();
  });

  it("with it off, nothing is stored and the row has no exchange", async () => {
    await ask(false);
    const stored = db.adjudicator.exchangeList();
    expect(stored.rows ?? stored).toHaveLength(0);
    expect(db.decisions.list({ feature: "recall" })[0]?.exchangeId).toBeNull();
  });
});

describe("swarm badges", () => {
  const RUN = "r1";
  const verdict = (task: number, mode: "shadow" | "live", subject: string): DecisionCallInput => ({
    ts: Date.now(),
    feature: "swarm",
    context: "job",
    subject,
    mode,
    status: "ok",
    provider: "openai-compatible",
    decision: { task, flags: [{ q: "stalled", p: 0.95, c: true }] },
    applied: mode === "live",
  });

  it("shows a live verdict and never a shadow one", () => {
    db.decisions.insertCall(verdict(1, "shadow", `run:${RUN}/task:1`));
    db.decisions.insertCall(verdict(2, "live", `run:${RUN}/task:2`));
    const badges = swarmBadges(local(live("swarm")), db, RUN);
    expect(badges.has(1)).toBe(false);
    expect(badges.get(2)).toMatch(/maybe stalled \(0\.95\)/);
  });

  it("shows nothing at all while the feature is in shadow mode", () => {
    db.decisions.insertCall(verdict(2, "live", `run:${RUN}/task:2`));
    expect(swarmBadges(local({ swarm: { enabled: true, shadow: true } }), db, RUN).size).toBe(0);
  });
});

describe("featuresWanted", () => {
  it.each(DECISION_FEATURES)("is true when only %s is enabled", (f) => {
    expect(featuresWanted(local({ [f]: { enabled: true } }))).toBe(true);
  });
  it("is false with nothing enabled or the adjudicator off", () => {
    expect(featuresWanted(local({}))).toBe(false);
    expect(featuresWanted(local({ swarm: { enabled: true } }, { enabled: false }))).toBe(false);
  });
});

describe("feature consent is per data class and origin", () => {
  const consent = (...e: string[]) => ({ featureConsent: e });
  it("matches the origin whatever path, case or trailing slash the stored entry has", () => {
    expect(hasFeatureConsent(consent(`memory@${ORIGIN}`), "recall", ORIGIN)).toBe(true);
    expect(hasFeatureConsent(consent(`memory@${ORIGIN}/`), "recall", ORIGIN)).toBe(true);
    expect(hasFeatureConsent(consent(`memory@${ORIGIN}/v1/decide`), "memory", ORIGIN)).toBe(true);
    expect(
      hasFeatureConsent(consent("memory@HTTPS://API.TYPESAFE.AI:443/v1"), "memory", ORIGIN),
    ).toBe(true);
  });
  it("is refused for another class, another origin, a malformed entry or no origin", () => {
    expect(hasFeatureConsent(consent(`diffs@${ORIGIN}`), "memory", ORIGIN)).toBe(false);
    expect(hasFeatureConsent(consent("memory@https://evil.example"), "memory", ORIGIN)).toBe(false);
    expect(
      hasFeatureConsent(consent("memory@https://api.typesafe.ai:8443"), "memory", ORIGIN),
    ).toBe(false);
    expect(
      hasFeatureConsent(
        consent("memory", "memory@not a url", "memory@ftp://api.typesafe.ai"),
        "memory",
        ORIGIN,
      ),
    ).toBe(false);
    expect(hasFeatureConsent(consent(`memory@${ORIGIN}`), "memory", undefined)).toBe(false);
  });
});

describe("spawnDecisionJob", () => {
  const job: DecisionJob = {
    v: 1,
    feature: "commit",
    projectRoot: "/p",
    sessionId: "s",
    payload: {},
  };
  const fake = () => {
    const child = {
      on: vi.fn(),
      unref: vi.fn(),
      stdin: { on: vi.fn(), end: vi.fn() },
    };
    const spawn = vi.fn(() => child);
    return { child, spawn };
  };

  // A fake install: the running module and the hook.js beside it (the only script ever spawned).
  const dist = join(mkdtempSync(join(tmpdir(), "em-surv-hook-")), "dist");
  mkdirSync(dist);
  writeFileSync(join(dist, "server.js"), "");
  writeFileSync(join(dist, "hook.js"), "");
  const moduleUrl = pathToFileURL(join(dist, "server.js")).href;

  it("starts the hook script detached with the job on stdin, then unrefs the child", () => {
    const { child, spawn } = fake();
    expect(
      spawnDecisionJob(job, {
        spawn: spawn as never,
        moduleUrl,
        execPath: "/node",
        env: {},
      }),
    ).toBe(true);
    expect(spawn).toHaveBeenCalledWith(
      "/node",
      [realpathSync(join(dist, "hook.js")), "--decision"],
      expect.objectContaining({ detached: true, shell: false }),
    );
    expect(child.stdin.end).toHaveBeenCalledWith(JSON.stringify(job));
    // without unref the parent hook would wait for the job
    expect(child.unref).toHaveBeenCalledTimes(1);
  });

  it("refuses without an installed hook, and reports a spawn that throws", () => {
    const { spawn } = fake();
    const bare = mkdtempSync(join(tmpdir(), "em-surv-bare-"));
    writeFileSync(join(bare, "server.js"), "");
    const noHook = pathToFileURL(join(bare, "server.js")).href;
    expect(spawnDecisionJob(job, { spawn: spawn as never, moduleUrl: noHook })).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
    const boom = vi.fn(() => {
      throw new Error("EAGAIN");
    });
    expect(spawnDecisionJob(job, { spawn: boom as never, moduleUrl })).toBe(false);
  });
});

describe("commit advice reads the diff the commit takes", () => {
  let repo: string;
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "pipe" });
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "em-sv-git-"));
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    git("config", "commit.gpgsign", "false");
    writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
    git("add", "a.ts");
    git("commit", "-q", "-m", "init");
    // tracked, modified, NOT staged
    writeFileSync(join(repo, "a.ts"), "export const a = 1;\nconsole.log('debug leftover');\n");
  });

  const seen: string[] = [];
  const run = async (command: string) => {
    seen.length = 0;
    db.decisions.purge();
    const config = local(live("commit"));
    const client = createDecisionClient("commit", {
      config,
      db,
      context: "job",
      env: NOENV,
      provider: stub(
        answerAll((_id, text) => {
          seen.push(text);
          return Object.fromEntries(
            ["message_mismatch", "debug_leftover", "unmentioned_work", "credential"].map((q) => [
              q,
              { kind: "yes_no", p: 0, calibrated: true } as DecisionAnswer,
            ]),
          );
        }),
      ),
    });
    await commitFeature.runJob?.(
      { v: 1, feature: "commit", projectRoot: repo, sessionId: "s", payload: { command } },
      client,
      db,
    );
  };

  it("git commit -a / -am / --all sends the working tree diff against HEAD", async () => {
    for (const cmd of ['git commit -am "x"', "git commit -a -m x", "git commit --all -m x"]) {
      await run(cmd);
      expect(seen.join("\n"), cmd).toContain("debug leftover");
    }
  });

  it("a plain git commit with nothing staged sends nothing", async () => {
    await run('git commit -m "x"');
    expect(seen).toEqual([]);
  });
});

describe("recall order", () => {
  const spec = (keys: string[]) => ({
    path: "prompt" as const,
    query: "q",
    items: keys.map((k) => ({ id: k, text: k, label: k })),
    baseline: keys,
  });
  it("an answered 0 still outranks an unanswered key, which keeps its place after the answered ones", () => {
    const keys = ["doc:u1", "memory:b", "doc:u2", "memory:c"];
    const answers: Answers = {
      "memory:b": { relevant: { kind: "yes_no", p: 0, calibrated: false } },
      "memory:c": { relevant: { kind: "yes_no", p: 0.9, calibrated: false } },
    } as never;
    const d = decideRecall(spec(keys) as never, 0.3)(answers);
    const got = d.decision as string[];
    expect(got.indexOf("memory:c")).toBeLessThan(got.indexOf("memory:b"));
    expect(got.indexOf("memory:b")).toBeLessThan(got.indexOf("doc:u1"));
    expect(got.slice(-2)).toEqual(["doc:u1", "doc:u2"]);
  });
});

describe("docs scores reorder inside each confidence group", () => {
  const p = (provider: string, confidence: "catalog" | "registry" | "probe" | "unknown") =>
    ({ provider, confidence, usedBy: [], registered: false }) as never;
  it("every group is sorted on its own slots", () => {
    const d = {
      providers: [
        p("npm:a", "catalog"),
        p("npm:b", "catalog"),
        p("npm:c", "registry"),
        p("npm:d", "registry"),
        p("npm:e", "probe"),
        p("npm:f", "probe"),
      ],
    } as never;
    const scores = new Map([
      ["npm:a", 0.1],
      ["npm:b", 0.9],
      ["npm:c", 0.2],
      ["npm:d", 0.8],
      ["npm:e", 0.3],
      ["npm:f", 0.7],
    ]);
    const r = applyDocsScores(d, scores, 0.5);
    expect(
      (r.discovery as { providers: Array<{ provider: string }> }).providers.map((x) => x.provider),
    ).toEqual(["npm:b", "npm:a", "npm:d", "npm:c", "npm:f", "npm:e"]);
    expect(r.reordered).toBe(6);
  });
});
