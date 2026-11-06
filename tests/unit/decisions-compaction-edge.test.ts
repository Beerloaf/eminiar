/**
 * Compaction (option D), the gaps the base file leaves: the session-guide rewrite and the sandbox
 * output triage both leave the deterministic result byte for byte when off, shadow, unsupported,
 * timed out or failed; the P1 sections and the budget hold; a canary never reaches the provider.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AdjudicatorConfig, AdjudicatorConfigSchema, ConfigSchema } from "../../src/config.js";
import type { ProjectContext } from "../../src/context.js";
import { createDecisionClient } from "../../src/decisions/client.js";
import { chooseSections, feature } from "../../src/decisions/features/compaction.js";
import type { DecisionProvider } from "../../src/decisions/providers/types.js";
import type { DecisionJob } from "../../src/decisions/types.js";
import { SNAPSHOT_BUDGET } from "../../src/hooks/pre-compact.js";
import { processOutput } from "../../src/sandbox/output.js";
import { guideSections, renderGuide } from "../../src/session/guide.js";
import { SqliteAdapter } from "../../src/storage/sqlite/adapter.js";

/** The provider triageOutput's own client will use: set per test. */
const injected = vi.hoisted(() => ({ provider: undefined as unknown, spawn: vi.fn(() => true) }));
vi.mock("../../src/decisions/client.js", async (orig) => {
  const m = await orig<typeof import("../../src/decisions/client.js")>();
  return {
    ...m,
    createDecisionClient: (f: never, deps: never) =>
      m.createDecisionClient(f, {
        ...(deps as object),
        ...(injected.provider ? { provider: injected.provider } : {}),
      } as never),
  };
});
vi.mock("../../src/decisions/job.js", async (orig) => ({
  ...(await orig<typeof import("../../src/decisions/job.js")>()),
  spawnDecisionJob: injected.spawn,
}));

const SID = "s1";
const GH = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";
const NOENV = {} as NodeJS.ProcessEnv;

function aj(c: Record<string, unknown>): AdjudicatorConfig {
  return AdjudicatorConfigSchema.parse({
    enabled: true,
    provider: "openai-compatible",
    openai: { preset: "ollama" },
    features: { compaction: { enabled: true, shadow: false, ...c } },
  }) as AdjudicatorConfig;
}

type Scorer = (text: string) => number;
interface Probe {
  calls: number;
  batches: string[];
}
function provider(
  score: Scorer,
  probe: Probe,
  mode: "ok" | "throw" | "hang" | "unsupported" = "ok",
) {
  const p: DecisionProvider = {
    id: "openai-compatible",
    remote: false,
    model: "m",
    maxPairs: 100,
    maxRequests: 2,
    supports: () => mode !== "unsupported",
    ask: async (batch) => {
      probe.calls++;
      probe.batches.push(JSON.stringify(batch));
      if (mode === "throw") throw new Error("boom");
      if (mode === "hang") return new Promise(() => {});
      return {
        answers: Object.fromEntries(
          batch.items.map((i) => [
            i.id,
            {
              useful: {
                kind: "score" as const,
                value: score(i.text),
                confidence: 1,
                calibrated: true,
              },
            },
          ]),
        ),
        tokensIn: 1,
        costUsd: null,
        latencyMs: 1,
        model: "m",
      };
    },
  };
  return p;
}
const probe = (): Probe => ({ calls: 0, batches: [] });

let db: SqliteAdapter;
let root: string;
beforeEach(() => {
  // outside the home directory: a personal config is trusted only from there
  root = mkdtempSync(join(tmpdir(), "cmpe-root-"));
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "cmpe-home-"));
  db = new SqliteAdapter(join(mkdtempSync(join(tmpdir(), "cmpe-")), "e.db"), { vectors: false });
  injected.provider = undefined;
  injected.spawn.mockClear();
});
afterEach(() => {
  db.db.close();
  delete process.env.EMINIAR_HOME;
});

