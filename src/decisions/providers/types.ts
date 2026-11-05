import type { HttpExchange, ProviderId } from "../../adjudicator/types.js";
import type { DecisionAnswer, DecisionKind, DecisionQuestionSpec } from "../types.js";

/** What a provider is asked in one request: already redacted, ids positional. */
export interface DecisionBatch {
  feature: string;
  /** Shared state text, redacted and cut. */
  context: string;
  items: Array<{ id: string; text: string }>;
  questions: DecisionQuestionSpec[];
}

export interface DecisionCallOptions {
  deadlineMs: number;
  signal?: AbortSignal | undefined;
  /** A live record per HTTP call, only when exchange capture is on. */
  exchange?: ((x: HttpExchange) => void) | undefined;
}

export interface DecisionBatchResult {
  /** item id → question name → answer; only what parsed. A malformed answer is simply absent. */
  answers: Record<string, Record<string, DecisionAnswer>>;
  tokensIn: number;
  /** null = unknown price. */
  costUsd: number | null;
  latencyMs: number;
  model: string;
}

/**
 * The small interface the DecisionClient talks to (the capability, not the vendor). Jev answers
 * with native probabilities; an OpenAI-compatible endpoint derives a probability from a JSON
 * answer (uncalibrated); the embedding provider answers similarity questions locally. ask()
 * throws ProviderError (timeout, http_error, rate_limited, invalid, no_key).
 */
export interface DecisionProvider {
  readonly id: ProviderId;
  /** Text leaves this machine. */
  readonly remote: boolean;
  readonly model: string;
  /** Per request: at most this many item × question pairs, and at most `maxRequests` requests. */
  readonly maxPairs: number;
  readonly maxRequests: number;
  supports(kind: DecisionKind, q?: DecisionQuestionSpec): boolean;
  ask(batch: DecisionBatch, o: DecisionCallOptions): Promise<DecisionBatchResult>;
}
