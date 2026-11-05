import { redact } from "../../adjudicator/redact.js";
import { loadConfig } from "../../config.js";
import type { ProjectContext } from "../../context.js";
import type { SearchResponse } from "../../search/pipeline.js";
import {
  type GuideSection,
  guideSections,
  renderSections,
  SNAPSHOT_BUDGET,
} from "../../session/guide.js";
import type { StorageAdapter } from "../../storage/adapter.js";
import { createDecisionClient } from "../client.js";
import type { DecisionFeatureModule } from "../feature.js";
import {
  type Answers,
  type Decision,
  type DecisionClient,
  type DecisionJob,
  type DecisionQuestionSpec,
  scoreActs,
} from "../types.js";

/**
 * Feature "compaction" (docs/design/jev-integration-options.md, option D). Two uses of one
 * question, "how useful is this piece for the current task":
 *  - the session guide written at PreCompact: score its sections, keep the most useful ones that
 *    fit SNAPSHOT_BUDGET, drop those below minKeep. A detached job rewrites the snapshot, and only
 *    while that snapshot is still the newest unconsumed one.
 *  - sandbox output triage (compaction.output): score the matched sections of an indexed output
 *    and return the useful ones, best first.
 * Shadow records what would have been kept or dropped and changes nothing. Every failure leaves
 * the deterministic result, byte for byte.
 */

const USEFUL: DecisionQuestionSpec = {
  name: "useful",
  kind: "score",
  instructions: "How useful is {item} for continuing the task in state.context?",
  levels: ["useless", "low", "some", "high", "essential"],
};

const MAX_ITEMS = 40;
const OUTPUT_CANDIDATES = 12;
const PRIORITY_ALWAYS = 1;

interface Payload {
  sessionId: string;
  snapshotId: number;
}

const isPayload = (p: unknown): p is Payload =>
  !!p &&
  typeof (p as Payload).sessionId === "string" &&
  typeof (p as Payload).snapshotId === "number";

const scoreOf = (a: Answers, id: string): number | undefined => {
  const v = a[id]?.[USEFUL.name];
  return v?.kind === "score" ? v.value : undefined;
};

/** May this item's score drop it? Uncalibrated scores reorder only. */
const canDrop = (a: Answers, id: string): boolean => scoreActs(a[id]?.[USEFUL.name], "drop");

/** Labels present in a rendered guide. */
const labelsIn = (body: string, sections: GuideSection[]): string[] =>
  sections.filter((s) => body.includes(`**${s.label}**: `)).map((s) => s.id);

/** Rendered size of one section on its own, with the newline that joins it to the next. */
const sizeOf = (s: GuideSection) => Buffer.byteLength(s.text) + 1;

/** Pick sections by score: the P1 ones always, then the best that fit, none below minKeep. */
export function chooseSections(
  sections: GuideSection[],
  score: (s: GuideSection) => number,
  minKeep: number,
  budget: number,
  /** Sections whose score may drop them below minKeep (default all). */
  canDropSection: (s: GuideSection) => boolean = () => true,
): GuideSection[] {
  const chosen = new Set<GuideSection>();
  let used = 0;
  for (const s of sections) {
    if (s.priority <= PRIORITY_ALWAYS) {
      chosen.add(s);
      used += sizeOf(s);
    }
  }
  const ranked = sections
    .filter((s) => !chosen.has(s) && (score(s) >= minKeep || !canDropSection(s)))
    .sort((a, b) => score(b) - score(a) || a.priority - b.priority);
  for (const s of ranked) {
    if (used + sizeOf(s) > budget) continue;
    chosen.add(s);
    used += sizeOf(s);
  }
  return sections.filter((s) => chosen.has(s));
}

/** The user's latest request from the guide sections: the context of the question. */
function taskOf(sections: GuideSection[]): string {
  const s =
    sections.find((x) => x.id === "Last Request") ?? sections.find((x) => x.id === "Intent");
  return s ? (s.items[s.items.length - 1] ?? "") : "";
}

