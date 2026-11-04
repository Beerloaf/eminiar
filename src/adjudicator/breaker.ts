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
 * `calls` counts every call that reached the provider on the same UTC day; at
 * `budget.dailyCalls` (0 = unlimited) a remote provider is skipped too, which is what limits a
 * provider whose price is unknown.
 *
 * Auth: a 401/403 sets state "auth_failed" with the fingerprint (sha256 of the key, first 12
 * hex, never the key) of the key that was rejected. The provider is skipped (status
 * "auth_failed") without any network call until the key changes or AUTH_LOCKOUT_MS passes.
 *
 * Every function is synchronous (better-sqlite3) and swallows nothing: the engine wraps them.
 */

import { createHash } from "node:crypto";
import type { AdjudicatorConfig } from "../config.js";
import type { AdjudicatorProviderState, AdjudicatorStore } from "../storage/types.js";
import type { ProviderStatus } from "./types.js";

/** The slow guard needs at least this many latencies before a p95 means anything. */
export const SLOW_MIN_SAMPLES = 5;
/** How long a rejected key keeps the provider skipped when the key does not change. */
export const AUTH_LOCKOUT_MS = 3_600_000;

export type GateDecision =
  | { allow: true; halfOpen: boolean; state: AdjudicatorProviderState | undefined }
  | {
      allow: false;
      status: Extract<
        ProviderStatus,
        "breaker_open" | "slow_guard" | "over_budget" | "auth_failed"
      >;
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

/** Calls made today: a stored count from an earlier UTC day counts as 0. */
export function callsToday(s: AdjudicatorProviderState | undefined, now: number): number {
  if (!s || s.spendDay !== utcDay(now)) return 0;
  return s.calls ?? 0;
}

/** Identifies a key without revealing it: sha256(key), first 12 hex chars. */
export function keyFingerprint(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 12);
}

/** HTTP 401/403: the provider rejected the key. */
export function isAuthFailure(kind: FailureClass, status?: number): boolean {
  return kind === "http_error" && (status === 401 || status === 403);
}

export interface AuthLockout {
  /** The provider is skipped for the key in use (or for an unknown key). */
  locked: boolean;
  /** When the lockout ends even if the key does not change. */
  until: number | null;
  /** Fingerprint of the rejected key (never the key). */
  fingerprint: string | null;
  /** The key in use differs from the rejected one, so the next call retries. */
  keyChanged: boolean;
  /** lastErrorClass, e.g. "http_error:401". */
  errorClass: string | null;
}

/**
 * The auth lockout of a stored state, for the gate and for status/doctor/dashboard ("API key
 * rejected"). undefined when the provider is not in state auth_failed. `keyFingerprint` is
 * the fingerprint of the key in use now; when it is omitted the key is assumed unchanged.
 */
export function authLockout(
  s: AdjudicatorProviderState | undefined,
  now: number,
  currentFingerprint?: string | null,
): AuthLockout | undefined {
  if (s?.state !== "auth_failed") return undefined;
  const keyChanged =
    currentFingerprint !== undefined && (currentFingerprint ?? null) !== s.authFingerprint;
  const expired = s.retryAt === null || now >= s.retryAt;
  return {
    locked: !keyChanged && !expired,
    until: s.retryAt,
    fingerprint: s.authFingerprint,
    keyChanged,
    errorClass: s.lastErrorClass,
  };
}

/**
 * May this provider be called now? Claims the half-open slot when an open breaker has cooled
 * down, and resets an expired slow state (with an empty latency ring).
 */
export function gate(
  store: AdjudicatorStore,
  provider: string,
  cfg: Pick<AdjudicatorConfig, "breaker" | "budget">,
  o: { now: number; remote: boolean; keyFingerprint?: string | null | undefined },
): GateDecision {
  let s = store.providerState(provider);
  const cooldownMs = cfg.breaker.cooldownSec * 1000;
  let halfOpen = false;

  if (s?.state === "auth_failed") {
    // Rejected key: skip without a call until the key changes or the lockout expires.
    const lock = authLockout(s, o.now, o.keyFingerprint);
    if (lock?.locked) return { allow: false, status: "auth_failed" };
    s = store.saveProviderState(provider, {
      state: "closed",
      retryAt: null,
      authFingerprint: null,
    });
  }

  if (s?.state === "open" || s?.state === "half_open") {
    // half_open with a future retryAt: another process holds the trial call.
    if (s.retryAt !== null && o.now < s.retryAt) return { allow: false, status: "breaker_open" };
    s = store.saveProviderState(provider, { state: "half_open", retryAt: o.now + cooldownMs });
    halfOpen = true;
  } else if (s?.state === "slow") {
    if (s.retryAt !== null && o.now < s.retryAt) return { allow: false, status: "slow_guard" };
    s = store.saveProviderState(provider, { state: "closed", retryAt: null, latencies: [] });
  }

  if (o.remote && overBudget(s, cfg, o.now)) {
    // Hand the half-open slot back: the breaker did not get its trial call.
    if (halfOpen) store.saveProviderState(provider, { state: "open", retryAt: o.now });
    return { allow: false, status: "over_budget" };
  }
  return { allow: true, halfOpen, state: s };
}

/** Today's USD spend reached budget.dailyUsd, or today's calls reached budget.dailyCalls (> 0). */
export function overBudget(
  s: AdjudicatorProviderState | undefined,
  cfg: Pick<AdjudicatorConfig, "budget">,
  now: number,
): boolean {
  if (spendToday(s, now) >= cfg.budget.dailyUsd) return true;
  const cap = cfg.budget.dailyCalls;
  return typeof cap === "number" && cap > 0 && callsToday(s, now) >= cap;
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
    calls: callsToday(s, o.now) + 1,
    authFingerprint: null,
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
    /** Fingerprint of the key the call used (keyFingerprint); stored on a 401/403. */
    keyFingerprint?: string | null | undefined;
  },
): AdjudicatorProviderState {
  const s = store.providerState(provider);
  const cooldownMs = cfg.breaker.cooldownSec * 1000;
  const errorClass = o.status !== undefined ? `${o.kind}:${o.status}` : o.kind;
  // Every call that reached the provider counts towards budget.dailyCalls (no_key never sent one).
  const day = { spendDay: utcDay(o.now), spendUsd: spendToday(s, o.now) };
  const calls = callsToday(s, o.now) + (o.kind === "no_key" ? 0 : 1);
  if (isAuthFailure(o.kind, o.status)) {
    // Not a breaker failure: retrying will not help until the key changes.
    return store.saveProviderState(provider, {
      state: "auth_failed",
      retryAt: o.now + AUTH_LOCKOUT_MS,
      authFingerprint: o.keyFingerprint ?? null,
      lastErrorAt: o.now,
      lastErrorClass: errorClass,
      ...day,
      calls,
    });
  }
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
    lastErrorClass: errorClass,
    latencies,
    ...day,
    calls,
  });
}

function isSlow(latencies: readonly number[], budgetMs: number): boolean {
  if (latencies.length < SLOW_MIN_SAMPLES) return false;
  const p = p95(latencies.slice(-50));
  return p !== undefined && p > budgetMs;
}
