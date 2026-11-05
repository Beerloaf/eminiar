import { z } from "zod";
import { featuresWanted } from "../config.js";
import type { RerankCandidate } from "../decisions/types.js";
import { getProvider } from "../embeddings/provider.js";
import { vectorRanker } from "../embeddings/queue.js";
import { list, MEMORY_KINDS, reconcile } from "../memory/store.js";
import { search } from "../search/pipeline.js";
import { getStorage } from "../storage/index.js";
import type { MemoryRow } from "../storage/types.js";
import { memoryLine } from "./em_memory.js";
import { defineTool, text } from "./types.js";

export const emRecall = defineTool({
  name: "em_recall",
  description:
    'Call this first when a task starts, a design changes or an approach is chosen: it recalls memories (.eminiar/memories, written by em_remember) and captured session history — decisions, constraints, errors and their fixes, rejected approaches — matching a query (hybrid keyword + semantic), so nothing is re-decided or re-broken. Without a query, lists the most recent memories, onboarding first. The hooks also push matching memories on their own ("eminiar recall", "eminiar memory"); this tool searches further, with synonyms. em_memory {action:"read"} shows a whole memory.',
  schema: {
    query: z.string().optional(),
    kind: z.enum(MEMORY_KINDS).optional().describe("Restrict to one memory kind"),
    topic: z.string().optional().describe("Restrict to memories under this topic"),
    limit: z.number().int().min(1).max(50).optional(),
    include_session_history: z
      .boolean()
      .optional()
      .describe("Also search captured session events (default true)"),
  },
  handler: async (args, ctx) => {
    const db = getStorage(ctx);
    reconcile(ctx, db);
    const limit = args.limit ?? 8;
    const lines: string[] = [];

    if (!args.query) {
      const rows = list(ctx, db, { kind: args.kind, topic: args.topic, limit });
      if (!rows.length)
        return text(
          "no memories yet; use em_remember to record decisions and constraints (or /eminiar:em-onboard to write the onboarding set)",
        );
      return text(rows.map(memoryLine).join("\n"));
    }

    const sources = args.include_session_history === false ? ["memory"] : ["memory", "session"];
    const vectorSearch = await vectorRanker(ctx, db);
    const r = await search(db, args.query, {
      limit: limit * 2,
      mode: "hybrid",
      vectorSearch,
      filters: { source: sources },
    });
    const seen = new Set<string>();
    // Opt-in precision rerank of the memory hits (adjudicator.features.recall); off = unchanged.
    const rerankOn = featuresWanted(ctx.config.adjudicator) && args.query.trim().length > 0;
    const entries: Array<{ line: string; mem?: { key: string; cand: RerankCandidate } }> = [];
    for (const h of r.hits) {
      const d = h.chunk.document;
      const snippet = h.snippet.replace(/\s+/g, " ").trim();
      if (d.source === "memory") {
        const name = d.uri?.startsWith("memory:") ? d.uri.slice(7) : undefined;
        const m: MemoryRow | undefined = name ? db.memoryGetByName(name) : undefined;
        if (!m?.name || seen.has(m.name)) continue;
        if (args.kind && m.kind !== args.kind) continue;
        if (args.topic && !m.name.startsWith(`${args.topic}/`)) continue;
        seen.add(m.name);
        entries.push({
          line: `${m.name} [${m.kind}] ${new Date(m.updated_at ?? m.created_at).toISOString().slice(0, 10)} — ${snippet}`,
          mem: {
            key: `memory:${m.name}`,
            cand: {
              key: `memory:${m.name}`,
              label: `${m.name} [${m.kind}]`,
              text: `${m.name}: ${m.content}`,
              matched: [],
              outcome: "shown",
            },
          },
        });
      } else if (!args.kind && !args.topic) {
        entries.push({
          line: `[session ${d.title}] ${new Date(d.created_at).toISOString().slice(0, 10)} — ${snippet}`,
        });
      }
      if (!rerankOn && entries.length >= limit) break;
    }
    let ordered = entries;
    if (rerankOn) {
      const mems = entries.flatMap((e) => (e.mem ? [e.mem] : []));
      const keys = await rerankMemories(
        ctx,
        db,
        args.query,
        mems.map((m) => m.cand),
        limit,
      );
      if (keys) {
        const byKey = new Map(entries.filter((e) => e.mem).map((e) => [e.mem!.key, e]));
        const next = keys.flatMap((k) => (byKey.has(k) ? [byKey.get(k)!] : []));
        let i = 0;
        // memory slots keep their place among the session lines; the reranked order fills them
        ordered = entries.flatMap((e) => (e.mem ? (i < next.length ? [next[i++]!] : []) : [e]));
      }
    }
    for (const e of ordered) {
      if (lines.length >= limit) break;
      lines.push(e.line);
    }
    if (r.corrections.length)
      lines.unshift(`(corrected: ${r.corrections.map((c) => `${c.from}→${c.to}`).join(", ")})`);
    const note =
      !vectorSearch && ctx.config.embeddings.enabled
        ? "\n(embeddings: model still loading — lexical results only this time)"
        : "";
    return text((lines.length ? lines.join("\n") : `nothing recalled for "${args.query}"`) + note);
  },
});

/**
 * The memory keys in the order the decision provider prefers, or undefined to keep the hybrid
 * order (feature off, shadow, unsupported, slow, or any error). Direct call within mcpMs.
 */
async function rerankMemories(
  ctx: Parameters<NonNullable<typeof emRecall.handler>>[1],
  db: ReturnType<typeof getStorage>,
  query: string,
  candidates: RerankCandidate[],
  _limit: number,
): Promise<string[] | undefined> {
  try {
    if (!candidates.length) return undefined;
    const [{ createDecisionClient }, { askRecallRerank }] = await Promise.all([
      import("../decisions/client.js"),
      import("../decisions/features/recall.js"),
    ]);
    const cfg = ctx.config.adjudicator;
    const client = createDecisionClient("recall", {
      config: cfg,
      db,
      context: "server",
      getEmbedder: () => getProvider(ctx.config),
    });
    return await askRecallRerank(client, {
      path: "prompt",
      query,
      candidates,
      dropBelow: cfg.features.recall.dropBelow,
      budgetMs: cfg.features.recall.mcpMs,
    });
  } catch {
    return undefined;
  }
}
