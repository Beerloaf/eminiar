/**
 * Wave 4 fixes. F3 (#307): a long-lived process sees a withdrawn consent or `features off` on its
 * next getContext() call. F9 (#313): a personal "off" for anything that sends text wins over the
 * project file and the env.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetSecrets } from "../../src/adjudicator/secrets.js";
import { ConfigSchema, configSourceSignature, loadConfig } from "../../src/config.js";
import { getContext, resetContextCache } from "../../src/context.js";
import { createDecisionClient } from "../../src/decisions/client.js";
import { decisionFeatureActive, decisionInactiveReason } from "../../src/decisions/config.js";
import type { DecisionProvider } from "../../src/decisions/providers/types.js";
import { paths } from "../../src/paths.js";
import { SqliteAdapter } from "../../src/storage/sqlite/adapter.js";

const ENV_KEYS = [
  "EMINIAR_HOME",
  "EMINIAR_ADJUDICATOR",
  "EMINIAR_ADJUDICATOR_PROVIDER",
  "EMINIAR_ADJUDICATOR_MODE",
  "EMINIAR_ADJUDICATOR_REMOTE",
  "EMINIAR_ADJUDICATOR_FEATURES",
  "EMINIAR_ADJUDICATOR_CAPTURE",
  "GROQ_API_KEY",
];
const ORIGIN = "https://api.groq.com";

let root: string;
const saved: Record<string, string | undefined> = {};

/** The personal config of a user who turned recall and commit advice on for Groq. */
function personal(extra: Record<string, unknown> = {}, features?: Record<string, unknown>) {
  writeFileSync(
    paths().configFile,
    JSON.stringify({
      adjudicator: {
        enabled: true,
        provider: "openai-compatible",
        openai: { preset: "groq" },
        remoteConsent: true,
        remoteConsentOrigins: [ORIGIN],
        featureConsent: [`memory@${ORIGIN}`, `diffs@${ORIGIN}`],
        features: features ?? {
          recall: { enabled: true, shadow: false },
          commit: { enabled: true, shadow: false },
        },
        ...extra,
      },
    }),
  );
}

function project(adj: Record<string, unknown>) {
  writeFileSync(join(root, "eminiar.config.json"), JSON.stringify({ adjudicator: adj }));
}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-w4-home-"));
  process.env.GROQ_API_KEY = "gsk_test_wave4";
  root = mkdtempSync(join(tmpdir(), "em-w4-root-"));
  writeFileSync(join(root, "package.json"), "{}");
  mkdirSync(join(root, ".git"));
  resetSecrets();
  resetContextCache();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetSecrets();
  resetContextCache();
});

