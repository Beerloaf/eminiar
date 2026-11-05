import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AdjudicatorConfig, Config } from "../../config.js";
import { getProvider } from "../../embeddings/provider.js";
import { paths } from "../../paths.js";
import type { Resolved } from "../config.js";
import { EXEMPLARS, type Exemplar } from "../data/exemplars.js";
import {
  type AdjudicationRequest,
  type AdjudicatorProvider,
  type Dist,
  type ProviderAnswer,
  type ProviderResult,
  TIERS,
  type Tier,
} from "../types.js";
import { PROBE_TIMEOUT_MS, type ProviderDeps, ProviderError } from "./http.js";
import type { ProviderFactory } from "./index.js";

/**
 * The offline embedding provider (docs/design/adjudicator.md §8): k-NN over bge-small vectors of
 * the labelled exemplars in data/exemplars.ts, reusing the embedding model of src/embeddings
 * (already warm in the MCP server). It answers tier and complexity only; research found no
 * signal for the tool.
 *
 * - Exemplar vectors are embedded once and cached at
 *   <paths().models>/adjudicator-exemplars-<sha of model id + texts>.json.
 * - Classification: the k most similar exemplars (cosine) at or above minSimilarity vote with
 *   their similarity as the weight. Tier Dist = vote shares (confidence = the top share);
 *   complexity = the weighted mean, its confidence = the top share of the rounded buckets.
 * - A request with no neighbour above minSimilarity gets no answer (the engine falls back).
 *
 * Registered at runtime by src/server.ts and the CLI (registerProvider("embedding", ...)); the
 * provider registry and the hook bundle never import this module.
 */

/** The slice of src/embeddings' EmbeddingProvider this module uses (tests inject a stub). */
export interface Embedder {
  readonly model: string;
  embed(texts: string[], kind: "query" | "passage"): Promise<Float32Array[]>;
  ready?(): boolean;
  warm?(): void;
  error?(): string | undefined;
}

export interface EmbeddingOptions {
  /** Resolves the shared embedder; undefined when embeddings are disabled or unavailable. */
  getEmbedder: () => Promise<Embedder | undefined>;
  /** Where the exemplar vector cache lives (default paths().models). */
  cacheDir?: string;
  /** Default EXEMPLARS. */
  exemplars?: readonly Exemplar[];
}

export interface EmbeddingProvider extends AdjudicatorProvider {
  /** Load the model and the exemplar vectors ahead of the first call (the server's warm-up). */
  warm(): Promise<void>;
}

/** A ProviderFactory whose providers also expose warm(). */
export type EmbeddingFactory = (...args: Parameters<ProviderFactory>) => EmbeddingProvider;

/** Bump when the cache file layout changes. */
const CACHE_FORMAT = 1;
/** Decimals kept per vector component in the cache file (~1.5-3 KB per exemplar). */
const CACHE_DECIMALS = 5;

interface CacheFile {
  format: number;
  model: string;
  count: number;
  vectors: number[][];
}

/** sha256 over the model id and the exemplar texts, shortened for the file name. */
export function exemplarCacheKey(model: string, texts: readonly string[]): string {
  const h = createHash("sha256");
  h.update(`${CACHE_FORMAT}\0${model}\0`);
  for (const t of texts) h.update(`${t}\0`);
  return h.digest("hex").slice(0, 16);
}

export function exemplarCachePath(dir: string, model: string, texts: readonly string[]): string {
  return join(dir, `adjudicator-exemplars-${exemplarCacheKey(model, texts)}.json`);
}

function readCache(file: string, model: string, count: number): Float32Array[] | undefined {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<CacheFile>;
    if (raw.format !== CACHE_FORMAT || raw.model !== model || raw.count !== count) return undefined;
    const vs = raw.vectors;
    if (!Array.isArray(vs) || vs.length !== count) return undefined;
    const dims = Array.isArray(vs[0]) ? vs[0].length : 0;
    if (!dims) return undefined;
    const out: Float32Array[] = [];
    for (const v of vs) {
      if (!Array.isArray(v) || v.length !== dims || !v.every((x) => Number.isFinite(x)))
        return undefined;
      out.push(Float32Array.from(v));
    }
    return out;
  } catch {
    return undefined;
  }
}

