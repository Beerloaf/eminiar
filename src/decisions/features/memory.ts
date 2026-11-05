import type { ProjectContext } from "../../context.js";
import { getProvider } from "../../embeddings/provider.js";
import { vectorRanker } from "../../embeddings/queue.js";
import { search } from "../../search/pipeline.js";
import type { StorageAdapter } from "../../storage/adapter.js";
import { createDecisionClient, type DecisionClientDeps } from "../client.js";
import { decisionFeatureConfig } from "../config.js";
import type { DecisionFeatureModule } from "../feature.js";
import { type Answers, choiceClears, clears, type DecisionQuestionSpec } from "../types.js";

/**
 * Decision feature "memory" (docs/design/jev-integration-options.md, option B): after em_remember
 * writes a memory, ask whether its nearest existing memories duplicate or supersede it, and
 * return one suggestion line for the tool reply. It never edits, replaces or supersedes anything.
 * Shadow, off, unsupported or an error all give undefined, so the reply stays as it was.
 */
export const feature: DecisionFeatureModule = {
  questionVersion: 1,
};

const SIM_QUESTION: DecisionQuestionSpec = {
  name: "memory_duplicate",
  kind: "yes_no",
  instructions:
    "Is the existing memory {item} a duplicate of the new memory, saying essentially the same thing?",
  similarity: "duplicate",
};

const CHOICE_QUESTION: DecisionQuestionSpec = {
  name: "memory_relation",
  kind: "choice",
  instructions:
    "How does the new memory relate to the existing memory {item}? Decide whether it repeats it, replaces it with a newer decision, concerns the same topic, or is about something else.",
  options: {
    duplicate: "the new memory says the same thing as the existing one",
    supersedes: "the new memory replaces or contradicts the existing one with a newer decision",
    related: "the same topic, but both are still valid",
    unrelated: "a different subject",
  },
};

export interface MemoryHygieneInput {
  /** The name the new memory was written under (excluded from the neighbours). */
  name: string;
  content: string;
  /** The caller already named a memory to supersede: nothing to suggest. */
  supersedes?: string | undefined;
  sessionId?: string | undefined;
}

/**
 * The suggestion line, or undefined. Never throws. The caller guards on featuresWanted so a
 * configuration with the feature off never loads this module.
 */
export async function suggestMemoryHygiene(
  ctx: ProjectContext,
  db: StorageAdapter,
  input: MemoryHygieneInput,
  /** Test seam: a provider or env to run the client with. */
  over: Partial<DecisionClientDeps> = {},
): Promise<string | undefined> {
  try {
    const cfg = ctx.config.adjudicator;
    if (input.supersedes) return undefined;
    const client = createDecisionClient("memory", {
      config: cfg,
      db,
      context: "server",
      getEmbedder: () => getProvider(ctx.config),
      ...over,
    });
    if (!client.active()) return undefined;
    const fc = decisionFeatureConfig(cfg, "memory") as {
      k: number;
      minProb: number;
      mcpMs: number;
    };
    const k = Math.max(1, fc.k);

    const vectorSearch = await vectorRanker(ctx, db).catch(() => undefined);
    const r = await search(db, input.content.slice(0, 200), {
      limit: k + 2,
      filters: { source: "memory" },
      vectorSearch,
    });
    const seen = new Set<string>([input.name]);
    const items: Array<{ id: string; text: string }> = [];
    for (const h of r.hits) {
      const name = (h.chunk.document.uri ?? "").replace(/^memory:/, "");
      if (seen.has(name)) continue;
      seen.add(name);
      const row = db.memoryGetByName(name);
      if (!row || row.status === "superseded") continue;
      items.push({ id: name, text: row.content });
      if (items.length >= k) break;
    }
    if (items.length === 0) return undefined;

    // Providers that cannot give a probability for a choice ask the duplicate yes/no question,
    // whose uncalibrated number is held to the conservative bar by clears().
    const yesNoOnly = cfg.provider === "embedding" || cfg.provider === "openai-compatible";
    const q = yesNoOnly ? SIM_QUESTION : CHOICE_QUESTION;
    const minProb = fc.minProb;
    const decide = (answers: Answers) => {
      let best: { id: string; rel: "duplicate" | "supersedes"; score: number } | undefined;
      for (const it of items) {
        const a = answers[it.id]?.[q.name];
        if (!a) continue;
        let rel: "duplicate" | "supersedes" | undefined;
        let score = 0;
        if (a.kind === "yes_no") {
          if (clears(a, minProb)) {
            rel = "duplicate";
            score = a.p;
          }
        } else if (a.kind === "choice") {
          for (const opt of ["duplicate", "supersedes"] as const)
            if (choiceClears(a, opt, minProb)) {
              rel = opt;
              score = a.probs[opt] ?? a.confidence;
            }
        }
        if (rel && (!best || score > best.score)) best = { id: it.id, rel, score };
      }
      if (!best) return { decision: { suggestion: "none" }, changed: 0 };
      const note =
        best.rel === "duplicate"
          ? `looks like a duplicate of ${best.id}; consider em_memory on it instead of a second copy`
          : `looks like it supersedes ${best.id}; pass supersedes: "${best.id}" to confirm`;
      return { decision: { suggestion: best.rel, id: best.id }, changed: 1, note };
    };

    const res = await client.ask(
      {
        feature: "memory",
        subject: `memory:${input.name}`,
        context: input.content,
        items,
        questions: [q],
        baseline: { suggestion: "none" },
        budgetMs: fc.mcpMs,
        questionVersion: feature.questionVersion,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      },
      decide,
    );
    return res.apply ? res.decision?.note : undefined;
  } catch {
    return undefined;
  }
}
