/**
 * Pure helpers for the Jev impact panel (no Preact, no DOM) so the node test suite can cover
 * them: the gating check, verdict and evidence labels, the heuristic → final tier grid, the
 * latency Jev adds, and the tiles, tables and footer lines of the panel.
 *
 * Types come type-only from the node side's report module (src/adjudicator/jev-impact.ts keeps
 * its own imports web-safe) and never from ../api.ts or src/ui/adjudicator-api.ts, so this file
 * stays loadable by the node tests.
 */
import type {
  JevCounts,
  JevDimInfluence,
  JevEvidenceKind,
  JevImpactReport,
  JevLatency,
  JevSplit,
  JevTierInfluence,
  JevTransition,
  JevVerdictLabel,
} from "../../../adjudicator/jev-impact.js";
import { formatUsd } from "../../../usage/pricing.js";
import {
  breakerInfo,
  type MatrixGrid,
  matrixGrid,
  ms,
  rate,
  type Tone,
} from "./adjudicator-helpers.js";

/** The overview fields the gate reads (AdjOverview in ../api.ts satisfies it). */
export interface JevGateInput {
  enabled: boolean;
  provider: { configured: string };
}

/**
 * The panel is shown only when the adjudicator is on and TypeSafe Jev is the configured
 * provider. Configured, not effective: a Jev that is configured but degraded (no key, no
 * consent) still shows, with a banner, because "every call falls back" is what it should reveal.
 * The server applies the same rule and answers {active:false} otherwise.
 */
export function jevActive(ov: JevGateInput | null | undefined): boolean {
  return !!ov && ov.enabled === true && ov.provider?.configured === "typesafe";
}

const usd = (n: number | null | undefined): string =>
  n === null || n === undefined || !Number.isFinite(n) ? "—" : formatUsd(n);

// --- verdict, evidence -----------------------------------------------------------------

export function verdictTone(label: JevVerdictLabel | string | null | undefined): Tone {
  if (label === "helping") return "ok";
  if (label === "hindering") return "bad";
  return "muted";
}

export function evidenceTone(kind: JevEvidenceKind | string): Tone {
  return kind === "help" ? "ok" : kind === "hurt" ? "bad" : "muted";
}

const EVIDENCE_LABELS: Record<string, string> = {
  too_small_after_up: "marked too small after Jev moved it up",
  too_big_after_up: "marked too big after Jev moved it up",
  good_after_up: "marked good after Jev moved it up",
  too_small_after_down: "marked too small after Jev moved it down",
  too_big_after_down: "marked too big after Jev moved it down",
  good_after_down: "marked good after Jev moved it down",
  success_after_down: "the cheaper model finished the work",
  failure_after_down: "the cheaper model failed or was redone",
  success_after_up: "finished on the bigger model (not counted)",
  failure_after_up: "failed even on the bigger model (not counted)",
};

/** A recorded evidence code in plain words; unknown codes pass through readably. */
export function evidenceLabel(code: string): string {
  return EVIDENCE_LABELS[code] ?? code.replace(/_/g, " ");
}

/**
 * The line beside the verdict pill: every reason (the deciding one first, then what the evidence
 * covers, e.g. upgrades that only feedback can judge) and n.
 */
export function verdictLine(v: Pick<JevImpactReport["verdict"], "reasons" | "n">): string {
  const parts = [...(v.reasons ?? [])];
  if (v.n) parts.push(`n = ${v.n}`);
  return parts.join(" · ");
}

// --- tier grid ---------------------------------------------------------------------------

/** heuristic tier (rows) × tier with Jev (columns); the diagonal is agreement. */
export function transitionGrid(transitions: readonly JevTransition[] | undefined): MatrixGrid {
  return matrixGrid((transitions ?? []).map((t) => ({ suggested: t.from, actual: t.to, n: t.n })));
}

// --- latency -----------------------------------------------------------------------------

/**
 * The wait Jev adds at p50: the applied decisions' inline latency minus the heuristic-only
 * rows' on the same surfaces; null when either side has no samples. Never negative.
 */
export function addedLatency(
  inline: Pick<JevLatency, "n" | "p50">,
  heuristic: Pick<JevLatency, "n" | "p50">,
): number | null {
  if (!inline.n || !heuristic.n || inline.p50 === null || heuristic.p50 === null) return null;
  return Math.max(0, inline.p50 - heuristic.p50);
}

// --- tiles -------------------------------------------------------------------------------

export interface JevTile {
  title: string;
  value: string;
  sub: string;
  help: string;
}

const share = (n: number, d: number): string => (d > 0 ? rate(n / d) : "—");

