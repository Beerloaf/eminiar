import { type FailureClass, gate, recordFailure, recordSuccess } from "../adjudicator/breaker.js";
import { currentKeyFingerprint, resolveAdjudicator } from "../adjudicator/config.js";
import type { Embedder } from "../adjudicator/providers/embedding.js";
import { type FetchLike, ProviderError } from "../adjudicator/providers/http.js";
import { forRemote } from "../adjudicator/redact.js";
import type { HttpExchange } from "../adjudicator/types.js";
import type { AdjudicatorConfig } from "../config.js";
import type { StorageAdapter } from "../storage/adapter.js";
import type { ExchangeInput } from "../storage/types.js";
import { decisionCacheKey } from "./cache.js";
import { decisionFeatureActive, decisionFeatureConfig, decisionInactiveReason } from "./config.js";
import { createDecisionProvider } from "./providers/index.js";
import type { DecisionProvider } from "./providers/types.js";
import {
  type Answers,
  type AskInput,
  type AskResult,
  DECISION_USABLE,
  type Decision,
  type DecisionAnswer,
  type DecisionClient,
  type DecisionContext,
  type DecisionFeature,
  type DecisionStatus,
} from "./types.js";

const DEFAULT_TTL_MS = 24 * 3_600_000;
const NOTE_DEDUPE_MS = 3_600_000;

export interface DecisionClientDeps {
  config: AdjudicatorConfig;
  db: StorageAdapter;
  context: DecisionContext;
  env?: NodeJS.ProcessEnv;
  fetch?: FetchLike;
  now?: () => number;
  log?: (line: string) => void;
  /** The embedding provider's embedder; only the MCP server and CLI have one. */
  getEmbedder?: () => Promise<Embedder | undefined>;
  /** Test seam: use this provider instead of the one the adjudicator resolves. */
  provider?: DecisionProvider;
}

const FAILURE: Record<string, FailureClass> = {
  timeout: "timeout",
  http_error: "http_error",
  rate_limited: "rate_limited",
  invalid: "invalid",
  no_key: "no_key",
};

/**
 * The decision client (docs/design/jev-integration-options.md): typed questions answered by
 * whichever provider the adjudicator runs (Jev, an OpenAI-compatible endpoint, or the local
 * embedding provider). It gates on that provider's own breaker row, redacts every byte that
 * leaves, caches, records one decision_calls row per ask and enforces shadow mode. ask() never
 * throws; in context "hook" it does no I/O at all. A provider that cannot answer a question kind
 * gives status "unsupported" and the feature keeps its deterministic path.
 */
