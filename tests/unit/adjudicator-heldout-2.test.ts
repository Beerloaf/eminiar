import { describe, expect, it } from "vitest";
import { EVAL_SET } from "../../src/adjudicator/data/evalset.js";
import { EXEMPLARS } from "../../src/adjudicator/data/exemplars.js";
import { extractFeatures } from "../../src/adjudicator/features.js";
import { complexityBucket, scoreHeuristic } from "../../src/adjudicator/heuristic.js";
import { DEFAULT_ROLES, TIERS, TOOL_IDS } from "../../src/adjudicator/types.js";
import { HELDOUT_SET } from "../fixtures/adjudicator-heldout.js";
import { HELDOUT_SET_2 } from "../fixtures/adjudicator-heldout-2.js";

/**
 * Second held-out check (task #24): 60 fresh items written before the asymmetric-tier change
 * (task #23, which prefers the larger tier on mixed evidence) was read. The scorer must beat this
 * set's majority baselines on tier and on complexity within +-1. Baselines are computed, never
 * hard-coded; do not loosen the assertions. Under-tier (true tier above predicted: a redo) and
 * over-tier (predicted above true: wasted tokens) rates are reported separately, not asserted.
 */

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const RANK: Record<string, number> = { haiku: 0, sonnet: 1, opus: 2, fable: 3 };

const rows = HELDOUT_SET_2.map((it) => {
  const s = scoreHeuristic(extractFeatures(it.text));
  return { it, s, bucket: complexityBucket(s.complexity) };
});
const N = rows.length;
const rate = (n: number, d = N) => (d === 0 ? 0 : n / d);

