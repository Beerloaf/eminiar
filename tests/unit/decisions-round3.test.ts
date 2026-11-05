/** Review #320 round 3 (F1-F4): recall error cache, memory/doc order, daily cap, compaction paths. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { forRemote } from "../../src/adjudicator/redact.js";
import { type AdjudicatorConfig, AdjudicatorConfigSchema } from "../../src/config.js";
import { createDecisionClient } from "../../src/decisions/client.js";
import { readablePaths } from "../../src/decisions/features/compaction.js";
import { decideRecall, errorContext } from "../../src/decisions/features/recall.js";
import type { Decision, DecisionQuestionSpec } from "../../src/decisions/types.js";
import { SqliteAdapter } from "../../src/storage/sqlite/adapter.js";

describe("F1: error cache context tells different errors apart", () => {
  const pre =
    "Command failed: npm run build in project billing-service while compiling typescript sources for the payments ledger module during the nightly settlement pipeline";
  it("same preamble, different error code: different context", () => {
    expect(errorContext(`${pre} error TS2322 settlement.ts`)).not.toBe(
      errorContext(`${pre} error TS2345 invoice.ts`),
    );
  });
  it("whitespace and case do not split the same error", () => {
    expect(errorContext("Error  A\nfailed")).toBe(errorContext("error a failed"));
  });
});

describe("F2: a memory-vs-doc order swap is not a change", () => {
  const yn = (p: number) => ({ kind: "yes_no" as const, p, calibrated: true });
  const spec = {
    path: "prompt" as const,
    query: "q",
    items: [
      { id: "memory:m", text: "m" },
      { id: "doc:2", text: "d" },
    ],
    baseline: ["memory:m", "doc:2"],
  };
  it("doc scored higher than memory: shown text unchanged", () => {
    const d = decideRecall(
      spec,
      0.1,
    )({
      "memory:m": { relevant: yn(0.5) },
      "doc:2": { relevant: yn(0.9) },
    } as never);
    expect(d.changed).toBe(0);
    expect(d.decision).toEqual(["memory:m", "doc:2"]);
  });
  it("a real reorder inside the memories still counts", () => {
    const s = {
      ...spec,
      items: [
        { id: "memory:a", text: "a" },
        { id: "memory:b", text: "b" },
      ],
      baseline: ["memory:a", "memory:b"],
    };
    const d = decideRecall(
      s,
      0.1,
    )({
      "memory:a": { relevant: yn(0.4) },
      "memory:b": { relevant: yn(0.9) },
    } as never);
    expect(d.changed).toBe(1);
  });
});

describe("F3: the daily cap does not block a cached ask", () => {
  const ORIGIN = "https://api.typesafe.ai";
  const ENV = { TYPESAFE_API_KEY: "sk-test-key-0123456789" } as NodeJS.ProcessEnv;
  let db: SqliteAdapter;
  const home = process.env.EMINIAR_HOME;
  beforeEach(() => {
    process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "r3-home-"));
    db = new SqliteAdapter(join(mkdtempSync(join(tmpdir(), "r3-")), "e.db"), { vectors: false });
  });
  afterEach(() => {
    db.db.close();
    if (home === undefined) delete process.env.EMINIAR_HOME;
    else process.env.EMINIAR_HOME = home;
  });
  const Q: DecisionQuestionSpec = {
    name: "helps",
    kind: "yes_no",
    instructions: "Does {item} help?",
  };
  const decide = (a: Record<string, unknown>): Decision => ({
    decision: Object.keys(a),
    changed: 1,
  });
  it("ask A, A, B, A with maxCallsPerDay 2: the last is cached", async () => {
    let n = 0;
    const cfg = AdjudicatorConfigSchema.parse({
      enabled: true,
      provider: "typesafe",
      remoteConsent: true,
      remoteConsentOrigins: [ORIGIN],
      featureConsent: [`memory@${ORIGIN}`],
      features: { recall: { enabled: true, shadow: false, maxCallsPerDay: 2 } },
    }) as AdjudicatorConfig;
    const c = createDecisionClient("recall", {
      config: cfg,
      db,
      context: "server",
      env: ENV,
      fetch: (async (_u: string, init: RequestInit) => {
        n++;
        const body = JSON.parse(String(init.body)) as { questions: Record<string, unknown> };
        const answers = Object.fromEntries(
          Object.keys(body.questions).map((k) => [k, { type: "noul", noul: 0.9 }]),
        );
        return new Response(JSON.stringify({ answers, usage: { input_tokens: 1 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as never,
    });
    const mk = (id: string) => ({
      feature: "recall" as const,
      subject: `s:${id}`,
      context: "ctx",
      items: [{ id, text: `body of ${id}` }],
      questions: [Q],
      baseline: { shown: [id] },
      budgetMs: 2000,
    });
    expect((await c.ask(mk("memory:a"), decide)).status).toBe("ok");
    expect((await c.ask(mk("memory:a"), decide)).status).toBe("cached");
    expect((await c.ask(mk("memory:b"), decide)).status).toBe("ok");
    expect((await c.ask(mk("memory:a"), decide)).status).toBe("cached");
    expect((await c.ask(mk("memory:c"), decide)).status).toBe("feature_cap");
    expect(n).toBe(2);
  });
});

describe("F4: compaction paths stay readable", () => {
  const root = "/Users/ryandick/Dev/Projects/eminiar2";
  it("strips the project root so the remote redactor keeps the path", () => {
    const t = readablePaths(
      `**Files Modified**: ${root}/src/decisions/client.ts | ${root}/src/a.ts`,
      root,
    );
    expect(t).toBe("**Files Modified**: src/decisions/client.ts | src/a.ts");
    expect(forRemote(t, 4000)).not.toContain("[b64]");
    expect(forRemote(t, 4000)).toContain("src/decisions/client.ts");
  });
  it("a long path outside the root is cut to its last two segments", () => {
    const t = readablePaths("/Users/ryandick/Other/Project9/lib/Deep/File.ts changed", root);
    expect(t).toBe("Deep/File.ts changed");
  });
  it("different file sets give different text", () => {
    expect(readablePaths(`${root}/src/a.ts`, root)).not.toBe(
      readablePaths(`${root}/src/b.ts`, root),
    );
  });
});
