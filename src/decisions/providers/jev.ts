import { z } from "zod";
import { keyFor, type Resolved } from "../../adjudicator/config.js";
import {
  type HttpOptions,
  type HttpResult,
  joinUrl,
  type ProviderDeps,
  ProviderError,
  postJson,
} from "../../adjudicator/providers/http.js";
import type { AdjudicatorConfig } from "../../config.js";
import type { DecisionAnswer, DecisionQuestionSpec } from "../types.js";
import type { DecisionProvider } from "./types.js";

/**
 * TypeSafe's Jev ("System One", docs/design/adjudicator.md §8) on the wire: the pinned model, the
 * response shapes and the one POST, shared by the adjudicator's provider and the decision
 * provider below. Jev's request and response code lives only here; the DecisionClient and the
 * feature modules never see it.
 */

/** The version thresholds were tuned against; aliases are replaced by it. */
export const JEV_PINNED = "jev-1.14.0";
export const JEV_DEFAULT_BASE_URL = "https://api.typesafe.ai/v1";
/** USD per input token; output tokens are free. */
export const JEV_PRICE_IN = 0.042 / 1_000_000;
export const JEV_BATCH = 10;
export const JEV_MAX_REQUESTS = 2;

/** Moving aliases (jev-latest, jev-preview) are never sent: they change silently under tuned thresholds. */
export function pinJevModel(model: string | undefined): string {
  if (!model || /^jev-(latest|preview)$/i.test(model.trim())) return JEV_PINNED;
  return model.trim();
}

const Probabilities = z.record(z.string(), z.number().min(0).max(1));
export const Answer = z.union([
  z.object({
    type: z.literal("choice"),
    choice: z.string(),
    confidence: z.number().min(0).max(1).optional(),
    probabilities: Probabilities.optional(),
  }),
  z.object({
    type: z.literal("score"),
    // On the rubric's own levels (0..criteria-1), echoed in `legend`; not 0..1.
    score: z.number().min(0),
    confidence: z.number().min(0).max(1).optional(),
    probabilities: Probabilities.optional(),
    legend: z.record(z.string(), z.string()).optional(),
  }),
  z.object({ type: z.literal("noul"), noul: z.number().min(0).max(1) }),
]);
export type Answer = z.infer<typeof Answer>;

export const JevResponse = z.object({
  model: z.string().optional(),
  answers: z.record(z.string(), z.unknown()),
  usage: z
    .object({
      input_tokens: z.number().nonnegative().optional(),
      output_tokens: z.number().nonnegative().optional(),
    })
    .optional(),
});
export type JevResponse = z.infer<typeof JevResponse>;

/** One POST to <baseUrl>/systemone. The caller parses the body (JevResponse.safeParse). */
export function postSystemOne(
  baseUrl: string,
  model: string,
  key: string,
  state: unknown,
  questions: unknown,
  http: Omit<HttpOptions, "key">,
): Promise<HttpResult> {
  return postJson(joinUrl(baseUrl, "systemone"), { model, state, questions }, { ...http, key });
}

/**
 * Jev scores on the rubric's levels (0..criteria-1), with the levels echoed in `legend`. The top
 * level comes from the legend when it has one, else from `rubricTop`; a score above it is
 * malformed (undefined). Normalised to 0..1.
 */
export function normalizeScore(
  a: Extract<Answer, { type: "score" }>,
  rubricTop: number,
): number | undefined {
  const levels = Object.keys(a.legend ?? {})
    .map(Number)
    .filter(Number.isInteger);
  const top = levels.length > 1 ? Math.max(...levels) : rubricTop;
  if (top <= 0 || a.score > top) return undefined;
  return a.score / top;
}

