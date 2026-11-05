import { describe, expect, it } from "vitest";
import { EVAL_SET } from "../../src/adjudicator/data/evalset.js";
import { EXEMPLARS } from "../../src/adjudicator/data/exemplars.js";
import { extractFeatures } from "../../src/adjudicator/features.js";
import { complexityBucket, scoreHeuristic } from "../../src/adjudicator/heuristic.js";
import { DEFAULT_ROLES, TIERS, TOOL_IDS } from "../../src/adjudicator/types.js";
import { HELDOUT_SET } from "../fixtures/adjudicator-heldout.js";

/**
 * Held-out check (task #22): the heuristic was tuned on EVAL_SET (40 items), so its score there is
 * optimistic. HELDOUT_SET (60 items) was labelled before the scorer was read. The scorer must beat
 * the majority-class baseline of THIS set on tier and on complexity within ±1. The baselines are
 * computed from the set, never hard-coded, and the assertions must not be loosened to pass: a
 * failure means the heuristic does not generalise and needs a coder task.
 */

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

const rows = HELDOUT_SET.map((it) => {
  const s = scoreHeuristic(extractFeatures(it.text));
  return { it, s, bucket: complexityBucket(s.complexity) };
});
const N = rows.length;
const rate = (n: number) => n / N;

/** Majority share of a label column. */
function majority(values: string[]): { label: string; share: number } {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  const [label, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!;
  return { label, share: n / values.length };
}

/** Best constant complexity guess scored within ±1 (the strictest constant baseline). */
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

describe("held-out set integrity", () => {
  it("has 60 unique, validly labelled items", () => {
    expect(HELDOUT_SET).toHaveLength(60);
    expect(new Set(HELDOUT_SET.map((i) => norm(i.text))).size).toBe(60);
    for (const it of HELDOUT_SET) {
      expect(TIERS as readonly string[]).toContain(it.tier);
      expect(TOOL_IDS as readonly string[]).toContain(it.tool);
      expect(DEFAULT_ROLES as readonly string[]).toContain(it.role);
      expect(Number.isInteger(it.complexity)).toBe(true);
      expect(it.complexity).toBeGreaterThanOrEqual(0);
      expect(it.complexity).toBeLessThanOrEqual(4);
    }
  });

  it("is disjoint from the tuning eval set and the embedding exemplars", () => {
    const seen = new Set([
      ...EVAL_SET.map((i) => norm(i.text)),
      ...EXEMPLARS.map((e) => norm(e.text)),
    ]);
    const clashes = HELDOUT_SET.filter((i) => seen.has(norm(i.text))).map((i) => i.text);
    expect(clashes).toEqual([]);
  });

  it("covers every tier and a spread of complexities, shapes and roles", () => {
    for (const t of ["haiku", "sonnet", "opus"]) {
      expect(HELDOUT_SET.some((i) => i.tier === t)).toBe(true);
    }
    for (let c = 0; c <= 4; c++) expect(HELDOUT_SET.some((i) => i.complexity === c)).toBe(true);
    expect(new Set(HELDOUT_SET.map((i) => i.role)).size).toBeGreaterThanOrEqual(6);
    expect(HELDOUT_SET.some((i) => i.text.includes("\n    at "))).toBe(true);
    expect(HELDOUT_SET.some((i) => i.text.split("\n").length >= 3)).toBe(true);
  });
});

describe("heuristic generalisation on the held-out set", () => {
  const tier = rate(rows.filter((r) => r.s.tier.choice === r.it.tier).length);
  const role = rate(rows.filter((r) => r.s.role.choice === r.it.role).length);
  const tool = rate(rows.filter((r) => r.s.tool.choice === r.it.tool).length);
  const cxExact = rate(rows.filter((r) => r.bucket === r.it.complexity).length);
  const cxWithin = rate(rows.filter((r) => Math.abs(r.bucket - r.it.complexity) <= 1).length);
  const mae = rows.reduce((n, r) => n + Math.abs(r.s.complexity - r.it.complexity), 0) / N;

  const baseTier = majority(HELDOUT_SET.map((i) => i.tier));
  const baseRole = majority(HELDOUT_SET.map((i) => i.role));
  const baseTool = majority(HELDOUT_SET.map((i) => i.tool));
  const baseCx = majority(HELDOUT_SET.map((i) => String(i.complexity)));
  const baseCxWithin = bestConstantWithin1(HELDOUT_SET.map((i) => i.complexity));

  it("prints the per-dimension accuracies, baselines and confusion matrices", () => {
    const lines = [
      "",
      `held-out set: ${N} items`,
      `tier        ${pct(tier)}   majority "${baseTier.label}" ${pct(baseTier.share)}`,
      `complexity  exact ${pct(cxExact)}  within±1 ${pct(cxWithin)}  MAE ${mae.toFixed(2)}   majority "${baseCx.label}" ${pct(baseCx.share)}  best-constant±1 (guess ${baseCxWithin.guess}) ${pct(baseCxWithin.share)}`,
      `role        ${pct(role)}   majority "${baseRole.label}" ${pct(baseRole.share)}`,
      `tool        ${pct(tool)}   majority "${baseTool.label}" ${pct(baseTool.share)}`,
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
      "tier misses",
      ...rows
        .filter((r) => r.s.tier.choice !== r.it.tier)
        .map(
          (r) =>
            `  want ${r.it.tier} got ${r.s.tier.choice} (cx want ${r.it.complexity} got ${r.s.complexity.toFixed(1)}): ${JSON.stringify(r.it.text.slice(0, 90))}`,
        ),
      "",
      "complexity misses beyond ±1",
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

  it("beats the best constant guess on complexity within ±1", () => {
    expect(cxWithin).toBeGreaterThan(baseCxWithin.share);
  });

  it("beats the majority class on exact complexity", () => {
    expect(cxExact).toBeGreaterThan(baseCx.share);
  });
});