function writeCache(file: string, dir: string, model: string, vectors: Float32Array[]): void {
  const k = 10 ** CACHE_DECIMALS;
  const body: CacheFile = {
    format: CACHE_FORMAT,
    model,
    count: vectors.length,
    vectors: vectors.map((v) => Array.from(v, (x) => Math.round(x * k) / k)),
  };
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmp, JSON.stringify(body));
    renameSync(tmp, file);
  } catch {
    // A read-only models dir only costs a re-embed next time.
    try {
      unlinkSync(tmp);
    } catch {}
  }
}

export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0;
}

/** Map a labelled tier onto the configured ladder: itself, else the nearest configured tier. */
export function nearestTier(t: Tier, ladder: readonly Tier[]): Tier {
  if (!ladder.length || ladder.includes(t)) return t;
  const at = TIERS.indexOf(t);
  let best = ladder[0] as Tier;
  let gap = Number.POSITIVE_INFINITY;
  for (const c of ladder) {
    const g = Math.abs(TIERS.indexOf(c) - at);
    // Ties go to the larger tier: the safer choice.
    if (g < gap || (g === gap && TIERS.indexOf(c) > TIERS.indexOf(best))) {
      best = c;
      gap = g;
    }
  }
  return best;
}

export interface KnnOptions {
  k: number;
  minSimilarity: number;
  tiers: readonly Tier[];
}

/** k-NN vote for one query vector; undefined when no exemplar reaches minSimilarity. */
export function classify(
  q: Float32Array,
  exemplars: readonly Exemplar[],
  vectors: readonly Float32Array[],
  o: KnnOptions,
): Pick<ProviderAnswer, "tier" | "complexity"> | undefined {
  const near: Array<{ i: number; sim: number }> = [];
  for (let i = 0; i < vectors.length; i++) {
    const sim = cosine(q, vectors[i] as Float32Array);
    if (sim >= o.minSimilarity) near.push({ i, sim });
  }
  if (!near.length) return undefined;
  near.sort((a, b) => b.sim - a.sim);
  const top = near.slice(0, Math.max(1, o.k));
  const weight = (sim: number) => Math.max(sim, 1e-6);
  const total = top.reduce((n, x) => n + weight(x.sim), 0);

  const tierVotes: Record<string, number> = {};
  const bucketVotes = new Map<number, number>();
  let cSum = 0;
  for (const { i, sim } of top) {
    const ex = exemplars[i] as Exemplar;
    const w = weight(sim) / total;
    const t = nearestTier(ex.tier, o.tiers);
    tierVotes[t] = (tierVotes[t] ?? 0) + w;
    cSum += w * ex.complexity;
    const b = Math.round(ex.complexity);
    bucketVotes.set(b, (bucketVotes.get(b) ?? 0) + w);
  }
  const complexity = Math.min(4, Math.max(0, cSum));
  const tier: Dist = {
    probs: tierVotes,
    confidence: Math.max(...Object.values(tierVotes)),
    calibrated: true,
  };
  return {
    tier,
    complexity: { value: complexity, confidence: Math.max(...bucketVotes.values()) },
  };
}

