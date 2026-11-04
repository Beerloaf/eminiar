/**
 * Blending a provider's answer onto the heuristic (docs/design/adjudicator.md §7.6), plus the
 * one-line advice every surface shows. Pure: the engine passes in the learned bias and timings.
 *
 * - α_d = min(cap_p, conf_p) per dimension. cap_p is `providerMax` for typesafe and
 *   openai-compatible, `embeddingMax` for embedding (tier and complexity only). conf_p is the
 *   calibrated confidence (Jev), or a self-reported one × `selfReportScale`.
 * - Tools stay with the heuristic: α_tool = 0 unless `weights.features.toolProvider` > 0, and it
 *   is capped by that value too.
 * - Tables: (1−α)·heuristic + α·provider, plus the noul adjustments, plus the learned bias; clamp
 *   at 0 and renormalise. Complexity: (1−α)·c_h + α·c_p.
 * - A tier table with confidence under `lowConfidence` moves one tier up (the safer choice).
 *
 * Bias keys are `<dimension>:<option>`, e.g. `tier:sonnet` or `role:coder` (learn.ts §7.7 resolves
 * the buckets and hands over the flat map).
 */

import { complexityBucket, DEFAULT_TIERS, effortFor, tableConfidence } from "./heuristic.js";
import {
  type Dist,
  type ProviderAnswer,
  type ProviderId,
  type ProviderResult,
  type ProviderStatus,
  type Reason,
  SCORER_VERSION,
  type ScoreSet,
  type ScoreTable,
  type Source,
  type Surface,
  TIERS,
  type Tier,
  type Verdict,
} from "./types.js";

export interface BlendWeights {
  providerMax?: number;
  embeddingMax?: number;
  selfReportScale?: number;
  lowConfidence?: number;
  features?: Record<string, number>;
}

export interface BlendOptions {
  key: string;
  provider: ProviderId;
  providerStatus?: ProviderStatus;
  source?: Source;
  /** The configured ladder, smallest first; drives the low-confidence round-up. */
  tiers?: readonly Tier[];
  latencyMs?: number;
  providerLatencyMs?: number;
  usage?: ProviderResult["usage"];
}

export const BLEND_DEFAULTS = Object.freeze({
  providerMax: 0.7,
  embeddingMax: 0.4,
  selfReportScale: 0.6,
  lowConfidence: 0.55,
});

/** Added by a noul answer above NOUL_AT (risky → tiers ≥ sonnet; needsPlan → em_swarm, architect). */
export const NOUL_BOOST = 0.3;
export const NOUL_AT = 0.7;

type Dim = "complexity" | "tier" | "role" | "tool";

const r2 = (n: number) => Math.round(n * 100) / 100;
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** Provider weight per dimension (§7.6). Zero for the heuristic or a missing answer. */
export function providerAlpha(
  provider: ProviderId,
  answer: ProviderAnswer | undefined,
  weights: BlendWeights = {},
): Partial<Record<Dim, number>> {
  if (!answer || provider === "heuristic") return {};
  const w = { ...BLEND_DEFAULTS, ...weights };
  const embedding = provider === "embedding";
  const cap = clamp01(embedding ? w.embeddingMax : w.providerMax);
  const scale = clamp01(w.selfReportScale);
  const conf = (d: Dist) => clamp01(d.calibrated ? d.confidence : d.confidence * scale);
  const out: Partial<Record<Dim, number>> = {};
  if (answer.complexity) {
    const calibrated = answer.tier?.calibrated ?? provider === "typesafe";
    const c = clamp01(answer.complexity.confidence * (calibrated ? 1 : scale));
    out.complexity = Math.min(cap, c);
  }
  if (answer.tier) out.tier = Math.min(cap, conf(answer.tier));
  if (!embedding) {
    if (answer.role) out.role = Math.min(cap, conf(answer.role));
    const toolProvider = clamp01(w.features?.toolProvider ?? 0);
    if (answer.tool && toolProvider > 0) out.tool = Math.min(cap, toolProvider, conf(answer.tool));
  }
  return out;
}

interface Add {
  option: string;
  weight: number;
  reason: Reason;
}

