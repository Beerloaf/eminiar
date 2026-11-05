import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { type AdjudicatorConfig, AdjudicatorConfigSchema } from "../../src/config.js";
import { createDecisionClient } from "../../src/decisions/client.js";
import { applyDocsScores, scorable, triageDiscovery } from "../../src/decisions/features/docs.js";
import type { DecisionProvider } from "../../src/decisions/providers/types.js";
import type { Discovery, ProviderCandidate } from "../../src/docs/discover.js";
import { SqliteAdapter } from "../../src/storage/sqlite/adapter.js";
import { formatDiscovery } from "../../src/tools/em_docs.js";

const ORIGIN = "https://api.typesafe.ai";

function cand(name: string, over: Partial<ProviderCandidate> = {}): ProviderCandidate {
  return {
    name,
    provider: `npm:${name}`,
    title: name,
    urls: [],
    confidence: "registry",
    usedBy: ["."],
    evidence: [`npm:${name}`],
    registered: false,
    ...over,
  };
}

function discovery(): Discovery {
  return {
    root: "/p",
    projects: ["."],
    local: [],
    providers: [cand("aaa"), cand("bbb"), cand("ccc"), cand("ddd", { registered: true })],
  };
}

function cfg(shadow: boolean): AdjudicatorConfig {
  return AdjudicatorConfigSchema.parse({
    enabled: true,
    provider: "typesafe",
    remoteConsent: true,
    remoteConsentOrigins: [ORIGIN],
    featureConsent: [`packages@${ORIGIN}`],
    features: { docs: { enabled: true, shadow } },
  }) as AdjudicatorConfig;
}

const ENV = { TYPESAFE_API_KEY: "sk-test-key-0123456789" } as NodeJS.ProcessEnv;

function provider(
  values: Record<string, number>,
  seen: { texts: string[] },
  supported = true,
): DecisionProvider {
  return {
    id: "typesafe",
    remote: true,
    model: "m",
    maxPairs: 40,
    maxRequests: 2,
    supports: () => supported,
    ask: async (batch) => {
      for (const i of batch.items) seen.texts.push(i.text);
      return {
        answers: Object.fromEntries(
          batch.items.map((i) => [
            i.id,
            {
              benefit: {
                kind: "score",
                value: values[`npm:${i.text.replace("npm package ", "")}`] ?? 0,
                confidence: 1,
                calibrated: true,
              },
            },
          ]),
        ),
        tokensIn: 10,
        costUsd: 0,
        latencyMs: 1,
        model: "m",
      };
    },
  };
}

describe("docs triage", () => {
  let db: SqliteAdapter;
  beforeEach(() => {
    db = new SqliteAdapter(join(mkdtempSync(join(tmpdir(), "docs-triage-")), "e.db"), {
      vectors: false,
    });
  });

  const client = (shadow: boolean, p: DecisionProvider) =>
    createDecisionClient("docs", {
      config: cfg(shadow),
      db,
      context: "server",
      env: ENV,
      provider: p,
    });

  it("scores only unregistered packages and sends only ecosystem and name", async () => {
    const seen = { texts: [] as string[] };
    const d = discovery();
    expect(scorable(d).map((p) => p.name)).toEqual(["aaa", "bbb", "ccc"]);
    await triageDiscovery(client(false, provider({}, seen)), cfg(false), d);
    expect(seen.texts.sort()).toEqual(["npm package aaa", "npm package bbb", "npm package ccc"]);
  });

  it("live: orders by score and flags registry packages above minScore (max 5)", async () => {
    const seen = { texts: [] as string[] };
    const d = discovery();
    const r = await triageDiscovery(
      client(false, provider({ "npm:aaa": 0.1, "npm:bbb": 0.9, "npm:ccc": 0.6 }, seen)),
      cfg(false),
      d,
    );
    expect(r.discovery.providers.map((p) => p.name)).toEqual(["bbb", "ccc", "aaa", "ddd"]);
    expect(r.discovery.providers.filter((p) => p.recommended).map((p) => p.name)).toEqual([
      "bbb",
      "ccc",
    ]);
    const out = formatDiscovery(r.discovery);
    expect(out).toContain("docs value 0.90");
    expect(out).toContain("Docs triage recommends indexing: bbb, ccc");
    // the input is not mutated
    expect(d.providers[0]!.docsScore).toBeUndefined();
  });

  it("shadow, unsupported and error leave the discovery and its output untouched", async () => {
    const d = discovery();
    const before = formatDiscovery(d);
    const seen = { texts: [] as string[] };
    const values = { "npm:bbb": 0.9 };
    const shadow = await triageDiscovery(client(true, provider(values, seen)), cfg(true), d);
    expect(shadow.discovery).toBe(d);
    const unsupported = await triageDiscovery(
      client(false, provider(values, seen, false)),
      cfg(false),
      d,
    );
    expect(unsupported.discovery).toBe(d);
    expect(unsupported.result?.status).toBe("unsupported");
    const broken: DecisionProvider = {
      ...provider(values, seen),
      ask: async () => {
        throw new Error("boom");
      },
    };
    // a different package set, so the 24 h answer cache of the runs above cannot answer it
    const fresh: Discovery = { ...d, providers: [cand("zzz"), cand("yyy")] };
    expect((await triageDiscovery(client(false, broken), cfg(false), fresh)).discovery).toBe(fresh);
    expect(formatDiscovery(d)).toBe(before);
  });

  it("an inactive client never asks", async () => {
    const seen = { texts: [] as string[] };
    const off = AdjudicatorConfigSchema.parse({ enabled: false }) as AdjudicatorConfig;
    const c = createDecisionClient("docs", {
      config: off,
      db,
      context: "server",
      env: ENV,
      provider: provider({}, seen),
    });
    const d = discovery();
    expect((await triageDiscovery(c, off, d)).discovery).toBe(d);
    expect(seen.texts).toEqual([]);
  });

  it("applyDocsScores keeps unscored candidates in place and caps recommendations at five", () => {
    const d: Discovery = {
      root: "/p",
      projects: ["."],
      local: [],
      providers: Array.from({ length: 8 }, (_, i) => cand(`p${i}`)),
    };
    const scores = new Map(d.providers.map((p, i) => [p.provider, 0.5 + i / 20] as const));
    scores.delete("npm:p3");
    const r = applyDocsScores(d, scores, 0.5);
    expect(r.discovery.providers[3]!.name).toBe("p3");
    expect(r.flagged).toBe(5);
  });
});