export function createDecisionClient(
  feature: DecisionFeature,
  deps: DecisionClientDeps,
): DecisionClient {
  const { config: cfg, db, context } = deps;
  const now = deps.now ?? Date.now;
  const fc = () => decisionFeatureConfig(cfg, feature);
  const env = deps.env;
  const maxChars = () => fc().maxChars ?? cfg.privacy.maxChars;
  let activeMemo: boolean | undefined;
  let providerMemo: { r: ReturnType<typeof resolveAdjudicator>; p?: DecisionProvider } | undefined;

  const resolved = () => {
    if (!providerMemo) {
      const r = resolveAdjudicator(cfg, env ? { context: "server", env } : { context: "server" });
      const pd = {
        env,
        fetch: deps.fetch,
        now: deps.now,
        log: deps.log,
        getEmbedder: deps.getEmbedder,
      };
      const p = deps.provider ?? createDecisionProvider(r, cfg, pd);
      providerMemo = p ? { r, p } : { r };
    }
    return providerMemo;
  };
  const modelId = () => resolved().p?.model ?? "";
  const providerId = () => resolved().p?.id ?? cfg.provider;

  const active = (): boolean => (activeMemo ??= decisionFeatureActive(cfg, feature, env));
  const mode = (): "shadow" | "live" => (fc().shadow ? "shadow" : "live");

  /** Redacted context and items as they would be sent. */
  const redacted = (input: Pick<AskInput, "context" | "items" | "cacheContext">) => ({
    context: forRemote(input.context ?? "", cfg.privacy.maxChars),
    cacheContext:
      input.cacheContext === undefined
        ? undefined
        : forRemote(input.cacheContext, cfg.privacy.maxChars),
    items: input.items.map((it) => ({ id: it.id, text: forRemote(it.text, maxChars()) })),
  });

  const keyOf = (
    input: Pick<AskInput, "questionVersion">,
    q: AskInput["questions"][number],
    red: { context: string; cacheContext?: string | undefined },
    it: { id: string; text: string },
  ) =>
    decisionCacheKey({
      feature,
      mode: mode(),
      provider: providerId(),
      model: modelId(),
      questionVersion: input.questionVersion ?? 1,
      question: q,
      context: red.cacheContext ?? red.context,
      itemId: it.id,
      itemText: it.text,
    });

  const cacheLookup = (input: Omit<AskInput, "budgetMs">, ttl: number) => {
    const red = redacted(input);
    const hit: Answers = {};
    const missing: number[] = [];
    red.items.forEach((it, i) => {
      const per: Record<string, DecisionAnswer> = {};
      for (const q of input.questions) {
        const v = ttl > 0 ? db.decisions.cacheGet(keyOf(input, q, red, it), now(), ttl) : undefined;
        if (v) per[q.name] = v as DecisionAnswer;
        else break;
      }
      if (Object.keys(per).length === input.questions.length) hit[it.id] = per;
      else missing.push(i);
    });
    return { red, hit, missing };
  };

  function cached(input: Omit<AskInput, "budgetMs">): Answers | undefined {
    try {
      if (!active() || input.items.length === 0) return undefined;
      const { hit, missing } = cacheLookup(input, input.cacheTtlMs ?? DEFAULT_TTL_MS);
      return missing.length === 0 ? hit : undefined;
    } catch {
      return undefined;
    }
  }

  type RowExtras = {
    items?: number;
    answers?: Answers;
    decision?: Decision;
    applied?: boolean;
    latencyMs?: number;
    tokensIn?: number;
    costUsd?: number | null;
    exchangeId?: number | null;
  };

  function insertRow(
    input: Pick<AskInput, "subject" | "baseline" | "sessionId">,
    status: DecisionStatus,
    x: RowExtras = {},
  ): number | undefined {
    try {
      const d = x.decision;
      return db.decisions.insertCall({
        ts: now(),
        feature,
        context,
        sessionId: input.sessionId ?? null,
        subject: input.subject,
        mode: mode(),
        status,
        items: x.items ?? 0,
        baseline: input.baseline,
        provider: providerId(),
        answers: x.answers,
        decision: d?.decision,
        changed: d?.changed ?? 0,
        applied: x.applied ?? false,
        latencyMs: x.latencyMs ?? null,
        tokensIn: x.tokensIn ?? null,
        costUsd: x.costUsd ?? null,
        model: modelId() || null,
        exchangeId: x.exchangeId ?? null,
        note: d?.note ?? null,
        noteSession:
          d?.note && d.deliver === true && mode() === "live" && x.applied
            ? (input.sessionId ?? null)
            : null,
      });
    } catch (err) {
      deps.log?.(`decisions: could not record a ${feature} call (${(err as Error).message})`);
      return undefined;
    }
  }

  function record(
    input: Pick<AskInput, "feature" | "subject" | "baseline" | "sessionId"> & { items?: number },
    status: DecisionStatus,
    decision?: Decision,
    extra?: { applied?: boolean },
  ): number | undefined {
    const x: RowExtras = { items: input.items ?? 0, applied: extra?.applied === true };
    if (decision) x.decision = decision;
    return insertRow(input, status, x);
  }

  async function ask(input: AskInput, decide: (a: Answers) => Decision): Promise<AskResult> {
    const t0 = now();
    const result = (status: DecisionStatus, x: Partial<AskResult> = {}): AskResult => ({
      status,
      mode: mode(),
      apply: false,
      answers: {},
      latencyMs: now() - t0,
      costUsd: null,
      ...x,
    });
    /** A failure status: one decision_calls row, no answers. */
    const rowResult = (status: DecisionStatus, x: RowExtras = {}): AskResult => {
      const callId = insertRow(input, status, x);
      return result(status, callId === undefined ? {} : { callId });
    };
    try {
      // Hooks never touch the network or the database through ask().
      if (context === "hook") return result("skipped");
      if (!active()) {
        if (!fc().enabled) return result("disabled");
        const status: DecisionStatus =
          decisionInactiveReason(cfg, feature, env ?? process.env) ?? "disabled";
        // A misconfiguration shows on the dashboard, at most once per feature per hour.
        return db.decisions.countSince(feature, status, t0 - NOTE_DEDUPE_MS) === 0
          ? rowResult(status)
          : result(status);
      }
      if (input.items.length === 0 || input.questions.length === 0) return result("skipped");

      const cap = fc().maxCallsPerDay;
      if (cap > 0 && db.decisions.callsToday(feature, t0) >= cap) return rowResult("feature_cap");

      // The deterministic path stands for a question kind the provider cannot answer.
      const { r, p: provider } = resolved();
      if (!provider || !input.questions.every((q) => provider.supports(q.kind, q)))
        return rowResult("unsupported");

      const ttl = input.cacheTtlMs ?? DEFAULT_TTL_MS;
      const { red, hit, missing } = cacheLookup(input, ttl);
      const finish = (status: DecisionStatus, answers: Answers, x: RowExtras = {}): AskResult => {
        let decision: Decision | undefined;
        let st = status;
        if (DECISION_USABLE.includes(st)) {
          try {
            decision = decide(answers);
          } catch (err) {
            deps.log?.(`decisions: ${feature} decide threw (${(err as Error).message})`);
            st = "error";
          }
        }
        const apply =
          !input.fillOnly &&
          mode() === "live" &&
          // A partial batch (some items unanswered) never acts: the baseline stands for all of it.
          // Every feature is batch-wise (a reordered list, a guide, a discovery set), so none is
          // itemwise-safe; the answered items are still cached and recorded.
          st !== "partial" &&
          DECISION_USABLE.includes(st) &&
          (decision?.changed ?? 0) > 0;
        const row: RowExtras = {
          ...x,
          items: input.items.length,
          answers,
          applied: apply,
          latencyMs: x.latencyMs ?? now() - t0,
        };
        if (decision) row.decision = decision;
        const callId = insertRow(input, st, row);
        const res = result(st, { apply, answers, costUsd: x.costUsd ?? null });
        if (decision) res.decision = decision;
        if (callId !== undefined) res.callId = callId;
        return res;
      };

      if (missing.length === 0) return finish("cached", hit);

      // The provider's breaker row is the adjudicator's own, so breaker and budget are shared.
      const fingerprint = currentKeyFingerprint(r, env);
      const lockWaitMs = Math.max(0, Math.min(200, Math.floor(input.budgetMs / 4)));
      let halfOpen = false;
      try {
        const g = gate(db.adjudicator, provider.id, cfg, {
          now: t0,
          remote: r.remote,
          keyFingerprint: fingerprint,
          lockWaitMs,
        });
        if (!g.allow) return rowResult(g.status);
        halfOpen = g.halfOpen;
      } catch {
        // A busy database fails CLOSED: no call.
        return rowResult("skipped");
      }

      // Positional wire ids: no memory name or path leaves the machine as an identifier.
      const wire = missing.map((m, n) => ({
        id: `i${n}`,
        text: red.items[m]?.text ?? "",
        index: m,
      }));
      const perReq = Math.max(1, Math.floor(provider.maxPairs / input.questions.length));
      const chunks: (typeof wire)[] = [];
      for (let i = 0; i < wire.length && chunks.length < provider.maxRequests; i += perReq)
        chunks.push(wire.slice(i, i + perReq));

      const captureOn = cfg.privacy.captureExchanges === true;
      const sink: HttpExchange[] = [];
      const ctl = new AbortController();
      const onAbort = () => ctl.abort();
      input.signal?.addEventListener("abort", onAbort, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<"timeout">((res) => {
        timer = setTimeout(() => res("timeout"), Math.max(0, input.budgetMs));
      });

      const requests = chunks.map(async (chunk) => ({
        chunk,
        res: await provider.ask(
          {
            feature,
            context: red.context,
            items: chunk.map(({ id, text }) => ({ id, text })),
            questions: input.questions,
          },
          {
            deadlineMs: Math.max(1, input.budgetMs - (now() - t0)),
            signal: ctl.signal,
            exchange: captureOn ? (x) => sink.push(x) : undefined,
          },
        ),
      }));

      const settledP = Promise.allSettled(requests);
      const raced = await Promise.race([settledP, deadline]);
      if (timer) clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);

      const elapsed = now() - t0;
      const fail = (kind: FailureClass, status?: number): AskResult => {
        try {
          recordFailure(db.adjudicator, provider.id, cfg, {
            now: now(),
            kind,
            status,
            latencyMs: elapsed,
            budgetMs: input.budgetMs,
            halfOpen,
            keyFingerprint: fingerprint,
            lockWaitMs,
          });
        } catch {
          // best effort: the breaker carries the count in memory
        }
        return rowResult(kind, { latencyMs: elapsed });
      };

      if (raced === "timeout") {
        ctl.abort();
        void settledP.catch(() => {});
        return fail("timeout");
      }
      const ok = raced.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
      if (ok.length === 0) {
        const first = raced.find((s) => s.status === "rejected");
        const e = first?.status === "rejected" ? first.reason : undefined;
        if (e instanceof ProviderError) return fail(FAILURE[e.kind] ?? "invalid", e.status);
        return fail("invalid");
      }

      // An item whose answers are missing or malformed is dropped (the baseline stands).
      const answers: Answers = { ...hit };
      const fresh: Array<{ key: string; a: DecisionAnswer }> = [];
      let tokensIn = 0;
      let costUsd: number | null = 0;
      for (const o of ok) {
        tokensIn += o.res.tokensIn;
        costUsd = costUsd === null || o.res.costUsd === null ? null : costUsd + o.res.costUsd;
        for (const w of o.chunk) {
          const it = red.items[w.index];
          const orig = input.items[w.index];
          const got = o.res.answers[w.id];
          if (!it || !orig || !got) continue;
          const per: Record<string, DecisionAnswer> = {};
          for (const q of input.questions) {
            const a = got[q.name];
            if (!a) break;
            per[q.name] = a;
            fresh.push({ key: keyOf(input, q, red, it), a });
          }
          if (Object.keys(per).length === input.questions.length) answers[orig.id] = per;
        }
      }
      const latencyMs = Math.max(...ok.map((o) => o.res.latencyMs));
      try {
        recordSuccess(db.adjudicator, provider.id, cfg, {
          now: now(),
          latencyMs,
          costUsd,
          budgetMs: input.budgetMs,
          lockWaitMs,
        });
      } catch {
        // best effort
      }
      if (fresh.length === 0) return rowResult("invalid", { latencyMs, tokensIn, costUsd });
      if (ttl > 0)
        try {
          for (const f of fresh) db.decisions.cachePut(f.key, feature, f.a, now());
        } catch {
          // a cache that cannot be written only costs a repeat call
        }
      let exchangeId: number | null = null;
      if (captureOn && cfg.privacy.captureExchanges === true && sink.length) {
        try {
          const callId = `${t0.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
          const xs: ExchangeInput[] = sink.map((x, batch) => ({
            ts: x.sentAt,
            callId,
            batch,
            provider: provider.id,
            model: provider.model,
            surface: `feature:${feature}`,
            context,
            method: x.method,
            target: x.target,
            rowIds: [],
            items: input.items.length,
            outcome: x.outcome === "pending" ? "timeout" : x.outcome,
            httpStatus: x.status,
            timedOut: x.outcome === "pending",
            attempts: x.attempts,
            ttfbMs: x.ttfbMs,
            durationMs: x.durationMs,
            retryWaitMs: x.retryWaitMs,
            deadlineMs: x.deadlineMs,
            budgetMs: input.budgetMs,
            requestBody: x.request.text,
            requestBytes: x.request.bytes,
            requestTruncated: x.request.truncated,
            responseBody: x.response ? x.response.text : null,
            responseBytes: x.response ? x.response.bytes : null,
            responseTruncated: x.response ? x.response.truncated : false,
            error: x.error,
          }));
          exchangeId = db.adjudicator.exchangeInsert(xs)[0] ?? null;
        } catch {
          // fail open: capture never changes a result
        }
      }
      const complete = Object.keys(answers).length === input.items.length;
      return finish(complete ? "ok" : "partial", answers, {
        latencyMs,
        tokensIn,
        costUsd,
        exchangeId,
      });
    } catch (err) {
      deps.log?.(`decisions: ${feature} ask failed (${(err as Error).message})`);
      return result("error");
    }
  }

  return { active, mode, ask, cached, record };
}
