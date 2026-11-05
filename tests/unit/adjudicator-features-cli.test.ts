/**
 * `eminiar adjudicator features [status|on|off|shadow|purge]` (task #285). A temp EMINIAR_HOME and
 * a scripted terminal. Features are provider-generic and personal-only: a local provider needs no
 * consent, a remote one needs its data class agreed at its origin (one line per class).
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
];
let home: string;
let root: string;
let db: SqliteAdapter;
let ctx: ProjectContext;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "em-featcli-home-"));
  root = mkdtempSync(join(tmpdir(), "em-featcli-root-"));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.EMINIAR_HOME = home;
  resetSecrets();
  const dbPath = join(root, "db.sqlite");
  db = new SqliteAdapter(dbPath, { vectors: false });
  ctx = { root, id: "test", dbPath, config: ConfigSchema.parse({}) };
});
afterEach(() => {
  db.close?.();
  for (const k of ENV_KEYS) delete process.env[k];
  resetSecrets();
});

function fakeIo(o: { tty?: boolean; answers?: string[]; env?: NodeJS.ProcessEnv } = {}) {
  const lines: string[] = [];
  const answers = [...(o.answers ?? [])];
  const io: Io = {
    out: (l) => lines.push(l),
    err: (l) => lines.push(`ERR ${l}`),
    isTTY: o.tty ?? false,
    ask: async () => answers.shift() ?? "",
    askHidden: async () => "",
    readStdin: async () => "",
    env: o.env ?? {},
    now: () => Date.UTC(2026, 10, 5, 12),
  };
  return { io, text: () => lines.join("\n") };
}

// biome-ignore lint/suspicious/noExplicitAny: untyped JSON
const raw = (): any =>
  existsSync(paths().configFile) ? JSON.parse(readFileSync(paths().configFile, "utf8")) : {};
const writeGlobal = (o: unknown) => writeFileSync(paths().configFile, JSON.stringify(o));
const run = (args: string[], io: Io) => adjudicatorCommand(args, ctx, { io, db });

describe("features status", () => {
  it("lists every feature as off by default", async () => {
    const t = fakeIo();
    expect(await run(["features"], t.io)).toBe(0);
    for (const f of ["recall", "memory", "commit", "compaction", "swarm", "docs"])
      expect(t.text()).toContain(f);
    expect(t.text()).toContain("all off");
  });

  it("shows shadow and live for a local provider with no consent", () => {
    const cfg = ConfigSchema.parse({
      adjudicator: {
        enabled: true,
        provider: "embedding",
        features: { recall: { enabled: true }, memory: { enabled: true, shadow: false } },
      },
    });
    const rows = featureRows(cfg, {});
    expect(rows.find((r) => r.name === "recall")?.state).toBe("shadow");
    expect(rows.find((r) => r.name === "memory")?.state).toBe("live");
    expect(rows.find((r) => r.name === "docs")?.state).toBe("off");
    expect(rows[0]?.dataClass).toContain("none");
  });

  it("marks an enabled feature waiting when the adjudicator is off", () => {
    const cfg = ConfigSchema.parse({ adjudicator: { features: { docs: true } } });
    const row = featureRows(cfg, {}).find((r) => r.name === "docs");
    expect(row?.state).toBe("waiting");
  });

  it("EMINIAR_ADJUDICATOR_FEATURES=0 withdraws every feature", () => {
    const cfg = ConfigSchema.parse({
      adjudicator: { enabled: true, provider: "embedding", features: { recall: true } },
    });
    expect(featureRows(cfg, { EMINIAR_ADJUDICATOR_FEATURES: "0" })[0]?.state).toBe("waiting");
  });
});

describe("features on/off/shadow", () => {
  it("turns a feature on in shadow mode without consent on a local provider", async () => {
    writeGlobal({ adjudicator: { enabled: true, provider: "embedding" } });
    const t = fakeIo();
    expect(await run(["features", "on", "recall"], t.io)).toBe(0);
    expect(raw().adjudicator.features.recall).toEqual({ enabled: true });
    expect(raw().adjudicator.featureConsent).toBeUndefined();
    expect(t.text()).toContain("no consent is needed");
  });

  it("shadow off makes it live, shadow on records only, off disables it", async () => {
    writeGlobal({ adjudicator: { enabled: true, provider: "embedding" } });
    await run(["features", "on", "memory"], fakeIo().io);
    await run(["features", "shadow", "memory", "off"], fakeIo().io);
    expect(raw().adjudicator.features.memory.shadow).toBe(false);
    await run(["features", "shadow", "memory", "on"], fakeIo().io);
    expect(raw().adjudicator.features.memory.shadow).toBe(true);
    await run(["features", "off", "memory"], fakeIo().io);
    expect(raw().adjudicator.features.memory.enabled).toBe(false);
  });

  it("rejects an unknown feature, a bad shadow value and --project", async () => {
    expect(await run(["features", "on", "nope"], fakeIo().io)).toBe(2);
    expect(await run(["features", "shadow", "docs", "maybe"], fakeIo().io)).toBe(2);
    const t = fakeIo();
    expect(
      await adjudicatorCommand(["features", "on", "docs", "--project"], ctx, { io: t.io, db }),
    ).toBe(2);
  });

  it("asks per data class on a remote provider and records the consent entry", async () => {
    writeGlobal({
      adjudicator: { enabled: true, provider: "typesafe", remoteConsent: true },
    });
    const env = { TYPESAFE_API_KEY: "sk-featcli-0123456789abcdef" } as NodeJS.ProcessEnv;
    const refused = fakeIo({ env });
    expect(await run(["features", "on", "commit"], refused.io)).toBe(1);
    expect(raw().adjudicator.features).toBeUndefined();

    const t = fakeIo({ env, tty: true, answers: ["y"] });
    expect(await run(["features", "on", "commit"], t.io)).toBe(0);
    expect(t.text()).toContain("staged diff");
    expect(raw().adjudicator.featureConsent).toEqual(["diffs@https://api.typesafe.ai"]);
    expect(raw().adjudicator.features.commit.enabled).toBe(true);
  });
});
