/**
 * The adjudication pipeline (docs/design/adjudicator.md §3, §9):
 *
 *   cache → heuristic → gate (enabled, consent, key, breaker, slow, budget) → provider → blend → persist
 *
 * `adjudicate()` NEVER throws and never waits past its budget: a provider that hangs is cut off
 * by a timer racing the call (its AbortSignal fires at the same moment), so the heuristic comes
 * back within budget + a few ms. Persistence and cache failures (DB busy, v8 not migrated) are
 * swallowed: the verdict is still returned, just not stored.
 *
 * Cache: keyed by sha256(SCORER_VERSION | configured provider | model | surface | text), so the
 * hooks pick up verdicts the server's embedding provider wrote. Only provider-blended verdicts
 * are cached (the heuristic is cheaper than a lookup). A null entry is the `pending` marker of a
 * running async job; it dedupes jobs for PENDING_TTL_MS.
 *
 * Call modes: "inline" calls the provider within the budget; "async" leaves the heuristic in
 * place and spawns one detached job per uncached request (async.ts), which later writes the
 * cache and updates the row; "never" makes no network call at all (advise-mode agent dispatch).
 */

import { createHash } from "node:crypto";
import type { AdjudicatorConfig } from "../config.js";
import type { AdjudicationInput, AdjudicationPatch, AdjudicatorStore } from "../storage/types.js";
import type { AsyncJob } from "./async.js";
import { blend } from "./blend.js";
import { authLockout, gate, overBudget, recordFailure, recordSuccess } from "./breaker.js";
import {
  currentKeyFingerprint,
  type Resolved,
  type RuntimeContext,
  resolveAdjudicator,
} from "./config.js";
import { extractFeatures } from "./features.js";
import { type Catalogue, DEFAULT_TIERS, scoreHeuristic } from "./heuristic.js";
import { createProvider, type ProviderDeps, ProviderError } from "./providers/index.js";
import { head, inputHash, normalize } from "./redact.js";
import {
  type AdjudicationRequest,
  type AdjudicatorProvider,
  type Features,
  type ProviderAnswer,
  type ProviderId,
  type ProviderResult,
  type ProviderStatus,
  SCORER_VERSION,
  type ScoreSet,
  type Surface,
  type Verdict,
} from "./types.js";

/** How long a pending marker blocks a second async job for the same key. */
export const PENDING_TTL_MS = 30_000;
/** Text that goes into the cache key (after normalisation). */
export const CACHE_KEY_CHARS = 2000;
/** Prune the cache on about one write in this many (hooks are separate processes). */
export const PRUNE_EVERY = 100;

export type CallMode = "inline" | "async" | "never";

export interface EngineOptions {
  /** The adjudicator section of the config. */
  config: AdjudicatorConfig;
  /** Where verdicts, rows and breaker state live; without it nothing is cached or persisted. */
  store?: AdjudicatorStore | undefined;
  /** Precomputed resolution (default: resolveAdjudicator(config, {context, env})). */
  resolved?: Resolved | undefined;
  /** Default "hook": the embedding provider only runs in "server" or "cli". */
  context?: RuntimeContext | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  /** Default "inline". */
  call?: CallMode | undefined;
  /** Total budget in ms from the call (default: surfaceBudget for the first request's surface). */
  budgetMs?: number | undefined;
  /** Insert one adjudications row per request (default true; needs `store`). */
  persist?: boolean | undefined;
  /** Extra columns for every inserted row (sessionId, agentId, runId, action, ...). */
  row?: Partial<AdjudicationInput> | undefined;
  /** Extra columns per request, by index (e.g. the plan's taskId). */
  rows?: ReadonlyArray<Partial<AdjudicationInput> | undefined> | undefined;
  /** Learned bias as a flat "<dimension>:<option>" map, or a function per request (learn.ts). */
  bias?:
    | Record<string, number>
    | ((req: AdjudicationRequest, f: Features, h: ScoreSet) => Record<string, number>)
    | undefined;
  /** Registered tool ids; narrows the tool table (default TOOL_IDS). */
  tools?: readonly string[] | undefined;
  /** Role options when a request carries no hints.roles (e.g. the active swarm's roles). */
  roles?: ReadonlyArray<{ name: string; description?: string }> | undefined;
  /** Passed to createProvider (fetch, log, env, tools seams). */
  deps?: ProviderDeps | undefined;
  /** A ready provider (test seam, or the server's long-lived instance); null forces heuristic. */
  provider?: AdjudicatorProvider | null | undefined;
  /**
   * call "async": starts the job; hooks pass spawnAsyncJob from async.ts (the engine does not import
   * it, so async.ts can import the engine without a cycle). Returns false when it could not.
   */
  spawn?: ((job: AsyncJob) => boolean) | undefined;
  /** call "async": the project root the child opens its DB under. */
  projectRoot?: string | undefined;
  /** Run even when `enabled` is false (the CLI's `test`); nothing is persisted then unless persist is true. */
  ignoreEnabled?: boolean | undefined;
  now?: (() => number) | undefined;
  log?: ((line: string) => void) | undefined;
  /** Test seam for the 1-in-PRUNE_EVERY cache prune. */
  random?: (() => number) | undefined;
}