function majority(values: string[]): { label: string; share: number } {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  const [label, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!;
  return { label, share: n / values.length };
}

function bestConstantWithin1(values: number[]): { guess: number; share: number } {
  let best = { guess: 0, share: 0 };
  for (let g = 0; g <= 4; g++) {
    const share = values.filter((v) => Math.abs(v - g) <= 1).length / values.length;
    if (share > best.share) best = { guess: g, share };
  }
  return best;
}

function confusion<T extends string | number>(labels: readonly T[], pairs: Array<[T, T]>): string {
  const w = Math.max(6, ...labels.map((l) => String(l).length + 1));
  const head = `${"truth\\pred".padEnd(w + 4)}${labels.map((l) => String(l).padStart(w)).join("")}`;
  const lines = labels.map((t) => {
    const cells = labels.map((p) =>
      String(pairs.filter(([a, b]) => a === t && b === p).length).padStart(w),
    );
    return `${String(t).padEnd(w + 4)}${cells.join("")}`;
  });
  return [head, ...lines].join("\n");
}

describe("second held-out set integrity", () => {
  it("has 60 unique, validly labelled items", () => {
    expect(HELDOUT_SET_2).toHaveLength(60);
    expect(new Set(HELDOUT_SET_2.map((i) => norm(i.text))).size).toBe(60);
    for (const it of HELDOUT_SET_2) {
      expect(TIERS as readonly string[]).toContain(it.tier);
      expect(TOOL_IDS as readonly string[]).toContain(it.tool);
      expect(DEFAULT_ROLES as readonly string[]).toContain(it.role);
      expect(Number.isInteger(it.complexity)).toBe(true);
      expect(it.complexity).toBeGreaterThanOrEqual(0);
      expect(it.complexity).toBeLessThanOrEqual(4);
    }
  });

  it("is disjoint from the tuning eval set, the exemplars and the first held-out set", () => {
    const seen = new Set([
      ...EVAL_SET.map((i) => norm(i.text)),
      ...EXEMPLARS.map((e) => norm(e.text)),
      ...HELDOUT_SET.map((i) => norm(i.text)),
    ]);
    const clashes = HELDOUT_SET_2.filter((i) => seen.has(norm(i.text))).map((i) => i.text);
    expect(clashes).toEqual([]);
  });

  it("has the intended mix: about 10 opus, 20 sonnet, 25 haiku, all complexities, edge shapes", () => {
    const count = (t: string) => HELDOUT_SET_2.filter((i) => i.tier === t).length;
    expect(count("opus")).toBeGreaterThanOrEqual(9);
    expect(count("sonnet")).toBeGreaterThanOrEqual(18);
    expect(count("haiku")).toBeGreaterThanOrEqual(24);
    for (let c = 0; c <= 4; c++) expect(HELDOUT_SET_2.some((i) => i.complexity === c)).toBe(true);
    expect(new Set(HELDOUT_SET_2.map((i) => i.role)).size).toBeGreaterThanOrEqual(6);
    expect(HELDOUT_SET_2.some((i) => i.text.includes("\n    at "))).toBe(true);
    expect(HELDOUT_SET_2.some((i) => i.text.split("\n").length >= 3)).toBe(true);
  });
});

describe("heuristic generalisation on the second held-out set", () => {
  const tier = rate(rows.filter((r) => r.s.tier.choice === r.it.tier).length);
  const role = rate(rows.filter((r) => r.s.role.choice === r.it.role).length);
  const tool = rate(rows.filter((r) => r.s.tool.choice === r.it.tool).length);
  const cxExact = rate(rows.filter((r) => r.bucket === r.it.complexity).length);
  const cxWithin = rate(rows.filter((r) => Math.abs(r.bucket - r.it.complexity) <= 1).length);
  const mae = rows.reduce((n, r) => n + Math.abs(r.s.complexity - r.it.complexity), 0) / N;

  const under = rows.filter((r) => RANK[r.s.tier.choice]! < RANK[r.it.tier]!);
  const over = rows.filter((r) => RANK[r.s.tier.choice]! > RANK[r.it.tier]!);
  const opusRows = rows.filter((r) => r.it.tier === "opus");
  const opusRecall = rate(
    opusRows.filter((r) => r.s.tier.choice === "opus").length,
    opusRows.length,
  );
  const haikuRows = rows.filter((r) => r.it.tier === "haiku");
  const haikuOver = rate(
    haikuRows.filter((r) => RANK[r.s.tier.choice]! > RANK.haiku!).length,
    haikuRows.length,
  );
  const sonnetRows = rows.filter((r) => r.it.tier === "sonnet");

  const baseTier = majority(HELDOUT_SET_2.map((i) => i.tier));
  const baseRole = majority(HELDOUT_SET_2.map((i) => i.role));
  const baseTool = majority(HELDOUT_SET_2.map((i) => i.tool));
  const baseCx = majority(HELDOUT_SET_2.map((i) => String(i.complexity)));
  const baseCxWithin = bestConstantWithin1(HELDOUT_SET_2.map((i) => i.complexity));

  it("prints accuracies, baselines, under/over-tier rates and confusion matrices", () => {
    const miss = (r: (typeof rows)[number]) =>
      `  want ${r.it.tier} got ${r.s.tier.choice} (cx want ${r.it.complexity} got ${r.s.complexity.toFixed(1)}): ${JSON.stringify(r.it.text.slice(0, 90))}`;
    const lines = [
      "",
      `held-out set 2: ${N} items`,
      `tier        ${pct(tier)}   majority "${baseTier.label}" ${pct(baseTier.share)}`,
      `complexity  exact ${pct(cxExact)}  within+-1 ${pct(cxWithin)}  MAE ${mae.toFixed(2)}   majority "${baseCx.label}" ${pct(baseCx.share)}  best-constant+-1 (guess ${baseCxWithin.guess}) ${pct(baseCxWithin.share)}`,
      `role        ${pct(role)}   majority "${baseRole.label}" ${pct(baseRole.share)}`,
      `tool        ${pct(tool)}   majority "${baseTool.label}" ${pct(baseTool.share)}`,
      `opus recall ${pct(opusRecall)} (${opusRows.filter((r) => r.s.tier.choice === "opus").length}/${opusRows.length})`,
      `under-tier  ${pct(rate(under.length))} (${under.length}/${N})   over-tier ${pct(rate(over.length))} (${over.length}/${N})`,
      `haiku items over-tiered ${pct(haikuOver)}   sonnet items under ${pct(rate(sonnetRows.filter((r) => RANK[r.s.tier.choice]! < 1).length, sonnetRows.length))} over ${pct(rate(sonnetRows.filter((r) => RANK[r.s.tier.choice]! > 1).length, sonnetRows.length))}`,
      "",
      "tier confusion",
      confusion(
        ["haiku", "sonnet", "opus", "fable"],
        rows.map((r) => [r.it.tier, r.s.tier.choice as (typeof TIERS)[number]]),
      ),
      "",
      "complexity confusion (bucketed)",
      confusion(
        [0, 1, 2, 3, 4],
        rows.map((r) => [r.it.complexity, r.bucket] as [number, number]),
      ),
      "",
      "under-tier misses",
      ...under.map(miss),
      "",
      "over-tier misses",
      ...over.map(miss),
      "",
      "complexity misses beyond +-1",
      ...rows
        .filter((r) => Math.abs(r.bucket - r.it.complexity) > 1)
        .map(
          (r) =>
            `  want ${r.it.complexity} got ${r.s.complexity.toFixed(1)}: ${JSON.stringify(r.it.text.slice(0, 90))}`,
        ),
    ];
    console.log(lines.join("\n"));
    expect(N).toBe(60);
  });

  it("beats the majority-class baseline on tier", () => {
    expect(tier).toBeGreaterThan(baseTier.share);
  });

  it("beats the best constant guess on complexity within +-1", () => {
    expect(cxWithin).toBeGreaterThan(baseCxWithin.share);
  });

  it("beats the majority class on exact complexity", () => {
    expect(cxExact).toBeGreaterThan(baseCx.share);
  });
});
