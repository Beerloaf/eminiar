import type { AdjudicationRow, Verdict } from "../adjudicator/types.js";

export type ContentType = "prose" | "code" | "json";

/** Well-known sources; any string is accepted so callers can namespace freely. */
export type Source =
  | "exec"
  | "batch"
  | "file"
  | "url"
  | "session"
  | "memory"
  | "code"
  | (string & {});

export interface DocumentInput {
  source: Source;
  title: string;
  uri?: string | undefined;
  contentType: ContentType;
  contentHash: string;
  sessionId?: string | undefined;
  meta?: Record<string, unknown> | undefined;
}

export interface DocumentRow {
  id: number;
  source: string;
  title: string;
  uri: string | null;
  content_type: ContentType;
  content_hash: string;
  session_id: string | null;
  meta: string | null;
  created_at: number;
}

export interface ChunkInput {
  ord: number;
  title: string;
  body: string;
  contentType: ContentType;
  startLine?: number | undefined;
  endLine?: number | undefined;
  hash: string;
  /** Graph node id (`sym:<rel>#<Qualified>`) this chunk is the body of, for code. */
  symbolId?: string | undefined;
}

export interface ChunkRow {
  id: number;
  document_id: number;
  ord: number;
  title: string;
  body: string;
  content_type: ContentType;
  start_line: number | null;
  end_line: number | null;
  hash: string;
  embedded: number;
  symbol_id: string | null;
}

export interface ChunkWithDoc extends ChunkRow {
  document: DocumentRow;
}

/** A document with its chunk count, for per-source listings. */
export interface DocumentSummaryRow {
  id: number;
  source: string;
  title: string;
  uri: string | null;
  created_at: number;
  chunks: number;
}

/** Document and chunk totals for one source tag. */
export interface SourceStatRow {
  source: string;
  documents: number;
  chunks: number;
  latest: number;
}

export interface SearchFilters {
  source?: string | string[] | undefined;
  /** Every source tag starting with this prefix (e.g. `docs:` for all documentation sources). */
  sourcePrefix?: string | undefined;
  contentType?: ContentType | undefined;
  /** Unix ms; only documents created at or after this time. */
  since?: number | undefined;
  sessionId?: string | undefined;
  documentIds?: number[] | undefined;
}

export interface FtsHit {
  chunkId: number;
  /** Higher is better (negated bm25). */
  score: number;
}

export interface VecHit {
  chunkId: number;
  distance: number;
}

export interface VocabTerm {
  term: string;
  df: number;
}

export type PurgeScope =
  | "index"
  | "sessions"
  | "graph"
  | "memories"
  | "usage"
  | "adjudicator"
  | "all";

export interface SessionRow {
  id: string;
  project_root: string | null;
  started_at: number | null;
  ended_at: number | null;
  source: string | null;
  last_prompt: string | null;
  transcript_path: string | null;
}

export interface EventInput {
  sessionId: string;
  category: string;
  priority: 1 | 2 | 3 | 4;
  tool?: string | undefined;
  payload: Record<string, unknown>;
  documentId?: number | undefined;
  ts?: number | undefined;
}

export interface EventRow {
  id: number;
  session_id: string;
  ts: number;
  category: string;
  priority: number;
  tool: string | null;
  payload: string;
  document_id: number | null;
}

export interface StatDelta {
  rawChars: number;
  returnedChars: number;
  durationMs: number;
}

export interface StatRow {
  session_id: string;
  tool: string;
  calls: number;
  raw_chars: number;
  returned_chars: number;
  duration_ms: number;
}

export interface MemoryInput {
  kind: string;
  content: string;
  tags?: string[] | undefined;
  nodeIds?: string[] | undefined;
  sessionId?: string | undefined;
  documentId?: number | undefined;
  /** `topic/slug`; the markdown file is `<memories.dir>/<name>.md`. */
  name?: string | undefined;
  /** Project-relative path of that file. */
  path?: string | undefined;
  fileHash?: string | undefined;
  fileMtime?: number | undefined;
  fileSize?: number | undefined;
  createdAt?: number | undefined;
  updatedAt?: number | undefined;
  /** ADR-style lifecycle for decisions: proposed | accepted | superseded | deprecated. */
  status?: string | undefined;
  /** Name of the memory this one replaces. */
  supersedes?: string | undefined;
}

