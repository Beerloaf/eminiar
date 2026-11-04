/**
 * Provider guards (docs/design/adjudicator.md §9): a circuit breaker, a p95 latency guard and a
 * daily spend cap, one set per provider, persisted in `adjudicator_provider_state` because every
 * hook runs in a new process.
 *
 * States: closed → open after `breaker.failures` consecutive timeouts, 5xx, 429/529 or refused
 * connections. Open lasts `cooldownSec`; then ONE call goes through as half_open (claimed by
 * writing half_open with a fresh retryAt, so a parallel hook still sees the provider as open).
 * Success closes it, a failure reopens it. "slow" is set when the p95 of the last latencies
 * exceeds the surface budget; the provider is skipped for `cooldownSec`, after which the ring
 * starts over.
 *
 * Spend: `spendUsd` accumulates per UTC day. At `budget.dailyUsd` or above a REMOTE provider is
 * skipped (local providers cost nothing and are never capped). A call whose price is unknown
 * (costUsd null) adds no dollars: its row keeps cost_usd NULL so stats can show "unknown".
 *
 * Every function is synchronous (better-sqlite3) and swallows nothing: the engine wraps them.
 */

import type { AdjudicatorConfig } from "../config.js";
import type { AdjudicatorProviderState, AdjudicatorStore } from "../storage/types.js";
import type { ProviderStatus } from "./types.js";

/** The slow guard needs at least this many latencies before a p95 means anything. */
export const SLOW_MIN_SAMPLES = 5;

export type GateDecision =
  | { allow: true; halfOpen: boolean; state: AdjudicatorProviderState | undefined }
  | {
      allow: false;
      status: Extract<ProviderStatus, "breaker_open" | "slow_guard" | "over_budget">;
    };

export type FailureClass = "timeout" | "http_error" | "rate_limited" | "invalid" | "no_key";

/** UTC day key, YYYY-MM-DD. */
export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Nearest-rank p95; undefined for an empty ring. */
export function p95(values: readonly number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)];
}

/** Today's spend: a stored figure from an earlier UTC day counts as 0. */
export function spendToday(s: AdjudicatorProviderState | undefined, now: number): number {
  if (!s || s.spendDay !== utcDay(now)) return 0;
  return s.spendUsd;
}

/**
 * May this provider be called now? Claims the half-open slot when an open breaker has cooled
 * down, and resets an expired slow state (with an empty latency ring).
 */
export function gate(
  store: AdjudicatorStore,
  provider: string,
  cfg: Pick<AdjudicatorConfig, "breaker" | "budget">,
  o: { now: number; remote: boolean },
): GateDecision {
  let s = store.providerState(provider);
  const cooldownMs = cfg.breaker.cooldownSec * 1000;
  let halfOpen = false;

  if (s?.state === "open" || s?.state === "half_open") {
    // half_open with a future retryAt: another process holds the trial call.
    if (s.retryAt !== null && o.now < s.retryAt) return { allow: false, status: "breaker_open" };
    s = store.saveProviderState(provider, { state: "half_open", retryAt: o.now + cooldownMs });
    halfOpen = true;
  } else if (s?.state === "slow") {
    if (s.retryAt !== null && o.now < s.retryAt) return { allow: false, status: "slow_guard" };
    s = store.saveProviderState(provider, { state: "closed", retryAt: null, latencies: [] });
  }

  if (o.remote && spendToday(s, o.now) >= cfg.budget.dailyUsd) {
    // Hand the half-open slot back: the breaker did not get its trial call.
    if (halfOpen) store.saveProviderState(provider, { state: "open", retryAt: o.now });
    return { allow: false, status: "over_budget" };
  }
  return { allow: true, halfOpen, state: s };
}

/** A successful call: close the breaker, record latency and spend, then apply the slow guard. */
export function recordSuccess(
  store: AdjudicatorStore,
  provider: string,
  cfg: Pick<AdjudicatorConfig, "breaker">,
  o: { now: number; latencyMs: number; costUsd: number | null; budgetMs: number },
): AdjudicatorProviderState {
  const s = store.providerState(provider);
  const day = utcDay(o.now);
  const spent = spendToday(s, o.now) + (o.costUsd ?? 0);
  const latencies = [...(s?.latencies ?? []), Math.max(0, Math.round(o.latencyMs))];
  const slow = isSlow(latencies, o.budgetMs);
  return store.saveProviderState(provider, {
    state: slow ? "slow" : "closed",
    failures: 0,
    retryAt: slow ? o.now + cfg.breaker.cooldownSec * 1000 : null,
    lastOkAt: o.now,
    latencies,
    spendDay: day,
    spendUsd: spent,
  });
}

/** Does this error class count towards opening the breaker? (§9: timeouts, 5xx, 429/529, refused.) */
export function countsAsFailure(kind: FailureClass, status?: number): boolean {
  if (kind === "timeout" || kind === "rate_limited") return true;
  if (kind === "http_error") return status === undefined || status >= 500;
  return false;
}

/** A failed call: count it, open the breaker at the threshold (or straight away from half_open). */
export function recordFailure(
  store: AdjudicatorStore,
  provider: string,
  cfg: Pick<AdjudicatorConfig, "breaker">,
  o: {
    now: number;
    kind: FailureClass;
    status?: number | undefined;
    latencyMs?: number | undefined;
    budgetMs: number;
    halfOpen: boolean;
  },
): AdjudicatorProviderState {
  const s = store.providerState(provider);
  const cooldownMs = cfg.breaker.cooldownSec * 1000;
  const counts = countsAsFailure(o.kind, o.status);
  const failures = counts ? (s?.failures ?? 0) + 1 : (s?.failures ?? 0);
  const latencies =
    o.kind === "timeout" && o.latencyMs !== undefined
      ? [...(s?.latencies ?? []), Math.max(0, Math.round(o.latencyMs))]
      : (s?.latencies ?? []);
  let state: string;
  let retryAt: number | null;
  if (counts && (o.halfOpen || failures >= cfg.breaker.failures)) {
    state = "open";
    retryAt = o.now + cooldownMs;
  } else if (o.halfOpen) {
    // A non-breaker error (invalid answer, 4xx) on the trial call: the provider is reachable.
    state = "closed";
    retryAt = null;
  } else if (isSlow(latencies, o.budgetMs)) {
    state = "slow";
    retryAt = o.now + cooldownMs;
  } else {
    state = s?.state === "slow" ? "closed" : (s?.state ?? "closed");
    retryAt = s?.retryAt ?? null;
  }
  return store.saveProviderState(provider, {
    state,
    failures,
    retryAt,
    lastErrorAt: o.now,
    lastErrorClass: o.status !== undefined ? `${o.kind}:${o.status}` : o.kind,
    latencies,
  });
}

function isSlow(latencies: readonly number[], budgetMs: number): boolean {
  if (latencies.length < SLOW_MIN_SAMPLES) return false;
  const p = p95(latencies.slice(-50));
  return p !== undefined && p > budgetMs;
}
