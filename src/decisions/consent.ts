import { originOf } from "../adjudicator/config.js";
import type { AdjudicatorConfig } from "../config.js";
import type { DecisionFeature } from "./types.js";

/** What a feature sends off this machine, as one class the user agrees to once per origin. */
export type DataClass = "memory" | "diffs" | "session" | "swarm" | "packages";

export const DATA_CLASS: Record<DecisionFeature, DataClass> = {
  recall: "memory",
  memory: "memory",
  commit: "diffs",
  compaction: "session",
  swarm: "swarm",
  docs: "packages",
};

/** The line the CLI shows before it writes the consent. Prompts are covered by remoteConsent. */
export function consentLine(c: DataClass, o: { origin: string; maxChars: number }): string {
  switch (c) {
    case "memory":
      return `sends the redacted prompt plus redacted memory and doc snippets (up to ${o.maxChars} chars each) to ${o.origin}`;
    case "diffs":
      return `sends the redacted staged diff (up to ${o.maxChars} chars, files matching commit.exclude left out) and the commit message to ${o.origin}`;
    case "session":
      return `sends redacted session-guide sections and, with compaction.output on, redacted em_execute output sections to ${o.origin}`;
    case "swarm":
      return `sends task titles, status changes and redacted blackboard posts of swarm runs to ${o.origin}`;
    case "packages":
      return `sends dependency names and versions only to ${o.origin}`;
  }
}

/** The featureConsent entry for a class at an origin. */
export function consentEntry(c: DataClass, origin: string): string {
  return `${c}@${origin}`;
}

/** Did the user agree to feature `f`'s data class at `origin`? A changed baseUrl means asking again. */
export function hasFeatureConsent(
  cfg: Pick<AdjudicatorConfig, "featureConsent">,
  f: DecisionFeature,
  origin: string | undefined,
): boolean {
  if (!origin) return false;
  const want = consentEntry(DATA_CLASS[f], origin);
  return cfg.featureConsent.some((e) => {
    const at = e.indexOf("@");
    if (at < 0) return false;
    const o = originOf(e.slice(at + 1));
    return o !== undefined && `${e.slice(0, at)}@${o}` === want;
  });
}