export const MEMORY_STATUSES = ["proposed", "accepted", "superseded", "deprecated"] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export interface MemoryRow {
  id: number;
  kind: string;
  content: string;
  tags: string | null;
  node_ids: string | null;
  session_id: string | null;
  document_id: number | null;
  created_at: number;
  name: string | null;
  path: string | null;
  file_hash: string | null;
  file_mtime: number | null;
  file_size: number | null;
  updated_at: number | null;
  status: string | null;
  supersedes: string | null;
}

/** Who produced a node/edge: a parser, a person, git history, or a derived analysis pass. */
export type GraphSource = "tree-sitter" | "curated" | "git" | "analysis";

export interface GraphNode {
  id: string;
  kind: string;
  name: string;
  path?: string | null | undefined;
  startLine?: number | null | undefined;
  endLine?: number | null | undefined;
  source: GraphSource;
  confidence?: number | undefined;
  meta?: Record<string, unknown> | undefined;
}

export interface GraphNodeRow {
  id: string;
  kind: string;
  name: string;
  path: string | null;
  start_line: number | null;
  end_line: number | null;
  source: GraphSource;
  confidence: number;
  meta: string | null;
  updated_at: number;
}

export interface GraphEdge {
  src: string;
  dst: string;
  kind: string;
  source: GraphSource;
  confidence?: number | undefined;
  weight?: number | undefined;
  meta?: Record<string, unknown> | undefined;
}

export interface GraphEdgeRow {
  src: string;
  dst: string;
  kind: string;
  source: GraphSource;
  confidence: number;
  weight: number;
  meta: string | null;
  updated_at: number;
}

/** indexed: parsed into graph + search; partial: indexed with parse errors; skipped/unsupported: not in the graph. */
export type FileIndexStatus = "indexed" | "partial" | "skipped" | "unsupported";

export interface FileIndexRow {
  path: string;
  hash: string;
  mtime: number | null;
  size: number | null;
  language: string | null;
  indexed_at: number;
  document_id: number | null;
  status: FileIndexStatus;
  /** Why the file is not fully indexed (e.g. "over 1.5 MB", a parser error). */
  reason: string | null;
  /** Symbols the parser found. */
  symbols: number | null;
  errors: string | null;
}

export interface FileIndexInput {
  path: string;
  hash: string;
  mtime: number | null;
  size: number | null;
  language: string | null;
  document_id: number | null;
  status?: FileIndexStatus | undefined;
  reason?: string | null | undefined;
  symbols?: number | null | undefined;
  errors?: string | null | undefined;
}

/** Per-node structural and churn signals; `score` is a hotspot signal, not a quality grade. */
export interface GraphMetricRow {
  node_id: string;
  kind: string;
  path: string | null;
  fan_in: number;
  fan_out: number;
  loc: number;
  complexity: number;
  commits_90d: number;
  score: number;
  cluster: number | null;
  updated_at: number;
}

export type GraphMetricInput = Omit<GraphMetricRow, "updated_at">;

export interface IndexRunRow {
  id: number;
  scope: string;
  started_at: number;
  finished_at: number | null;
  scanned: number;
  indexed: number;
  unchanged: number;
  skipped: number;
  removed: number;
  errors: number;
  head_sha: string | null;
  detail: string | null;
}

export type IndexRunSummary = Partial<
  Pick<
    IndexRunRow,
    "scanned" | "indexed" | "unchanged" | "skipped" | "removed" | "errors" | "detail"
  >
>;

export interface SnapshotRow {
  id: number;
  session_id: string | null;
  trigger: string | null;
  body: string;
  bytes: number;
  created_at: number;
  consumed_at: number | null;
}

// --- usage (transcript-derived model calls, tool results, context events) --------------

/** One API request as recorded in a Claude Code transcript. Token counts are raw, cost is cached. */
export interface ApiCallRow {
  request_id: string;
  message_id: string;
  session_id: string;
  /** Subagent id when the call came from a sidechain, else null. */
  agent_id: string | null;
  sidechain: number;
  ts: number;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_create_5m: number;
  cache_create_1h: number;
  cache_read: number;
  thinking_tokens: number;
  web_searches: number;
  web_fetches: number;
  service_tier: string | null;
  speed: string | null;
  stop_reason: string | null;
  prompt_id: string | null;
  git_branch: string | null;
  cwd: string | null;
  effort: string | null;
  version: string | null;
  entrypoint: string | null;
  /** Cost at ingest time from the bundled pricing table; null when the model is unknown. */
  cost_usd: number | null;
  /** 1 when cost_usd came from a known price, 0 when the model was not priced. */
  priced: number;
}

export type ApiCallInput = Omit<ApiCallRow, "cost_usd" | "priced"> &
  Partial<Pick<ApiCallRow, "cost_usd" | "priced">>;