function mixTable(
  h: ScoreTable,
  dist: Dist | undefined,
  alpha: number,
  provider: ProviderId,
  adds: Add[],
  bias: Record<string, number>,
): { table: ScoreTable; alpha: number } {
  const options = h.entries.map((e) => e.option);
  let pSum = 0;
  if (dist && alpha > 0) for (const o of options) pSum += Math.max(0, dist.probs[o] ?? 0);
  const a = pSum > 0 ? alpha : 0;
  const rows = h.entries.map((e) => {
    const reasons = [...e.reasons];
    const p = a > 0 && dist ? Math.max(0, dist.probs[e.option] ?? 0) / pSum : 0;
    let s = (1 - a) * e.score + a * p;
    if (a > 0 && p > 0)
      reasons.push({
        feature: "provider",
        weight: r2(a * p),
        note: `${provider} p ${r2(p)} × α ${r2(a)}`,
      });
    for (const add of adds)
      if (add.option === e.option) {
        s += add.weight;
        reasons.push(add.reason);
      }
    const b = bias[`${h.dimension}:${e.option}`] ?? 0;
    if (b) {
      s += b;
      reasons.push({ feature: "bias", weight: r2(b), note: "learned from outcomes" });
    }
    return { option: e.option, s: Math.max(0, s), reasons };
  });
  const total = rows.reduce((n, r) => n + r.s, 0);
  if (!(total > 0)) return { table: h, alpha: a };
  const entries = rows
    .map((r) => ({ option: r.option, score: r.s / total, reasons: r.reasons }))
    .sort((x, y) => y.score - x.score);
  return {
    table: {
      dimension: h.dimension,
      entries,
      choice: entries[0]?.option ?? h.choice,
      confidence: tableConfidence(entries),
    },
    alpha: a,
  };
}

/** The ladder the round-up climbs: the configured tiers, or TIERS order over the table's options. */
function ladderOf(table: ScoreTable, tiers?: readonly Tier[]): string[] {
  const present = new Set(table.entries.map((e) => e.option));
  const base: readonly string[] = tiers?.length ? tiers : TIERS;
  const ladder = base.filter((t) => present.has(t));
  return ladder.length ? ladder : [...DEFAULT_TIERS];
}