export interface Adjudication {
  request: AdjudicationRequest;
  verdict: Verdict;
  cacheKey: string;
  features: Features;
  /** The adjudications row, when one was inserted. */
  rowId?: number;
  /** call "async": a job was spawned for this request, or one was already pending. */
  queued?: boolean;
  /** The model the provider reported, when it answered. */
  providerModel?: string;
}

/** The provider budget for a surface; local providers use timeouts.localMs on hook surfaces. */
export function surfaceBudget(cfg: AdjudicatorConfig, surface: Surface, local = false): number {
  const t = cfg.timeouts;
  switch (surface) {
    case "prompt":
      return local ? t.localMs : t.promptMs;
    case "agent":
    case "tool":
      return local ? t.localMs : t.agentMs;
    default:
      return t.planMs;
  }
}

/** The cache key (§9): never the text itself. */
export function cacheKeyFor(
  req: Pick<AdjudicationRequest, "surface" | "text">,
  r: Pick<Resolved, "configured" | "model">,
): string {
  const text = normalize(req.text).toLowerCase().replace(/\s+/g, " ").slice(0, CACHE_KEY_CHARS);
  return createHash("sha256")
    .update([SCORER_VERSION, r.configured, r.model ?? "", req.surface, text].join("|"))
    .digest("hex");
}

/** The verdict columns of an adjudications row (insert, or the async job's update). */
export function verdictColumns(
  v: Verdict,
  o: { features?: Features | undefined; providerModel?: string | undefined } = {},
): AdjudicationPatch {
  const u = v.usage;
  const scores = {
    complexity: v.complexity,
    complexityReasons: v.complexityReasons,
    tool: v.tool,
    tier: v.tier,
    role: v.role,
    effort: v.effort,
    features: o.features,
    alpha: v.alpha,
    bias: v.bias,
  };
  return {
    complexity: v.complexity,
    tier: v.tier.choice,
    effort: v.effort,
    tool: v.tool.choice,
    role: v.role.choice,
    confidence: v.tier.confidence,
    scores: JSON.stringify(scores),
    source: v.source,
    provider: v.provider,
    providerModel: o.providerModel ?? null,
    providerStatus: v.providerStatus,
    latencyMs: Math.round(v.latencyMs),
    providerLatencyMs: v.providerLatencyMs !== undefined ? Math.round(v.providerLatencyMs) : null,
    tokensIn: u ? u.inTok : null,
    tokensOut: u ? u.outTok : null,
    costUsd: u ? u.costUsd : null,
    version: v.version,
  };
}

const statusOfDegraded = (r: Resolved): ProviderStatus => {
  switch (r.degraded) {
    case "no_key":
      return "no_key";
    case "no_consent":
      return "no_consent";
    case undefined:
      return "n/a";
    default:
      return "skipped";
  }
};

interface Item {
  req: AdjudicationRequest;
  cfg?: AdjudicatorConfig;
  index: number;
  features: Features;
  h: ScoreSet;
  bias: Record<string, number>;
  cacheKey: string;
  verdict?: Verdict;
  pending?: boolean;
  queued?: boolean;
  providerModel?: string | undefined;
  job?: AsyncJob;
}

/**
 * Score `reqs` through the whole pipeline. Never throws; resolves within the budget (+ timer
 * slack) even when the provider ignores its AbortSignal.
 */
