/**
 * Pure helpers of the Jev impact panel (src/ui/web/views/jev-helpers.ts): the gate, labels, the
 * heuristic -> final tier grid, the latency Jev adds and the tiles of the panel.
 */
import { describe, expect, it } from "vitest";
import {
  impactReport,
  type JevImpactReport,
  type JevSplit,
  type JevTierInfluence,
} from "../../src/adjudicator/jev-impact.js";
import { breakerInfo, ms, rate } from "../../src/ui/web/views/adjudicator-helpers.js";
import {
  addedLatency,
  complexityLine,
  dimLine,
  evidenceLabel,
  evidenceTone,
  excludedLine,
  footerFacts,
  jevActive,
  kpiRows,
  outcomeRows,
  successCell,
  surfaceRows,
  transitionGrid,
  verdictLine,
  verdictTone,
} from "../../src/ui/web/views/jev-helpers.js";
import { formatUsd } from "../../src/usage/pricing.js";

const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);

function emptyReport(): JevImpactReport {
  return impactReport(
    [],
    [],
    {},
    { config: { timeouts: { promptMs: 1500, agentMs: 3000, planMs: 4000 } }, now: NOW },
  );
}

/** An empty report with fields overridden. */
function reportWith(over: {
  tier?: Partial<JevTierInfluence>;
  effective?: Partial<JevImpactReport["influence"]["effective"]>;
  cost?: Partial<JevImpactReport["cost"]>;
  savings?: Partial<JevImpactReport["savings"]>;
  coverage?: Partial<JevImpactReport["coverage"]>;
  sample?: Partial<JevImpactReport["sample"]>;
}): JevImpactReport {
  const r = emptyReport();
  return {
    ...r,
    sample: { ...r.sample, ...over.sample },
    coverage: { ...r.coverage, ...over.coverage },
    influence: {
      ...r.influence,
      tier: { ...r.influence.tier, ...over.tier },
      effective: { ...r.influence.effective, ...over.effective },
    },
    cost: { ...r.cost, ...over.cost },
    savings: { ...r.savings, ...over.savings },
  };
}

// --- jevActive -----------------------------------------------------------------------------------

describe("jevActive", () => {
  const ov = (enabled: boolean, configured: string) => ({ enabled, provider: { configured } });

  it("is true only when the adjudicator is on and typesafe is configured", () => {
    expect(jevActive(ov(true, "typesafe"))).toBe(true);
  });

  it("is false when the adjudicator is disabled, whatever the provider", () => {
    for (const p of ["typesafe", "heuristic", "openai-compatible", "embedding"])
      expect(jevActive(ov(false, p)), p).toBe(false);
  });

  it("is false for the heuristic, openai-compatible and embedding providers", () => {
    for (const p of ["heuristic", "openai-compatible", "embedding", "", "TYPESAFE", "typesafe "])
      expect(jevActive(ov(true, p)), p).toBe(false);
  });

  it("is false while the overview is not loaded or incomplete", () => {
    expect(jevActive(undefined)).toBe(false);
    expect(jevActive(null)).toBe(false);
    expect(jevActive({ enabled: true } as never)).toBe(false);
    expect(jevActive({ enabled: true, provider: undefined } as never)).toBe(false);
    expect(jevActive({ enabled: true, provider: { configured: undefined } } as never)).toBe(false);
    expect(jevActive({ provider: { configured: "typesafe" } } as never)).toBe(false);
  });

  it("needs enabled to be exactly true, not merely truthy", () => {
    expect(jevActive({ enabled: 1, provider: { configured: "typesafe" } } as never)).toBe(false);
    expect(jevActive({ enabled: "true", provider: { configured: "typesafe" } } as never)).toBe(
      false,
    );
  });

  it("agrees with the server's gate for a degraded Jev: configured, not effective", () => {
    // AdjOverview's provider block also has `effective`; a degraded Jev still shows the panel
    const degraded = {
      enabled: true,
      provider: { configured: "typesafe", effective: "heuristic" },
    };
    expect(jevActive(degraded)).toBe(true);
  });
});

// --- tones and labels ---------------------------------------------------------------------------------

