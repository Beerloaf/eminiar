/**
 * Provider guards (docs/design/adjudicator.md §9): a circuit breaker, a p95 latency guard and a
 * daily spend cap, one set per provider, persisted in `adjudicator_provider_state` because every
 * hook runs in a new process.
 *
 * States: closed → open after `breaker.failures` consecutive timeouts, 5xx, 429/529 or refused
 * connections. Open lasts `cooldownSec`; then ONE call goes through as half_open (claimed by
 * writing half_open with a fresh retryAt, so a parallel hook still sees the provider as open).
 * Success closes it, a failure reopens it. "slow" is set when, over at least SLOW_MIN_SAMPLES
 * recent calls, the p95 of latency / budget exceeds 1: each sample is judged against the budget
 * of the call that produced it (stored alongside it), so a 4 s warm-up under a 10 s budget never
 * makes a later 150 ms call under a 1.2 s budget look slow. Warm-up and test/probe calls
 * (surface "test") pass `sample: false` and stay out of the ring. The provider is skipped for
 * `cooldownSec`, after which the ring starts over.
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
 * Timeouts: a call cut off at its deadline goes into the latency ring as a sample ABOVE its
 * budget (budget + 1 ms, or what it really took if more), so the p95 ratio counts it as slow.
 * The engine measures the call from its own start while the budget also covers the pre-call
 * work, so the raw wall time of an aborted call is always a little under the budget and would
 * never trip the guard. A provider that times out on more than 1 call in 20 trips the slow guard
 * once SLOW_MIN_SAMPLES samples are in, even though its successes keep resetting the breaker's
 * consecutive-failure streak.
 *
 * Every function is synchronous (better-sqlite3) and swallows nothing: the engine wraps them.
 * gate reads the state WITHOUT a lock (WAL readers never wait) and decides from it; only when it
 * must write (claim the half-open slot, reset an expired slow or auth state) does it re-read and
 * write inside one store.atomically() (BEGIN IMMEDIATE), so parallel hook processes cannot all
 * claim the half-open slot. recordSuccess and recordFailure read-modify-write inside one
 * atomically() too, so no spend/call increment is lost. Each takes `lockWaitMs` to bound how long
 * it waits for another process's write lock; the caller treats a throw as "provider not allowed".
 * A record that could not be written keeps its call and spend in memory (per store) and they are
 * added to the next record that succeeds; the gate counts them meanwhile.
 */

import { createHash } from "node:crypto";
import type { AdjudicatorConfig } from "../config.js";
import type { AdjudicatorProviderState, AdjudicatorStore } from "../storage/types.js";
import type { ProviderStatus } from "./types.js";

/**
 * The slow guard needs at least this many samples before it can trip. Below 20, nearest-rank
 * p95 is the maximum, so a single outlier would decide.
 */
export const SLOW_MIN_SAMPLES = 20;
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

// --- accounting a record could not write ------------------------------------------------

/** Calls and spend of today that a record failed to write (database busy). */
export interface Unrecorded {
  day: string;
  calls: number;
  spendUsd: number;
}

const unrecordedByStore = new WeakMap<AdjudicatorStore, Map<string, Unrecorded>>();

/**
 * What failed records of this store left unwritten for `provider` today (zeros when nothing).
 * A long-lived process (the MCP server) adds it to the next record that succeeds; a hook process
 * exits first, so the engine also logs it.
 */
export function unrecorded(store: AdjudicatorStore, provider: string, now: number): Unrecorded {
  const day = utcDay(now);
  const u = unrecordedByStore.get(store)?.get(provider);
  return u && u.day === day ? { ...u } : { day, calls: 0, spendUsd: 0 };
}

function carry(
  store: AdjudicatorStore,
  provider: string,
  now: number,
  calls: number,
  spendUsd: number,
): void {
  if (!calls && !spendUsd) return;
  const u = unrecorded(store, provider, now);
  let m = unrecordedByStore.get(store);
  if (!m) {
    m = new Map();
    unrecordedByStore.set(store, m);
  }
  m.set(provider, { day: u.day, calls: u.calls + calls, spendUsd: u.spendUsd + spendUsd });
}

function settle(store: AdjudicatorStore, provider: string): void {
  unrecordedByStore.get(store)?.delete(provider);
}

/** The stored state with today's unwritten calls and spend added (for the budget check). */
function withUnrecorded(
  s: AdjudicatorProviderState | undefined,
  u: Unrecorded,
  now: number,
): AdjudicatorProviderState | undefined {
  if (!u.calls && !u.spendUsd) return s;
  const base: AdjudicatorProviderState = s ?? {
    provider: "",
    state: "closed",
    failures: 0,
    retryAt: null,
    lastOkAt: null,
    lastErrorAt: null,
    lastErrorClass: null,
    latencies: [],
    spendDay: null,
    spendUsd: 0,
    calls: 0,
    authFingerprint: null,
  };
  return {
    ...base,
    spendDay: u.day,
    spendUsd: spendToday(s, now) + u.spendUsd,
    calls: callsToday(s, now) + u.calls,
  };
}

