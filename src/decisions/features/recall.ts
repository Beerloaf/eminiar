import { createHash } from "node:crypto";
import { loadConfig } from "../../config.js";
import { promptTerms } from "../../session/recall.js";
import type { DecisionFeatureModule, HookSeam } from "../feature.js";
import {
  type Answers,
  type AskInput,
  clears,
  type Decision,
  type DecisionClient,
  type DecisionItem,
  type DecisionQuestionSpec,
  type RecallRerank,
  type RerankCandidate,
} from "../types.js";

/**
 * Feature "recall": precision for the term-matched candidates of recallForText (prompt path) and
 * recallForError (past errors), plus error recurrence ("same underlying failure?"). One yes/no
 * question per candidate, answerable by a calibrated provider or by embedding similarity.
 *
 * Hook path: no call. The seam looks the answers up in the cache; a hit is recorded and (in live
 * mode) reorders / drops candidates, a miss queues one detached job that asks and fills the cache.
 * MCP path (em_recall): askRecallRerank asks directly within the feature's mcpMs budget.
 * Everything falls back to the term-matched result by returning undefined.
 */

const QUESTION_VERSION = 1;
const MAX_ITEMS = 8;
const ITEM_CHARS = 600;
const POOL = new Set<RerankCandidate["outcome"]>(["shown", "over-limit"]);

const RELEVANT: DecisionQuestionSpec = {
  name: "relevant",
  kind: "yes_no",
  similarity: "relevance",
  instructions:
    "Is {item} directly relevant to what the request in the shared context is about, so that knowing it would change how the work is done?",
};
const SAME_FAILURE: DecisionQuestionSpec = {
  name: "same_failure",
  kind: "yes_no",
  similarity: "relevance",
  instructions:
    "Is {item} the same underlying failure as the error in the shared context (same cause, not merely similar wording)?",
};

export type RecallPath = "prompt" | "error";

function questionFor(key: string): DecisionQuestionSpec {
  return key.startsWith("err:") ? SAME_FAILURE : RELEVANT;
}

function hash12(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 12);
}

/**
 * The candidates worth asking about: those that cleared the term bar (shown or over the limit),
 * the shown ones first so a full pool never leaves a shown candidate unasked.
 */
function pool(cands: RerankCandidate[]): RerankCandidate[] {
  const ok = cands.filter((c) => POOL.has(c.outcome));
  // over-limit candidates alternate between memories and docs, so neither kind crowds the other out
  const over = ok.filter((c) => c.outcome !== "shown");
  const mem = over.filter((c) => c.key.startsWith("memory:"));
  const other = over.filter((c) => !c.key.startsWith("memory:"));
  const mixed: RerankCandidate[] = [];
  for (let i = 0; i < Math.max(mem.length, other.length); i++) {
    if (mem[i]) mixed.push(mem[i]!);
    if (other[i]) mixed.push(other[i]!);
  }
  return [...ok.filter((c) => c.outcome === "shown"), ...mixed].slice(0, MAX_ITEMS);
}

/**
 * The cache context of a request: the sorted, de-duplicated search terms, so two prompts that
 * mean the same thing (same terms) share one verdict. Hashed with the key, never stored or sent.
 */
function termsOf(query: string): string | undefined {
  const t = [...new Set(promptTerms(query))].sort().join(" ");
  return t || undefined;
}

/**
 * The cache context of an error request: a hash of the whole normalised error text (case and
 * whitespace folded), so two errors that share a long preamble but differ later never share a
 * "same failure?" verdict. Term sets cannot tell them apart (they are capped at the first terms).
 */
export function errorContext(query: string): string | undefined {
  const n = query.toLowerCase().replace(/\s+/g, " ").trim();
  return n ? `error ${hash12(n)} ${hash12(n.slice(-200))}` : undefined;
}

interface Spec {
  path: RecallPath;
  query: string;
  items: DecisionItem[];
  /** Every key the term match shows (the pool's and those past it). */
  baseline: string[];
  /** Shown keys that did not fit the pool: kept, after the answered ones, never dropped. */
  rest?: string[];
}

function specOf(path: RecallPath, query: string, cands: RerankCandidate[]): Spec | undefined {
  const p = pool(cands);
  if (!p.length) return undefined;
  const inPool = new Set(p.map((c) => c.key));
  return {
    path,
    query,
    items: p.map((c) => ({
      id: c.key,
      text: c.text.slice(0, ITEM_CHARS),
      label: c.label,
    })),
    baseline: cands.filter((c) => c.outcome === "shown").map((c) => c.key),
    rest: cands.filter((c) => c.outcome === "shown" && !inPool.has(c.key)).map((c) => c.key),
  };
}

function inputOf(
  spec: Spec,
  sessionId: string | undefined,
): Omit<AskInput, "budgetMs"> & { questions: DecisionQuestionSpec[] } {
  const questions = [...new Set(spec.items.map((i) => questionFor(i.id)))];
  // a single question per input keeps the cache lookup uniform; mixed pools ask both per item
  const input: Omit<AskInput, "budgetMs"> & { questions: DecisionQuestionSpec[] } = {
    feature: "recall",
    subject: `${spec.path}:${hash12(spec.query)}`,
    context: spec.query,
    items: spec.items,
    questions,
    baseline: spec.baseline,
    questionVersion: QUESTION_VERSION,
  };
  const cc = spec.path === "error" ? errorContext(spec.query) : termsOf(spec.query);
  if (cc) input.cacheContext = cc;
  if (sessionId) input.sessionId = sessionId;
  return input;
}