export async function adjudicate(
  reqs: readonly AdjudicationRequest[],
  opts: EngineOptions,
): Promise<Adjudication[]> {
  const now = opts.now ?? Date.now;
  const start = now();
  const log = opts.log ?? (() => {});
  const items: Item[] = [];
  try {
    const cfg = opts.config;
    for (const [index, req] of reqs.entries()) items.push(prepare(req, index, opts));
    if (!items.length) return [];

    const enabled = cfg.enabled || opts.ignoreEnabled === true;
    const r =
      opts.resolved ??
      resolveAdjudicator(cfg, {
        context: opts.context ?? "hook",
        ...(opts.env ? { env: opts.env } : {}),
      });
    const store = opts.store;
    // Off means nothing is written; the CLI's ignoreEnabled run persists only when asked to.
    const persist =
      !!store && (cfg.enabled ? opts.persist !== false : enabled && opts.persist === true);
    const firstSurface = items[0]?.req.surface ?? "prompt";
    const budgetMs = Math.max(0, opts.budgetMs ?? surfaceBudget(cfg, firstSurface, r.local));
    for (const it of items) it.cacheKey = cacheKeyFor(it.req, r);

    if (!enabled) {
      for (const it of items) it.verdict = heuristicVerdict(it, "heuristic", "heuristic", "n/a");
      return finish(items, opts, start, now, false);
    }

    // 1. Cache (not for a configured heuristic: scoring is cheaper than the lookup).
    const useCache = r.configured !== "heuristic" && !!store;
    if (useCache && store) {
      const ttlMs = cfg.cache.ttlHours * 3_600_000;
      for (const it of items) {
        const hit = safe(() => store.cacheGet(it.cacheKey, now(), ttlMs), log);
        if (!hit) continue;
        if (hit.verdict) {
          // A hit costs nothing and belongs to no earlier row.
          const { id: _id, usage: _usage, providerLatencyMs: _pl, ...cached } = hit.verdict;
          it.verdict = { ...cached, key: it.req.key, source: "cache" };
        } else if (now() - hit.createdAt < PENDING_TTL_MS) {
          it.pending = true;
        }
      }
    }
    const misses = items.filter((it) => !it.verdict);
    if (!misses.length) return finish(items, opts, start, now, persist);

    // 2. Gate: effective provider, call mode, provider instance, breaker / slow / budget.
    const fallback = (status: ProviderStatus) => {
      const source = r.configured === "heuristic" ? "heuristic" : "fallback";
      for (const it of misses) it.verdict = heuristicVerdict(it, r.configured, source, status);
      return finish(items, opts, start, now, persist);
    };
    if (r.provider === "heuristic") return fallback(statusOfDegraded(r));
    const call = opts.call ?? "inline";
    if (call === "never") return fallback("skipped");
    const provider =
      opts.provider !== undefined
        ? opts.provider
        : safe(
            () => createProvider(r, cfg, { log, env: opts.env, tools: opts.tools, ...opts.deps }),
            log,
          );
    if (!provider) return fallback("skipped");

    // Fingerprint of the key in use (never the key): a 401/403 locks out only this key.
    const keyFp = safe(() => currentKeyFingerprint(r, opts.env), log) ?? null;

    if (call === "async") {
      // The hook only peeks at the breaker; the child claims a half-open slot when it runs.
      const peek = store ? safe(() => peekGate(store, r, cfg, now(), keyFp), log) : undefined;
      if (peek) return fallback(peek);
      for (const it of misses) {
        it.verdict = heuristicVerdict(it, r.configured, "fallback", "skipped");
        if (it.pending) it.queued = true;
        else it.job = buildJob(it, cfg, opts, budgetMs);
      }
      // Rows first, so each job can carry the id of the row it will update.
      const out = finish(items, opts, start, now, persist);
      for (const [i, it] of items.entries()) {
        if (!it.job) continue;
        const a = out[i] as Adjudication;
        if (a.rowId !== undefined) it.job.rowId = a.rowId;
        const job = it.job;
        const spawned = opts.spawn ? safe(() => opts.spawn?.(job), log) === true : false;
        if (!opts.spawn) log("adjudicator: async call without a spawn function");
        if (!spawned) continue;
        a.queued = true;
        if (store) safe(() => store.cachePut(it.cacheKey, null, r.configured, now()), log);
      }
      return out;
    }

    let halfOpen = false;
    if (store) {
      const g = safe(
        () => gate(store, r.provider, cfg, { now: now(), remote: r.remote, keyFingerprint: keyFp }),
        log,
      );
      if (g && !g.allow) return fallback(g.status);
      halfOpen = !!g?.allow && g.halfOpen;
    }

    // 3. Provider, raced against the remaining budget.
    const remaining = budgetMs - (now() - start);
    if (remaining <= 0) return fallback("timeout");
    const callStart = now();
    const outcome = await callWithin(
      provider,
      misses.map((it) => it.req),
      remaining,
    );
    const providerLatencyMs = now() - callStart;

    if (!outcome.ok) {
      const kind = outcome.kind;
      log(`adjudicator: ${r.provider} ${kind}${outcome.status ? ` ${outcome.status}` : ""}`);
      if (store)
        safe(
          () =>
            recordFailure(store, r.provider, cfg, {
              now: now(),
              kind,
              status: outcome.status,
              latencyMs: providerLatencyMs,
              budgetMs,
              halfOpen,
              keyFingerprint: keyFp,
            }),
          log,
        );
      for (const it of misses) {
        it.verdict = heuristicVerdict(it, r.provider, "fallback", kind);
        it.verdict.providerLatencyMs = providerLatencyMs;
      }
      return finish(items, opts, start, now, persist);
    }

    // 4. Blend each answered request; missing answers keep the heuristic (per key).
    const res = outcome.result;
    if (store)
      safe(
        () =>
          recordSuccess(store, r.provider, cfg, {
            now: now(),
            latencyMs: res.latencyMs || providerLatencyMs,
            costUsd: res.usage.costUsd,
            budgetMs,
          }),
        log,
      );
    const byKey = new Map<string, ProviderAnswer>();
    for (const a of res.answers) if (!byKey.has(a.key)) byKey.set(a.key, a);
    const answered = misses.filter((it) => byKey.has(it.req.key)).length;
    // Each answered request carries its share of the batch's usage, so rows and cache entries
    // sum to what the call cost.
    const share = answered ? 1 / answered : 0;
    const u = res.usage;
    const usage = {
      inTok: Math.round(u.inTok * share),
      outTok: Math.round(u.outTok * share),
      costUsd: u.costUsd === null ? null : u.costUsd * share,
    };
    for (const it of misses) {
      const answer = byKey.get(it.req.key);
      if (!answer) {
        it.verdict = heuristicVerdict(it, r.provider, "fallback", "skipped");
        it.verdict.providerLatencyMs = providerLatencyMs;
        continue;
      }
      it.verdict = blend(it.h, answer, it.bias, cfg.weights, {
        key: it.req.key,
        provider: r.provider,
        providerStatus: "ok",
        source: "blend",
        tiers: cfg.tiers,
        providerLatencyMs,
        usage,
      });
      it.providerModel = res.model || r.model;
      if (store) {
        const v = it.verdict;
        safe(() => store.cachePut(it.cacheKey, v, r.configured, now()), log);
      }
    }
    if (store && answered && (opts.random ?? Math.random)() < answered / PRUNE_EVERY)
      safe(
        () => store.cachePrune(cfg.cache.maxEntries, cfg.cache.ttlHours * 3_600_000, now()),
        log,
      );
    return finish(items, opts, start, now, persist);
  } catch (err) {
    // Last resort: whatever went wrong, every request still gets a heuristic verdict.
    log(`adjudicator: engine error ${(err as Error)?.message ?? String(err)}`);
    for (const [index, req] of reqs.entries()) {
      const it = items[index] ?? safePrepare(req, index, opts);
      if (!it.verdict) it.verdict = heuristicVerdict(it, "heuristic", "heuristic", "n/a");
      items[index] = it;
    }
    return items.map((it) => ({
      request: it.req,
      verdict: { ...(it.verdict as Verdict), latencyMs: now() - start },
      cacheKey: it.cacheKey,
      features: it.features,
    }));
  }
}

