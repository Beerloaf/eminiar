import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AdjudicatorConfig,
  AdjudicatorConfigSchema,
  featuresWanted,
  loadConfig,
} from "../../src/config.js";
import { createDecisionClient } from "../../src/decisions/client.js";
import { decisionFeatureActive } from "../../src/decisions/config.js";
import { DATA_CLASS, hasFeatureConsent } from "../../src/decisions/consent.js";
import type { DecisionProvider } from "../../src/decisions/providers/types.js";
import {
  clears,
  DECISION_FEATURES,
  type Decision,
  type DecisionQuestionSpec,
} from "../../src/decisions/types.js";
import { SqliteAdapter } from "../../src/storage/sqlite/adapter.js";

const KEY = "sk-test-key-0123456789";
const ENV = { TYPESAFE_API_KEY: KEY } as NodeJS.ProcessEnv;
const ORIGIN = "https://api.typesafe.ai";
// A well-known secret shape that the redactor must remove before anything leaves.
const CANARY = "AKIAIOSFODNN7EXAMPLE";
const CANARY_TOKEN = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";

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

interface Calls {
  n: number;
  bodies: string[];
}

/** Answers every question like the live API: a noul probability per question id. */
function fakeFetch(p: number, calls: Calls) {
  return async (_url: string, init: RequestInit) => {
    calls.n++;
    calls.bodies.push(String(init.body));
    const body = JSON.parse(String(init.body)) as { questions: Record<string, unknown> };
    const answers = Object.fromEntries(
      Object.keys(body.questions).map((k) => [k, { type: "noul", noul: p }]),
    );
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 100 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

const decide = (a: Record<string, Record<string, unknown>>): Decision => ({
  decision: Object.keys(a),
  changed: Object.keys(a).length,
});

let db: SqliteAdapter;
const homeBefore = process.env.EMINIAR_HOME;
beforeEach(() => {
  // no ambient key file or personal config may leak into the "no key" cases
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "decc-home-"));
  db = new SqliteAdapter(join(mkdtempSync(join(tmpdir(), "decc-")), "e.db"), { vectors: false });
});
afterEach(() => {
  db.db.close();
  if (homeBefore === undefined) delete process.env.EMINIAR_HOME;
  else process.env.EMINIAR_HOME = homeBefore;
});

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

const rowCount = () =>
  (db.db.prepare("SELECT COUNT(*) AS n FROM decision_calls").get() as { n: number }).n;
const cacheCount = () =>
  (db.db.prepare("SELECT COUNT(*) AS n FROM decision_cache").get() as { n: number }).n;

describe("off costs nothing", () => {
  it("the default config is inactive: no fetch, no row, no cache write", async () => {
    const calls: Calls = { n: 0, bodies: [] };
    const c = createDecisionClient("recall", {
      config: AdjudicatorConfigSchema.parse({
        enabled: true,
        provider: "typesafe",
      }) as AdjudicatorConfig,
      db,
      context: "server",
      env: ENV,
      fetch: fakeFetch(0.9, calls),
    });
    expect(c.active()).toBe(false);
    const r = await c.ask(input(), decide);
    expect(r.status).toBe("disabled");
    expect(r.apply).toBe(false);
    expect(calls.n).toBe(0);
    expect(rowCount()).toBe(0);
    expect(cacheCount()).toBe(0);
    expect(c.cached(input())).toBeUndefined();
  });

  it("every feature is inactive for the default config and featuresWanted is false", () => {
    const d = AdjudicatorConfigSchema.parse({ enabled: true }) as AdjudicatorConfig;
    expect(featuresWanted(d)).toBe(false);
    for (const f of DECISION_FEATURES) expect(decisionFeatureActive(d, f, ENV)).toBe(false);
  });

  it("a disabled adjudicator turns an enabled feature off", async () => {
    const calls: Calls = { n: 0, bodies: [] };
    const c = createDecisionClient("recall", {
      config: cfgWith({ enabled: false }),
      db,
      context: "server",
      env: ENV,
      fetch: fakeFetch(0.9, calls),
    });
    expect((await c.ask(input(), decide)).status).toBe("disabled");
    expect(calls.n).toBe(0);
    expect(cacheCount()).toBe(0);
    expect(c.cached(input())).toBeUndefined();
  });

  it("EMINIAR_ADJUDICATOR_FEATURES=0 withdraws a configured feature", async () => {
    const calls: Calls = { n: 0, bodies: [] };
    const c = createDecisionClient("recall", {
      config: cfgWith(),
      db,
      context: "server",
      env: { ...ENV, EMINIAR_ADJUDICATOR_FEATURES: "0" },
      fetch: fakeFetch(0.9, calls),
    });
    expect((await c.ask(input(), decide)).apply).toBe(false);
    expect(calls.n).toBe(0);
  });
});

