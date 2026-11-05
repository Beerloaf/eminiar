/**
 * Shared types of the decision features (docs/design/jev-integration-options.md): small typed
 * questions (yes/no, choice, score) answered by whichever provider the adjudicator runs. No
 * provider's wire types appear here. Web-safe: no node: imports and no runtime code, so src/ui/web may `import type` from here.
 */

export type DecisionFeature = "recall" | "memory" | "commit" | "compaction" | "swarm" | "docs";
export const DECISION_FEATURES: readonly DecisionFeature[] = [
  "recall",
  "memory",
  "commit",
  "compaction",
  "swarm",
  "docs",
];

/** yes_no answers with a probability (Jev's "noul"), choice picks an option, score rates a rubric. */
export type DecisionKind = "yes_no" | "choice" | "score";
/** Where a call runs. Hooks never touch the network. */
export type DecisionContext = "hook" | "job" | "server" | "cli";

export interface DecisionQuestionSpec {
  name: string;
  kind: DecisionKind;
  /** "{item}" is replaced by `item "<id>" in state.items`. */
  instructions: string;
  /** choice: option → criterion (at most 255 options). */
  options?: Record<string, string>;
  /** score rubric, lowest level first. */
  levels?: string[];
  /**
   * yes_no only: the question is answerable by embedding similarity ("relevance" of an item to
   * the context, "duplicate" of an item against it), so the offline embedding provider may take it.
   */
  similarity?: "relevance" | "duplicate";
}

/** `text` is RAW; the client redacts it before it leaves. */
export interface DecisionItem {
  id: string;
  text: string;
  label?: string;
}

export interface AskInput {
  feature: DecisionFeature;
  /** Opaque id such as "prompt:<hash12>", "memory:<name>", "run:<id>/task:<n>"; never raw text. */
  subject: string;
  /** Shared state text (a prompt, a commit message); redacted and cut. */
  context?: string;
  /** At most 40 item × question pairs per request, at most 2 requests. */
  items: DecisionItem[];
  questions: DecisionQuestionSpec[];
  /** The deterministic decision as JSON of ids/labels only. */
  baseline: unknown;
  budgetMs: number;
  signal?: AbortSignal;
  sessionId?: string;
  /** Default 24 h; 0 = no cache. */
  cacheTtlMs?: number;
  /** The feature module's questionVersion; part of the cache key (default 1). */
  questionVersion?: number;
}

export type DecisionAnswer =
  | { kind: "yes_no"; p: number; calibrated: boolean }
  | {
      kind: "choice";
      choice: string;
      probs: Record<string, number>;
      confidence: number;
      calibrated: boolean;
    }
  /** value is normalised to 0..1. */
  | { kind: "score"; value: number; confidence: number; calibrated: boolean };

/**
 * Does a yes_no answer clear `min`? A calibrated probability (Jev) is compared as it is. An
 * uncalibrated one (a model's self-reported number, an embedding similarity) must clear a more
 * conservative bar: the larger of `min` and 0.85.
 */
export function clears(a: DecisionAnswer | undefined, min: number): boolean {
  if (a?.kind !== "yes_no") return false;
  return a.p >= (a.calibrated ? min : Math.max(min, 0.85));
}

/** item id → question name → answer. */
export type Answers = Record<string, Record<string, DecisionAnswer>>;

export type DecisionStatus =
  | "ok"
  | "cached"
  | "partial"
  | "timeout"
  | "http_error"
  | "rate_limited"
  | "invalid"
  | "no_key"
  | "breaker_open"
  | "slow_guard"
  | "over_budget"
  | "auth_failed"
  | "feature_cap"
  | "disabled"
  | "no_consent"
  | "skipped"
  /** The active provider cannot answer one of the question kinds; the deterministic path stands. */
  | "unsupported"
  | "error";

/** Statuses whose answers can be used. */
export const DECISION_USABLE: readonly DecisionStatus[] = ["ok", "cached", "partial"];

export interface Decision {
  /** Ids and labels only. */
  decision: unknown;
  changed: number;
  /** Built by the feature from a template and typed answers; never echoes user or provider text. */
  note?: string;
}

export interface AskResult {
  status: DecisionStatus;
  mode: "shadow" | "live";
  /** live && status is usable && decision.changed > 0. Features change behaviour only when apply. */
  apply: boolean;
  answers: Answers;
  decision?: Decision;
  callId?: number;
  latencyMs: number;
  costUsd: number | null;
}