/** Reject with a timeout when the deadline passes or the signal aborts first. */
function withDeadline<T>(p: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const fail = () => reject(new ProviderError("timeout", "embedding deadline exceeded"));
    if (signal?.aborted) return fail();
    const timer = setTimeout(fail, Math.max(0, ms));
    const onAbort = () => {
      clearTimeout(timer);
      fail();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

function asProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  return new ProviderError(
    "invalid",
    `embedding failed: ${(err as Error)?.message ?? String(err)}`,
  );
}

/**
 * The factory to pass to registerProvider("embedding", ...). Exemplar vectors are shared by
 * every provider the factory creates, so the engine may create one per call.
 */
export function embeddingFactory(opts: EmbeddingOptions): EmbeddingFactory {
  const exemplars = opts.exemplars ?? EXEMPLARS;
  const texts = exemplars.map((e) => e.text);
  const loaded = new Map<string, Promise<Float32Array[]>>();

  const vectorsFor = (emb: Embedder): Promise<Float32Array[]> => {
    let p = loaded.get(emb.model);
    if (!p) {
      p = (async () => {
        const dir = opts.cacheDir ?? paths().models;
        const file = exemplarCachePath(dir, emb.model, texts);
        const cached = readCache(file, emb.model, texts.length);
        if (cached) return cached;
        const vs = await emb.embed(texts, "passage");
        if (vs.length !== texts.length)
          throw new ProviderError("invalid", "the embedder returned the wrong number of vectors");
        writeCache(file, dir, emb.model, vs);
        return vs;
      })();
      // A failed load is retried on the next call, not cached forever.
      p.catch(() => loaded.delete(emb.model));
      loaded.set(emb.model, p);
    }
    return p;
  };

  const prepare = async (): Promise<{ emb: Embedder; vectors: Float32Array[] }> => {
    const emb = await opts.getEmbedder();
    if (!emb) throw new ProviderError("invalid", "embeddings are disabled or unavailable");
    return { emb, vectors: await vectorsFor(emb) };
  };

  return (_r: Resolved, cfg: AdjudicatorConfig, deps: ProviderDeps): EmbeddingProvider => {
    const now = deps.now ?? Date.now;
    const knn: KnnOptions = {
      k: cfg.embedding.k,
      minSimilarity: cfg.embedding.minSimilarity,
      tiers: cfg.tiers,
    };
    return {
      id: "embedding",
      remote: false,
      dims: ["tier", "complexity"],

      async warm() {
        await prepare();
      },

      async adjudicate(reqs, o): Promise<ProviderResult> {
        const t0 = now();
        // Started outside the deadline race, so a slow first load still finishes for the next call.
        const work = (async () => {
          const { emb, vectors } = await prepare();
          const qs = reqs.length ? await emb.embed(reqs.map(textOf), "passage") : [];
          return { model: emb.model, vectors, qs };
        })();
        work.catch(() => undefined);
        let res: Awaited<typeof work>;
        try {
          res = await withDeadline(work, o.deadlineMs, o.signal);
        } catch (err) {
          throw asProviderError(err);
        }
        const answers: ProviderAnswer[] = [];
        reqs.forEach((req, i) => {
          const q = res.qs[i];
          if (!q) return;
          const a = classify(q, exemplars, res.vectors, knn);
          if (a) answers.push({ key: req.key, ...a });
        });
        deps.log?.(
          `adjudicator embedding: ${answers.length}/${reqs.length} answered in ${now() - t0} ms`,
        );
        return {
          answers,
          usage: { inTok: 0, outTok: 0, costUsd: 0 },
          latencyMs: now() - t0,
          model: res.model,
        };
      },

      async probe(o) {
        const t0 = now();
        try {
          const { emb } = await withDeadline(prepare(), PROBE_TIMEOUT_MS, o.signal);
          return {
            ok: true,
            latencyMs: now() - t0,
            detail: `${emb.model} loaded, ${exemplars.length} exemplars`,
          };
        } catch (err) {
          const e = asProviderError(err);
          const detail = e.kind === "timeout" ? "the embedding model is still loading" : e.message;
          return { ok: false, latencyMs: now() - t0, detail };
        }
      },
    };
  };
}

/** The request text as the embedder sees it (the embedder caps length itself). */
function textOf(r: AdjudicationRequest): string {
  return r.text.replace(/\s+/g, " ").trim();
}

/** The factory the server and CLI register: the shared src/embeddings model for `config`. */
export function defaultEmbeddingFactory(config: Config): EmbeddingFactory {
  return embeddingFactory({ getEmbedder: () => getProvider(config) });
}