describe("fallback paths keep the deterministic result", () => {
  it("no key: no network call and nothing applied", async () => {
    const calls: Calls = { n: 0, bodies: [] };
    const c = createDecisionClient("recall", {
      config: cfgWith(),
      db,
      context: "server",
      env: {} as NodeJS.ProcessEnv,
      fetch: fakeFetch(0.9, calls),
    });
    const r = await c.ask(input(), decide);
    expect(r.apply).toBe(false);
    expect(r.answers).toEqual({});
    expect(["disabled", "no_key", "no_consent"]).toContain(r.status);
    expect(calls.n).toBe(0);
  });

  it("a timeout gives status timeout, applies nothing and trips the breaker", async () => {
    const calls: Calls = { n: 0, bodies: [] };
    const hang = (_u: string, init: RequestInit) =>
      new Promise<Response>((_res, rej) => {
        calls.n++;
        init.signal?.addEventListener("abort", () => rej(new Error("aborted")));
      });
    const mk = () =>
      createDecisionClient("recall", {
        config: cfgWith({ breaker: { failures: 2, cooldownSec: 120 } }),
        db,
        context: "server",
        env: ENV,
        fetch: hang as never,
      });
    const a = await mk().ask(input({ budgetMs: 40, items: [{ id: "x1", text: "t1" }] }), decide);
    expect(a.status).toBe("timeout");
    expect(a.apply).toBe(false);
    await mk().ask(input({ budgetMs: 40, items: [{ id: "x2", text: "t2" }] }), decide);
    const before = calls.n;
    const open = await mk().ask(input({ budgetMs: 40, items: [{ id: "x3", text: "t3" }] }), decide);
    expect(open.status).not.toBe("ok");
    expect(open.apply).toBe(false);
    expect(calls.n).toBe(before); // the open breaker stopped the call
  });

  it("an HTTP 500 is a failure status, not an applied decision", async () => {
    const c = createDecisionClient("recall", {
      config: cfgWith(),
      db,
      context: "server",
      env: ENV,
      fetch: (async () => new Response("boom", { status: 500 })) as never,
    });
    const r = await c.ask(input(), decide);
    expect(r.status).toBe("http_error");
    expect(r.apply).toBe(false);
  });

  it("a malformed body gives invalid and is not cached", async () => {
    const c = createDecisionClient("recall", {
      config: cfgWith(),
      db,
      context: "server",
      env: ENV,
      fetch: (async () =>
        new Response(JSON.stringify({ nonsense: true }), { status: 200 })) as never,
    });
    const r = await c.ask(input(), decide);
    expect(r.status).toBe("invalid");
    expect(r.apply).toBe(false);
    expect(cacheCount()).toBe(0);
  });

  it("an answer for no item gives invalid; an answer for some gives partial", async () => {
    const half = (async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { questions: Record<string, unknown> };
      const ids = Object.keys(body.questions).slice(0, 1);
      return new Response(
        JSON.stringify({
          answers: Object.fromEntries(ids.map((k) => [k, { type: "noul", noul: 0.9 }])),
        }),
        { status: 200 },
      );
    }) as never;
    const c = createDecisionClient("recall", {
      config: cfgWith(),
      db,
      context: "server",
      env: ENV,
      fetch: half,
    });
    const items = [
      { id: "memory:a", text: "aaa" },
      { id: "memory:b", text: "bbb" },
    ];
    const r = await c.ask(input({ items }), decide);
    expect(r.status).toBe("partial");
    expect(Object.keys(r.answers)).toHaveLength(1);
  });

  it("a decide that throws is an error status and applies nothing", async () => {
    const calls: Calls = { n: 0, bodies: [] };
    const c = createDecisionClient("recall", {
      config: cfgWith(),
      db,
      context: "server",
      env: ENV,
      fetch: fakeFetch(0.9, calls),
    });
    const r = await c.ask(input(), () => {
      throw new Error("bad decide");
    });
    expect(r.status).toBe("error");
    expect(r.apply).toBe(false);
  });

  it("a provider that throws a plain Error is invalid and never rejects ask()", async () => {
    const provider: DecisionProvider = {
      id: "typesafe",
      remote: true,
      model: "m",
      maxPairs: 10,
      maxRequests: 1,
      supports: () => true,
      ask: async () => {
        throw new Error("kaboom");
      },
    };
    const c = createDecisionClient("recall", {
      config: cfgWith(),
      db,
      context: "server",
      env: ENV,
      provider,
    });
    const r = await c.ask(input(), decide);
    expect(r.status).toBe("invalid");
    expect(r.apply).toBe(false);
  });

  it("empty items or questions are skipped without a call", async () => {
    const calls: Calls = { n: 0, bodies: [] };
    const c = createDecisionClient("recall", {
      config: cfgWith(),
      db,
      context: "server",
      env: ENV,
      fetch: fakeFetch(0.9, calls),
    });
    expect((await c.ask(input({ items: [] }), decide)).status).toBe("skipped");
    expect((await c.ask(input({ questions: [] }), decide)).status).toBe("skipped");
    expect(calls.n).toBe(0);
  });

  it("a low-confidence answer cannot change the decision a caller derives", async () => {
    const calls: Calls = { n: 0, bodies: [] };
    const c = createDecisionClient("recall", {
      config: cfgWith(),
      db,
      context: "server",
      env: ENV,
      fetch: fakeFetch(0.2, calls),
    });
    const r = await c.ask(input(), (a) => {
      const p = Object.values(a)[0]?.helps;
      return clears(p, 0.6) ? { decision: "act", changed: 1 } : { decision: "keep", changed: 0 };
    });
    expect(r.status).toBe("ok");
    expect(r.decision?.decision).toBe("keep");
    expect(r.apply).toBe(false);
  });

  it("the per-day cap stops further calls", async () => {
    const calls: Calls = { n: 0, bodies: [] };
    const mk = () =>
      createDecisionClient("recall", {
        config: cfgWith({
          features: { recall: { enabled: true, shadow: false, maxCallsPerDay: 1 } },
        }),
        db,
        context: "server",
        env: ENV,
        fetch: fakeFetch(0.9, calls),
      });
    await mk().ask(input({ items: [{ id: "a", text: "one" }] }), decide);
    const r = await mk().ask(input({ items: [{ id: "b", text: "two" }] }), decide);
    expect(r.status).toBe("feature_cap");
    expect(calls.n).toBe(1);
  });
});