/** One tool invocation and its result size, from the transcript. */
export interface ToolUseRow {
  tool_use_id: string;
  session_id: string;
  agent_id: string | null;
  ts: number;
  tool: string;
  input_chars: number;
  /** Characters in the tool_result block; null until the result entry is seen. */
  result_chars: number | null;
  is_error: number;
  /** The request that produced the tool_use block. */
  request_id: string | null;
}

/** Compactions and clears, from `compact_boundary` system entries. */
export interface ContextEventRow {
  id: number;
  session_id: string;
  ts: number;
  kind: "compact" | "clear";
  trigger: string | null;
  pre_tokens: number | null;
  post_tokens: number | null;
}
export type ContextEventInput = Omit<ContextEventRow, "id">;

/** Tail state for one transcript file so ingest only reads new bytes. */
export interface TranscriptFileRow {
  path: string;
  session_id: string | null;
  offset: number;
  size: number;
  mtime: number;
  /**
   * sha1 (hex) of the first min(512, size) bytes when the row was written, so a rewrite
   * that keeps the size is still noticed. Null for rows that never read the file.
   */
  head_hash?: string | null;
  ingested_at: number;
}

/** One statusline render, recorded when the figures change. */
export interface StatuslineSnapshotRow {
  id: number;
  session_id: string;
  ts: number;
  model_id: string | null;
  cost_usd: number | null;
  api_ms: number | null;
  duration_ms: number | null;
  ctx_input_tokens: number | null;
  ctx_output_tokens: number | null;
  ctx_size: number | null;
  ctx_used_pct: number | null;
  cache_warm: number | null;
  cache_ttl: string | null;
  five_hour_pct: number | null;
  five_hour_resets_at: number | null;
  seven_day_pct: number | null;
  seven_day_resets_at: number | null;
  lines_added: number | null;
  lines_removed: number | null;
}
export type StatuslineSnapshotInput = Omit<StatuslineSnapshotRow, "id">;

export interface UsageFilter {
  sessionId?: string | undefined;
  /** Epoch ms, inclusive. */
  since?: number | undefined;
  /** Epoch ms, exclusive. */
  until?: number | undefined;
  /** true = only sidechain rows, false = only main-thread rows, undefined = both. */
  sidechain?: boolean | undefined;
  limit?: number | undefined;
}

// --- adjudicator (docs/design/adjudicator.md §12) ------------------------------------

/** A new `adjudications` row: `id` is assigned, `ts` defaults to now, outcome to pending. */
export type AdjudicationInput = Omit<AdjudicationRow, "id" | "ts" | "outcome" | "final"> & {
  ts?: number | undefined;
  outcome?: AdjudicationRow["outcome"] | undefined;
  final?: boolean | undefined;
};

/** Columns to change; undefined leaves a column alone, null clears it. */
export type AdjudicationPatch = {
  [K in Exclude<keyof AdjudicationRow, "id">]?: AdjudicationRow[K] | undefined;
};