/** A wire answer → DecisionAnswer for the question that asked it; undefined when malformed or the wrong kind. */
export function toDecisionAnswer(
  raw: unknown,
  spec: DecisionQuestionSpec,
): DecisionAnswer | undefined {
  const p = Answer.safeParse(raw);
  if (!p.success) return undefined;
  const a = p.data;
  if (spec.kind === "yes_no" && a.type === "noul")
    return { kind: "yes_no", p: a.noul, calibrated: true };
  if (spec.kind === "choice" && a.type === "choice") {
    const options = Object.keys(spec.options ?? {});
    if (!options.includes(a.choice)) return undefined;
    const probs: Record<string, number> = {};
    let sum = 0;
    for (const o of options) {
      const v = a.probabilities?.[o];
      if (v !== undefined && v > 0) {
        probs[o] = v;
        sum += v;
      }
    }
    if (sum <= 0)
      return {
        kind: "choice",
        choice: a.choice,
        probs: { [a.choice]: 1 },
        confidence: a.confidence ?? 0.5,
        calibrated: true,
      };
    for (const o of Object.keys(probs)) probs[o] = (probs[o] ?? 0) / sum;
    return {
      kind: "choice",
      choice: a.choice,
      probs,
      confidence: a.confidence ?? probs[a.choice] ?? 0.5,
      calibrated: true,
    };
  }
  if (spec.kind === "score" && a.type === "score") {
    const value = normalizeScore(a, Math.max(1, (spec.levels?.length ?? 2) - 1));
    return value === undefined
      ? undefined
      : { kind: "score", value, confidence: a.confidence ?? 0.5, calibrated: true };
  }
  return undefined;
}

/**
 * Jev as a decision provider: native probabilities for every kind. One POST per batch; the
 * wire ids and question ids are the batch's own (positional).
 */
export function createJevDecisionProvider(
  r: Resolved,
  cfg: AdjudicatorConfig,
  deps: ProviderDeps = {},
): DecisionProvider {
  const baseUrl = r.baseUrl ?? JEV_DEFAULT_BASE_URL;
  const model = pinJevModel(r.model ?? cfg.typesafe.model);
  return {
    id: "typesafe",
    remote: r.remote,
    model,
    maxPairs: 40,
    maxRequests: JEV_MAX_REQUESTS,
    supports: () => true,
    async ask(batch, o) {
      const key = keyFor({ ...r, keyId: r.keyId ?? "typesafe" }, deps.env)?.key;
      if (!key) throw new ProviderError("no_key", "no key for typesafe");
      const questions: Record<string, unknown> = {};
      for (const it of batch.items)
        for (const q of batch.questions) {
          const instructions = q.instructions.replaceAll(
            "{item}",
            `item "${it.id}" in state.items`,
          );
          questions[`${it.id}.${q.name}`] =
            q.kind === "choice"
              ? { type: "choice", instructions, criteria: q.options ?? {} }
              : q.kind === "score"
                ? { type: "score", instructions, criteria: q.levels ?? [] }
                : { type: "noul", instructions };
        }
      const res = await postSystemOne(
        baseUrl,
        model,
        key,
        { feature: batch.feature, context: batch.context, items: batch.items },
        questions,
        {
          deadlineMs: o.deadlineMs,
          signal: o.signal,
          fetch: deps.fetch,
          now: deps.now,
          log: deps.log,
          exchange: o.exchange,
        },
      );
      const parsed = JevResponse.safeParse(res.json);
      if (!parsed.success)
        throw new ProviderError("invalid", "the Jev response has an unexpected shape");
      const answers: Record<string, Record<string, DecisionAnswer>> = {};
      for (const it of batch.items) {
        const per: Record<string, DecisionAnswer> = {};
        for (const q of batch.questions) {
          const a = toDecisionAnswer(parsed.data.answers[`${it.id}.${q.name}`], q);
          if (a) per[q.name] = a;
        }
        answers[it.id] = per;
      }
      const tokensIn = parsed.data.usage?.input_tokens ?? 0;
      return {
        answers,
        tokensIn,
        costUsd: tokensIn * JEV_PRICE_IN,
        latencyMs: res.latencyMs,
        model: parsed.data.model ?? model,
      };
    },
  };
}