describe("F3: a running process re-reads the config when it changes (#307)", () => {
  it("withdrawing featureConsent reaches the same long-lived context", () => {
    personal();
    const ctx = getContext(root);
    expect(decisionFeatureActive(ctx.config.adjudicator, "recall")).toBe(true);
    personal({ featureConsent: [] });
    const again = getContext(root);
    expect(again).toBe(ctx);
    expect(decisionFeatureActive(again.config.adjudicator, "recall")).toBe(false);
    expect(decisionInactiveReason(ctx.config.adjudicator, "recall")).toBe("no_consent");
  });

  it("`features off` and a withdrawn remote consent both reach it", () => {
    personal();
    const ctx = getContext(root);
    expect(decisionFeatureActive(ctx.config.adjudicator, "commit")).toBe(true);
    personal({}, { recall: { enabled: true, shadow: false }, commit: { enabled: false } });
    expect(decisionFeatureActive(getContext(root).config.adjudicator, "commit")).toBe(false);
    expect(decisionFeatureActive(getContext(root).config.adjudicator, "recall")).toBe(true);
    personal({ remoteConsent: false, remoteConsentOrigins: [] });
    expect(decisionFeatureActive(getContext(root).config.adjudicator, "recall")).toBe(false);
  });

  it("a personal enabled:false reaches it", () => {
    personal();
    const ctx = getContext(root);
    personal({ enabled: false });
    expect(getContext(root).config.adjudicator.enabled).toBe(false);
    expect(decisionFeatureActive(ctx.config.adjudicator, "recall")).toBe(false);
  });

  it("keeps the same Config object while nothing changed (no reload per call)", () => {
    personal();
    const c1 = getContext(root).config;
    const sig = configSourceSignature(root);
    expect(getContext(root).config).toBe(c1);
    expect(configSourceSignature(root)).toBe(sig);
  });

  it("an env kill switch set in-process is honoured by the memo and the context", () => {
    personal();
    const cfg = getContext(root).config.adjudicator;
    expect(decisionFeatureActive(cfg, "recall")).toBe(true);
    process.env.EMINIAR_ADJUDICATOR_REMOTE = "0";
    // the memo of the old object re-evaluates…
    expect(decisionFeatureActive(cfg, "recall")).toBe(false);
    // …and the context reloads with remoteConsent withdrawn
    const fresh = getContext(root).config.adjudicator;
    expect(fresh).not.toBe(cfg);
    expect(fresh.remoteConsent).toBe(false);
    expect(decisionFeatureActive(fresh, "recall")).toBe(false);
    delete process.env.EMINIAR_ADJUDICATOR_REMOTE;
    process.env.EMINIAR_ADJUDICATOR_FEATURES = "0";
    expect(decisionFeatureActive(cfg, "recall")).toBe(false);
  });

  it("a client made after the withdrawal sends nothing", async () => {
    personal();
    getContext(root);
    personal({ featureConsent: [] });
    const db = new SqliteAdapter(join(root, "db.sqlite"), { vectors: false });
    let asked = 0;
    const provider: DecisionProvider = {
      id: "openai-compatible",
      model: "m",
      maxPairs: 16,
      maxRequests: 1,
      supports: () => true,
      ask: async () => {
        asked++;
        return { answers: {}, latencyMs: 1, tokensIn: 0, costUsd: null };
      },
    } as unknown as DecisionProvider;
    try {
      const client = createDecisionClient("recall", {
        config: getContext(root).config.adjudicator,
        db,
        context: "server",
        provider,
      });
      expect(client.active()).toBe(false);
      const res = await client.ask(
        {
          feature: "recall",
          subject: "q",
          baseline: [],
          items: [{ id: "a", text: "x" }],
          questions: [{ name: "rel", kind: "yes_no", text: "relevant?" }],
          budgetMs: 100,
        } as never,
        () => ({ changed: 0 }) as never,
      );
      expect(res.status).toBe("no_consent");
      expect(asked).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe("F7: an adjudicator section without feature settings skips the features schema (#311)", () => {
  it("gives exactly what the full schema gives, key order included", () => {
    const adj = { enabled: true, provider: "heuristic", surfaces: { tools: true } };
    writeFileSync(paths().configFile, JSON.stringify({ adjudicator: adj }));
    const lean = loadConfig(root);
    const full = ConfigSchema.parse({ adjudicator: adj });
    expect(JSON.stringify(lean)).toBe(JSON.stringify(full));
    expect(lean.adjudicator.features.recall.enabled).toBe(false);
  });

  it("still refuses a key-like field (defaults, adjudicator off)", () => {
    writeFileSync(
      paths().configFile,
      JSON.stringify({ adjudicator: { enabled: true, openai: { apiKey: "sk-nope" } } }),
    );
    expect(loadConfig(root).adjudicator.enabled).toBe(false);
  });

  const dist = join(__dirname, "..", "..", "dist");
  it.skipIf(!existsSync(join(dist, "hook.js")))(
    "the built hook.js statically loads one shared chunk (tsup.config.ts oneSharedHookChunk)",
    () => {
      const seen = new Set<string>();
      const walk = (f: string) => {
        if (seen.has(f)) return;
        seen.add(f);
        const src = readFileSync(join(dist, f), "utf8");
        for (const m of src.matchAll(/^(?:import|export)[^;]*?from\s*"\.\/(hook-[^"]+\.js)"/gms))
          walk(m[1] as string);
      };
      walk("hook.js");
      // hook.js plus one chunk; the pre-branch hook loaded three files, wave 3 loaded ten.
      expect(seen.size).toBeLessThanOrEqual(2);
    },
  );

  it("a features key goes through the full schema", () => {
    personal({}, { recall: true });
    const a = loadConfig(root).adjudicator;
    expect(a.features.recall).toMatchObject({ enabled: true, shadow: true, maxCallsPerDay: 500 });
  });
});

describe("F9: a personal off wins over the project file and the env (#313)", () => {
  it("project enabled:true cannot switch on a personally paused adjudicator or its features", () => {
    personal({ enabled: false });
    project({ enabled: true });
    const a = loadConfig(root).adjudicator;
    expect(a.enabled).toBe(false);
    expect(decisionInactiveReason(a, "commit")).toBe("disabled");
    expect(decisionFeatureActive(a, "recall")).toBe(false);
  });

  it("EMINIAR_ADJUDICATOR=1 cannot either; =0 still turns it off", () => {
    personal({ enabled: false });
    process.env.EMINIAR_ADJUDICATOR = "1";
    expect(loadConfig(root).adjudicator.enabled).toBe(false);
    personal();
    process.env.EMINIAR_ADJUDICATOR = "0";
    expect(loadConfig(root).adjudicator.enabled).toBe(false);
  });

  it("a silent personal file still lets the project turn the adjudicator on, and off", () => {
    writeFileSync(paths().configFile, JSON.stringify({ adjudicator: { provider: "heuristic" } }));
    project({ enabled: true });
    expect(loadConfig(root).adjudicator.enabled).toBe(true);
    personal();
    project({ enabled: false });
    expect(loadConfig(root).adjudicator.enabled).toBe(false);
  });

  it("a personal surface off, promptMode heuristic and minPromptChars floor win", () => {
    personal({
      surfaces: { tools: false, plan: false },
      promptMode: "heuristic",
      minPromptChars: 200,
    });
    project({
      surfaces: { tools: true, plan: true, prompt: false },
      promptMode: "blocking",
      minPromptChars: 0,
    });
    const a = loadConfig(root).adjudicator;
    expect(a.surfaces).toEqual({ prompt: false, agent: true, plan: false, tools: false });
    expect(a.promptMode).toBe("heuristic");
    expect(a.minPromptChars).toBe(200);
    project({ minPromptChars: 500, promptMode: "async" });
    personal({ minPromptChars: 200, promptMode: "async" });
    const b = loadConfig(root).adjudicator;
    expect(b.minPromptChars).toBe(500);
    expect(b.promptMode).toBe("async");
  });
});