export interface DecisionClient {
  /** Feature on + consent + provider resolved (memoised). */
  active(): boolean;
  mode(): "shadow" | "live";
  /** Never throws; resolves within budgetMs plus about 20 ms. */
  ask(input: AskInput, decide: (a: Answers) => Decision): Promise<AskResult>;
  /** Sync, cache-only, no write: the only method allowed in context "hook". */
  cached(input: Omit<AskInput, "budgetMs">): Answers | undefined;
  /** A decision_calls row without a call (hook shadow and cache hits). */
  record(
    input: Pick<AskInput, "feature" | "subject" | "baseline" | "sessionId"> & { items?: number },
    status: DecisionStatus,
    decision?: Decision,
  ): number | undefined;
}

// --- hooks and jobs ---------------------------------------------------------------------

export interface RerankCandidate {
  key: string;
  label: string;
  text: string;
  matched: string[];
  outcome: "shown" | "seen" | "gated" | "skipped" | "over-limit";
}
/** Returns the keys to show in order, or undefined to keep the term-matched result. */
export type RecallRerank = (query: string, candidates: RerankCandidate[]) => string[] | undefined;

/** Written to a detached `em-hook --decision` child through stdin; carries no key and no config. */
export interface DecisionJob {
  v: 1;
  feature: DecisionFeature;
  projectRoot: string;
  sessionId?: string;
  payload: unknown;
}

// --- storage ----------------------------------------------------------------------------

export interface DecisionCallInput {
  ts: number;
  feature: DecisionFeature;
  context: DecisionContext;
  sessionId?: string | null;
  subject: string;
  mode: "shadow" | "live";
  status: DecisionStatus;
  items?: number;
  baseline?: unknown;
  /** The provider that answered (or would have): typesafe, openai-compatible, embedding. */
  provider?: string | null;
  answers?: unknown;
  decision?: unknown;
  changed?: number;
  applied?: boolean;
  latencyMs?: number | null;
  tokensIn?: number | null;
  costUsd?: number | null;
  model?: string | null;
  exchangeId?: number | null;
  note?: string | null;
  noteSession?: string | null;
}

export interface DecisionCallRow {
  id: number;
  ts: number;
  feature: DecisionFeature;
  context: DecisionContext;
  sessionId: string | null;
  subject: string;
  mode: "shadow" | "live";
  status: DecisionStatus;
  items: number;
  baseline: unknown;
  provider: string | null;
  answers: unknown;
  decision: unknown;
  changed: number;
  applied: boolean;
  latencyMs: number | null;
  tokensIn: number | null;
  costUsd: number | null;
  model: string | null;
  exchangeId: number | null;
  note: string | null;
  noteSession: string | null;
  deliveredAt: number | null;
  feedback: "helped" | "hurt" | null;
}

export interface DecisionFeatureSummary {
  calls: number;
  byStatus: Record<string, number>;
  shadow: number;
  live: number;
  ok: number;
  /** ok rows where the provider agreed with the baseline (changed = 0). */
  agree: number;
  changed: number;
  applied: number;
  costUsd: number;
  p50Ms: number | null;
  p95Ms: number | null;
  helped: number;
  hurt: number;
}

export interface DecisionStore {
  /** Inserts and prunes to the newest `keep` rows (default DECISION_CALLS_KEEP) in one transaction. */
  insertCall(c: DecisionCallInput, keep?: number): number;
  callsToday(feature: DecisionFeature, now: number): number;
  /** Rows of one feature and status since `since` (the disabled/no_consent dedupe). */
  countSince(feature: DecisionFeature, status: DecisionStatus, since: number): number;
  cacheGet(key: string, now: number, ttlMs: number): unknown | undefined;
  cachePut(key: string, feature: DecisionFeature, answers: unknown, now: number): void;
  cachePrune(max: number): number;
  /** Undelivered notes of `sessionId` younger than maxAgeMs (default 10 min), oldest first. */
  pendingNotes(
    sessionId: string,
    now: number,
    maxAgeMs?: number,
  ): Array<{ id: number; note: string }>;
  /** Atomically claims (marks delivered and returns) the pending notes: only one caller gets each. */
  claimNotes(
    sessionId: string,
    now: number,
    maxAgeMs?: number,
  ): Array<{ id: number; note: string }>;
  markDelivered(ids: number[], now: number): void;
  latestBySubject(
    feature: DecisionFeature,
    subjectPrefix: string,
    limit: number,
  ): DecisionCallRow[];
  summary(o?: { since?: number }): Record<DecisionFeature, DecisionFeatureSummary>;
  list(o?: { feature?: DecisionFeature; limit?: number; beforeId?: number }): DecisionCallRow[];
  feedback(id: number, v: "helped" | "hurt" | null): boolean;
  /** Clears decision_calls and decision_cache. */
  purge(): void;
}
