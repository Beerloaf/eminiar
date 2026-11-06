/**
 * Pure helpers for the Features panel (no Preact, no DOM) so the node tests can cover them.
 * Types come type-only from the web-safe decision types; nothing here imports node: modules.
 */
import type { DecisionFeatureSummary } from "../../../decisions/types.js";
import { formatUsd } from "../../../usage/pricing.js";

/** What each feature decides, for the row subtitle. */
export const FEATURE_HELP: Record<string, string> = {
  recall: "re-ranks recalled memories and docs",
  memory: "flags duplicate or stale memories",
  commit: "advice note before a commit",
  compaction: "triages what to keep when compacting",
  swarm: "judges swarm task results",
  docs: "triages documentation sources",
};

export type FeatureState = "off" | "no consent" | "waiting" | "shadow" | "live";

export function featureState(f: {
  enabled: boolean;
  shadow: boolean;
  inactive: string | null;
}): FeatureState {
  if (!f.enabled) return "off";
  if (f.inactive === "no_consent") return "no consent";
  // Enabled but blocked for any other reason (heuristic provider, no key, features env kill switch).
  if (f.inactive) return "waiting";
  return f.shadow ? "shadow" : "live";
}

/** Why an enabled feature is not running, for the state badge tooltip. */
export function stateTitle(f: { inactive: string | null }): string | undefined {
  if (f.inactive === "no_consent") return "remote consent for this data class has not been given";
  if (f.inactive)
    return "enabled but not running: the provider is heuristic or has no key, or the adjudicator or its features are switched off";
  return undefined;
}

/** Calls whose provider could not answer the question (deterministic path was used). */
export const unsupported = (s: DecisionFeatureSummary): number => s.byStatus.unsupported ?? 0;

/** Statuses where the provider call itself failed (not a guard, consent or unsupported skip). */
const ERROR_STATUSES = ["error", "timeout", "http_error", "rate_limited", "invalid", "auth_failed"];

export function errors(s: DecisionFeatureSummary): number {
  return ERROR_STATUSES.reduce((n, k) => n + (s.byStatus[k] ?? 0), 0);
}

/** Share of answered calls where the provider agreed with the deterministic baseline. */
export function agreementPct(s: DecisionFeatureSummary): number | null {
  return s.ok > 0 ? Math.round((s.agree / s.ok) * 100) : null;
}

export const agreementText = (s: DecisionFeatureSummary): string => {
  const p = agreementPct(s);
  return p === null ? "—" : `${p}% (${s.agree}/${s.ok})`;
};

export const costText = (n: number): string => (n > 0 ? formatUsd(n) : "—");

/** Statuses are free-form strings from the store; list the non-ok ones for a tooltip. */
export function statusTitle(s: DecisionFeatureSummary): string {
  const e = Object.entries(s.byStatus).sort((a, b) => b[1] - a[1]);
  return e.length ? e.map(([k, v]) => `${k} ${v}`).join(", ") : "no calls";
}
