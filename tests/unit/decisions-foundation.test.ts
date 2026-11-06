import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AdjudicatorConfig,
  AdjudicatorConfigSchema,
  adjudicatorDefaults,
  featuresWanted,
} from "../../src/config.js";
import { createDecisionClient } from "../../src/decisions/client.js";
import { decisionFeatureActive } from "../../src/decisions/config.js";
import { hasFeatureConsent } from "../../src/decisions/consent.js";
import type { DecisionProvider } from "../../src/decisions/providers/types.js";
import { clears, type Decision, type DecisionQuestionSpec } from "../../src/decisions/types.js";
import { SqliteAdapter } from "../../src/storage/sqlite/adapter.js";

const ENV = { TYPESAFE_API_KEY: "sk-test-key-0123456789" } as NodeJS.ProcessEnv;
const ORIGIN = "https://api.typesafe.ai";

function cfgWith(over: Record<string, unknown> = {}): AdjudicatorConfig {
  return AdjudicatorConfigSchema.parse({
    enabled: true,
    provider: "typesafe",
    remoteConsent: true,
    remoteConsentOrigins: [ORIGIN],
    featureConsent: [`memory@${ORIGIN}`],
    features: { recall: { enabled: true, shadow: false } },
    ...over,
  }) as AdjudicatorConfig;
}

const Q: DecisionQuestionSpec = {
  name: "helps",
  kind: "yes_no",
  instructions: "Does {item} help?",
};

function fakeFetch(p: number, calls: { n: number; bodies: string[] }) {
  return async (_url: string, init: RequestInit) => {
    calls.n++;
    const body = JSON.parse(String(init.body)) as { questions: Record<string, unknown> };
    calls.bodies.push(String(init.body));
    const answers = Object.fromEntries(
      Object.keys(body.questions).map((k) => [k, { type: "noul", noul: p }]),
    );
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 100 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

describe("feature config", () => {
  it("is off, shadow and personal-only by default", () => {
    const d = adjudicatorDefaults();
    expect(d.features.recall).toMatchObject({ enabled: false, shadow: true });
    expect(d.featureConsent).toEqual([]);
    expect(featuresWanted(d)).toBe(false);
  });

  it("accepts true/false shorthand", () => {
    const c = AdjudicatorConfigSchema.parse({
      enabled: true,
      features: { memory: true, docs: false },
    });
    expect(c.features.memory).toMatchObject({ enabled: true, shadow: true });
    expect(c.features.docs.enabled).toBe(false);
    expect(featuresWanted(c as AdjudicatorConfig)).toBe(true);
  });
});

describe("decisionFeatureActive", () => {
  it("needs the adjudicator, the feature, a provider and consent for the data class", () => {
    const c = cfgWith();
    expect(decisionFeatureActive(c, "recall", ENV)).toBe(true);
    expect(decisionFeatureActive(c, "memory", ENV)).toBe(false); // feature not enabled
    const on = cfgWith({ features: { recall: true, commit: true } });
    expect(decisionFeatureActive(on, "recall", ENV)).toBe(true);
    expect(decisionFeatureActive(on, "commit", ENV)).toBe(false); // diffs class not agreed
    expect(hasFeatureConsent(on, "commit", ORIGIN)).toBe(false);
  });

  it("is withdrawn by EMINIAR_ADJUDICATOR_FEATURES=0 ", () => {
    const on = cfgWith({ features: { recall: true } });
    expect(decisionFeatureActive(on, "recall", { ...ENV, EMINIAR_ADJUDICATOR_FEATURES: "0" })).toBe(
      false,
    );
  });

  it("a project file cannot enable a feature", () => {
    // features and featureConsent are not in the project layer's allow-list
    const keys = ["features", "featureConsent"];
    return import("../../src/config.js").then(({ PROJECT_ADJUDICATOR_KEYS }) => {
      for (const k of keys) expect(PROJECT_ADJUDICATOR_KEYS).not.toContain(k);
    });
  });

  it("a local provider needs no remote consent", () => {
    const c = AdjudicatorConfigSchema.parse({
      enabled: true,
      provider: "openai-compatible",
      openai: { preset: "ollama" },
      features: { recall: true },
    }) as AdjudicatorConfig;
    expect(decisionFeatureActive(c, "recall", {} as NodeJS.ProcessEnv)).toBe(true);
  });
});

describe("DecisionClient", () => {
  let db: SqliteAdapter;
  beforeEach(() => {
    db = new SqliteAdapter(join(mkdtempSync(join(tmpdir(), "dec-")), "e.db"), { vectors: false });
  });
  afterEach(() => db.db.close());

  const decide = (a: Record<string, Record<string, unknown>>): Decision => ({
    decision: Object.keys(a),
    changed: Object.keys(a).length,
  });
  const input = (items = [{ id: "memory:a", text: "CANARY-TEXT-123 body" }]) => ({
    feature: "recall" as const,
    subject: "prompt:abc",
    context: "the prompt",
    items,
    questions: [Q],
    baseline: { shown: ["memory:a"] },
    budgetMs: 2000,
  });

  it("asks once, caches, records a row, and never stores text", async () => {
    const calls = { n: 0, bodies: [] as string[] };
    const mk = () =>
      createDecisionClient("recall", {
        config: cfgWith({ features: { recall: { enabled: true, shadow: false } } }),
        db,
        context: "server",
        env: ENV,
        fetch: fakeFetch(0.9, calls),
      });
    const c = mk();
    const r = await c.ask(input(), decide);
    expect(r.status).toBe("ok");
    expect(r.apply).toBe(true);
    expect(r.answers["memory:a"]?.helps).toMatchObject({
      kind: "yes_no",
      p: 0.9,
      calibrated: true,
    });
    // the wire id is positional; no memory name leaves
    expect(calls.bodies[0]).not.toContain("memory:a");
    const r2 = await mk().ask(input(), decide);
    expect(r2.status).toBe("cached");
    expect(calls.n).toBe(1);
    const rows = db.decisions.list({});
    expect(rows).toHaveLength(2);
    expect(rows[1]?.provider).toBe("typesafe");
    const dump =
      JSON.stringify(db.db.prepare("SELECT * FROM decision_calls").all()) +
      JSON.stringify(db.db.prepare("SELECT * FROM decision_cache").all());
    expect(dump).not.toContain("CANARY-TEXT-123");
  });

  it("shadow records but does not apply", async () => {
    const calls = { n: 0, bodies: [] as string[] };
    const c = createDecisionClient("recall", {
      config: cfgWith({ features: { recall: { enabled: true, shadow: true } } }),
      db,
      context: "server",
      env: ENV,
      fetch: fakeFetch(0.9, calls),
    });
    const r = await c.ask(input(), decide);
    expect(r.status).toBe("ok");
    expect(r.mode).toBe("shadow");
    expect(r.apply).toBe(false);
  });

  it("context hook never calls fetch", async () => {
    const calls = { n: 0, bodies: [] as string[] };
    const c = createDecisionClient("recall", {
      config: cfgWith(),
      db,
      context: "hook",
      env: ENV,
      fetch: fakeFetch(0.9, calls),
    });
    const r = await c.ask(input(), decide);
    expect(r.status).toBe("skipped");
    expect(calls.n).toBe(0);
    expect(c.cached(input())).toBeUndefined();
  });

  it("an unsupported question kind gives 'unsupported' and no call", async () => {
    const provider: DecisionProvider = {
      id: "embedding",
      remote: false,
      model: "e",
      maxPairs: 10,
      maxRequests: 1,
      supports: () => false,
      ask: async () => {
        throw new Error("must not be called");
      },
    };
    const c = createDecisionClient("recall", {
      config: cfgWith(),
      db,
      context: "server",
      env: ENV,
      provider,
    });
    expect((await c.ask(input(), decide)).status).toBe("unsupported");
  });

  it("an OpenAI-compatible endpoint answers uncalibrated yes_no", async () => {
    const c = createDecisionClient("recall", {
      config: AdjudicatorConfigSchema.parse({
        enabled: true,
        provider: "openai-compatible",
        openai: { preset: "ollama" },
        features: { recall: { enabled: true, shadow: false } },
      }) as AdjudicatorConfig,
      db,
      context: "server",
      env: {} as NodeJS.ProcessEnv,
      fetch: async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"answers":[{"id":"i0.helps","p":0.95}]}' } }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          }),
          { status: 200 },
        ),
    });
    const r = await c.ask(input(), decide);
    expect(r.status).toBe("ok");
    const a = r.answers["memory:a"]?.helps;
    expect(a).toMatchObject({ kind: "yes_no", calibrated: false });
    expect(clears(a, 0.6)).toBe(true);
    expect(clears({ kind: "yes_no", p: 0.7, calibrated: false }, 0.6)).toBe(false);
  });
});

