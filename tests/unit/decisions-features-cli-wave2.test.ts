/**
 * Wave 2 fix (F8): a degraded remote provider is still remote for consent and status messages.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adjudicatorCommand, featureRows, type Io } from "../../src/adjudicator/cli.js";
import { resetSecrets } from "../../src/adjudicator/secrets.js";
import { ConfigSchema } from "../../src/config.js";
import type { ProjectContext } from "../../src/context.js";
import { paths } from "../../src/paths.js";
import { SqliteAdapter } from "../../src/storage/sqlite/adapter.js";

const ENV_KEYS = [
  "EMINIAR_HOME",
  "EMINIAR_ADJUDICATOR",
  "EMINIAR_ADJUDICATOR_PROVIDER",
  "EMINIAR_ADJUDICATOR_REMOTE",
  "EMINIAR_ADJUDICATOR_FEATURES",
  "TYPESAFE_API_KEY",
];
const ORIGIN = "https://api.typesafe.ai";

let db: SqliteAdapter;
let ctx: ProjectContext;

beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), "em-fcw2-home-"));
  const root = mkdtempSync(join(tmpdir(), "em-fcw2-root-"));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.EMINIAR_HOME = home;
  resetSecrets();
  const dbPath = join(root, "db.sqlite");
  db = new SqliteAdapter(dbPath, { vectors: false });
  ctx = { root, id: "test", dbPath, config: ConfigSchema.parse({}) };
  writeFileSync(
    paths().configFile,
    JSON.stringify({ adjudicator: { enabled: true, provider: "typesafe" } }),
  );
});
afterEach(() => {
  db.close?.();
  for (const k of ENV_KEYS) delete process.env[k];
  resetSecrets();
});

function fakeIo() {
  const lines: string[] = [];
  const io: Io = {
    out: (l) => lines.push(l),
    err: (l) => lines.push(`ERR ${l}`),
    isTTY: false,
    ask: async () => "",
    askHidden: async () => "",
    readStdin: async () => "",
    env: {},
    now: () => Date.UTC(2026, 10, 5, 12),
  };
  return { io, text: () => lines.join("\n") };
}

// biome-ignore lint/suspicious/noExplicitAny: untyped JSON
const raw = (): any => JSON.parse(readFileSync(paths().configFile, "utf8"));
const run = (args: string[], io: Io) => adjudicatorCommand(args, ctx, { io, db });

describe("a remote provider that is merely degraded (no key, no provider consent)", () => {
  it("features on shows the origin consent line, records consent, never claims local", async () => {
    const t = fakeIo();
    expect(await run(["features", "on", "commit", "--yes"], t.io)).toBe(0);
    const text = t.text();
    expect(text).toContain(ORIGIN);
    expect(text).toContain("waiting");
    expect(text).not.toContain("nothing leaves this machine");
    expect(text).not.toContain("local provider");
    expect(raw().adjudicator.featureConsent.some((e: string) => e.endsWith(ORIGIN))).toBe(true);
  });

  it("features status reports the configured provider's data class, not local", async () => {
    await run(["features", "on", "commit", "--yes"], fakeIo().io);
    const t = fakeIo();
    expect(await run(["features", "status"], t.io)).toBe(0);
    const text = t.text();
    expect(text).toContain("remote");
    expect(text).toContain("waiting");
    expect(text).not.toContain("none (local provider)");
    expect(text).not.toContain("(local)");
  });

  it("featureRows names the origin it would send to and consent state", () => {
    const row = featureRows(
      ConfigSchema.parse({
        adjudicator: { enabled: true, provider: "typesafe", features: { commit: true } },
      }),
      {},
    ).find((r) => r.name === "commit");
    expect(row?.dataClass).toContain(ORIGIN);
    expect(row?.consented).toBe(false);
  });

  it("without a terminal or --yes it still refuses", async () => {
    expect(await run(["features", "on", "commit"], fakeIo().io)).toBe(1);
  });
});
