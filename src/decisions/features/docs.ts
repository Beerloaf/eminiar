import { createHash } from "node:crypto";
import type { AdjudicatorConfig } from "../../config.js";
import type { Discovery, ProviderCandidate } from "../../docs/discover.js";
import { decisionFeatureConfig } from "../config.js";
import type { DecisionFeatureModule } from "../feature.js";
import type {
  Answers,
  AskResult,
  Decision,
  DecisionClient,
  DecisionQuestionSpec,
} from "../types.js";
import { scoreActs } from "../types.js";

/**
 * Decision feature "docs" (docs/design/jev-integration-options.md, option F): score each
 * dependency by how much a coding agent benefits from having its documentation indexed, and let
 * the scores order the registry and library candidates of `em_docs discover`. Only the package
 * ecosystem and name of catalogued or lockfile-verified public packages leave the machine. Shadow, off, unsupported and error leave the discovery
 * untouched (the output is byte-identical to the deterministic one).
 */
export const feature: DecisionFeatureModule = {
  questionVersion: 1,
};

const QUESTION = "benefit";
/** Item × question pairs per request is 40; stay well below it. */
export const DOCS_MAX_ITEMS = 30;
/** At most this many registry packages are flagged recommended. */
export const DOCS_MAX_RECOMMENDED = 5;

export const DOCS_QUESTION: DecisionQuestionSpec = {
  name: QUESTION,
  kind: "score",
  instructions:
    "How much does a coding agent benefit from having the documentation of {item} indexed? Judge only the package named, by ecosystem and name.",
  levels: ["none", "low", "medium", "high", "essential"],
};

const ECOSYSTEM: Record<string, string> = { npm: "npm", pypi: "PyPI", go: "Go module" };

/**
 * May this package name leave the machine? Only names in the bundled catalogue of well-known
 * packages, or ones the project's own files show come from the default public registry
 * (`publicVerified`: lockfile entries resolved from registry.npmjs.org or pypi.org, a Go module on
 * a vendor-run host without replace or go.work). Workspace members, git, URL and path sources and
 * names a private index could serve are never sent. When unsure, the name stays home.
 */
export function isPublicName(p: ProviderCandidate): boolean {
  if (p.nonRegistry) return false;
  // only the BUNDLED catalogue counts: a team's own docs.catalog entries may name private packages
  if (p.confidence === "catalog" && p.builtinCatalog === true) return true;
  return p.publicVerified === true && /^(npm|pypi|go):/.test(p.provider);
}

/** The candidates worth scoring: unregistered public packages, most widely used first. */
export function scorable(d: Discovery): ProviderCandidate[] {
  return d.providers
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => !p.registered && /^(npm|pypi|go):/.test(p.provider))
    .filter(({ p }) => isPublicName(p))
    .filter(({ p }) => p.confidence === "registry" || (p.tier ?? "library") === "library")
    .sort((a, b) => b.p.usedBy.length - a.p.usedBy.length || a.i - b.i)
    .slice(0, DOCS_MAX_ITEMS)
    .map(({ p }) => p);
}

function scoreOf(answers: Answers, id: string): number | undefined {
  const a = answers[id]?.[QUESTION];
  return a?.kind === "score" ? a.value : undefined;
}

/**
 * Apply scores to a copy of the discovery: within each confidence group the scored candidates
 * take the group's scored slots in descending score order (unscored ones keep their place), and
 * registry packages at or above `minScore` are flagged recommended (at most five).
 */
export function applyDocsScores(
  d: Discovery,
  scores: Map<string, number>,
  minScore: number,
  /** Providers whose score may flag them recommended (default all); others only reorder. */
  flaggable: (provider: string) => boolean = () => true,
): { discovery: Discovery; reordered: number; flagged: number } {
  const providers = d.providers.map((p) => ({ ...p }));
  let reordered = 0;
  for (const conf of ["catalog", "registry", "probe", "unknown"] as const) {
    const slots: number[] = [];
    providers.forEach((p, i) => {
      if (p.confidence === conf && scores.has(p.provider)) slots.push(i);
    });
    const sorted = slots
      .map((i) => providers[i]!)
      .sort((a, b) => scores.get(b.provider)! - scores.get(a.provider)!);
    const before = slots.map((i) => providers[i]!);
    slots.forEach((slot, k) => {
      providers[slot] = sorted[k]!;
      if (sorted[k] !== before[k]) reordered++;
    });
  }
  let flagged = 0;
  for (const p of providers) {
    const s = scores.get(p.provider);
    if (s === undefined) continue;
    p.docsScore = Math.round(s * 100) / 100;
    if (
      p.confidence === "registry" &&
      s >= minScore &&
      flaggable(p.provider) &&
      flagged < DOCS_MAX_RECOMMENDED
    ) {
      p.recommended = true;
      flagged++;
    }
  }
  return { discovery: { ...d, providers }, reordered, flagged };
}

export interface DocsTriage {
  discovery: Discovery;
  result?: AskResult;
}

/**
 * Ask the client to score the discovery's packages and return the discovery to show. Returns the
 * input untouched unless the client is live and the answers apply. Never throws.
 */
export async function triageDiscovery(
  client: DecisionClient,
  cfg: AdjudicatorConfig,
  d: Discovery,
): Promise<DocsTriage> {
  try {
    if (!client.active()) return { discovery: d };
    const items = scorable(d);
    if (!items.length) return { discovery: d };
    const fc = decisionFeatureConfig(cfg, "docs") as { minScore?: number; mcpMs?: number };
    const minScore = fc.minScore ?? 0.5;
    const ids = items.map((p) => p.provider);
    const subject = `docs:${createHash("sha256").update(ids.join("\n")).digest("hex").slice(0, 12)}`;
    let next: Discovery = d;
    const decide = (answers: Answers): Decision => {
      const scores = new Map<string, number>();
      for (const id of ids) {
        const v = scoreOf(answers, id);
        if (v !== undefined) scores.set(id, v);
      }
      const r = applyDocsScores(d, scores, minScore, (id) =>
        scoreActs(answers[id]?.[QUESTION], "flag"),
      );
      next = r.discovery;
      return {
        decision: {
          order: r.discovery.providers.map((p) => p.provider),
          recommended: r.discovery.providers.filter((p) => p.recommended).map((p) => p.provider),
        },
        changed: r.reordered + r.flagged,
        note: `scored ${scores.size} of ${items.length} packages`,
      };
    };
    const result = await client.ask(
      {
        feature: "docs",
        subject,
        items: items.map((p) => {
          const [eco, ...rest] = p.provider.split(":");
          const name = rest.join(":");
          return { id: p.provider, text: `${ECOSYSTEM[eco!] ?? eco} package ${name}`, label: name };
        }),
        questions: [DOCS_QUESTION],
        baseline: { order: d.providers.map((p) => p.provider), recommended: [] },
        budgetMs: fc.mcpMs ?? 3000,
        questionVersion: feature.questionVersion,
      },
      decide,
    );
    return result.apply ? { discovery: next, result } : { discovery: d, result };
  } catch {
    return { discovery: d };
  }
}