// --- gate -------------------------------------------------------------------------------

type GateOptions = {
  now: number;
  remote: boolean;
  keyFingerprint?: string | null | undefined;
  /** Bound on the wait for another process's write lock (default: the connection's). */
  lockWaitMs?: number | undefined;
};

/**
 * May this provider be called now? Claims the half-open slot when an open breaker has cooled
 * down, and resets an expired slow state (with an empty latency ring). Denials and the plain
 * closed case only read; the write lock is taken only to claim or reset. Throws when that write
 * cannot get the lock within `lockWaitMs`: the caller must then NOT call the provider.
 */
export function gate(
  store: AdjudicatorStore,
  provider: string,
  cfg: Pick<AdjudicatorConfig, "breaker" | "budget">,
  o: GateOptions,
): GateDecision {
  const u = unrecorded(store, provider, o.now);
  const s = store.providerState(provider);
  const read = planGate(withUnrecorded(s, u, o.now), cfg, o);
  if (read !== "write") return read.allow ? { ...read, state: s } : read;
  return atomically(store, () => gateTx(store, provider, cfg, o, u), o.lockWaitMs);
}

/** The gate's decision from a state read without a lock, or "write" when it must claim/reset. */
function planGate(
  s: AdjudicatorProviderState | undefined,
  cfg: Pick<AdjudicatorConfig, "budget">,
  o: GateOptions,
): GateDecision | "write" {
  const over = o.remote && overBudget(s, cfg, o.now);
  const future = s?.retryAt !== null && s?.retryAt !== undefined && o.now < s.retryAt;
  if (s?.state === "auth_failed") {
    if (authLockout(s, o.now, o.keyFingerprint)?.locked)
      return { allow: false, status: "auth_failed" };
  } else if (s?.state === "open" || s?.state === "half_open") {
    if (future) return { allow: false, status: "breaker_open" };
  } else if (s?.state === "slow") {
    if (future) return { allow: false, status: "slow_guard" };
  } else {
    return over
      ? { allow: false, status: "over_budget" }
      : { allow: true, halfOpen: false, state: s };
  }
  // A claim or reset is due, but an exhausted budget denies without touching the state.
  return over ? { allow: false, status: "over_budget" } : "write";
}

function gateTx(
  store: AdjudicatorStore,
  provider: string,
  cfg: Pick<AdjudicatorConfig, "breaker" | "budget">,
  o: GateOptions,
  u: Unrecorded,
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
    s = store.saveProviderState(provider, {
      state: "closed",
      retryAt: null,
      latencies: [],
      latencyBudgets: [],
    });
  }

  if (o.remote && overBudget(withUnrecorded(s, u, o.now), cfg, o.now)) {
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
  o: {
    now: number;
    latencyMs: number;
    costUsd: number | null;
    budgetMs: number;
    /** false: a warm-up or test call; its latency stays out of the slow guard (default true). */
    sample?: boolean | undefined;
    /** Bound on the wait for another process's write lock (default: the connection's). */
    lockWaitMs?: number | undefined;
  },
): AdjudicatorProviderState {
  const u = unrecorded(store, provider, o.now);
  return recorded(store, provider, o.now, 1, o.costUsd ?? 0, () =>
    atomically(
      store,
      () => {
        const s = store.providerState(provider);
        const day = utcDay(o.now);
        const spent = spendToday(s, o.now) + u.spendUsd + (o.costUsd ?? 0);
        const ring = o.sample === false ? ringOf(s) : addSample(s, o.latencyMs, o.budgetMs);
        const slow = isSlow(ring);
        return store.saveProviderState(provider, {
          state: slow ? "slow" : "closed",
          failures: 0,
          retryAt: slow ? o.now + cfg.breaker.cooldownSec * 1000 : null,
          lastOkAt: o.now,
          ...ring,
          spendDay: day,
          spendUsd: spent,
          calls: callsToday(s, o.now) + u.calls + 1,
          authFingerprint: null,
        });
      },
      o.lockWaitMs,
    ),
  );
}

/**
 * Run a record; on success the carried calls and spend are now in the stored state, on a throw
 * (database busy) this record's own call and spend are carried instead, and the error rethrown.
 */
