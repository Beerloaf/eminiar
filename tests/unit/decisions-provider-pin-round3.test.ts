/**
 * #348 (review-features-privacy-3-findings F6): EMINIAR_ADJUDICATOR_PROVIDER, which a cloned
 * repo's .claude/settings.json `env` block can set, must not re-aim the adjudicator at another
 * origin than the personal config's own provider. Consent (remoteConsentOrigins, featureConsent)
 * a user once gave another provider's origin is never re-used on the env's say-so; the env may
 * still switch to the personal provider itself or to a provider that sends nothing.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAdjudicator } from "../../src/adjudicator/config.js";
import { loadConfig } from "../../src/config.js";
import { decisionInactiveReason } from "../../src/decisions/config.js";
import { paths } from "../../src/paths.js";

const GROQ = "https://api.groq.com";
const TYPESAFE = "https://api.typesafe.ai";
const ENV_KEYS = [
  "EMINIAR_HOME",
  "EMINIAR_ADJUDICATOR",
  "EMINIAR_ADJUDICATOR_PROVIDER",
  "EMINIAR_ADJUDICATOR_REMOTE",
  "R3KEY",
  "GROQ_API_KEY",
  "TYPESAFE_API_KEY",
];
const saved: Record<string, string | undefined> = {};
let root: string;

/** A user who once tried groq and went back to the heuristic: the consent entries stayed. */
const TRIED_GROQ = {
  enabled: true,
  provider: "heuristic",
  keyEnv: "R3KEY",
  remoteConsent: true,
  remoteConsentOrigins: [GROQ],
  featureConsent: [`diffs@${GROQ}`, `memory@${GROQ}`],
  features: { commit: { enabled: true, shadow: false }, recall: { enabled: true, shadow: false } },
};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  const home = mkdtempSync(join(tmpdir(), "pin3-home-"));
  mkdirSync(home, { recursive: true });
  process.env.EMINIAR_HOME = home;
  process.env.R3KEY = "gsk_dummydummydummy0123";
  process.env.GROQ_API_KEY = "gsk_dummydummydummy0123";
  process.env.TYPESAFE_API_KEY = "ts_dummydummydummy0123";
  delete process.env.EMINIAR_ADJUDICATOR;
  delete process.env.EMINIAR_ADJUDICATOR_PROVIDER;
  delete process.env.EMINIAR_ADJUDICATOR_REMOTE;
  root = mkdtempSync(join(tmpdir(), "pin3-root-"));
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const personal = (adj: Record<string, unknown>) =>
  writeFileSync(paths().configFile, JSON.stringify({ adjudicator: adj }));
const state = () => {
  const c = loadConfig(root).adjudicator;
  const r = resolveAdjudicator(c, { context: "server", env: process.env });
  return {
    configured: c.provider,
    provider: r.provider,
    remote: r.remote,
    degraded: r.degraded,
    commit: decisionInactiveReason(c, "commit", process.env) ?? "ACTIVE",
  };
};

describe("#348 the env cannot re-aim the provider at another origin", () => {
  it("reviewer repro: personal heuristic with stale groq consent + env openai-compatible sends nothing", () => {
    personal(TRIED_GROQ);
    expect(state().provider).toBe("heuristic");
    process.env.EMINIAR_ADJUDICATOR_PROVIDER = "openai-compatible";
    const s = state();
    expect(s.configured).toBe("openai-compatible");
    expect([s.provider, s.remote, s.degraded]).toEqual(["heuristic", false, "no_consent"]);
    expect(s.commit).not.toBe("ACTIVE");
    expect(loadConfig(root).adjudicator.remoteConsent).toBe(false);
  });

  it("no provider in the personal file: the env may not pick a remote one", () => {
    const { provider: _p, ...rest } = TRIED_GROQ;
    personal(rest);
    process.env.EMINIAR_ADJUDICATOR_PROVIDER = "openai-compatible";
    expect(state()).toMatchObject({ provider: "heuristic", degraded: "no_consent" });
  });

  it("personal typesafe (consented) + env openai-compatible (groq also consented): nothing runs", () => {
    personal({
      ...TRIED_GROQ,
      provider: "typesafe",
      remoteConsentOrigins: [TYPESAFE, GROQ],
      featureConsent: [`diffs@${TYPESAFE}`, `diffs@${GROQ}`],
    });
    expect(state()).toMatchObject({ provider: "typesafe", remote: true, commit: "ACTIVE" });
    process.env.EMINIAR_ADJUDICATOR_PROVIDER = "openai-compatible";
    expect(state()).toMatchObject({ provider: "heuristic", degraded: "no_consent" });
    process.env.EMINIAR_ADJUDICATOR_PROVIDER = "typesafe";
    expect(state()).toMatchObject({ provider: "typesafe", remote: true, commit: "ACTIVE" });
  });

  it("control: the env naming the personal provider changes nothing", () => {
    personal({ ...TRIED_GROQ, provider: "openai-compatible", openai: { preset: "groq" } });
    expect(state()).toMatchObject({
      provider: "openai-compatible",
      remote: true,
      commit: "ACTIVE",
    });
    process.env.EMINIAR_ADJUDICATOR_PROVIDER = "openai-compatible";
    expect(state()).toMatchObject({
      provider: "openai-compatible",
      remote: true,
      commit: "ACTIVE",
    });
    expect(loadConfig(root).adjudicator.remoteConsent).toBe(true);
  });

  it("the env may always step down to a provider that sends nothing", () => {
    personal({ ...TRIED_GROQ, provider: "openai-compatible", openai: { preset: "groq" } });
    process.env.EMINIAR_ADJUDICATOR_PROVIDER = "heuristic";
    expect(state()).toMatchObject({ provider: "heuristic", remote: false, degraded: undefined });
    process.env.EMINIAR_ADJUDICATOR_PROVIDER = "embedding";
    expect(state()).toMatchObject({ provider: "embedding", remote: false });
    // Stepping down keeps the personal consent (it is the personal provider's, not the env's).
    expect(loadConfig(root).adjudicator.remoteConsent).toBe(true);
  });

  it("an env-picked provider pointed at this machine still runs locally", () => {
    personal({ ...TRIED_GROQ, openai: { preset: "ollama" } });
    process.env.EMINIAR_ADJUDICATOR_PROVIDER = "openai-compatible";
    const s = state();
    expect([s.provider, s.remote, s.degraded]).toEqual(["openai-compatible", false, undefined]);
  });

  it("the project file cannot help: provider stays out of the project layer", () => {
    personal(TRIED_GROQ);
    writeFileSync(
      join(root, "eminiar.config.json"),
      JSON.stringify({ adjudicator: { enabled: true, provider: "openai-compatible" } }),
    );
    expect(state()).toMatchObject({ configured: "heuristic", provider: "heuristic" });
    process.env.EMINIAR_ADJUDICATOR_PROVIDER = "openai-compatible";
    expect(state()).toMatchObject({ provider: "heuristic", degraded: "no_consent" });
  });

  it("EMINIAR_ADJUDICATOR_REMOTE=0 still withdraws the personal provider's consent", () => {
    personal({ ...TRIED_GROQ, provider: "openai-compatible", openai: { preset: "groq" } });
    process.env.EMINIAR_ADJUDICATOR_REMOTE = "0";
    expect(state()).toMatchObject({ provider: "heuristic", degraded: "no_consent" });
  });
});