/** One request through the pipeline; never throws. */
export async function adjudicateOne(
  req: AdjudicationRequest,
  opts: EngineOptions,
): Promise<Adjudication> {
  const [out] = await adjudicate([req], opts);
  return out as Adjudication;
}

// --- internals -----------------------------------------------------------------

function prepare(req: AdjudicationRequest, index: number, opts: EngineOptions): Item {
  const cfg = opts.config;
  const features = extractFeatures(req.text, req.hints);
  const catalogue: Catalogue = { tiers: cfg.tiers };
  const tools = opts.tools ?? opts.deps?.tools;
  if (tools) catalogue.tools = tools;
  const roles = req.hints?.roles ?? opts.roles;
  if (roles?.length) catalogue.roles = roles;
  const h = scoreHeuristic(
    features,
    { tierCenters: cfg.weights.tierCenters, features: cfg.weights.features },
    catalogue,
  );
  let bias: Record<string, number> = {};
  if (cfg.learning.enabled && opts.bias)
    bias = typeof opts.bias === "function" ? opts.bias(req, features, h) : opts.bias;
  return { req, index, features, h, bias, cacheKey: "", cfg };
}

/** prepare() for the last-resort path: falls back to empty features if scoring itself throws. */
function safePrepare(req: AdjudicationRequest, index: number, opts: EngineOptions): Item {
  try {
    return prepare(req, index, { ...opts, bias: undefined });
  } catch {
    const features = extractFeatures("", undefined);
    const h = scoreHeuristic(features);
    return { req, index, features, h, bias: {}, cacheKey: "" };
  }
}

