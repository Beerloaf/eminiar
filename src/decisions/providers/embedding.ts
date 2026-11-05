import type { Embedder } from "../../adjudicator/providers/embedding.js";
import { ProviderError } from "../../adjudicator/providers/http.js";
import type { AdjudicatorConfig } from "../../config.js";
import type { DecisionAnswer } from "../types.js";
import type { DecisionProvider } from "./types.js";

/**
 * The offline embedding provider as a decision provider. It answers only yes_no questions that
 * name a `similarity` ("relevance" of an item to the context, "duplicate" of an item against it)
 * by cosine similarity; anything else is unsupported and the feature keeps its deterministic
 * path. p is a rescaled similarity, never a calibrated probability. Needs an embedder, which only
 * the MCP server and CLI have (deps.embedder); without one nothing is supported.
 */

function cosine(a: Float32Array, b: Float32Array): number {
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

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function createEmbeddingDecisionProvider(
  cfg: AdjudicatorConfig,
  getEmbedder: (() => Promise<Embedder | undefined>) | undefined,
): DecisionProvider {
  return {
    id: "embedding",
    remote: false,
    model: "embedding",
    maxPairs: 400,
    maxRequests: 1,
    supports: (kind, q) => !!getEmbedder && kind === "yes_no" && q?.similarity !== undefined,
    async ask(batch, o) {
      const emb = await getEmbedder?.();
      if (!emb) throw new ProviderError("invalid", "embeddings are disabled or unavailable");
      const t0 = Date.now();
      const work = (async () => {
        const [ctx] = await emb.embed([batch.context], "query");
        const vs = await emb.embed(
          batch.items.map((i) => i.text),
          "passage",
        );
        return { ctx, vs };
      })();
      const { ctx, vs } = await new Promise<Awaited<typeof work>>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new ProviderError("timeout", "embedding deadline exceeded")),
          Math.max(1, o.deadlineMs),
        );
        work.then(
          (v) => {
            clearTimeout(timer);
            resolve(v);
          },
          (e) => {
            clearTimeout(timer);
            reject(
              e instanceof ProviderError
                ? e
                : new ProviderError("invalid", String(e?.message ?? e)),
            );
          },
        );
      });
      if (!ctx || vs.length !== batch.items.length)
        throw new ProviderError("invalid", "the embedder returned the wrong number of vectors");
      const min = cfg.embedding.minSimilarity;
      const answers: Record<string, Record<string, DecisionAnswer>> = {};
      batch.items.forEach((it, i) => {
        const sim = cosine(ctx, vs[i] as Float32Array);
        const per: Record<string, DecisionAnswer> = {};
        for (const q of batch.questions) {
          if (q.kind !== "yes_no" || !q.similarity) continue;
          const p =
            q.similarity === "duplicate"
              ? clamp01((sim - 0.85) / 0.15)
              : clamp01((sim - min) / (1 - min));
          per[q.name] = { kind: "yes_no", p, calibrated: false };
        }
        answers[it.id] = per;
      });
      return { answers, tokensIn: 0, costUsd: 0, latencyMs: Date.now() - t0, model: emb.model };
    },
  };
}
