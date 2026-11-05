import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../../src/config.js";
import type { ProjectContext } from "../../src/context.js";
import { SqliteAdapter } from "../../src/storage/sqlite/adapter.js";
import { featuresPayload } from "../../src/ui/adjudicator-api.js";
import {
  agreementPct,
  agreementText,
  errors,
  featureState,
  unsupported,
} from "../../src/ui/web/views/features-helpers.js";

// biome-ignore lint/suspicious/noExplicitAny: untyped JSON payloads
type Json = any;
const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
let db: SqliteAdapter;
let ctx: ProjectContext;
const cfg = (adjudicator: Record<string, unknown>) => ConfigSchema.parse({ adjudicator });

beforeEach(() => {
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-feat-home-"));
  const root = mkdtempSync(join(tmpdir(), "em-feat-"));
  const dbPath = join(root, "db.sqlite");
  db = new SqliteAdapter(dbPath, { vectors: false });
  ctx = { root, id: "t", dbPath, config: cfg({}) };
});
afterEach(() => {
  db.close();
  delete process.env.EMINIAR_HOME;
});

const call = (status: string, changed: number, cost = 0.001, feature = "recall") =>
  db.decisions.insertCall({
    ts: NOW - 1000,
    feature: feature as never,
    context: "hook",
    subject: "s",
    mode: "shadow",
    status: status as never,
    changed,
    costUsd: cost,
  });

describe("featuresPayload", () => {
  it("is inactive when the adjudicator is off or no feature is enabled", () => {
    const off = featuresPayload(ctx, { config: cfg({}), db, now: () => NOW, env: {} }).body as Json;
    expect(off).toMatchObject({ active: false, reason: "disabled" });
    const none = featuresPayload(ctx, {
      config: cfg({ enabled: true, provider: "embedding" }),
      db,
      now: () => NOW,
      env: {},
    }).body as Json;
    expect(none).toMatchObject({ active: false, reason: "no_features" });
  });

  it("counts per feature, whatever the provider", () => {
    call("ok", 0);
    call("ok", 1);
    call("unsupported", 0, 0);
    call("timeout", 0, 0);
    const r = featuresPayload(ctx, {
      config: cfg({ enabled: true, provider: "embedding", features: { recall: true } }),
      db,
      now: () => NOW,
      env: {},
    }).body as Json;
    expect(r.active).toBe(true);
    expect(r.features).toHaveLength(6);
    const recall = r.features.find((f: Json) => f.feature === "recall");
    expect(recall.enabled).toBe(true);
    expect(recall.summary.calls).toBe(4);
    expect(agreementPct(recall.summary)).toBe(50);
    expect(agreementText(recall.summary)).toBe("50% (1/2)");
    expect(unsupported(recall.summary)).toBe(1);
    expect(errors(recall.summary)).toBe(1);
    expect(featureState(recall)).toMatch(/shadow|no consent/);
    expect(featureState(r.features.find((f: Json) => f.feature === "docs"))).toBe("off");
  });
});