export function blend(
  h: ScoreSet,
  answer: ProviderAnswer | undefined,
  bias: Record<string, number> = {},
  weights: BlendWeights = {},
  opts: BlendOptions = { key: "", provider: "heuristic" },
): Verdict {
  const w = { ...BLEND_DEFAULTS, ...weights };
  const alpha = providerAlpha(opts.provider, answer, weights);
  const tierLadder = ladderOf(h.tier, opts.tiers);
  const sonnetAt = tierLadder.indexOf("sonnet");
  const riskFrom = sonnetAt >= 0 ? sonnetAt : 1;

  // Complexity.
  let complexity = h.complexity;
  const complexityReasons = [...h.complexityReasons];
  const ac = alpha.complexity ?? 0;
  if (answer?.complexity && ac > 0) {
    const cp = Math.min(4, Math.max(0, answer.complexity.value));
    complexity = (1 - ac) * h.complexity + ac * cp;
    complexityReasons.push({
      feature: "provider",
      weight: r2(complexity - h.complexity),
      note: `${opts.provider} says ${r2(cp)} (α ${r2(ac)})`,
    });
  }

  // Noul adjustments.
  const tierAdds: Add[] = [];
  const toolAdds: Add[] = [];
  const roleAdds: Add[] = [];
  if ((answer?.risky ?? 0) > NOUL_AT)
    for (const t of tierLadder.slice(riskFrom))
      tierAdds.push({
        option: t,
        weight: NOUL_BOOST,
        reason: {
          feature: "risky",
          weight: NOUL_BOOST,
          note: `${opts.provider}: risky ${r2(answer?.risky ?? 0)}`,
        },
      });
  if ((answer?.needsPlan ?? 0) > NOUL_AT) {
    const reason = (o: string): Add => ({
      option: o,
      weight: NOUL_BOOST,
      reason: {
        feature: "needsPlan",
        weight: NOUL_BOOST,
        note: `${opts.provider}: needs a plan ${r2(answer?.needsPlan ?? 0)}`,
      },
    });
    toolAdds.push(reason("em_swarm"));
    roleAdds.push(reason("architect"));
  }

  const tier = mixTable(h.tier, answer?.tier, alpha.tier ?? 0, opts.provider, tierAdds, bias);
  const role = mixTable(h.role, answer?.role, alpha.role ?? 0, opts.provider, roleAdds, bias);
  const tool = mixTable(h.tool, answer?.tool, alpha.tool ?? 0, opts.provider, toolAdds, bias);

  // Low confidence → one tier up.
  let tierTable = tier.table;
  if (tierTable.confidence < w.lowConfidence) {
    const at = tierLadder.indexOf(tierTable.choice);
    const up = at >= 0 && at < tierLadder.length - 1 ? tierLadder[at + 1] : undefined;
    if (up) {
      tierTable = {
        ...tierTable,
        choice: up,
        entries: tierTable.entries.map((e) =>
          e.option === up
            ? {
                ...e,
                reasons: [
                  ...e.reasons,
                  {
                    feature: "lowConfidence",
                    weight: r2(w.lowConfidence - tierTable.confidence),
                    note: "low confidence → rounded up",
                  },
                ],
              }
            : e,
        ),
      };
    }
  }

  const effective: Partial<Record<Dim, number>> = {};
  if (ac > 0 && answer?.complexity) effective.complexity = r2(ac);
  if (tier.alpha > 0) effective.tier = r2(tier.alpha);
  if (role.alpha > 0) effective.role = r2(role.alpha);
  if (tool.alpha > 0) effective.tool = r2(tool.alpha);

  const v: Verdict = {
    key: opts.key,
    complexity,
    complexityReasons,
    tool: tool.table,
    tier: tierTable,
    role: role.table,
    effort: effortFor(complexity),
    source: opts.source ?? (answer && opts.provider !== "heuristic" ? "blend" : "heuristic"),
    provider: opts.provider,
    providerStatus: opts.providerStatus ?? (answer ? "ok" : "n/a"),
    alpha: effective,
    bias,
    latencyMs: opts.latencyMs ?? 0,
    version: SCORER_VERSION,
  };
  if (opts.providerLatencyMs !== undefined) v.providerLatencyMs = opts.providerLatencyMs;
  if (opts.usage) v.usage = opts.usage;
  return v;
}

// --- advice -----------------------------------------------------------------

export const ADVICE_MAX = 220;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The intent that moved complexity most, for the advice label. */
function mainIntent(v: Pick<Verdict, "complexityReasons">): string | undefined {
  let best: Reason | undefined;
  for (const r of v.complexityReasons)
    if (r.feature.startsWith("intent.") && (!best || Math.abs(r.weight) > Math.abs(best.weight)))
      best = r;
  return best?.feature.slice("intent.".length);
}

/** One line, at most 220 chars (§10 "Advice text"). */
export function formatAdvice(v: Verdict, surface: Surface = "prompt"): string {
  const bucket = complexityBucket(v.complexity);
  const intent = mainIntent(v);
  const label = `complexity ${bucket}/4${intent ? ` (${intent.replace("_", " ")})` : ""}`;
  const role = v.role.choice && v.role.choice !== "none" ? `, role ${v.role.choice}` : "";
  let line: string;
  if (surface === "agent" || surface === "plan") {
    line = `eminiar adjudicator: ${label} → ${v.tier.choice} (effort ${v.effort})${role}`;
  } else {
    const tools = v.tool.entries
      .filter((e) => e.option !== "none" && e.score >= 0.15)
      .slice(0, 2)
      .map((e) => e.option);
    const start =
      v.tool.choice === "none" || !tools.length
        ? "no tool needed"
        : `start with ${tools.join(" → ")}`;
    line = `eminiar adjudicator: ${label} · ${start} · if you delegate: ${v.tier.choice}${role}`;
  }
  return clip(line.replace(/\s+/g, " "), ADVICE_MAX);
}