describe("shadow mode", () => {
  it("records the verdict but applies nothing and the baseline stands", async () => {
    const calls: Calls = { n: 0, bodies: [] };
    const c = createDecisionClient("recall", {
      config: cfgWith({ features: { recall: { enabled: true, shadow: true } } }),
      db,
      context: "server",
      env: ENV,
      fetch: fakeFetch(0.9, calls),
    });
    const r = await c.ask(input(), decide);
    expect(r.mode).toBe("shadow");
    expect(r.apply).toBe(false);
    expect(r.decision?.changed).toBe(1);
    const rows = db.decisions.list({});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.mode).toBe("shadow");
    expect(rows[0]?.applied).toBeFalsy();
  });

  it("a live ask applies and records applied", async () => {
    const calls: Calls = { n: 0, bodies: [] };
    const c = createDecisionClient("recall", {
      config: cfgWith(),
      db,
      context: "server",
      env: ENV,
      fetch: fakeFetch(0.9, calls),
    });
    const r = await c.ask(input(), decide);
    expect(r.apply).toBe(true);
    expect(db.decisions.list({})[0]?.applied).toBeTruthy();
  });

  it("an unchanged verdict is not applied even live", async () => {
    const c = createDecisionClient("recall", {
      config: cfgWith(),
      db,
      context: "server",
      env: ENV,
      fetch: fakeFetch(0.9, { n: 0, bodies: [] }),
    });
    const r = await c.ask(input(), () => ({ decision: [], changed: 0 }));
    expect(r.apply).toBe(false);
  });
});