function recorded<T>(
  store: AdjudicatorStore,
  provider: string,
  now: number,
  calls: number,
  spendUsd: number,
  fn: () => T,
): T {
  let out: T;
  try {
    out = fn();
  } catch (err) {
    carry(store, provider, now, calls, spendUsd);
    throw err;
  }
  settle(store, provider);
  return out;
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
    /** false: a warm-up or test call; its latency stays out of the slow guard (default true). */
    sample?: boolean | undefined;
    /** Fingerprint of the key the call used (keyFingerprint); stored on a 401/403. */
    keyFingerprint?: string | null | undefined;
    /** Bound on the wait for another process's write lock (default: the connection's). */
    lockWaitMs?: number | undefined;
  },
): AdjudicatorProviderState {
  const u = unrecorded(store, provider, o.now);
  const calls = o.kind === "no_key" ? 0 : 1;
  return recorded(store, provider, o.now, calls, 0, () =>
    atomically(store, () => recordFailureTx(store, provider, cfg, o, u), o.lockWaitMs),
  );
}

function recordFailureTx(
  store: AdjudicatorStore,
  provider: string,
  cfg: Pick<AdjudicatorConfig, "breaker">,
  o: Parameters<typeof recordFailure>[3],
  u: Unrecorded,
): AdjudicatorProviderState {
  const s = store.providerState(provider);
  const cooldownMs = cfg.breaker.cooldownSec * 1000;
  const errorClass = o.status !== undefined ? `${o.kind}:${o.status}` : o.kind;
  // Every call that reached the provider counts towards budget.dailyCalls (no_key never sent one).
  const day = { spendDay: utcDay(o.now), spendUsd: spendToday(s, o.now) + u.spendUsd };
  const calls = callsToday(s, o.now) + u.calls + (o.kind === "no_key" ? 0 : 1);
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
  // A timeout is a sample above its budget (see the header): the call took at least that long.
  const ring =
    o.kind === "timeout" && o.sample !== false
      ? addSample(s, timeoutLatency(o.latencyMs, o.budgetMs), o.budgetMs)
      : ringOf(s);
  let state: string;
  let retryAt: number | null;
  if (counts && (o.halfOpen || failures >= cfg.breaker.failures)) {
    state = "open";
    retryAt = o.now + cooldownMs;
  } else if (o.halfOpen) {
    // A non-breaker error (invalid answer, 4xx) on the trial call: the provider is reachable.
    state = "closed";
    retryAt = null;
  } else if (isSlow(ring)) {
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
    ...ring,
    ...day,
    calls,
  });
}

/** The latency sample of a call cut off at its deadline: never below budget + 1 ms. */
export function timeoutLatency(latencyMs: number | undefined, budgetMs: number): number {
  return Math.max(Math.round(latencyMs ?? 0), Math.round(budgetMs) + 1);
}

/** The store's write transaction when it has one (SQLite: BEGIN IMMEDIATE), else `fn` as is. */
function atomically<T>(store: AdjudicatorStore, fn: () => T, lockWaitMs?: number): T {
  if (store.atomically) return store.atomically(fn, { lockWaitMs });
  return lockWaitMs !== undefined && store.withLockWait ? store.withLockWait(lockWaitMs, fn) : fn();
}

/** The latency ring and its per-sample budgets, kept the same length (0 = budget unknown). */
interface Ring {
  latencies: number[];
  latencyBudgets: number[];
}

/** The stored ring with its budgets aligned to it (older rows have fewer or no budgets). */
function ringOf(s: AdjudicatorProviderState | undefined): Ring {
  const latencies = [...(s?.latencies ?? [])];
  const all = s?.latencyBudgets ?? [];
  const known = all.slice(Math.max(0, all.length - latencies.length));
  const pad = Math.max(0, latencies.length - known.length);
  return { latencies, latencyBudgets: [...new Array<number>(pad).fill(0), ...known] };
}

function addSample(
  s: AdjudicatorProviderState | undefined,
  latencyMs: number,
  budgetMs: number,
): Ring {
  const r = ringOf(s);
  r.latencies.push(Math.max(0, Math.round(latencyMs)));
  r.latencyBudgets.push(Math.max(0, Math.round(budgetMs)));
  return r;
}

/**
 * p95 of latency / budget over the last 50 samples with a known budget is above 1. Samples
 * without one (written before budgets were stored) are ignored rather than guessed.
 */
export function isSlow(ring: Ring): boolean {
  const ratios: number[] = [];
  const from = Math.max(0, ring.latencies.length - 50);
  for (let i = from; i < ring.latencies.length; i++) {
    const budget = ring.latencyBudgets[i] ?? 0;
    const latency = ring.latencies[i];
    if (budget > 0 && latency !== undefined) ratios.push(latency / budget);
  }
  if (ratios.length < SLOW_MIN_SAMPLES) return false;
  const p = p95(ratios);
  return p !== undefined && p > 1;
}