/** The five tiles under the verdict. */
export function kpiRows(r: JevImpactReport, breakerState?: string | null): JevTile[] {
  const t = r.influence.tier;
  const eff = r.influence.effective;
  const c = r.cost;
  const changed = t.up + t.down;
  // Uncertain near-ties are compared but cannot show a change, so they are not in the share.
  const certain = Math.max(0, t.compared - t.uncertain);
  const cov = r.coverage;
  const answered = Math.max(0, cov.attempts - cov.errors);
  const added = addedLatency(c.inline, c.heuristicInline);
  const s = r.savings;
  const breaker = breakerInfo(breakerState);
  const netKnown = s.usageAvailable && s.repriced > 0;
  return [
    {
      title: "changed the tier",
      value: share(changed, certain),
      sub: `↑${t.up} ↓${t.down} of ${certain} compared · ${t.uncertain} uncertain left out · ${r.sample.deferred} deferred`,
      help: "decisions where Jev moved the tier away from what the heuristic alone would have chosen; uncertain near-ties and deferred async prompt rows are not counted",
    },
    {
      title: "effective model changed",
      value: share(eff.changed, eff.dispatches),
      sub: `${eff.changed} of ${eff.dispatches} dispatches · unknown ${eff.unknown}`,
      help: "dispatches whose model, after the apply bounds, differs from what the heuristic alone would have led to; unknown: a ranged role or apply bounds that are not stored could have changed the answer",
    },
    {
      title: "Jev calls",
      value: String(cov.attempts),
      sub: `${answered} answered · failure ${rate(cov.failureRate)} · p50 ${ms(c.providerLatency.p50)} · breaker ${breaker.label}`,
      help: "provider calls attempted for decisions in range, answered or not (timeouts and errors included), and the share that failed",
    },
    {
      title: "Jev spend",
      value: usd(c.spendUsd),
      sub: `${c.usdPerCall === null ? "—" : formatUsd(c.usdPerCall)} per call · adds ${
        added === null ? "—" : `~${ms(added)}`
      } inline`,
      help: "the provider's own cost; the added wait is the p50 inline latency of Jev decisions minus heuristic-only ones",
    },
    {
      title: "net from Jev's changes",
      value: netKnown ? usd(s.netUsd) : "—",
      sub: !s.usageAvailable
        ? "no usage data"
        : s.repriced === 0
          ? "no repriced dispatches yet"
          : `saved ${usd(s.downSavedUsd)} · extra ${usd(s.upCostUsd)} · spend ${usd(c.spendUsd)}`,
      help: "cost the changed dispatches would have had on the heuristic's model, minus what they cost, minus Jev's spend (list prices)",
    },
  ];
}

// --- tables ------------------------------------------------------------------------------

export interface JevSurfaceRow extends JevCounts {
  label: string;
}

/** Per-surface tier agreement, busiest first. */
export function surfaceRows(t: JevTierInfluence): JevSurfaceRow[] {
  return Object.entries(t.bySurface ?? {})
    .map(([label, c]) => ({ label, ...c }))
    .filter((r) => r.compared > 0)
    .sort((a, b) => b.compared - a.compared || a.label.localeCompare(b.label));
}

/** "agree 12 of 15 · 3 changed · 2 uncertain" for the role and tool lines. */
export function dimLine(d: JevDimInfluence): string {
  if (!d.compared) return "no compared decisions";
  return `agree ${d.agree} of ${d.compared} · ${d.changed} changed · ${d.uncertain} uncertain`;
}

/** "mean Δ +0.12 · mean |Δ| 0.40 over 18" for the complexity line. */
export function complexityLine(c: JevImpactReport["influence"]["complexity"]): string {
  if (!c.n || c.meanDelta === null) {
    return c.excludedBeforeFix
      ? `no scored rows yet (${c.excludedBeforeFix} before the score-scale fix left out)`
      : "no scored rows yet";
  }
  const d = c.meanDelta;
  const sign = d > 0 ? "+" : d < 0 ? "−" : "";
  return (
    `mean Δ ${sign}${Math.abs(d).toFixed(2)} · mean |Δ| ${(c.meanAbsDelta ?? 0).toFixed(2)} over ${c.n}` +
    (c.excludedBeforeFix ? ` · ${c.excludedBeforeFix} before the score-scale fix left out` : "")
  );
}

export interface JevOutcomeRow {
  label: string;
  changed: string;
  unchanged: string;
}

/**
 * "75% of 4": the success rate over the outcomes it is computed from (success + failure), so
 * abandoned or n/a finals never sit in the denominator (review-jev2 J6); "—" when there are none.
 */
export function successCell(s: Pick<JevSplit, "success" | "failure" | "successRate">): string {
  const n = s.success + s.failure;
  return n ? `${rate(s.successRate)} of ${n}` : "—";
}

/** Changed vs unchanged dispatches, one row per figure. */
export function outcomeRows(changed: JevSplit, unchanged: JevSplit): JevOutcomeRow[] {
  const row = (label: string, f: (s: JevSplit) => string): JevOutcomeRow => ({
    label,
    changed: f(changed),
    unchanged: f(unchanged),
  });
  return [
    row("dispatches", (s) => String(s.dispatches)),
    row("advice followed", (s) => rate(s.followRate)),
    row("success", successCell),
    row("feedback: good", (s) => String(s.feedback.good)),
    row("feedback: too small", (s) => String(s.feedback.too_small)),
    row("feedback: too big", (s) => String(s.feedback.too_big)),
  ];
}