describe("hook context", () => {
  it("makes no network call and no database write, and reads no cache", async () => {
    const calls: Calls = { n: 0, bodies: [] };
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
    expect(rowCount()).toBe(0);
    expect(cacheCount()).toBe(0);
  });

  it("cached() serves what a server ask stored, without a call", async () => {
    const calls: Calls = { n: 0, bodies: [] };
    const server = createDecisionClient("recall", {
      config: cfgWith(),
      db,
      context: "server",
      env: ENV,
      fetch: fakeFetch(0.9, calls),
    });
    await server.ask(input(), decide);
    expect(calls.n).toBe(1);
    const hook = createDecisionClient("recall", {
      config: cfgWith(),
      db,
      context: "hook",
      env: ENV,
      fetch: fakeFetch(0.9, calls),
    });
    const hit = hook.cached(input());
    expect(hit?.["memory:a"]?.helps).toMatchObject({ kind: "yes_no", p: 0.9 });
    expect(hook.cached(input({ items: [{ id: "memory:a", text: "other text" }] }))).toBeUndefined();
    expect(calls.n).toBe(1);
  });
});

describe("the uncalibrated threshold", () => {
  const yn = (p: number, calibrated: boolean) => ({ kind: "yes_no" as const, p, calibrated });
  it("calibrated answers compare to the given minimum as is", () => {
    expect(clears(yn(0.6, true), 0.6)).toBe(true);
    expect(clears(yn(0.59, true), 0.6)).toBe(false);
    expect(clears(yn(0.3, true), 0.25)).toBe(true);
  });
  it("uncalibrated answers need max(min, 0.85)", () => {
    expect(clears(yn(0.84, false), 0.6)).toBe(false);
    expect(clears(yn(0.85, false), 0.6)).toBe(true);
    expect(clears(yn(0.9, false), 0.95)).toBe(false); // min above the floor wins
    expect(clears(yn(0.95, false), 0.95)).toBe(true);
    expect(clears(yn(0.7, false), 0.25)).toBe(false);
  });
  it("a missing or non-yes_no answer never clears", () => {
    expect(clears(undefined, 0.1)).toBe(false);
    expect(
      clears(
        { kind: "choice", choice: "a", probs: { a: 1 }, confidence: 1, calibrated: true },
        0.1,
      ),
    ).toBe(false);
  });
});

describe("consent and project config", () => {
  it("a remote provider needs the data class agreed at its own origin", () => {
    const c = cfgWith({
      features: { recall: true, memory: true, commit: true },
      featureConsent: [`memory@${ORIGIN}`],
    });
    expect(DATA_CLASS.recall).toBe("memory");
    expect(DATA_CLASS.memory).toBe("memory");
    expect(decisionFeatureActive(c, "recall", ENV)).toBe(true);
    expect(decisionFeatureActive(c, "memory", ENV)).toBe(true); // same class
    expect(decisionFeatureActive(c, "commit", ENV)).toBe(false); // diffs not agreed
    expect(hasFeatureConsent(c, "recall", "https://other.example")).toBe(false);
    expect(hasFeatureConsent(c, "recall", undefined)).toBe(false);
  });

  it("a consent for another origin does not carry over", () => {
    const c = cfgWith({ featureConsent: ["memory@https://other.example"] });
    expect(decisionFeatureActive(c, "recall", ENV)).toBe(false);
  });

  it("an unconsented ask records no_consent once and makes no call", async () => {
    const calls: Calls = { n: 0, bodies: [] };
    const c = createDecisionClient("recall", {
      config: cfgWith({ featureConsent: [] }),
      db,
      context: "server",
      env: ENV,
      fetch: fakeFetch(0.9, calls),
    });
    const r1 = await c.ask(input(), decide);
    const r2 = await c.ask(input(), decide);
    expect(r1.status).toBe("no_consent");
    expect(r2.status).toBe("no_consent");
    expect(calls.n).toBe(0);
    expect(rowCount()).toBe(1); // deduplicated to one per hour
  });

  it("a local OpenAI-compatible provider needs no consent for any data class", () => {
    const c = AdjudicatorConfigSchema.parse({
      enabled: true,
      provider: "openai-compatible",
      openai: { preset: "ollama" },
      features: { recall: true, commit: true, swarm: true, docs: true },
    }) as AdjudicatorConfig;
    for (const f of ["recall", "commit", "swarm", "docs"] as const)
      expect(decisionFeatureActive(c, f, {} as NodeJS.ProcessEnv)).toBe(true);
  });

  it("the heuristic provider never activates a feature", () => {
    const c = AdjudicatorConfigSchema.parse({
      enabled: true,
      provider: "heuristic",
      features: { recall: true },
    }) as AdjudicatorConfig;
    expect(decisionFeatureActive(c, "recall", ENV)).toBe(false);
  });

  describe("eminiar.config.json", () => {
    const saved = { home: process.env.EMINIAR_HOME };
    afterEach(() => {
      if (saved.home === undefined) delete process.env.EMINIAR_HOME;
      else process.env.EMINIAR_HOME = saved.home;
    });

    it("cannot enable a feature or grant featureConsent", () => {
      process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-home-"));
      const root = mkdtempSync(join(tmpdir(), "em-proj-"));
      writeFileSync(
        join(root, "eminiar.config.json"),
        JSON.stringify({
          adjudicator: {
            enabled: true,
            features: { recall: { enabled: true, shadow: false }, memory: true },
            featureConsent: [`memory@${ORIGIN}`],
          },
        }),
      );
      const cfg = loadConfig(root).adjudicator;
      expect(cfg.enabled).toBe(true); // an allowed key does apply
      expect(cfg.features.recall.enabled).toBe(false);
      expect(cfg.features.recall.shadow).toBe(true);
      expect(cfg.features.memory.enabled).toBe(false);
      expect(cfg.featureConsent).toEqual([]);
      expect(featuresWanted(cfg)).toBe(false);
    });

    it("the personal config still enables a feature", () => {
      const home = mkdtempSync(join(tmpdir(), "em-home-"));
      process.env.EMINIAR_HOME = home;
      mkdirSync(home, { recursive: true });
      const root = mkdtempSync(join(tmpdir(), "em-proj-"));
      writeFileSync(
        join(home, "config.json"),
        JSON.stringify({
          adjudicator: {
            enabled: true,
            features: { recall: true },
            featureConsent: [`memory@${ORIGIN}`],
          },
        }),
      );
      const cfg = loadConfig(root).adjudicator;
      expect(cfg.features.recall.enabled).toBe(true);
      expect(cfg.featureConsent).toEqual([`memory@${ORIGIN}`]);
    });
  });
});

