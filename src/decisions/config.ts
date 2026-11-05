import { resolveAdjudicator } from "../adjudicator/config.js";
import type { AdjudicatorConfig } from "../config.js";
import { hasFeatureConsent } from "./consent.js";
import type { DecisionFeature } from "./types.js";

/** The settings of one feature plus the fields only some features have. */
export type DecisionFeatureConfig = AdjudicatorConfig["features"][DecisionFeature] & {
  maxChars?: number;
};

export function decisionFeatureConfig(
  cfg: AdjudicatorConfig,
  f: DecisionFeature,
): DecisionFeatureConfig {
  return cfg.features[f] as DecisionFeatureConfig;
}

export { featuresWanted } from "../config.js";

/** Why a feature is not active, or undefined when it is. */
export type DecisionInactive = "disabled" | "no_consent";

export function decisionInactiveReason(
  cfg: AdjudicatorConfig,
  f: DecisionFeature,
  env: NodeJS.ProcessEnv = process.env,
): DecisionInactive | undefined {
  if (!cfg.enabled || env.EMINIAR_ADJUDICATOR === "0" || env.EMINIAR_ADJUDICATOR_FEATURES === "0")
    return "disabled";
  if (!cfg.features[f].enabled || cfg.provider === "heuristic") return "disabled";
  const r = resolveAdjudicator(cfg, { context: "server", env });
  if (r.provider === "heuristic") return r.degraded === "no_consent" ? "no_consent" : "disabled";
  // A local provider (embedding, loopback Ollama/LM Studio/llama.cpp) needs no remote consent;
  // a remote one needs the feature's data class agreed at its origin.
  if (r.remote && !hasFeatureConsent(cfg, f, r.origin)) return "no_consent";
  return undefined;
}

const memo = new WeakMap<AdjudicatorConfig, Map<DecisionFeature, boolean>>();

/**
 * Is feature `f` on? True only when the adjudicator is enabled with a working provider (key and
 * origin consent resolved), the feature is enabled, a remote provider's origin has the feature's
 * data class agreed, and EMINIAR_ADJUDICATOR_FEATURES is not 0. Off costs two property reads. Memoised per
 * config object for the process env; an explicit `env` is evaluated every time.
 */
export function decisionFeatureActive(
  cfg: AdjudicatorConfig,
  f: DecisionFeature,
  env?: NodeJS.ProcessEnv,
): boolean {
  if (!cfg.enabled || !cfg.features[f].enabled) return false;
  if (env) return decisionInactiveReason(cfg, f, env) === undefined;
  const m = memo.get(cfg) ?? new Map<DecisionFeature, boolean>();
  memo.set(cfg, m);
  const hit = m.get(f);
  if (hit !== undefined) return hit;
  const v = decisionInactiveReason(cfg, f) === undefined;
  m.set(f, v);
  return v;
}

/** The helper the design names: `featureActive(cfg, "recall")`. */
export const featureActive = decisionFeatureActive;
