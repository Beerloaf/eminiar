/**
 * Wave 5. F12: shadow and live never share a cached answer. F14: a partial batch never acts.
 * #317: enabledSource() names the real deciding layer; `enable --project` explains a personal off.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adjudicatorCommand, enabledSource, type Io } from "../../src/adjudicator/cli.js";
import { resetSecrets } from "../../src/adjudicator/secrets.js";
import { type AdjudicatorConfig, AdjudicatorConfigSchema, ConfigSchema } from "../../src/config.js";
import { createDecisionClient } from "../../src/decisions/client.js";
import type { DecisionProvider } from "../../src/decisions/providers/types.js";
import type { DecisionQuestionSpec } from "../../src/decisions/types.js";
import { paths } from "../../src/paths.js";
import { SqliteAdapter } from "../../src/storage/sqlite/adapter.js";

const ORIGIN = "https://api.typesafe.ai";
const Q: DecisionQuestionSpec = {
  name: "helps",
  kind: "yes_no",
  instructions: "Does {item} help?",
};
const ENV = { TYPESAFE_API_KEY: "sk-test-key-0123456789" } as NodeJS.ProcessEnv;
const homeBefore = process.env.EMINIAR_HOME;
let db: SqliteAdapter;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "dec5-home-"));
  process.env.EMINIAR_HOME = home;
  resetSecrets();
  db = new SqliteAdapter(join(mkdtempSync(join(tmpdir(), "dec5-")), "e.db"), { vectors: false });
});
afterEach(() => {
  db.db.close();
  delete process.env.EMINIAR_ADJUDICATOR;
  if (homeBefore === undefined) delete process.env.EMINIAR_HOME;
  else process.env.EMINIAR_HOME = homeBefore;
});

function cfg(shadow: boolean): AdjudicatorConfig {
  return AdjudicatorConfigSchema.parse({
    enabled: true,
    provider: "typesafe",
    remoteConsent: true,
    remoteConsentOrigins: [ORIGIN],
    featureConsent: [`memory@${ORIGIN}`],
    features: { recall: { enabled: true, shadow } },
  }) as AdjudicatorConfig;
}

/** Answers the first `answered` items of every request; counts requests. */
function provider(answered: number) {
  const state = { calls: 0 };
  const p = {
    id: "typesafe",
    remote: true,
    model: "m",
    maxPairs: 32,
    maxRequests: 1,
    supports: () => true,
    ask: async (b: { items: Array<{ id: string }> }) => {
      state.calls++;
      const answers: Record<string, Record<string, unknown>> = {};
      for (const it of b.items.slice(0, answered))
        answers[it.id] = { helps: { kind: "yes_no", p: 0.9, calibrated: true } };
      return { answers, latencyMs: 1, tokensIn: 1, costUsd: 0, model: "m" };
    },
  } as unknown as DecisionProvider;
  return { p, state };
}

const input = (n: number) => ({
  feature: "recall" as const,
  subject: "s",
  context: "ctx",
  items: Array.from({ length: n }, (_, i) => ({ id: `memory:${i}`, text: `body ${i}` })),
  questions: [Q],
  baseline: ["memory:0"],
  budgetMs: 2000,
});
const decide = () => ({ decision: ["x"], changed: 1 });

describe("F12 shadow answers never apply when the feature goes live", () => {
  it("a live ask after a shadow ask calls the provider again and then applies", async () => {
    const config = cfg(true);
    const { p, state } = provider(1);
    const c = createDecisionClient("recall", {
      config,
      db,
      context: "server",
      provider: p,
      env: ENV,
    });
    const a = await c.ask(input(1), decide);
    expect(a.status).toBe("ok");
    expect(a.apply).toBe(false);
    expect(state.calls).toBe(1);
    config.features.recall.shadow = false;
    expect(c.cached(input(1))).toBeUndefined();
    const b = await c.ask(input(1), decide);
    expect(state.calls).toBe(2);
    expect(b.status).toBe("ok");
    expect(b.apply).toBe(true);
    // live now cached for live
    expect((await c.ask(input(1), decide)).status).toBe("cached");
    expect(state.calls).toBe(2);
  });
});

describe("F14 a partial batch keeps the baseline", () => {
  it("1 of 2 items answered: status partial, answers recorded, nothing applied", async () => {
    const { p } = provider(1);
    const c = createDecisionClient("recall", {
      config: cfg(false),
      db,
      context: "server",
      provider: p,
      env: ENV,
    });
    const r = await c.ask(input(2), decide);
    expect(r.status).toBe("partial");
    expect(Object.keys(r.answers)).toEqual(["memory:0"]);
    expect(r.apply).toBe(false);
  });

  it("all answered applies", async () => {
    const { p } = provider(2);
    const c = createDecisionClient("recall", {
      config: cfg(false),
      db,
      context: "server",
      provider: p,
      env: ENV,
    });
    const r = await c.ask(input(2), decide);
    expect(r.status).toBe("ok");
    expect(r.apply).toBe(true);
  });
});

describe("#317 enabledSource and enable --project", () => {
  const root = () => mkdtempSync(join(tmpdir(), "dec5-root-"));
  const personal = (enabled: boolean) => {
    mkdirSync(home, { recursive: true });
    writeFileSync(paths().configFile, JSON.stringify({ adjudicator: { enabled } }));
  };
  const project = (r: string, enabled: boolean) =>
    writeFileSync(join(r, "eminiar.config.json"), JSON.stringify({ adjudicator: { enabled } }));

  it("a personal false is the deciding source over project true and env =1", () => {
    const r = root();
    personal(false);
    project(r, true);
    expect(enabledSource(r, {})).toContain("personal");
    expect(enabledSource(r, { EMINIAR_ADJUDICATOR: "1" })).toContain("personal");
    expect(enabledSource(r, { EMINIAR_ADJUDICATOR: "0" })).toBe("env EMINIAR_ADJUDICATOR=0");
  });

  it("otherwise env > project > global > default", () => {
    const r = root();
    expect(enabledSource(r, {})).toBe("default");
    personal(true);
    expect(enabledSource(r, {})).toContain("global");
    project(r, false);
    expect(enabledSource(r, {})).toBe("project eminiar.config.json");
    expect(enabledSource(r, { EMINIAR_ADJUDICATOR: "1" })).toBe("env EMINIAR_ADJUDICATOR=1");
  });

  it("enable --project says why it stays off under a personal false", async () => {
    const r = root();
    personal(false);
    const lines: string[] = [];
    const io: Io = {
      out: (l) => lines.push(l),
      err: (l) => lines.push(`ERR ${l}`),
      isTTY: false,
      ask: async () => "",
      askHidden: async () => "",
      readStdin: async () => "",
      env: {},
      now: () => 0,
    };
    const dbPath = join(r, "db.sqlite");
    const ctx = { root: r, id: "t", dbPath, config: ConfigSchema.parse({}) };
    expect(await adjudicatorCommand(["enable", "--project"], ctx, { io, db })).toBe(0);
    const text = lines.join("\n");
    expect(text).toContain("stays off for you");
    expect(text).toContain("personal");
    expect(text).toContain("still off");
  });
});