describe("redaction", () => {
  it("a canary secret never reaches the request body or the stored tables", async () => {
    const calls: Calls = { n: 0, bodies: [] };
    const c = createDecisionClient("recall", {
      config: cfgWith({ privacy: { captureExchanges: false } }),
      db,
      context: "server",
      env: ENV,
      fetch: fakeFetch(0.9, calls),
    });
    const r = await c.ask(
      input({
        context: `deploy with aws key ${CANARY} and token ${CANARY_TOKEN} now`,
        items: [
          { id: "memory:a", text: `prod uses ${CANARY} and ${CANARY_TOKEN} for access` },
          { id: "memory:b", text: `password: hunter2hunter2 api_key=${CANARY_TOKEN}` },
        ],
      }),
      decide,
    );
    expect(r.status).toBe("ok");
    expect(calls.n).toBe(1);
    for (const body of calls.bodies) {
      expect(body).not.toContain(CANARY);
      expect(body).not.toContain(CANARY_TOKEN);
      expect(body).not.toContain("hunter2hunter2");
      expect(body).not.toContain(KEY);
    }
    const dump =
      JSON.stringify(db.db.prepare("SELECT * FROM decision_calls").all()) +
      JSON.stringify(db.db.prepare("SELECT * FROM decision_cache").all());
    expect(dump).not.toContain(CANARY);
    expect(dump).not.toContain(CANARY_TOKEN);
    expect(dump).not.toContain("hunter2hunter2");
  });

  it("the cache key is built from redacted text, so a secret change does not miss", async () => {
    const calls: Calls = { n: 0, bodies: [] };
    const mk = () =>
      createDecisionClient("recall", {
        config: cfgWith(),
        db,
        context: "server",
        env: ENV,
        fetch: fakeFetch(0.9, calls),
      });
    const one = input({ items: [{ id: "memory:a", text: `uses ${CANARY} here` }] });
    await mk().ask(one, decide);
    const r = await mk().ask(one, decide);
    expect(r.status).toBe("cached");
    expect(calls.n).toBe(1);
  });

  it("wire ids are positional: no memory name leaves the machine", async () => {
    const calls: Calls = { n: 0, bodies: [] };
    const c = createDecisionClient("recall", {
      config: cfgWith(),
      db,
      context: "server",
      env: ENV,
      fetch: fakeFetch(0.9, calls),
    });
    await c.ask(input({ items: [{ id: "memory:secret-name", text: "x body" }] }), decide);
    expect(calls.bodies[0]).not.toContain("secret-name");
    expect(calls.bodies[0]).toContain("i0");
  });
});