function heuristicVerdict(
  it: Item,
  provider: ProviderId,
  source: Verdict["source"],
  status: ProviderStatus,
): Verdict {
  return blend(it.h, undefined, it.bias, it.cfg?.weights ?? {}, {
    tiers: it.cfg?.tiers ?? DEFAULT_TIERS,
    key: it.req.key,
    provider,
    providerStatus: status,
    source,
  });
}

function finish(
  items: Item[],
  opts: EngineOptions,
  start: number,
  now: () => number,
  persist: boolean,
): Adjudication[] {
  const log = opts.log ?? (() => {});
  const cfg = opts.config;
  const latencyMs = now() - start;
  return items.map((it) => {
    const verdict = { ...(it.verdict as Verdict), latencyMs };
    const out: Adjudication = {
      request: it.req,
      verdict,
      cacheKey: it.cacheKey,
      features: it.features,
    };
    if (it.queued) out.queued = true;
    if (it.providerModel) out.providerModel = it.providerModel;
    if (persist && opts.store) {
      const store = opts.store;
      const cols = verdictColumns(verdict, {
        features: it.features,
        providerModel: it.providerModel,
      });
      const row: AdjudicationInput = {
        ...(cols as Omit<AdjudicationInput, "surface" | "inputHash">),
        surface: it.req.surface,
        inputHash: inputHash(it.req.text),
        inputHead: cfg.privacy.storeHead ? head(it.req.text) : null,
        inputChars: it.req.text.length,
        ...opts.row,
        ...opts.rows?.[it.index],
      };
      const id = safe(() => store.insert(row), log);
      if (id !== undefined) {
        out.rowId = id;
        verdict.id = id;
      }
    }
    return out;
  });
}

type CallOutcome =
  | { ok: true; result: ProviderResult }
  | {
      ok: false;
      kind: "timeout" | "http_error" | "rate_limited" | "invalid" | "no_key";
      status?: number;
    };

/** The provider call, cut off at `ms` whether or not the provider honours its signal. */
async function callWithin(
  provider: AdjudicatorProvider,
  reqs: AdjudicationRequest[],
  ms: number,
): Promise<CallOutcome> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<CallOutcome>((resolve) => {
    timer = setTimeout(() => {
      ac.abort();
      resolve({ ok: false, kind: "timeout" });
    }, ms);
    timer.unref?.();
  });
  const attempt = (async (): Promise<CallOutcome> => {
    try {
      const result = await provider.adjudicate(reqs, { signal: ac.signal, deadlineMs: ms });
      return { ok: true, result };
    } catch (err) {
      if (err instanceof ProviderError) {
        const o: CallOutcome = { ok: false, kind: err.kind };
        if (err.status !== undefined) o.status = err.status;
        return o;
      }
      if (ac.signal.aborted || (err as Error)?.name === "AbortError")
        return { ok: false, kind: "timeout" };
      return { ok: false, kind: "invalid" };
    }
  })();
  try {
    return await Promise.race([attempt, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A read-only gate for the async path: locked out, open, slow or over budget, claiming nothing. */
function peekGate(
  store: AdjudicatorStore,
  r: Resolved,
  cfg: AdjudicatorConfig,
  now: number,
  keyFp: string | null,
): ProviderStatus | undefined {
  const s = store.providerState(r.provider);
  if (!s) return undefined;
  if (authLockout(s, now, keyFp)?.locked) return "auth_failed";
  if ((s.state === "open" || s.state === "half_open") && s.retryAt !== null && now < s.retryAt)
    return "breaker_open";
  if (s.state === "slow" && s.retryAt !== null && now < s.retryAt) return "slow_guard";
  if (r.remote && overBudget(s, cfg, now)) return "over_budget";
  return undefined;
}

function buildJob(
  it: Item,
  cfg: AdjudicatorConfig,
  opts: EngineOptions,
  budgetMs: number,
): AsyncJob {
  // Never the key: the child resolves it itself (env or key file).
  const job: AsyncJob = {
    v: 1,
    projectRoot: opts.projectRoot ?? process.cwd(),
    request: it.req,
    cacheKey: it.cacheKey,
    config: cfg,
    context: opts.context ?? "hook",
    budgetMs: 2 * budgetMs,
    bias: it.bias,
  };
  if (opts.tools) job.tools = [...opts.tools];
  if (opts.roles) job.roles = opts.roles.map((r) => ({ ...r }));
  return job;
}

function safe<T>(fn: () => T, log: (line: string) => void): T | undefined {
  try {
    return fn();
  } catch (err) {
    log(`adjudicator: ${(err as Error)?.message ?? String(err)}`);
    return undefined;
  }
}