async function runCompactionJob(
  job: DecisionJob,
  client: DecisionClient,
  db: StorageAdapter,
): Promise<void> {
  try {
    if (!isPayload(job.payload)) return;
    const { sessionId, snapshotId } = job.payload;
    const fc = loadConfig(job.projectRoot).adjudicator.features.compaction;
    const sections = guideSections(db, sessionId);
    if (sections.length < 2) return;
    const baselineBody = renderSections(sections, SNAPSHOT_BUDGET);
    const baselineKept = labelsIn(baselineBody, sections);
    let body: string | undefined;
    const stillLatest = () => db.snapshotLatestUnconsumed(sessionId)?.id === snapshotId;

    const res = await client.ask(
      {
        feature: "compaction",
        subject: `snapshot:${snapshotId}`,
        context: taskOf(sections),
        items: sections
          .slice(0, MAX_ITEMS)
          .map((s) => ({ id: s.id, text: s.text, label: s.label })),
        questions: [USEFUL],
        baseline: { kept: baselineKept },
        budgetMs: fc.jobMs,
        sessionId,
        questionVersion: feature.questionVersion,
      },
      (answers): Decision => {
        // A section the provider did not score keeps its baseline fate (1 if rendered, else 0).
        const score = (s: GuideSection) =>
          scoreOf(answers, s.id) ?? (baselineKept.includes(s.id) ? 1 : 0);
        const chosen = chooseSections(
          sections,
          score,
          fc.minKeep,
          SNAPSHOT_BUDGET,
          // an unscored section keeps its baseline fate; a scored one drops only when calibrated
          (s) => scoreOf(answers, s.id) === undefined || canDrop(answers, s.id),
        );
        body = renderSections(chosen, SNAPSHOT_BUDGET);
        const kept = labelsIn(body, sections);
        const dropped = sections.filter((s) => !kept.includes(s.id)).map((s) => s.id);
        const changed =
          kept.filter((k) => !baselineKept.includes(k)).length +
          baselineKept.filter((k) => !kept.includes(k)).length;
        return { decision: { kept, dropped, late: !stillLatest() }, changed };
      },
    );
    if (!res.apply || !body) return;
    const newBody = body;
    // Only while nothing consumed or replaced the snapshot this job was queued for.
    db.transaction(() => {
      if (!stillLatest()) return;
      db.snapshotInsert({ sessionId, trigger: "jev", body: newBody });
      db.snapshotMarkConsumed(snapshotId);
    });
  } catch {
    // fail open: the original snapshot stands
  }
}

/** Mask whole lines the redactor would change: tool output can hold secrets. */
export function maskedLines(text: string): string {
  return text
    .split("\n")
    .map((l) => (redact(l) !== l ? "[masked line]" : l))
    .join("\n");
}

/**
 * Output triage for processOutput: score the candidate hits against the intent and return the
 * responses with only the useful hits, best first. Undefined = leave the output exactly as is
 * (off, shadow, no change, unsupported, any failure).
 */
export async function triageOutput(
  db: StorageAdapter,
  ctx: ProjectContext,
  intent: string,
  documentId: number,
  responses: SearchResponse[],
): Promise<SearchResponse[] | undefined> {
  try {
    const cfg = ctx.config.adjudicator;
    const fc = cfg.features.compaction;
    const client = createDecisionClient("compaction", { config: cfg, db, context: "server" });
    if (!client.active()) return undefined;
    const keyOf = (h: SearchResponse["hits"][number]) => `c${h.chunk.ord}`;
    const cands = new Map<string, SearchResponse["hits"][number]>();
    for (const r of responses)
      for (const h of r.hits) {
        if (cands.size >= OUTPUT_CANDIDATES) break;
        if (!cands.has(keyOf(h))) cands.set(keyOf(h), h);
      }
    if (cands.size < 2) return undefined;
    const ids = [...cands.keys()];
    let scores: Record<string, number> = {};
    const res = await client.ask(
      {
        feature: "compaction",
        subject: `output:doc${documentId}`,
        context: intent,
        items: ids.map((id) => ({ id, text: maskedLines(cands.get(id)?.snippet ?? "") })),
        questions: [USEFUL],
        baseline: { shown: ids },
        budgetMs: fc.mcpMs,
        questionVersion: feature.questionVersion,
      },
      (answers): Decision => {
        scores = Object.fromEntries(ids.map((id) => [id, scoreOf(answers, id) ?? 1]));
        const kept = ids
          .filter((id) => (scores[id] ?? 1) >= fc.minKeep || !canDrop(answers, id))
          .sort((a, b) => (scores[b] ?? 1) - (scores[a] ?? 1));
        // Never empty the output: with nothing above minKeep the deterministic result stands.
        const same = !kept.length || kept.join() === ids.join();
        const changed = same ? 0 : ids.length - kept.length || 1;
        return { decision: { kept: same ? ids : kept }, changed };
      },
    );
    if (!res.apply) return undefined;
    const kept = (res.decision?.decision as { kept?: string[] } | undefined)?.kept;
    if (!kept?.length) return undefined;
    return responses.map((r) => {
      const inCands = r.hits.filter((h) => cands.has(keyOf(h)));
      const rest = r.hits.filter((h) => !cands.has(keyOf(h)));
      const hits = inCands
        .filter((h) => kept.includes(keyOf(h)))
        .sort((a, b) => (scores[keyOf(b)] ?? 1) - (scores[keyOf(a)] ?? 1));
      return { ...r, hits: [...hits, ...rest] };
    });
  } catch {
    return undefined;
  }
}

export const feature: DecisionFeatureModule = {
  questionVersion: 1,
  preCompact: (_seam, x) => ({ sessionId: x.sessionId, snapshotId: x.snapshotId }),
  runJob: runCompactionJob,
};
