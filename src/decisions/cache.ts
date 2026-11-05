import { createHash } from "node:crypto";
import { inputHash } from "../adjudicator/redact.js";
import type { DecisionFeature, DecisionQuestionSpec } from "./types.js";

/** Hash of a question's wording, so edited instructions never hit an old answer. */
export function questionHash(q: DecisionQuestionSpec): string {
  return createHash("sha256")
    .update(JSON.stringify([q.kind, q.instructions, q.options ?? null, q.levels ?? null]))
    .digest("hex")
    .slice(0, 16);
}

/**
 * sha256 over feature | mode | provider | model | questionVersion | question | context | item id | item text.
 * Context and item text are the REDACTED strings that would be sent, hashed, never stored.
 */
export function decisionCacheKey(o: {
  feature: DecisionFeature;
  /** Shadow and live never share an answer: a shadow answer must not act the moment it flips. */
  mode: "shadow" | "live";
  provider: string;
  model: string;
  questionVersion: number;
  question: DecisionQuestionSpec;
  context: string;
  itemId: string;
  itemText: string;
}): string {
  return createHash("sha256")
    .update(
      [
        o.feature,
        o.mode,
        o.provider,
        o.model,
        String(o.questionVersion),
        `${o.question.name}:${questionHash(o.question)}`,
        inputHash(o.context),
        o.itemId,
        inputHash(o.itemText),
      ].join("|"),
    )
    .digest("hex");
}
