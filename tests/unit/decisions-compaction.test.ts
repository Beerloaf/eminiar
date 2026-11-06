import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AdjudicatorConfig, AdjudicatorConfigSchema } from "../../src/config.js";
import { createDecisionClient } from "../../src/decisions/client.js";
import { chooseSections, feature, maskedLines } from "../../src/decisions/features/compaction.js";
import type { DecisionProvider } from "../../src/decisions/providers/types.js";
import type { DecisionJob } from "../../src/decisions/types.js";
import { guideSections, renderGuide, renderSections } from "../../src/session/guide.js";
import { SqliteAdapter } from "../../src/storage/sqlite/adapter.js";

const SID = "s1";

function cfg(shadow: boolean): AdjudicatorConfig {
  return AdjudicatorConfigSchema.parse({
    enabled: true,
    provider: "openai-compatible",
    openai: { preset: "ollama" },
    features: { compaction: { enabled: true, shadow } },
  }) as AdjudicatorConfig;
}

/** Scores every section 1 except those named in `low`, which get 0. */
function provider(low: string[], calls: { n: number } = { n: 0 }): DecisionProvider {
  return {
    id: "openai-compatible",
    remote: false,
    model: "m",
    maxPairs: 40,
    maxRequests: 2,
    supports: () => true,
    ask: async (batch) => {
      calls.n++;
      const answers: Record<string, Record<string, never>> = {};
      for (const it of batch.items) {
        answers[it.id] = {
          useful: {
            kind: "score",
            value: low.some((l) => it.text.includes(`**${l}**`)) ? 0 : 1,
            confidence: 1,
            calibrated: true,
          } as never,
        };
      }
      return { answers, tokensIn: 1, costUsd: null, latencyMs: 1, model: "m" };
    },
  };
}

describe("compaction", () => {
  let db: SqliteAdapter;
  beforeEach(() => {
    db = new SqliteAdapter(join(mkdtempSync(join(tmpdir(), "cmp-")), "e.db"), { vectors: false });
    const ev = (category: string, priority: 1 | 2 | 3 | 4, payload: Record<string, unknown>) =>
      db.eventInsert({ sessionId: SID, category, priority, payload });
    ev("user_prompt", 1, { text: "fix the login redirect" });
    ev("files", 2, { path: "src/login.ts" });
    ev("git", 3, { command: "git status" });
    ev("mcp_tool", 4, { tool: "em_search" });
  });
  afterEach(() => db.db.close());

  const run = async (shadow: boolean, low: string[]) => {
    const snapshotId = db.snapshotInsert({
      sessionId: SID,
      trigger: "auto",
      body: renderGuide(db, SID),
    });
    const config = cfg(shadow);
    const job: DecisionJob = {
      v: 1,
      feature: "compaction",
      projectRoot: tmpdir(),
      sessionId: SID,
      payload: { sessionId: SID, snapshotId },
    };
    const client = createDecisionClient("compaction", {
      config,
      db,
      context: "job",
      env: {} as NodeJS.ProcessEnv,
      provider: provider(low),
    });
    return { snapshotId, job, client };
  };

  it("renderGuide is guideSections composed with renderSections", () => {
    expect(renderGuide(db, SID, 2048)).toBe(renderSections(guideSections(db, SID), 2048));
    expect(renderGuide(db, SID, 60)).toBe(renderSections(guideSections(db, SID), 60));
    expect(renderGuide(db, "none")).toBe("");
  });

  it("preCompact hands the job the snapshot", () => {
    expect(feature.preCompact?.({} as never, { sessionId: "a", snapshotId: 3 })).toEqual({
      sessionId: "a",
      snapshotId: 3,
    });
  });

  it("live: rewrites the snapshot without the low-scored section", async () => {
    const { snapshotId, job, client } = await run(false, ["Files Modified"]);
    await feature.runJob?.(job, client, db);
    const next = db.snapshotLatestUnconsumed(SID);
    expect(next?.id).not.toBe(snapshotId);
    expect(next?.body).toContain("**Last Request**");
    expect(next?.body).not.toContain("**Files Modified**");
  });

  it("shadow: records and changes nothing", async () => {
    const { snapshotId, job, client } = await run(true, ["Files Modified"]);
    await feature.runJob?.(job, client, db);
    expect(db.snapshotLatestUnconsumed(SID)?.id).toBe(snapshotId);
    const rows = db.decisions.list({ feature: "compaction" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ mode: "shadow", applied: false });
    expect(JSON.stringify(rows[0]?.decision)).toContain("Files Modified");
  });

  it("a consumed snapshot is left alone and the row says late", async () => {
    const { snapshotId, job, client } = await run(false, ["Files Modified"]);
    db.snapshotMarkConsumed(snapshotId);
    await feature.runJob?.(job, client, db);
    expect(db.snapshotLatestUnconsumed(SID)).toBeUndefined();
    expect(JSON.stringify(db.decisions.list({ feature: "compaction" })[0]?.decision)).toContain(
      '"late":true',
    );
  });

  it("a bad payload does nothing", async () => {
    const { job, client } = await run(false, []);
    await feature.runJob?.({ ...job, payload: { nope: 1 } }, client, db);
    expect(db.decisions.list({ feature: "compaction" })).toHaveLength(0);
  });

  it("chooseSections keeps P1, ranks by score, honours minKeep and the budget", () => {
    const mk = (id: string, priority: number, n: number) => ({
      id,
      label: id,
      text: "x".repeat(n),
      priority,
      items: [],
    });
    const s = [mk("a", 1, 10), mk("b", 2, 50), mk("c", 3, 50), mk("d", 4, 5)];
    const score = (x: { id: string }) => ({ a: 0, b: 0.5, c: 0.9, d: 0.1 })[x.id] ?? 0;
    expect(chooseSections(s, score, 0.3, 200).map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(chooseSections(s, score, 0.3, 70).map((x) => x.id)).toEqual(["a", "c"]);
  });

  it("masks every output line the redactor would change", () => {
    const out = maskedLines("ok line\npassword=hunter2hunter2\nuser@example.com wrote");
    expect(out.split("\n")[0]).toBe("ok line");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("example.com");
  });
});
