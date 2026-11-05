/**
 * Docs triage (option F), the gaps the base file leaves: through the real `em_docs discover`
 * tool the output is byte-identical when off, shadow, unsupported, timed out, failed or breaker
 * open; only "<ecosystem> package <name>" leaves the machine (no versions, paths, evidence or
 * URLs, and a canary in a package name is redacted); the batch is capped; the recommended pick
 * honours the flag.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigSchema } from "../../src/config.js";
import { getContext, type ProjectContext, resetContextCache } from "../../src/context.js";
import {
  applyDocsScores,
  DOCS_MAX_ITEMS,
  DOCS_MAX_RECOMMENDED,
  scorable,
} from "../../src/decisions/features/docs.js";
import type { DecisionProvider } from "../../src/decisions/providers/types.js";
import { pickCandidates } from "../../src/docs/add.js";
import type { Discovery, ProviderCandidate } from "../../src/docs/discover.js";
import { closeAllStorage } from "../../src/storage/index.js";
import { emDocs, formatDiscovery } from "../../src/tools/em_docs.js";

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

const ORIGIN = "https://api.typesafe.ai";
const GH = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";
const VERSION = "9.8.7-canaryver";
const PKGS = ["zzdocs-alpha", "zzdocs-bravo", "zzdocs-charlie", GH];

let root: string;
let home: string;
let base: ProjectContext;

type Mode = "ok" | "throw" | "hang" | "unsupported";
interface Probe {
  calls: number;
  texts: string[];
  batches: string[];
}
const newProbe = (): Probe => ({ calls: 0, texts: [], batches: [] });

function provider(score: (name: string) => number, p: Probe, mode: Mode = "ok"): DecisionProvider {
  return {
    id: "typesafe",
    remote: true,
    model: "m",
    maxPairs: 40,
    maxRequests: 2,
    supports: () => mode !== "unsupported",
    ask: async (batch) => {
      p.calls++;
      p.batches.push(JSON.stringify(batch));
      for (const i of batch.items) p.texts.push(i.text);
      if (mode === "throw") throw new Error("boom");
      if (mode === "hang") return new Promise(() => {});
      return {
        answers: Object.fromEntries(
          batch.items.map((i) => [
            i.id,
            {
              benefit: {
                kind: "score" as const,
                value: score(i.text.replace(/^\S+ package /, "")),
                confidence: 1,
                calibrated: true,
              },
            },
          ]),
        ),
        tokensIn: 1,
        costUsd: 0,
        latencyMs: 1,
        model: "m",
      };
    },
  };
}

// A database of its own per context: the 24 h answer cache must not carry one scenario's
// answers into the next.
let n = 0;
const ctxWith = (docs: Record<string, unknown> | undefined): ProjectContext => ({
  ...base,
  dbPath: join(home, `docs-${n++}.sqlite`),
  config: ConfigSchema.parse(
    docs === undefined
      ? {}
      : {
          adjudicator: {
            enabled: true,
            provider: "typesafe",
            remoteConsent: true,
            remoteConsentOrigins: [ORIGIN],
            featureConsent: [`packages@${ORIGIN}`],
            features: { docs: { enabled: true, shadow: false, ...docs } },
          },
        },
  ),
});

const discover = async (ctx: ProjectContext) => {
  const r = await emDocs.handler({ action: "discover" } as never, ctx);
  return r.content.map((c) => c.text).join("\n");
};

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "em-dde-home-"));
  process.env.EMINIAR_HOME = home;
  process.env.EMINIAR_EMBEDDINGS = "0";
  process.env.TYPESAFE_API_KEY = "sk-test-key-0123456789";
  root = mkdtempSync(join(tmpdir(), "em-dde-"));
  mkdirSync(join(root, "private-subdir"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "app",
      dependencies: Object.fromEntries(PKGS.map((p) => [p, VERSION])),
    }),
  );
  writeFileSync(
    join(root, "package-lock.json"),
    JSON.stringify({
      packages: Object.fromEntries(
        PKGS.map((p) => [
          `node_modules/${p}`,
          { resolved: `https://registry.npmjs.org/${p}/-/${p}.tgz` },
        ]),
      ),
    }),
  );
  resetContextCache();
  base = getContext(root);
});
afterAll(() => {
  closeAllStorage();
  delete process.env.EMINIAR_HOME;
  delete process.env.EMINIAR_EMBEDDINGS;
  delete process.env.TYPESAFE_API_KEY;
});
beforeEach(() => {
  injected.provider = undefined;
});

describe("em_docs discover with the triage", () => {
  it("is byte-identical off, disabled, shadow, unsupported, failed and timed out", async () => {
    const plain = await discover(ctxWith(undefined));
    expect(plain).toContain("zzdocs-alpha");
    const high = (n: string) => (n === "zzdocs-bravo" ? 0.95 : 0.1);

    const pr = newProbe();
    injected.provider = provider(high, pr);
    expect(await discover(ctxWith(undefined))).toBe(plain);
    expect(await discover(ctxWith({ enabled: false }))).toBe(plain);
    expect(pr.calls).toBe(0);

    expect(await discover(ctxWith({ shadow: true }))).toBe(plain);
    expect(pr.calls).toBe(1);

    injected.provider = provider(high, newProbe(), "unsupported");
    expect(await discover(ctxWith({}))).toBe(plain);

    injected.provider = provider(high, newProbe(), "throw");
    expect(await discover(ctxWith({}))).toBe(plain);

    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ adjudicator: { features: { docs: { mcpMs: 50 } } } }),
    );
    injected.provider = provider(high, newProbe(), "hang");
    const t0 = Date.now();
    expect(await discover(ctxWith({ mcpMs: 50 }))).toBe(plain);
    expect(Date.now() - t0).toBeLessThan(3000);
    writeFileSync(join(home, "config.json"), "{}");
  });

  it("live: reorders by score and says what it recommends", async () => {
    const plain = await discover(ctxWith(undefined));
    injected.provider = provider((n) => (n === "zzdocs-charlie" ? 0.99 : 0.05), newProbe());
    const live = await discover(ctxWith({ minScore: 0.5 }));
    expect(live).not.toBe(plain);
    expect(live).toContain("docs value 0.99");
    expect(live).toContain("Docs triage recommends indexing: zzdocs-charlie");
    expect(live.indexOf("zzdocs-charlie")).toBeLessThan(live.indexOf("zzdocs-alpha"));
  });

  it("sends the ecosystem and name only, never a version, path, URL or canary", async () => {
    const pr = newProbe();
    injected.provider = provider(() => 0.5, pr);
    await discover(ctxWith({}));
    expect(pr.calls).toBe(1);
    expect(pr.texts.sort().filter((t) => !t.includes("ghp_"))).toEqual([
      "npm package zzdocs-alpha",
      "npm package zzdocs-bravo",
      "npm package zzdocs-charlie",
    ]);
    const wire = pr.batches.join("");
    expect(wire).not.toContain(GH);
    expect(wire).not.toContain(VERSION);
    expect(wire).not.toContain(root);
    expect(wire).not.toContain("private-subdir");
    expect(wire).not.toContain("package.json");
  });

  it("asks nothing when no candidate is an unregistered registry package", async () => {
    const empty = mkdtempSync(join(tmpdir(), "em-dde-empty-"));
    writeFileSync(join(empty, "package.json"), JSON.stringify({ name: "x" }));
    resetContextCache();
    const ctx = { ...ctxWith({}), root: empty, id: "empty", dbPath: join(empty, "db.sqlite") };
    const pr = newProbe();
    injected.provider = provider(() => 1, pr);
    const out = await emDocs.handler({ action: "discover" } as never, ctx);
    expect(out.isError).toBeFalsy();
    expect(pr.calls).toBe(0);
  });
});

describe("scorable and applyDocsScores", () => {
  const cand = (name: string, over: Partial<ProviderCandidate> = {}): ProviderCandidate => ({
    name,
    provider: `npm:${name}`,
    title: name,
    urls: ["https://example.test/secret-path"],
    confidence: "registry",
    publicVerified: true,
    usedBy: ["."],
    evidence: [`npm:${name}`],
    registered: false,
    ...over,
  });
  const disc = (providers: ProviderCandidate[]): Discovery => ({
    root: "/p",
    projects: ["."],
    local: [],
    providers,
  });

  it("caps the batch at DOCS_MAX_ITEMS and keeps the most widely used first", () => {
    const many = Array.from({ length: DOCS_MAX_ITEMS + 15 }, (_, i) =>
      cand(`p${i}`, { usedBy: i === 44 ? ["a", "b", "c"] : ["."] }),
    );
    const s = scorable(disc(many));
    expect(s).toHaveLength(DOCS_MAX_ITEMS);
    expect(s[0]?.name).toBe("p44");
  });

  it("scores catalog, infra, probe, unknown and registered candidates never", () => {
    const s = scorable(
      disc([
        cand("cat", { confidence: "catalog", tier: "service" }),
        cand("probe", { confidence: "probe", tier: "service" }),
        cand("reg", { registered: true }),
        cand("other", { provider: "docker:other" }),
        cand("ok"),
      ]),
    );
    expect(s.map((x) => x.name)).toEqual(["ok"]);
  });

  it("never flags a catalog candidate, never more than the cap, and leaves ties in place", () => {
    const d = disc([
      cand("cat", { confidence: "catalog", provider: "npm:cat" }),
      ...Array.from({ length: 9 }, (_, i) => cand(`r${i}`)),
    ]);
    const scores = new Map(d.providers.map((p) => [p.provider, 0.9] as const));
    const r = applyDocsScores(d, scores, 0.5);
    expect(r.flagged).toBe(DOCS_MAX_RECOMMENDED);
    expect(r.discovery.providers.find((p) => p.name === "cat")?.recommended).toBeUndefined();
    expect(r.reordered).toBe(0);
    expect(r.discovery.providers.map((p) => p.name)).toEqual(d.providers.map((p) => p.name));
  });

  it("a score exactly at minScore recommends; just below does not; empty scores change nothing", () => {
    const d = disc([cand("a"), cand("b")]);
    const r = applyDocsScores(
      d,
      new Map([
        ["npm:a", 0.5],
        ["npm:b", 0.49],
      ]),
      0.5,
    );
    expect(r.discovery.providers.filter((p) => p.recommended).map((p) => p.name)).toEqual(["a"]);
    const none = applyDocsScores(d, new Map(), 0.5);
    expect(none.reordered + none.flagged).toBe(0);
    expect(formatDiscovery(none.discovery)).toBe(formatDiscovery(d));
  });
});

describe("pick recommended honours the flag", () => {
  const cand = (name: string, over: Partial<ProviderCandidate> = {}): ProviderCandidate => ({
    name,
    provider: `npm:${name}`,
    title: name,
    urls: [],
    confidence: "registry",
    publicVerified: true,
    usedBy: ["."],
    evidence: [],
    registered: false,
    ...over,
  });
  const disc = (providers: ProviderCandidate[]): Discovery => ({
    root: "/p",
    projects: ["."],
    local: [],
    providers,
  });

  it("a flagged registry package is picked, an unflagged probe one is not, registered ones never", () => {
    const d = disc([
      cand("flagged", { recommended: true }),
      cand("unflagged", { confidence: "probe", recommended: false }),
      cand("done", { recommended: true, registered: true }),
      cand("service", { confidence: "catalog", tier: "service", recommended: false }),
    ]);
    expect(pickCandidates(d, "recommended").map((p) => p.name)).toEqual(["flagged"]);
  });

  it("without any flag the deterministic rule is unchanged", () => {
    const d = disc([
      cand("probe", { confidence: "probe" }),
      cand("reg"),
      cand("svc", { confidence: "catalog", tier: "service" }),
      cand("lib", { confidence: "catalog", tier: "library" }),
    ]);
    expect(pickCandidates(d, "recommended").map((p) => p.name)).toEqual(["probe", "svc"]);
  });
});
