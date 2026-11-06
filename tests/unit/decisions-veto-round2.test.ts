/**
 * #326 (review-features-privacy-2 N6): the project file or the env is never the only thing that
 * makes a provider run. Without a personal `enabled: true`, a project `enabled: true` or
 * EMINIAR_ADJUDICATOR=1 turns on the local heuristic only, even when the personal file already
 * names a remote provider, consent and features.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enabledSource } from "../../src/adjudicator/cli.js";
import { loadConfig } from "../../src/config.js";
import { decisionInactiveReason } from "../../src/decisions/config.js";
import { paths } from "../../src/paths.js";

const ORIGIN = "https://api.groq.com";
const ENV_KEYS = ["EMINIAR_HOME", "EMINIAR_ADJUDICATOR", "EMINIAR_ADJUDICATOR_PROVIDER", "R2KEY"];
const saved: Record<string, string | undefined> = {};
let root: string;

const REMOTE = {
  provider: "openai-compatible",
  openai: { preset: "groq" },
  keyEnv: "R2KEY",
  remoteConsent: true,
  remoteConsentOrigins: [ORIGIN],
  featureConsent: [`diffs@${ORIGIN}`],
  features: { commit: { enabled: true, shadow: false } },
};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  const home = mkdtempSync(join(tmpdir(), "veto2-home-"));
  mkdirSync(home, { recursive: true });
  process.env.EMINIAR_HOME = home;
  process.env.R2KEY = "k";
  delete process.env.EMINIAR_ADJUDICATOR;
  delete process.env.EMINIAR_ADJUDICATOR_PROVIDER;
  root = mkdtempSync(join(tmpdir(), "veto2-root-"));
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const personal = (adj: Record<string, unknown>) =>
  writeFileSync(paths().configFile, JSON.stringify({ adjudicator: adj }));
const project = (adj: Record<string, unknown>) =>
  writeFileSync(join(root, "eminiar.config.json"), JSON.stringify({ adjudicator: adj }));
const commit = () => {
  const c = loadConfig(root).adjudicator;
  return {
    enabled: c.enabled,
    provider: c.provider,
    reason: decisionInactiveReason(c, "commit", process.env),
  };
};

describe("#326 project enabled:true turns on the heuristic only", () => {
  it("personal provider + consent but no `enabled` key, project on: heuristic, commit disabled", () => {
    personal(REMOTE);
    project({ enabled: true });
    expect(commit()).toEqual({ enabled: true, provider: "heuristic", reason: "disabled" });
  });

  it("the same with EMINIAR_ADJUDICATOR=1 instead of the project file", () => {
    personal(REMOTE);
    process.env.EMINIAR_ADJUDICATOR = "1";
    expect(commit()).toEqual({ enabled: true, provider: "heuristic", reason: "disabled" });
  });

  it("an env-picked provider does not get round it", () => {
    personal(REMOTE);
    project({ enabled: true });
    process.env.EMINIAR_ADJUDICATOR_PROVIDER = "typesafe";
    expect(commit().provider).toBe("heuristic");
  });

  it("no personal file at all: project on still gives the heuristic", () => {
    project({ enabled: true });
    expect(commit()).toEqual({ enabled: true, provider: "heuristic", reason: "disabled" });
  });

  it("a personal enabled:true keeps the personal provider (project on or not)", () => {
    personal({ ...REMOTE, enabled: true });
    expect(commit()).toEqual({ enabled: true, provider: "openai-compatible", reason: undefined });
    project({ enabled: true });
    expect(commit()).toEqual({ enabled: true, provider: "openai-compatible", reason: undefined });
  });

  it("a personal enabled:false still wins outright", () => {
    personal({ ...REMOTE, enabled: false });
    project({ enabled: true });
    process.env.EMINIAR_ADJUDICATOR = "1";
    expect(commit().enabled).toBe(false);
  });

  it("nothing on anywhere: off", () => {
    personal(REMOTE);
    expect(commit().enabled).toBe(false);
  });
});

describe("#326 enabledSource says when only the heuristic is on", () => {
  it("project or env on without a personal enabled:true", () => {
    personal(REMOTE);
    project({ enabled: true });
    expect(enabledSource(root, {})).toMatch(
      /^project eminiar\.config\.json \(local heuristic only/,
    );
    expect(enabledSource(root, { EMINIAR_ADJUDICATOR: "1" })).toMatch(
      /^env EMINIAR_ADJUDICATOR=1 \(local heuristic only/,
    );
  });

  it("no qualifier with a personal enabled:true or a project false", () => {
    personal({ ...REMOTE, enabled: true });
    project({ enabled: true });
    expect(enabledSource(root, {})).toBe("project eminiar.config.json");
    personal(REMOTE);
    project({ enabled: false });
    expect(enabledSource(root, {})).toBe("project eminiar.config.json");
  });
});