describe("DecisionStore", () => {
  let db: SqliteAdapter;
  beforeEach(() => {
    db = new SqliteAdapter(join(mkdtempSync(join(tmpdir(), "dec-")), "e.db"), { vectors: false });
  });
  afterEach(() => db.db.close());

  const base = {
    feature: "commit" as const,
    context: "job" as const,
    subject: "s",
    mode: "live" as const,
    status: "ok" as const,
  };

  it("prunes to the newest rows and delivers a note once, expiring after 10 minutes", () => {
    for (let i = 0; i < 5; i++) db.decisions.insertCall({ ...base, ts: 1000 + i }, 3);
    expect(db.decisions.list({})).toHaveLength(3);
    const id = db.decisions.insertCall({ ...base, ts: 5000, note: "n1", noteSession: "s1" });
    expect(db.decisions.pendingNotes("s1", 5001)).toEqual([{ id, note: "n1" }]);
    db.decisions.markDelivered([id], 5002);
    expect(db.decisions.pendingNotes("s1", 5003)).toEqual([]);
    const old = db.decisions.insertCall({ ...base, ts: 1, note: "old", noteSession: "s1" });
    expect(old).toBeGreaterThan(0);
    expect(db.decisions.pendingNotes("s1", 700_000)).toEqual([]);
  });

  it("summarises per feature and purges with the adjudicator scope", () => {
    db.decisions.insertCall({ ...base, ts: Date.now(), changed: 0, latencyMs: 40 });
    db.decisions.insertCall({ ...base, ts: Date.now(), changed: 2, applied: true });
    const s = db.decisions.summary();
    expect(s.commit).toMatchObject({ calls: 2, ok: 2, agree: 1, changed: 1, applied: 1 });
    db.purge("adjudicator");
    expect(db.decisions.list({})).toHaveLength(0);
  });
});