export interface AdjudicationListFilter {
  /** Epoch ms, inclusive. */
  since?: number | undefined;
  surface?: string | undefined;
  provider?: string | undefined;
  outcome?: string | undefined;
  /** Default 50, at most 500. */
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface AdjudicatorCacheEntry {
  key: string;
  /** null is the `pending` marker an async job leaves while it runs. */
  verdict: Verdict | null;
  provider: string | null;
  createdAt: number;
  lastHitAt: number | null;
  hits: number;
}

/** Breaker, latency ring and daily spend of one provider (§9). */
export interface AdjudicatorProviderState {
  provider: string;
  /** closed | open | half_open | slow | auth_failed */
  state: string;
  failures: number;
  retryAt: number | null;
  lastOkAt: number | null;
  lastErrorAt: number | null;
  lastErrorClass: string | null;
  /** The last ≤ 50 provider latencies in ms, oldest first. */
  latencies: number[];
  /**
   * The budget in ms each latency was measured against, index-aligned with the END of
   * `latencies` (a shorter array means the oldest samples predate it; 0 = unknown). The slow
   * guard judges latency / budget, so surfaces with different budgets can share one ring.
   */
  latencyBudgets?: number[];
  /** UTC day (YYYY-MM-DD) that `spendUsd` and `calls` belong to. */
  spendDay: string | null;
  spendUsd: number;
  /** Provider calls made on `spendDay` (budget.dailyCalls). */
  calls: number;
  /**
   * state "auth_failed": sha256(key)[0:12] of the key the provider rejected (401/403); never
   * the key. The provider is skipped until the key changes or retryAt passes.
   */
  authFingerprint: string | null;
}

/** One learned bucket (§7.7): decayed counts n/s/f and the bias they yield. */
export interface AdjudicatorBiasRow {
  dimension: string;
  bucket: string;
  option: string;
  n: number;
  s: number;
  f: number;
  costMedian: number | null;
  bias: number;
  updatedAt: number | null;
}

export interface LatencyStats {
  /** Rows with a value. */
  n: number;
  p50: number | null;
  p95: number | null;
}

export interface AdjudicationSummary {
  since: number | null;
  total: number;
  bySurface: Record<string, number>;
  bySource: Record<string, number>;
  byProviderStatus: Record<string, number>;
  byAction: Record<string, number>;
  byOutcome: Record<string, number>;
  latency: LatencyStats;
  providerLatency: LatencyStats;
  /**
   * follow = followed / (advised + followed + ignored): advice-mode dispatches whose advice
   * was taken. apply = applied / (applied + respected) and respect = respected /
   * (applied + respected): apply-mode dispatches. null when the denominator is 0.
   */
  rates: { follow: number | null; apply: number | null; respect: number | null };
  /** Σ cost_usd: the adjudicator's own provider spend. */
  costUsd: number;
  /** Σ savings_usd as reconcile credited it. */
  savingsUsd: number;
  /** savingsUsd − costUsd. */
  netUsd: number;
  /** Applied rows whose actual_model does not name model_final. */
  applyIneffective: number;
  /** Applied rows with an actual_model to compare against (the m of "n of m"). */
  applyChecked: number;
}

/** Persistence of the adjudicator; synchronous, every hook write is one statement. */
export interface AdjudicatorStore {
  insert(row: AdjudicationInput): number;
  /** Returns false when no row has that id. */
  update(id: number, patch: AdjudicationPatch): boolean;
  get(id: number): AdjudicationRow | undefined;
  /** Newest first; `total` counts every row matching the filter. */
  list(filter?: AdjudicationListFilter): { rows: AdjudicationRow[]; total: number };
  latestForSession(sessionId: string, surface: string): AdjudicationRow | undefined;
  /**
   * The newest row whose tool_use_id is `toolUseId` (indexed), optionally only of `surface` and
   * with ts >= `since`.
   */
  byToolUseId(
    toolUseId: string,
    filter?: { surface?: string; since?: number },
  ): AdjudicationRow | undefined;
  /** Oldest first. */
  forTask(runId: string, taskId: number): AdjudicationRow[];
  /** Rows with final = 0, oldest first; `olderThan` (epoch ms) keeps only rows with ts < it. */
  nonFinal(limit: number, olderThan?: number): AdjudicationRow[];

  /**
   * The cache entry for `key`. A hit with a verdict bumps hits and last_hit_at to `now`.
   * With `maxAgeMs`, an entry created before now − maxAgeMs is a miss (and is not bumped).
   */
  cacheGet(key: string, now: number, maxAgeMs?: number): AdjudicatorCacheEntry | undefined;
  /** Insert or replace; `null` writes the pending marker. */
  cachePut(key: string, verdict: Verdict | null, provider: string | null, now?: number): void;
  /** Drop entries older than ttlMs, then all but the maxEntries most recently used. Returns rows deleted. */
  cachePrune(maxEntries: number, ttlMs: number, now?: number): number;

  providerState(provider: string): AdjudicatorProviderState | undefined;
  /** Merge `patch` into the stored state (or a closed default) and save it; returns the result. */
  saveProviderState(
    provider: string,
    patch: Partial<Omit<AdjudicatorProviderState, "provider">>,
  ): AdjudicatorProviderState;
  /**
   * Run `fn` as one write transaction that takes the write lock up front (SQLite BEGIN
   * IMMEDIATE), so a read-modify-write of the provider state (half-open claim, spend and call
   * counters) cannot interleave with another hook process. Nested calls join the outer one.
   * Optional: a store without it (a test double, the try-it wrapper) runs `fn` directly.
   */
  atomically?<T>(fn: () => T): T;

  biasAll(): AdjudicatorBiasRow[];
  biasUpsert(row: Omit<AdjudicatorBiasRow, "updatedAt"> & { updatedAt?: number | null }): void;
  /** Clears the bias table only; returns rows deleted. */
  biasReset(): number;

  summary(since?: number): AdjudicationSummary;
  /** Clears all four adjudicator tables. */
  purge(): void;
}