/**
 * Turn the answers into the keys to show: highest probability first, and a candidate a calibrated
 * provider rates below `dropBelow` is left out. An uncalibrated answer (embedding similarity, a
 * model's own number) only reorders: it is never trusted to drop. Keys the provider did not answer
 * keep their place after the answered ones.
 */
export function decideRecall(spec: Spec, dropBelow: number): (a: Answers) => Decision {
  return (answers) => {
    const scored = spec.items.map((it, i) => {
      const a = answers[it.id]?.[questionFor(it.id).name];
      const yn = a?.kind === "yes_no" ? a : undefined;
      return { key: it.id, i, p: yn ? yn.p : -1, drop: !!yn?.calibrated && !clears(yn, dropBelow) };
    });
    // The shown text groups memories before docs, so compare (and emit) in that grouping: a
    // memory-vs-doc order change alone changes nothing the reader sees.
    const grouped = (ks: string[]) => [
      ...ks.filter((k) => k.startsWith("memory:")),
      ...ks.filter((k) => !k.startsWith("memory:")),
    ];
    const ranked = scored
      .filter((s) => !s.drop)
      .sort((x, y) => y.p - x.p || x.i - y.i)
      .map((s) => s.key);
    const keys = grouped([...ranked, ...(spec.rest ?? [])]);
    const base = grouped(spec.baseline);
    const head = keys.slice(0, base.length);
    const changed = head.length === base.length && head.every((k, n) => k === base[n]) ? 0 : 1;
    const decision: Decision = { decision: keys, changed };
    // A dashboard line only (no `deliver`): recall's effect is the reordered recall block.
    if (changed)
      decision.note = `recall ${spec.path}: ${keys.length}/${spec.items.length + (spec.rest?.length ?? 0)} kept`;
    return decision;
  };
}

function asKeys(d: Decision | undefined): string[] | undefined {
  return Array.isArray(d?.decision) ? (d.decision as string[]) : undefined;
}

/** em_recall / CLI: ask directly within the budget. Undefined means keep the original order. */
export async function askRecallRerank(
  client: DecisionClient,
  o: {
    path: RecallPath;
    query: string;
    candidates: RerankCandidate[];
    dropBelow: number;
    budgetMs: number;
    sessionId?: string | undefined;
  },
): Promise<string[] | undefined> {
  try {
    if (!client.active()) return undefined;
    const spec = specOf(o.path, o.query, o.candidates);
    if (!spec) return undefined;
    const input = inputOf(spec, o.sessionId);
    const r = await client.ask({ ...input, budgetMs: o.budgetMs }, decideRecall(spec, o.dropBelow));
    return r.apply ? asKeys(r.decision) : undefined;
  } catch {
    return undefined;
  }
}

export const feature: DecisionFeatureModule = {
  questionVersion: QUESTION_VERSION,

  recallRerank(seam: HookSeam, path: RecallPath): RecallRerank | undefined {
    const dropBelow = seam.ctx.config.adjudicator.features.recall.dropBelow;
    return (query, candidates) => {
      try {
        const spec = specOf(path, query, candidates);
        if (!spec) return undefined;
        const input = inputOf(spec, seam.sessionId);
        const answers = seam.client.cached(input);
        if (!answers) {
          // deferred: the job asks, the verdict is recorded beside the baseline
          seam.spawn({
            path,
            query,
            items: spec.items,
            baseline: spec.baseline,
            rest: spec.rest,
          });
          return undefined;
        }
        const decision = decideRecall(spec, dropBelow)(answers);
        const live = seam.client.mode() === "live" && decision.changed > 0;
        seam.client.record(
          {
            feature: "recall",
            subject: input.subject,
            baseline: spec.baseline,
            sessionId: seam.sessionId,
            items: spec.items.length,
          },
          "cached",
          decision,
          { applied: live },
        );
        return live ? asKeys(decision) : undefined;
      } catch {
        return undefined;
      }
    };
  },

  async runJob(job, client) {
    try {
      const p = job.payload as Partial<Spec> | undefined;
      if (
        !p ||
        (p.path !== "prompt" && p.path !== "error") ||
        typeof p.query !== "string" ||
        !Array.isArray(p.items) ||
        !Array.isArray(p.baseline)
      )
        return;
      const items = p.items
        .filter(
          (i): i is DecisionItem => !!i && typeof i.id === "string" && typeof i.text === "string",
        )
        .slice(0, MAX_ITEMS);
      if (!items.length) return;
      const rest = Array.isArray(p.rest) ? p.rest.map(String) : [];
      const spec: Spec = {
        path: p.path,
        query: p.query,
        items,
        baseline: p.baseline.map(String),
        rest,
      };
      const fc = loadConfig(job.projectRoot).adjudicator.features.recall;
      // The job only fills the cache: it changes no output, so its row is never "applied".
      await client.ask(
        { ...inputOf(spec, job.sessionId), budgetMs: fc.jobMs, fillOnly: true },
        decideRecall(spec, fc.dropBelow),
      );
    } catch {
      // a job never throws
    }
  },
};