describe("session-guide rewrite", () => {
  const seed = (extra = false) => {
    const ev = (category: string, priority: 1 | 2 | 3 | 4, payload: Record<string, unknown>) =>
      db.eventInsert({ sessionId: SID, category, priority, payload });
    ev("user_prompt", 1, { text: `fix the login redirect, my token is ${GH}` });
    ev("files", 2, { path: "src/login.ts" });
    ev("git", 3, { command: "git status" });
    ev("mcp_tool", 4, { tool: "em_search" });
    if (extra)
      for (let i = 0; i < 60; i++)
        ev("files", 2, { path: `src/long/path/number/${i}/file${i}.ts` });
  };
  const snap = () => {
    const body = renderGuide(db, SID, SNAPSHOT_BUDGET);
    return { body, id: db.snapshotInsert({ sessionId: SID, trigger: "auto", body }) };
  };
  const exec = async (
    cfg: AdjudicatorConfig,
    p: DecisionProvider,
    snapshotId: number,
    payload: unknown = { sessionId: SID, snapshotId },
  ) => {
    const job: DecisionJob = {
      v: 1,
      feature: "compaction",
      projectRoot: root,
      sessionId: SID,
      payload,
    };
    await feature.runJob?.(
      job,
      createDecisionClient("compaction", {
        config: cfg,
        db,
        context: "job",
        env: NOENV,
        provider: p,
      }),
      db,
    );
  };
  const unchanged = (s: { id: number; body: string }) => {
    const latest = db.snapshotLatestUnconsumed(SID);
    expect(latest?.id).toBe(s.id);
    expect(latest?.body).toBe(s.body);
  };

  // A fresh database per scenario: the 24 h answer cache would otherwise let a shadow run's
  // answers satisfy a later live one.
  const scenarios: Array<
    [string, Record<string, unknown>, "ok" | "throw" | "hang" | "unsupported", number]
  > = [
    ["off", { enabled: false }, "ok", 0],
    ["shadow", { shadow: true }, "ok", 1],
    ["unsupported", {}, "unsupported", 0],
    ["error", {}, "throw", 1],
    ["timeout", { jobMs: 60 }, "hang", 1],
  ];
  it.each(scenarios)("%s leaves the snapshot byte-identical", async (_n, c, mode, calls) => {
    seed();
    const s = snap();
    const pr = probe();
    // the job reads its budget from the personal config, as a real child does
    writeFileSync(
      join(process.env.EMINIAR_HOME as string, "config.json"),
      JSON.stringify({ adjudicator: { features: { compaction: c } } }),
    );
    const t0 = Date.now();
    await exec(
      aj(c),
      provider(() => 0, pr, mode),
      s.id,
    );
    expect(Date.now() - t0).toBeLessThan(2000);
    if (mode !== "unsupported") expect(pr.calls).toBe(calls);
    unchanged(s);
  });

  it("a canary secret in the session never reaches the provider", async () => {
    seed();
    const s = snap();
    const pr = probe();
    await exec(
      aj({}),
      provider(() => 1, pr),
      s.id,
    );
    expect(pr.calls).toBe(1);
    expect(pr.batches.join("")).not.toContain(GH);
  });

  it("keeps the P1 sections even when every section scores zero, within the budget", async () => {
    seed(true);
    const s = snap();
    await exec(
      aj({}),
      provider(() => 0, probe()),
      s.id,
    );
    const next = db.snapshotLatestUnconsumed(SID);
    const p1 = guideSections(db, SID).filter((x) => x.priority <= 1);
    expect(p1.length).toBeGreaterThan(0);
    for (const x of p1) expect(next?.body).toContain(`**${x.label}**: `);
    expect(Buffer.byteLength(next?.body ?? "")).toBeLessThanOrEqual(SNAPSHOT_BUDGET);
  });

  it("never exceeds the budget when everything scores high", async () => {
    seed(true);
    const s = snap();
    await exec(
      aj({}),
      provider(() => 1, probe()),
      s.id,
    );
    expect(Buffer.byteLength(db.snapshotLatestUnconsumed(SID)?.body ?? "")).toBeLessThanOrEqual(
      SNAPSHOT_BUDGET,
    );
  });

  it("a newer snapshot wins: the job leaves it alone", async () => {
    seed();
    const old = snap();
    await new Promise((r) => setTimeout(r, 15));
    const newer = db.snapshotInsert({ sessionId: SID, trigger: "auto", body: "NEWER BODY" });
    await exec(
      aj({}),
      provider(() => 0, probe()),
      old.id,
    );
    expect(db.snapshotLatestUnconsumed(SID)?.id).toBe(newer);
    expect(db.snapshotLatestUnconsumed(SID)?.body).toBe("NEWER BODY");
  });

  it("a session with fewer than two sections, or a malformed payload, asks nothing", async () => {
    const pr = probe();
    const only = db.snapshotInsert({ sessionId: SID, trigger: "auto", body: "x" });
    await exec(
      aj({}),
      provider(() => 0, pr),
      only,
    );
    for (const bad of [undefined, null, 7, { sessionId: 1, snapshotId: "a" }, { sessionId: SID }])
      await exec(
        aj({}),
        provider(() => 0, pr),
        only,
        bad,
      );
    expect(pr.calls).toBe(0);
    expect(db.snapshotLatestUnconsumed(SID)?.id).toBe(only);
  });

  it("chooseSections: P1 stay when over budget alone; ties keep priority order; empty is empty", () => {
    const mk = (id: string, priority: number, n: number) => ({
      id,
      label: id,
      text: "x".repeat(n),
      priority,
      items: [],
    });
    const s = [mk("p1", 1, 500), mk("p2", 2, 10), mk("p3", 3, 10)];
    expect(chooseSections(s, () => 1, 0.3, 100).map((x) => x.id)).toEqual(["p1"]);
    expect(chooseSections(s, () => 1, 0.3, 600).map((x) => x.id)).toEqual(["p1", "p2", "p3"]);
    expect(chooseSections(s, () => 0, 0.3, 600).map((x) => x.id)).toEqual(["p1"]);
    expect(chooseSections([], () => 1, 0.3, 100)).toEqual([]);
  });

  describe("the PreCompact hook", () => {
    const hookInput = (cwd: string) =>
      ({ session_id: SID, cwd, trigger: "auto", hook_event_name: "PreCompact" }) as never;

    it("spawns one job only when the feature is wanted, and the stored snapshot is the same", async () => {
      seed();
      const expected = renderGuide(db, SID, SNAPSHOT_BUDGET);
      const f = vi.fn();
      vi.stubGlobal("fetch", f);
      try {
        const { decisionPreCompact } = await import("../../src/decisions/hooks.js");
        const mk = (c: Record<string, unknown>): ProjectContext => ({
          root: tmpdir(),
          id: "t",
          dbPath: "x",
          config: ConfigSchema.parse({
            adjudicator: {
              enabled: true,
              // a job has no embedder, so the embedding provider spawns nothing; use a local server
              provider: "openai-compatible",
              openai: { preset: "ollama", baseUrl: "http://127.0.0.1:9/v1", model: "m" },
              features: { compaction: c },
            },
          }),
        });
        const id = db.snapshotInsert({ sessionId: SID, trigger: "auto", body: expected });
        const t0 = Date.now();
        await decisionPreCompact(mk({ enabled: false }), db, SID, id);
        expect(injected.spawn).not.toHaveBeenCalled();
        await decisionPreCompact(mk({ enabled: true }), db, SID, id);
        expect(Date.now() - t0).toBeLessThan(500);
        expect(injected.spawn).toHaveBeenCalledTimes(1);
        expect(f).not.toHaveBeenCalled();
        expect(db.snapshotLatestUnconsumed(SID)?.body).toBe(expected);
        void hookInput;
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });
});

describe("sandbox output triage", () => {
  // Sections far enough apart to land in different chunks; the canary sits in the second one.
  const sections = ["alpha", "bravo", "charlie", "delta", "echo"];
  const noise = (tag: string) =>
    Array.from({ length: 60 }, (_, i) => `${tag} routine line ${i} of filler text for chunking`);
  const big = sections
    .flatMap((s) => [
      ...noise(s),
      `FAILURE in ${s}: assertion failed in module ${s}`,
      ...(s === "bravo" ? [`FAILURE token=${GH} leaked in bravo`] : []),
    ])
    .join("\n");

  const mkCtx = (c: Record<string, unknown> | undefined): ProjectContext => ({
    root: tmpdir(),
    id: "t",
    dbPath: "x",
    config: ConfigSchema.parse(
      c === undefined
        ? {}
        : {
            adjudicator: {
              enabled: true,
              provider: "openai-compatible",
              openai: { preset: "ollama" },
              features: { compaction: { enabled: true, shadow: false, output: true, ...c } },
            },
          },
    ),
  });

  const input = { stdout: big, title: "t", source: "exec" as const };
  const norm = (t: string) => t.replace(/doc \d+/g, "doc N").replace(/\[\d+\]/g, "[N]");

  async function text(
    ctx: ProjectContext,
    p?: DecisionProvider,
    intent: string | null = "FAILURE",
    queries: string[] = [],
  ) {
    injected.provider = p;
    // a fresh database each time: document ids and the answer cache are per database
    const d = new SqliteAdapter(join(mkdtempSync(join(tmpdir(), "cmpo-")), "e.db"), {
      vectors: false,
    });
    try {
      return norm(
        (
          await processOutput(d, ctx, {
            ...input,
            triage: true,
            queries,
            ...(intent ? { intent } : {}),
          })
        ).text,
      );
    } finally {
      d.db.close();
    }
  }

  it("off, output flag off, shadow, unsupported, error, timeout: byte-identical to the baseline", async () => {
    const base = await text(mkCtx(undefined));
    expect(base).toContain("FAILURE");
    const high = (t: string) => (t.includes("bravo") ? 1 : 0);
    const pr = probe();
    expect(await text(mkCtx({ output: false }), provider(high, pr))).toBe(base);
    expect(pr.calls).toBe(0);
    expect(await text(mkCtx({ enabled: false }), provider(high, pr))).toBe(base);
    expect(pr.calls).toBe(0);
    expect(await text(mkCtx({ shadow: true }), provider(high, pr))).toBe(base);
    expect(pr.calls).toBe(1);
    expect(await text(mkCtx({}), provider(high, probe(), "unsupported"))).toBe(base);
    expect(await text(mkCtx({}), provider(high, probe(), "throw"))).toBe(base);
    const t0 = Date.now();
    expect(await text(mkCtx({ mcpMs: 50 }), provider(high, probe(), "hang"))).toBe(base);
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("no intent means no call", async () => {
    const pr = probe();
    const base = await text(mkCtx(undefined), undefined, null, ["FAILURE"]);
    expect(
      await text(
        mkCtx({}),
        provider(() => 1, pr),
        null,
        ["FAILURE"],
      ),
    ).toBe(base);
    expect(pr.calls).toBe(0);
  });

  it("the provider never sees the canary line of the output", async () => {
    const pr = probe();
    await text(
      mkCtx({}),
      provider(() => 1, pr),
    );
    expect(pr.calls).toBe(1);
    expect(pr.batches.join("")).not.toContain(GH);
    expect(pr.batches.join("")).toContain("masked line");
  });

  it("live: low-scored sections drop out, and an all-zero scoring keeps the baseline", async () => {
    const base = await text(mkCtx(undefined));
    const only = await text(
      mkCtx({}),
      provider((t) => (t.includes("charlie") ? 1 : 0), probe()),
    );
    expect(only).toContain("FAILURE in charlie");
    expect(only).not.toContain("FAILURE in echo");
    expect(only.length).toBeLessThan(base.length);
    expect(
      await text(
        mkCtx({}),
        provider(() => 0, probe()),
      ),
    ).toBe(base);
  });
});

describe("output triage with several queries", () => {
  it("a dropped section is dropped from every query's results, not only the first", async () => {
    const parts = ["alpha", "bravo", "charlie", "delta", "echo"].flatMap((s) => [
      ...Array.from({ length: 60 }, (_, i) => `${s} routine line ${i} of filler text for chunking`),
      `FAILURE in ${s}: assertion failed`,
    ]);
    const ctx: ProjectContext = {
      root: tmpdir(),
      id: "t",
      dbPath: "x",
      config: ConfigSchema.parse({
        adjudicator: {
          enabled: true,
          provider: "openai-compatible",
          openai: { preset: "ollama" },
          features: { compaction: { enabled: true, shadow: false, output: true } },
        },
      }),
    };
    injected.provider = provider((t) => (t.includes("alpha") ? 1 : 0), probe());
    const d = new SqliteAdapter(join(mkdtempSync(join(tmpdir(), "cmpo2-")), "e.db"), {
      vectors: false,
    });
    const r = await processOutput(d, ctx, {
      stdout: parts.join("\n"),
      title: "t",
      source: "exec",
      triage: true,
      intent: "FAILURE",
      queries: ["assertion", "FAILURE"],
    });
    d.db.close();
    expect(r.text).toContain("FAILURE in alpha");
    expect(r.text).not.toContain("FAILURE in echo");
  });
});