describe("verdictTone and evidenceTone", () => {
  it("maps the three verdict labels", () => {
    expect(verdictTone("helping")).toBe("ok");
    expect(verdictTone("hindering")).toBe("bad");
    expect(verdictTone("not enough data")).toBe("muted");
  });

  it("is muted for anything else", () => {
    for (const v of ["", "unknown", null, undefined]) expect(verdictTone(v)).toBe("muted");
  });

  it("maps evidence kinds", () => {
    expect(evidenceTone("help")).toBe("ok");
    expect(evidenceTone("hurt")).toBe("bad");
    expect(evidenceTone("neutral")).toBe("muted");
    expect(evidenceTone("whatever")).toBe("muted");
  });
});

describe("evidenceLabel", () => {
  const codes = {
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

  it("has a plain-words label for all 10 codes", () => {
    expect(Object.keys(codes)).toHaveLength(10);
    for (const [code, label] of Object.entries(codes))
      expect(evidenceLabel(code), code).toBe(label);
  });

  it("never shows a raw snake_case code for a known code", () => {
    for (const code of Object.keys(codes)) expect(evidenceLabel(code)).not.toContain("_");
  });

  it("passes an unknown code through, readably", () => {
    expect(evidenceLabel("brand_new_code")).toBe("brand new code");
    expect(evidenceLabel("x")).toBe("x");
    expect(evidenceLabel("")).toBe("");
  });
});

// --- transitionGrid --------------------------------------------------------------------------------------

describe("transitionGrid", () => {
  it("orders both axes haiku, sonnet, opus, fable", () => {
    const g = transitionGrid([
      { from: "fable", to: "opus", n: 1 },
      { from: "opus", to: "fable", n: 1 },
      { from: "sonnet", to: "haiku", n: 2 },
      { from: "haiku", to: "sonnet", n: 3 },
    ]);
    expect(g.rows).toEqual(["haiku", "sonnet", "opus", "fable"]);
    expect(g.cols).toEqual(["haiku", "sonnet", "opus", "fable"]);
  });

  it("only has the tiers that occur, still in ladder order", () => {
    const g = transitionGrid([
      { from: "opus", to: "sonnet", n: 1 },
      { from: "haiku", to: "opus", n: 1 },
    ]);
    expect(g.rows).toEqual(["haiku", "opus"]);
    expect(g.cols).toEqual(["sonnet", "opus"]);
  });

  it("counts agreement as the diagonal", () => {
    const g = transitionGrid([
      { from: "haiku", to: "haiku", n: 4 },
      { from: "sonnet", to: "sonnet", n: 6 },
      { from: "haiku", to: "sonnet", n: 3 },
      { from: "opus", to: "sonnet", n: 1 },
    ]);
    expect(g.agree).toBe(10);
    expect(g.total).toBe(14);
    expect(g.max).toBe(6);
    expect(g.cell("haiku", "sonnet")).toBe(3);
    expect(g.cell("sonnet", "haiku")).toBe(0);
    expect(g.cell("opus", "sonnet")).toBe(1);
    expect(g.cell("nope", "nada")).toBe(0);
  });

  it("is empty for no transitions, and for undefined", () => {
    for (const t of [[], undefined]) {
      const g = transitionGrid(t);
      expect(g.rows).toEqual([]);
      expect(g.cols).toEqual([]);
      expect(g.total).toBe(0);
      expect(g.agree).toBe(0);
      expect(g.max).toBe(0);
    }
  });

  it("adds up repeated pairs", () => {
    const g = transitionGrid([
      { from: "haiku", to: "sonnet", n: 2 },
      { from: "haiku", to: "sonnet", n: 3 },
    ]);
    expect(g.cell("haiku", "sonnet")).toBe(5);
    expect(g.total).toBe(5);
  });

  it("puts unknown tiers after the known ones", () => {
    const g = transitionGrid([
      { from: "zeta", to: "haiku", n: 1 },
      { from: "alpha", to: "opus", n: 1 },
      { from: "sonnet", to: "haiku", n: 1 },
    ]);
    expect(g.rows).toEqual(["sonnet", "alpha", "zeta"]);
  });

  it("is built from a real report's transitions", () => {
    const r = reportWith({
      tier: {
        transitions: [
          { from: "haiku", to: "sonnet", n: 3 },
          { from: "sonnet", to: "sonnet", n: 3 },
        ],
      },
    });
    const g = transitionGrid(r.influence.tier.transitions);
    expect(g.agree).toBe(3);
    expect(g.total).toBe(6);
  });
});

// --- addedLatency -----------------------------------------------------------------------------------------

describe("addedLatency", () => {
  it("is the inline p50 minus the heuristic-only p50", () => {
    expect(addedLatency({ n: 8, p50: 620 }, { n: 5, p50: 20 })).toBe(600);
    expect(addedLatency({ n: 1, p50: 21 }, { n: 1, p50: 20 })).toBe(1);
  });

  it("is null when either side has no samples", () => {
    expect(addedLatency({ n: 0, p50: null }, { n: 5, p50: 20 })).toBeNull();
    expect(addedLatency({ n: 8, p50: 620 }, { n: 0, p50: null })).toBeNull();
    expect(addedLatency({ n: 0, p50: null }, { n: 0, p50: null })).toBeNull();
    // a count without a p50 is no sample either
    expect(addedLatency({ n: 3, p50: null }, { n: 5, p50: 20 })).toBeNull();
    expect(addedLatency({ n: 3, p50: 100 }, { n: 5, p50: null })).toBeNull();
    expect(addedLatency({ n: 0, p50: 100 }, { n: 5, p50: 20 })).toBeNull();
  });

  it("is never negative", () => {
    expect(addedLatency({ n: 8, p50: 10 }, { n: 5, p50: 200 })).toBe(0);
    expect(addedLatency({ n: 8, p50: 20 }, { n: 5, p50: 20 })).toBe(0);
  });

  it("is 0, not null, when Jev adds nothing", () => {
    expect(addedLatency({ n: 2, p50: 0 }, { n: 2, p50: 0 })).toBe(0);
  });
});

// --- kpiRows ----------------------------------------------------------------------------------------------

describe("kpiRows", () => {
  const titles = (r: JevImpactReport) => kpiRows(r).map((t) => t.title);

  it("has the five tiles in order, each with a value, a sub line and help", () => {
    const tiles = kpiRows(emptyReport());
    expect(tiles.map((t) => t.title)).toEqual([
      "changed the tier",
      "effective model changed",
      "Jev calls",
      "Jev spend",
      "net from Jev's changes",
    ]);
    for (const t of tiles) {
      expect(t.value.length).toBeGreaterThan(0);
      expect(t.sub.length).toBeGreaterThan(0);
      expect(t.help.length).toBeGreaterThan(0);
    }
    expect(titles(emptyReport())).toHaveLength(5);
  });

  it("shows dashes on the tier tile with nothing compared", () => {
    const [tier] = kpiRows(emptyReport());
    expect(tier?.value).toBe("—");
    expect(tier?.sub).toBe("↑0 ↓0 of 0 compared · 0 uncertain left out · 0 deferred");
  });

  it("shows dashes on the effective-model tile with no dispatches", () => {
    const eff = kpiRows(emptyReport())[1];
    expect(eff?.value).toBe("—");
    expect(eff?.sub).toBe("0 of 0 dispatches · unknown 0");
  });

  it("the tier tile is the share of certain compared decisions that went up or down", () => {
    const r = reportWith({
      tier: { compared: 21, up: 3, down: 2, agree: 15, uncertain: 1 },
      sample: { deferred: 4 },
    });
    const tier = kpiRows(r)[0];
    expect(tier?.value).toBe(rate(5 / 20));
    expect(tier?.value).toBe("25%");
    expect(tier?.sub).toBe("↑3 ↓2 of 20 compared · 1 uncertain left out · 4 deferred");
  });

  it("leaves uncertain near-ties out of the tier tile, as its help says (review-jev F4)", () => {
    // 5 certain up moves and 5 uncertain near-ties: Jev changed 5 of 5, not 50%.
    const r = reportWith({ tier: { compared: 10, up: 5, down: 0, agree: 0, uncertain: 5 } });
    const tier = kpiRows(r)[0];
    expect(tier?.value).toBe("100%");
    expect(tier?.sub).toBe("↑5 ↓0 of 5 compared · 5 uncertain left out · 0 deferred");
    expect(tier?.help).toContain("uncertain near-ties");
    expect(tier?.help).toContain("not counted");
  });

  it("a Jev that never changed the tier reads 0%, not a dash", () => {
    const r = reportWith({ tier: { compared: 10, agree: 10 } });
    expect(kpiRows(r)[0]?.value).toBe("0%");
  });

  it("the effective tile counts changed over dispatches", () => {
    const r = reportWith({ effective: { dispatches: 8, changed: 2, unchanged: 5, unknown: 1 } });
    const eff = kpiRows(r)[1];
    expect(eff?.value).toBe("25%");
    expect(eff?.sub).toBe("2 of 8 dispatches · unknown 1");
  });

  it("the calls tile shows attempts, answered, failure rate, latency and the breaker", () => {
    const r = reportWith({
      cost: { calls: 42, providerLatency: { n: 40, p50: 640, p95: 1800 } },
      coverage: { attempts: 50, errors: 5, failureRate: 0.1 },
    });
    expect(kpiRows(r, "closed")[2]).toMatchObject({
      value: "50",
      sub: `45 answered · failure ${rate(0.1)} · p50 ${ms(640)} · breaker ${breakerInfo("closed").label}`,
    });
    expect(kpiRows(r, "open")[2]?.sub).toContain(`breaker ${breakerInfo("open").label}`);
    expect(kpiRows(r)[2]?.sub).toContain(`breaker ${breakerInfo(undefined).label}`);
    expect(kpiRows(r, null)[2]?.sub).toContain(`breaker ${breakerInfo(null).label}`);
  });

  it("the calls tile has dashes for an unknown failure rate and latency", () => {
    const calls = kpiRows(emptyReport())[2];
    expect(calls?.value).toBe("0");
    expect(calls?.sub).toContain("failure —");
    expect(calls?.sub).toContain("p50 —");
  });

  it("the spend tile shows spend, cost per call and the added wait", () => {
    const r = reportWith({
      cost: {
        spendUsd: 0.0123,
        calls: 6,
        usdPerCall: 0.00205,
        inline: { n: 5, p50: 640, p95: 900 },
        heuristicInline: { n: 5, p50: 40, p95: 60 },
      },
    });
    const spend = kpiRows(r)[3];
    expect(spend?.value).toBe(formatUsd(0.0123));
    expect(spend?.sub).toBe(`${formatUsd(0.00205)} per call · adds ~${ms(600)} inline`);
  });

  it("the spend tile has dashes with no calls and no latency samples", () => {
    const spend = kpiRows(emptyReport())[3];
    expect(spend?.sub).toBe("— per call · adds — inline");
    expect(spend?.value).toBe(formatUsd(0));
  });

  it("the spend tile never shows a negative added wait", () => {
    const r = reportWith({
      cost: { inline: { n: 5, p50: 10, p95: 12 }, heuristicInline: { n: 5, p50: 300, p95: 400 } },
    });
    expect(kpiRows(r)[3]?.sub).toContain(`adds ~${ms(0)} inline`);
  });

  describe("the net tile", () => {
    const net = (over: Partial<JevImpactReport["savings"]>, spend = 0.01) =>
      kpiRows(reportWith({ savings: over, cost: { spendUsd: spend } }))[4];

    it("is a dash with 'no usage data' when usage is unavailable", () => {
      const t = net({ usageAvailable: false, repriced: 3, netUsd: 1.5 });
      expect(t?.value).toBe("—");
      expect(t?.sub).toBe("no usage data");
    });

    it("is a dash when nothing has been repriced yet", () => {
      const t = net({ usageAvailable: true, repriced: 0, netUsd: 0 });
      expect(t?.value).toBe("—");
      expect(t?.sub).toBe("no repriced dispatches yet");
    });

    it("shows the net with the saved, extra and spend figures once dispatches are repriced", () => {
      const t = net({
        usageAvailable: true,
        repriced: 4,
        netUsd: 0.5,
        downSavedUsd: 0.7,
        upCostUsd: 0.2,
      });
      expect(t?.value).toBe(formatUsd(0.5));
      expect(t?.sub).toBe(
        `saved ${formatUsd(0.7)} · extra ${formatUsd(0.2)} · spend ${formatUsd(0.01)}`,
      );
    });

    it("shows a loss as a loss", () => {
      const t = net({ usageAvailable: true, repriced: 1, netUsd: -0.25 });
      expect(t?.value).toBe(formatUsd(-0.25));
      expect(t?.value).toContain("-");
    });

    it("shows a zero net as a figure, not a dash, once something was repriced", () => {
      const t = net({ usageAvailable: true, repriced: 2, netUsd: 0 });
      expect(t?.value).toBe(formatUsd(0));
      expect(t?.value).not.toBe("—");
    });

    it("a non-finite net is a dash, not NaN", () => {
      const t = net({ usageAvailable: true, repriced: 2, netUsd: Number.NaN });
      expect(t?.value).toBe("—");
    });
  });
});

// --- the tables and the footer -----------------------------------------------------------------------------

describe("surfaceRows", () => {
  it("lists surfaces with compared decisions, busiest first, ties by name", () => {
    const t = reportWith({
      tier: {
        bySurface: {
          prompt: { compared: 10, agree: 8, up: 1, down: 1 },
          agent: { compared: 10, agree: 5, up: 5, down: 0 },
          plan: { compared: 3, agree: 3, up: 0, down: 0 },
          mcp: { compared: 0, agree: 0, up: 0, down: 0 },
        },
      },
    }).influence.tier;
    expect(surfaceRows(t).map((r) => r.label)).toEqual(["agent", "prompt", "plan"]);
    expect(surfaceRows(t)[0]).toMatchObject({ label: "agent", compared: 10, up: 5 });
  });

  it("is empty with no surfaces", () => {
    expect(surfaceRows(emptyReport().influence.tier)).toEqual([]);
    expect(surfaceRows({ ...emptyReport().influence.tier, bySurface: undefined as never })).toEqual(
      [],
    );
  });
});

describe("dimLine and complexityLine", () => {
  it("dimLine summarises agreement, changes and near-ties", () => {
    expect(dimLine({ compared: 15, agree: 12, changed: 3, uncertain: 2, transitions: [] })).toBe(
      "agree 12 of 15 · 3 changed · 2 uncertain",
    );
    expect(dimLine({ compared: 0, agree: 0, changed: 0, uncertain: 0, transitions: [] })).toBe(
      "no compared decisions",
    );
  });

  it("complexityLine gives signed means, and says when nothing is scored", () => {
    expect(
      complexityLine({ n: 18, meanDelta: 0.12, meanAbsDelta: 0.4, excludedBeforeFix: 0 }),
    ).toBe("mean Δ +0.12 · mean |Δ| 0.40 over 18");
    expect(complexityLine({ n: 5, meanDelta: -0.5, meanAbsDelta: 0.5, excludedBeforeFix: 2 })).toBe(
      "mean Δ −0.50 · mean |Δ| 0.50 over 5 · 2 before the score-scale fix left out",
    );
    expect(complexityLine({ n: 3, meanDelta: 0, meanAbsDelta: 0, excludedBeforeFix: 0 })).toBe(
      "mean Δ 0.00 · mean |Δ| 0.00 over 3",
    );
    expect(
      complexityLine({ n: 0, meanDelta: null, meanAbsDelta: null, excludedBeforeFix: 0 }),
    ).toBe("no scored rows yet");
    expect(
      complexityLine({ n: 0, meanDelta: null, meanAbsDelta: null, excludedBeforeFix: 4 }),
    ).toBe("no scored rows yet (4 before the score-scale fix left out)");
  });
});

describe("outcomeRows", () => {
  const split = (over: Partial<JevSplit>): JevSplit => ({
    dispatches: 0,
    followed: 0,
    followDenom: 0,
    followRate: null,
    final: 0,
    success: 0,
    failure: 0,
    successRate: null,
    feedback: { good: 0, too_small: 0, too_big: 0 },
    ...over,
  });

  it("puts changed and unchanged side by side, one row per figure", () => {
    const rows = outcomeRows(
      split({
        dispatches: 10,
        followRate: 0.5,
        final: 8,
        success: 6,
        failure: 2,
        successRate: 0.75,
        feedback: { good: 2, too_small: 3, too_big: 1 },
      }),
      split({
        dispatches: 30,
        followRate: 1,
        final: 20,
        success: 18,
        failure: 2,
        successRate: 0.9,
      }),
    );
    expect(rows.map((r) => r.label)).toEqual([
      "dispatches",
      "advice followed",
      "success",
      "feedback: good",
      "feedback: too small",
      "feedback: too big",
    ]);
    expect(rows[0]).toEqual({ label: "dispatches", changed: "10", unchanged: "30" });
    expect(rows[1]).toMatchObject({ changed: "50%", unchanged: "100%" });
    expect(rows[2]).toMatchObject({ changed: "75% of 8", unchanged: "90% of 20" });
    expect(rows[3]).toMatchObject({ changed: "2", unchanged: "0" });
    expect(rows[4]).toMatchObject({ changed: "3" });
    expect(rows[5]).toMatchObject({ changed: "1" });
  });

  it("shows dashes where there is no denominator", () => {
    const rows = outcomeRows(split({}), split({}));
    expect(rows[1]).toMatchObject({ changed: "—", unchanged: "—" });
    expect(rows[2]).toMatchObject({ changed: "—", unchanged: "—" });
  });

  it("the success cell's denominator is the outcomes the rate is over, not every final (review-jev2 J6)", () => {
    // 1 success + 3 abandoned: 4 final, but the rate is over 1 outcome
    const s = split({ final: 4, success: 1, failure: 0, successRate: 1 });
    expect(successCell(s)).toBe(`${rate(1)} of 1`);
    expect(outcomeRows(s, split({}))[2]).toMatchObject({
      changed: `${rate(1)} of 1`,
      unchanged: "—",
    });
    // only abandoned finals: no rate, no "of 3"
    expect(successCell(split({ final: 3, successRate: null }))).toBe("—");
    expect(successCell(split({ final: 5, success: 1, failure: 1, successRate: 0.5 }))).toBe(
      `${rate(0.5)} of 2`,
    );
  });
});

describe("footerFacts", () => {
  it("lists latency, deferred, timeouts, models and eras", () => {
    const r = reportWith({
      cost: {
        providerLatency: { n: 40, p50: 640, p95: 1800 },
        inline: { n: 30, p50: 700, p95: 1900 },
        deferred: 3,
        timeouts: 2,
      },
      sample: {
        models: { "jev-1.14.0": 30, "jev-1.13.0": 10 },
        eras: { units: 12, wholeText: 5 },
      },
    });
    expect(footerFacts(r)).toEqual([
      `provider p50 ${ms(640)} · p95 ${ms(1800)} over 40`,
      `inline p50 ${ms(700)} over 30`,
      "deferred 3",
      "timeouts 2",
      "models jev-1.14.0: 30, jev-1.13.0: 10",
      "briefs per statement 12 · as one text 5",
    ]);
  });

  it("leaves out the figures that have no samples", () => {
    expect(footerFacts(emptyReport())).toEqual(["deferred 0", "timeouts 0"]);
  });
});

describe("the calls tile counts calls that did not answer (review-jev F4)", () => {
  it("10 answered and 90 timeouts read 100 calls, 10 answered, failure 90%", () => {
    const r = reportWith({
      cost: { calls: 10 },
      coverage: { attempts: 100, errors: 90, failureRate: 0.9 },
    });
    const tile = kpiRows(r, "closed")[2];
    expect(tile?.value).toBe("100");
    expect(tile?.sub.startsWith(`10 answered · failure ${rate(0.9)}`)).toBe(true);
    expect(tile?.help).toContain("answered or not");
  });
});

describe("verdictLine", () => {
  it("joins every reason and n, the deciding reason first", () => {
    expect(
      verdictLine({
        reasons: ["10 of 10 labelled outcomes went its way", "40 upgrades not counted"],
        n: 10,
      }),
    ).toBe("10 of 10 labelled outcomes went its way · 40 upgrades not counted · n = 10");
  });

  it("leaves n out when there is no evidence", () => {
    expect(verdictLine({ reasons: ["3 compared decisions; need 30"], n: 0 })).toBe(
      "3 compared decisions; need 30",
    );
    expect(verdictLine(emptyReport().verdict)).toContain("need 30");
  });
});

describe("excludedLine", () => {
  it("names every reason a dispatch was left out, the advice-not-run count included", () => {
    const x = {
      kept: 1,
      deferred: 2,
      notJev: 3,
      unreconstructable: 4,
      uncertain: 5,
      unknown: 6,
      notRun: 7,
      notFinal: 8,
      bounds: 9,
    };
    expect(excludedLine(x)).toBe(
      "kept model 1 · deferred 2 · fell back 3 · uncertain 9 · unknown model 6 · apply bounds not stored 9 · advised tier not run 7 (outcome and feedback not counted) · outcome not final yet 8",
    );
  });
});
