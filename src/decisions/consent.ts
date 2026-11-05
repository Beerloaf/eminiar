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
      return `sends redacted session-guide sections (the latest request, intent, files, tasks and similar) and, with compaction.output on, redacted sections of em_execute command output only (never em_execute_file or em_batch_execute contents; lines that look like secrets are masked) to ${o.origin}`;
    case "swarm":
      return `sends task titles, statuses, the first line of task results, worker roles and tool-call counts, the first line of worker final messages, spawn prompts and other trail events, and redacted blackboard posts of swarm runs to ${o.origin}`;
    case "packages":
      return `sends package names only, never versions, and only for well-known catalogued packages or names your lockfile shows came from the default public registry (registry.npmjs.org or pypi.org; Go modules on vendor-run hosts); workspace members, scoped npm packages, git, URL and path sources, names a declared private index could serve, and anything unverified are never sent, to ${o.origin}`;
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
