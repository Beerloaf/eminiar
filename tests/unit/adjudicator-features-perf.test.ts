import { describe, expect, it } from "vitest";
import { extractFeatures } from "../../src/adjudicator/features.js";

/**
 * extractFeatures runs on the user's prompt in the UserPromptSubmit hook, so its regexes must
 * stay linear (task #114, memory adjudicator/features-linear-regexes). Before the fix PATH_RE,
 * ENUM3, LIST3 and STACK_RE took 0.5 to 1.7 s on a 32 KB prompt; they now take about 0.5 ms.
 * The timing bound is deliberately loose (orders of magnitude, not a benchmark) so a slow CI box
 * does not flake, while a return to quadratic behaviour (hundreds of ms) still fails.
 */

const SIZE = 32768;
/** Generous: ~0.5 ms measured, ~500-1700 ms with the old regexes. */
const BUDGET_MS = 100;

const INPUTS: Record<string, string> = {
  "no spaces": "x".repeat(SIZE),
  "many dots": "a.b.".repeat(SIZE / 4),
  "trailing 'at ' with a long token": `at ${"x".repeat(SIZE)}`,
  "long newline run between words": `a${"\n".repeat(SIZE)}b`,
  "stack-frame lookalike with a long line number": `at a:${"1".repeat(SIZE)}x`,
};

/** Best of a few runs: one slow run (GC, a busy CI core) must not decide the verdict. */
function bestOfMs(text: string, runs = 3): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    extractFeatures(text);
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

describe("extractFeatures stays linear on long adversarial inputs", () => {
  extractFeatures("warm up the regex engine and JIT");

  for (const [name, text] of Object.entries(INPUTS)) {
    it(`handles ${name} (${SIZE} chars) in well under ${BUDGET_MS} ms`, () => {
      expect(text.length).toBeGreaterThanOrEqual(SIZE);
      const ms = bestOfMs(text);
      expect(ms).toBeLessThan(BUDGET_MS);
    });
  }

  it("still returns sane features for those inputs", () => {
    for (const text of Object.values(INPUTS)) {
      const f = extractFeatures(text);
      expect(f.chars).toBeGreaterThan(0);
      expect(f.paths).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("extractFeatures path counting is unchanged", () => {
  it("counts two paths in prose", () => {
    expect(extractFeatures("src/a.ts and lib/b.json").paths).toBe(2);
  });

  it("counts a file with a trailing segment as one path", () => {
    expect(extractFeatures("a.ts/x").paths).toBe(1);
  });

  it("does not count a path-looking token without a known extension", () => {
    expect(extractFeatures("src/adjudicator/feat").paths).toBe(0);
  });
});

describe("extractFeatures enumeration detection is unchanged", () => {
  it("still reads dotfile lists as an enumeration (scope signal)", () => {
    expect(extractFeatures(".env, .npmrc and .gitignore").scope).toBeGreaterThan(0);
    expect(extractFeatures("fix .env, .npmrc and .gitignore").scope).toBeGreaterThan(0);
  });

  it("does not read a single item as an enumeration", () => {
    expect(extractFeatures(".env").scope).toBe(0);
  });

  it("still flags a short command list as batchable", () => {
    expect(extractFeatures("run a, b and c").scope).toBeGreaterThan(0);
  });
});

describe("extractFeatures stack-trace detection is unchanged", () => {
  it("detects a frame with a function and location", () => {
    expect(extractFeatures("  at fn (src/x.js:3:7)").stackTrace).toBe(true);
  });

  it("detects a bare file:line frame followed by trailing spaces", () => {
    expect(extractFeatures("at x.js:1   ").stackTrace).toBe(true);
    expect(extractFeatures("at x.js:1   \nthen more text").stackTrace).toBe(true);
  });

  it("does not treat 'at' plus a bare word as a frame", () => {
    expect(extractFeatures("at noframe").stackTrace).toBe(false);
  });

  it("does not treat the long lookalike inputs as traces", () => {
    expect(extractFeatures(INPUTS["trailing 'at ' with a long token"] as string).stackTrace).toBe(
      false,
    );
    expect(
      extractFeatures(INPUTS["stack-frame lookalike with a long line number"] as string).stackTrace,
    ).toBe(false);
  });
});
