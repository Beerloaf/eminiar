import type { ProjectContext } from "../context.js";
import { triageOutput } from "../decisions/features/compaction.js";
import { kickEmbedding } from "../embeddings/queue.js";
import { indexContent } from "../index/indexer.js";
import { formatResults } from "../search/format.js";
import { type SearchResponse, search } from "../search/pipeline.js";
import { getCurrentSession } from "../session/current.js";
import type { StorageAdapter } from "../storage/adapter.js";
import { topTermsOf } from "../storage/terms.js";
import type { Source } from "../storage/types.js";

export interface ProcessInput {
  stdout: string;
  title: string;
  source: Source;
  intent?: string | undefined;
  queries?: string[] | undefined;
  /** Index even when under the threshold (batch mode needs every output searchable). */
  forceIndex?: boolean | undefined;
  maxTokens?: number | undefined;
  /**
   * The output is em_execute's own stdout, the only kind the opt-in compaction.output triage may
   * send to a provider. File reads (em_execute_file) and batch commands never set it.
   */
  triage?: boolean | undefined;
}

export interface Processed {
  text: string;
  documentId?: number;
  chunks?: number;
  returnedChars: number;
}

const HEAD = 3 * 1024;
const TAIL = 1 * 1024;

/**
 * Decide what the model gets to see. Small outputs are returned verbatim. Large
 * ones are indexed; with an intent/queries only matching sections come back
 * (plus a vocabulary of searchable terms), otherwise a head/tail preview and the
 * document id for follow-up `em_search` calls.
 */
export async function processOutput(
  db: StorageAdapter,
  ctx: ProjectContext,
  input: ProcessInput,
): Promise<Processed> {
  const threshold = ctx.config.sandbox.indexThreshold;
  const out = input.stdout;
  if (!input.forceIndex && out.length <= threshold) {
    return { text: out, returnedChars: out.length };
  }
  if (!out.trim()) return { text: "", returnedChars: 0 };

  const r = indexContent(db, {
    source: input.source,
    title: input.title,
    content: out,
    sessionId: getCurrentSession(ctx),
    meta: input.intent ? { intent: input.intent } : undefined,
  });
  kickEmbedding(ctx, db);
  const queries = [...(input.queries ?? [])];
  if (input.intent && !queries.includes(input.intent)) queries.unshift(input.intent);

  if (out.length <= threshold) {
    return { text: out, documentId: r.documentId, chunks: r.chunks, returnedChars: out.length };
  }

  const lines: string[] = [];
  if (queries.length) {
    const responses: SearchResponse[] = [];
    for (const q of queries) {
      responses.push(
        await search(db, q, {
          limit: 5,
          mode: "lexical",
          filters: { documentIds: [r.documentId] },
        }),
      );
    }
    let shown = responses;
    // Opt-in output triage (off by default): one boolean check when off.
    const tf = ctx.config.adjudicator.features.compaction;
    if (input.triage && tf.enabled && tf.output && input.intent) {
      try {
        shown = (await triageOutput(db, ctx, input.intent, r.documentId, responses)) ?? responses;
      } catch {
        // optional: the deterministic result stands
      }
    }
    lines.push(formatResults(shown, input.maxTokens ?? 1500));
    // Vocabulary from this document's chunks only; see topTermsOf for why not fts5vocab.
    const bodies = db.chunksOfDocument(r.documentId).map((c) => c.body);
    const terms = topTermsOf(bodies, 40).map((t) => t.term);
    if (terms.length) lines.push(`\nsearchable terms: ${terms.join(", ")}`);
  } else {
    lines.push(out.slice(0, HEAD));
    if (out.length > HEAD + TAIL) lines.push(`\n… ${out.length - HEAD - TAIL} chars omitted …\n`);
    lines.push(out.slice(-TAIL));
  }
  lines.push(
    `\n[indexed as doc ${r.documentId} (${r.chunks} chunks, ${out.length} chars); em_search with document_ids: [${r.documentId}] for more]`,
  );
  const text = lines.join("\n");
  return { text, documentId: r.documentId, chunks: r.chunks, returnedChars: text.length };
}
