import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AdjudicatorConfig, AdjudicatorConfigSchema } from "../../src/config.js";
import { getContext, type ProjectContext, resetContextCache } from "../../src/context.js";
import { suggestMemoryHygiene } from "../../src/decisions/features/memory.js";
import type { DecisionProvider } from "../../src/decisions/providers/types.js";
import type { DecisionAnswer } from "../../src/decisions/types.js";
import { write } from "../../src/memory/store.js";
import type { StorageAdapter } from "../../src/storage/adapter.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";
import { emRemember } from "../../src/tools/em_remember.js";

const ORIGIN = "https://api.typesafe.ai";
const ENV = { TYPESAFE_API_KEY: "sk-test-key-0123456789" } as NodeJS.ProcessEnv;

let root: string;
let ctx: ProjectContext;
let db: StorageAdapter;

function cfg(shadow: boolean): AdjudicatorConfig {
  return AdjudicatorConfigSchema.parse({
    enabled: true,
    provider: "typesafe",
    remoteConsent: true,
    remoteConsentOrigins: [ORIGIN],
    featureConsent: [`memory@${ORIGIN}`],
    features: { memory: { enabled: true, shadow } },
  }) as AdjudicatorConfig;
}

function provider(answer: (id: string) => DecisionAnswer): DecisionProvider {
  return {
    id: "typesafe",
    remote: false,
    model: "m",
    maxPairs: 100,
    maxRequests: 1,
    supports: () => true,
    ask: async (batch) => ({
      answers: Object.fromEntries(
        batch.items.map((i) => [i.id, { [batch.questions[0]!.name]: answer(i.id) }]),
      ),
      tokensIn: 1,
      costUsd: 0,
      latencyMs: 1,
      model: "m",
    }),
  };
}

const choice = (c: string): DecisionAnswer => ({
  kind: "choice",
  choice: c,
  probs: { [c]: 0.95 },
  confidence: 0.95,
  calibrated: true,
});

beforeAll(() => {
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-home-"));
  process.env.EMINIAR_EMBEDDINGS = "0";
  root = mkdtempSync(join(tmpdir(), "em-dmem-"));
  writeFileSync(join(root, "package.json"), "{}");
  resetContextCache();
  ctx = getContext(root);
  db = getStorage(ctx);
  write(ctx, db, {
    name: "auth/tokens",
    kind: "decision",
    content: "Session tokens are stored in redis with a one hour expiry",
  });
});
afterAll(() => {
  closeAllStorage();
  delete process.env.EMINIAR_HOME;
  delete process.env.EMINIAR_EMBEDDINGS;
});

const NEW = "Session tokens are stored in postgres with a one day expiry";
const input = { name: "auth/tokens-v2", content: NEW };
const inputFor = (n: number) => ({ name: "auth/tokens-v2", content: `${NEW} variant ${n}` });

describe("memory hygiene suggestion", () => {
  it("suggests a superseded memory in live mode", async () => {
    ctx.config.adjudicator = cfg(false);
    write(ctx, db, { name: "auth/tokens-v2", kind: "decision", content: NEW });
    const line = await suggestMemoryHygiene(ctx, db, input, {
      env: ENV,
      provider: provider(() => choice("supersedes")),
    });
    expect(line).toBe(
      'looks like it supersedes auth/tokens; pass supersedes: "auth/tokens" to confirm',
    );
    expect(db.memoryGetByName("auth/tokens")?.status).not.toBe("superseded");
  });

  it("accepts the embedding yes_no duplicate form", async () => {
    ctx.config.adjudicator = cfg(false);
    const line = await suggestMemoryHygiene(ctx, db, inputFor(1), {
      env: ENV,
      provider: provider(() => ({ kind: "yes_no", p: 0.99, calibrated: false })),
    });
    expect(line).toContain("duplicate of auth/tokens");
  });

  it("says nothing for shadow, unrelated answers or an explicit supersedes", async () => {
    const p = provider(() => choice("supersedes"));
    ctx.config.adjudicator = cfg(true);
    expect(await suggestMemoryHygiene(ctx, db, input, { env: ENV, provider: p })).toBeUndefined();
    ctx.config.adjudicator = cfg(false);
    expect(
      await suggestMemoryHygiene(ctx, db, inputFor(2), {
        env: ENV,
        provider: provider(() => choice("unrelated")),
      }),
    ).toBeUndefined();
    expect(
      await suggestMemoryHygiene(
        ctx,
        db,
        { ...input, supersedes: "auth/tokens" },
        { env: ENV, provider: p },
      ),
    ).toBeUndefined();
  });

  it("leaves the em_remember reply untouched when the feature is off", async () => {
    ctx.config.adjudicator = AdjudicatorConfigSchema.parse({}) as AdjudicatorConfig;
    const r = await emRemember.handler(
      { content: "An unrelated project fact", kind: "note", name: "misc/fact" },
      ctx,
    );
    expect(r.content.map((c) => c.text).join("")).toMatch(/^remembered misc\/fact \(note\) → \S+$/);
  });
});