/** The "left out" note under the outcomes table, by reason. */
export function excludedLine(x: JevImpactReport["outcomes"]["excluded"]): string {
  return [
    `kept model ${x.kept}`,
    `deferred ${x.deferred}`,
    `fell back ${x.notJev}`,
    `uncertain ${x.uncertain + x.unreconstructable}`,
    `unknown model ${x.unknown}`,
    `apply bounds not stored ${x.bounds ?? 0}`,
    `advised tier not run ${x.notRun ?? 0} (outcome and feedback not counted)`,
    `outcome not final yet ${x.notFinal ?? 0}`,
  ].join(" · ");
}

type Excluded = JevImpactReport["outcomes"]["excluded"];

/** The kept-pin note: how many dispatches kept their pin and where Jev's pick differed. */
export function keptLine(x: Pick<Excluded, "kept" | "keptDisagreed">): string | null {
  if (!x.kept) return null;
  const d = x.keptDisagreed ?? 0;
  return d > 0
    ? `${x.kept} kept their pin; Jev's pick differed on ${d}: give those roles a model_range`
    : `${x.kept} kept their pin`;
}

/** The deferred-prompt note: promptMode "blocking" is the opt-in, at the measured p50. */
export function deferredLine(r: Pick<JevImpactReport, "cost">, promptMode: unknown): string | null {
  const n = r.cost.deferred;
  if (!n || promptMode === "blocking") return null;
  const p50 = r.cost.providerLatency.p50;
  return `${n} prompts got the heuristic's advice while Jev answered in the background: set adjudicator.promptMode "blocking" to wait for Jev${p50 === null ? "" : ` (adds about ${ms(p50)} per prompt)`}`;
}

/** The decision features that are not enabled, from the overview's sanitized config. */
export function featuresOff(config: unknown): string[] {
  const f = (config as { features?: Record<string, { enabled?: boolean } | undefined> } | null)
    ?.features;
  if (!f || typeof f !== "object") return [];
  return Object.keys(f).filter((k) => f[k] && f[k]?.enabled === false);
}

/** What would give the panel a verdict; empty once it has one. */
export function verdictSteps(r: Pick<JevImpactReport, "verdict" | "outcomes">): string[] {
  const v = r.verdict;
  if (v.label !== "not enough data") return [];
  const out: string[] = [];
  if (!v.changed)
    out.push("No dispatch ran a model Jev changed yet: ranged roles let Jev move the model");
  const fb = (s: JevSplit) => s.feedback.good + s.feedback.too_small + s.feedback.too_big;
  if (fb(r.outcomes.changed) + fb(r.outcomes.unchanged) === 0)
    out.push(
      "No feedback yet: label finished tasks with fit good, too_small or too_big (em_swarm update fit)",
    );
  // With no changed dispatch the first step already says why there are no outcomes (review-C C3).
  if (v.changed && v.n < v.minEvidence)
    out.push(`${v.n} labelled outcomes on decisions Jev changed; need ${v.minEvidence}`);
  if (v.units < v.minUnits)
    out.push(`Labelled outcomes come from ${v.units} runs or sessions; need ${v.minUnits}`);
  if (v.compared < v.minCompared)
    out.push(`${v.compared} compared plan or agent decisions; need ${v.minCompared}`);
  // Every minimum met and still no verdict: the evidence is split (verdictOf).
  if (!out.length && v.n >= v.minEvidence && v.units >= v.minUnits && v.compared >= v.minCompared)
    out.push(
      `Evidence is split (${v.help} help vs ${v.hurt} hurt): more labelled outcomes will settle it`,
    );
  return out;
}

/** An optional hint, not a verdict condition: decision features send text to the provider. */
export function featuresHint(config: unknown): string | null {
  const off = featuresOff(config);
  return off.length
    ? `Optional: decision features off (${off.join(", ")}); they send text to the provider, enable one with eminiar adjudicator features on <feature>`
    : null;
}

/** The muted footer: latency, deferred, timeouts, models, eras. */
export function footerFacts(r: JevImpactReport): string[] {
  const c = r.cost;
  const out: string[] = [];
  if (c.providerLatency.n)
    out.push(
      `provider p50 ${ms(c.providerLatency.p50)} · p95 ${ms(c.providerLatency.p95)} over ${c.providerLatency.n}`,
    );
  if (c.inline.n) out.push(`inline p50 ${ms(c.inline.p50)} over ${c.inline.n}`);
  out.push(`deferred ${c.deferred}`);
  out.push(`timeouts ${c.timeouts}`);
  const models = Object.entries(r.sample.models ?? {})
    .sort((a, b) => b[1] - a[1])
    .map(([m, n]) => `${m}: ${n}`);
  if (models.length) out.push(`models ${models.join(", ")}`);
  const eras = r.sample.eras;
  if (eras.units || eras.wholeText)
    out.push(`briefs per statement ${eras.units} · as one text ${eras.wholeText}`);
  return out;
}
