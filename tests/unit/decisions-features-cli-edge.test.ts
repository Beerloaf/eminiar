/**
 * `eminiar adjudicator features ...`, the gaps the base file leaves: consent per data class
 * (accumulating, never duplicated, declined, refused without a terminal), local providers needing
 * none, the personal-only refusal of --project, purge with and without a yes, the JSON status, and
 * that no key ever lands in the config file.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adjudicatorCommand, featureRows, type Io } from "../../src/adjudicator/cli.js";
import { resetSecrets } from "../../src/adjudicator/secrets.js";
import { ConfigSchema } from "../../src/config.js";
import type { ProjectContext } from "../../src/context.js";
import { DATA_CLASS } from "../../src/decisions/consent.js";
import { DECISION_FEATURES } from "../../src/decisions/types.js";
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
const KEY = "sk-featedge-0123456789abcdef";
const REMOTE_ENV = { TYPESAFE_API_KEY: KEY } as NodeJS.ProcessEnv;

let home: string;
let root: string;
let db: SqliteAdapter;
let ctx: ProjectContext;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "em-fce-home-"));
  root = mkdtempSync(join(tmpdir(), "em-fce-root-"));
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
  const asked: string[] = [];
  const io: Io = {
    out: (l) => lines.push(l),
    err: (l) => lines.push(`ERR ${l}`),
    isTTY: o.tty ?? false,
    ask: async (q) => {
      asked.push(q);
      return answers.shift() ?? "";
    },
    askHidden: async () => "",
    readStdin: async () => "",
    env: o.env ?? {},
    now: () => Date.UTC(2026, 10, 5, 12),
  };
  return { io, text: () => lines.join("\n"), asked };
}

// biome-ignore lint/suspicious/noExplicitAny: untyped JSON
const raw = (): any =>
  existsSync(paths().configFile) ? JSON.parse(readFileSync(paths().configFile, "utf8")) : {};
const rawText = () =>
  existsSync(paths().configFile) ? readFileSync(paths().configFile, "utf8") : "";
const writeGlobal = (o: unknown) => writeFileSync(paths().configFile, JSON.stringify(o));
const run = (args: string[], io: Io) => adjudicatorCommand(args, ctx, { io, db });
const remote = () =>
  writeGlobal({ adjudicator: { enabled: true, provider: "typesafe", remoteConsent: true } });

describe("consent per data class on a remote provider", () => {
  it("every feature shows its own consent line and records its class at the origin", async () => {
    remote();
    for (const f of DECISION_FEATURES) {
      const t = fakeIo({ env: REMOTE_ENV });
      expect(await run(["features", "on", f, "--yes"], t.io), f).toBe(0);
      expect(t.text()).toContain(ORIGIN);
      expect(t.text()).toContain(`wrote`);
      expect(raw().adjudicator.features[f].enabled).toBe(true);
      expect(raw().adjudicator.featureConsent).toContain(`${DATA_CLASS[f]}@${ORIGIN}`);
    }
    const classes = new Set(DECISION_FEATURES.map((f) => DATA_CLASS[f]));
    expect(raw().adjudicator.featureConsent).toHaveLength(classes.size);
  });

  it("a second on never duplicates the entry; recall and memory share one class", async () => {
    remote();
    await run(["features", "on", "recall", "--yes"], fakeIo({ env: REMOTE_ENV }).io);
    await run(["features", "on", "recall", "--yes"], fakeIo({ env: REMOTE_ENV }).io);
    await run(["features", "on", "memory", "--yes"], fakeIo({ env: REMOTE_ENV }).io);
    expect(raw().adjudicator.featureConsent).toEqual([`memory@${ORIGIN}`]);
  });

  it("asks once in a terminal, and 'n' or an empty answer changes nothing", async () => {
    remote();
    const before = rawText();
    for (const answer of ["n", "", "no"]) {
      const t = fakeIo({ env: REMOTE_ENV, tty: true, answers: [answer] });
      expect(await run(["features", "on", "commit"], t.io)).toBe(0);
      expect(t.asked).toHaveLength(1);
      expect(t.text()).toContain("Nothing was changed");
    }
    expect(rawText()).toBe(before);
  });

  it("without a terminal and without --yes it refuses and writes nothing", async () => {
    remote();
    const before = rawText();
    const t = fakeIo({ env: REMOTE_ENV });
    expect(await run(["features", "on", "docs"], t.io)).toBe(1);
    expect(t.text()).toContain("needs a yes");
    expect(rawText()).toBe(before);
  });

  it("--yes works without a terminal", async () => {
    remote();
    const t = fakeIo({ env: REMOTE_ENV });
    expect(await run(["features", "on", "docs", "--yes"], t.io)).toBe(0);
    expect(raw().adjudicator.featureConsent).toEqual([`packages@${ORIGIN}`]);
  });

  it("never writes the key, or any environment value, into the config", async () => {
    remote();
    await run(["features", "on", "commit", "--yes"], fakeIo({ env: REMOTE_ENV }).io);
    await run(["features", "shadow", "commit", "off"], fakeIo({ env: REMOTE_ENV }).io);
    expect(rawText()).not.toContain(KEY);
    expect(rawText()).not.toMatch(/sk-|TYPESAFE_API_KEY/);
  });

  it("off keeps the consent and turns only the feature off", async () => {
    remote();
    await run(["features", "on", "swarm", "--yes"], fakeIo({ env: REMOTE_ENV }).io);
    expect(await run(["features", "off", "swarm"], fakeIo().io)).toBe(0);
    expect(raw().adjudicator.features.swarm.enabled).toBe(false);
    expect(raw().adjudicator.featureConsent).toEqual([`swarm@${ORIGIN}`]);
  });

  it("status tells a missing consent from a given one", async () => {
    remote();
    writeGlobal({
      adjudicator: {
        enabled: true,
        provider: "typesafe",
        remoteConsent: true,
        remoteConsentOrigins: [ORIGIN],
        features: { commit: { enabled: true }, docs: { enabled: true } },
        featureConsent: [`diffs@${ORIGIN}`],
      },
    });
    const t = fakeIo({ env: REMOTE_ENV });
    expect(await run(["features"], t.io)).toBe(0);
    const lines = t.text().split("\n");
    expect(lines.find((l) => l.includes("commit"))).toMatch(/consent given/);
    expect(lines.find((l) => l.includes("docs"))).toMatch(/waiting/);
    expect(lines.find((l) => l.includes("docs"))).toMatch(/consent missing/);
  });

  it("consent for another origin does not count; the environment cannot grant a missing one", () => {
    const cfg = ConfigSchema.parse({
      adjudicator: {
        enabled: true,
        provider: "typesafe",
        remoteConsent: true,
        remoteConsentOrigins: [ORIGIN],
        features: { commit: true },
        featureConsent: ["diffs@https://elsewhere.example.test"],
      },
    });
    const env = { ...REMOTE_ENV, EMINIAR_ADJUDICATOR_FEATURES: "1" };
    expect(featureRows(cfg, env).find((r) => r.name === "commit")?.state).toBe("waiting");
  });
});

describe("local providers need no consent", () => {
  it.each([
    ["embedding", { provider: "embedding" }],
    ["a loopback Ollama", { provider: "openai-compatible", openai: { preset: "ollama" } }],
  ])("%s: on works without a terminal and records no consent", async (_n, a) => {
    writeGlobal({ adjudicator: { enabled: true, ...a } });
    for (const f of DECISION_FEATURES) {
      const t = fakeIo();
      expect(await run(["features", "on", f], t.io), f).toBe(0);
      expect(t.text()).toContain("no consent is needed");
      expect(t.asked).toHaveLength(0);
    }
    expect(raw().adjudicator.featureConsent).toBeUndefined();
  });

  it("status shows 'none (local provider)' for every feature", async () => {
    writeGlobal({ adjudicator: { enabled: true, provider: "embedding" } });
    const t = fakeIo();
    await run(["features"], t.io);
    expect(t.text().match(/none \(local provider\)/g)).toHaveLength(DECISION_FEATURES.length);
  });
});

describe("--project and bad input", () => {
  it.each([
    ["on", ["features", "on", "docs", "--project"]],
    ["off", ["features", "off", "docs", "--project"]],
    ["shadow", ["features", "shadow", "docs", "off", "--project"]],
  ])("%s --project is refused and writes no file", async (_n, args) => {
    writeGlobal({ adjudicator: { enabled: true, provider: "embedding" } });
    const before = rawText();
    const t = fakeIo();
    expect(await run(args, t.io)).toBe(2);
    expect(t.text()).toContain("personal setting");
    expect(rawText()).toBe(before);
    expect(existsSync(join(root, "eminiar.config.json"))).toBe(false);
  });

  it("an unknown action, a missing name and a missing shadow value exit 2 and change nothing", async () => {
    writeGlobal({ adjudicator: { enabled: true, provider: "embedding" } });
    const before = rawText();
    expect(await run(["features", "frobnicate"], fakeIo().io)).toBe(2);
    expect(await run(["features", "on"], fakeIo().io)).toBe(2);
    expect(await run(["features", "off", "Recall"], fakeIo().io)).toBe(2);
    expect(await run(["features", "shadow", "docs"], fakeIo().io)).toBe(2);
    expect(rawText()).toBe(before);
  });

  it("on with the adjudicator off writes the setting and says it is not running yet", async () => {
    writeGlobal({ adjudicator: { enabled: false, provider: "embedding" } });
    const t = fakeIo();
    expect(await run(["features", "on", "recall"], t.io)).toBe(0);
    expect(raw().adjudicator.features.recall.enabled).toBe(true);
    expect(t.text()).toMatch(/not running yet/);
  });

  it("on in shadow mode by default: the feature is not live until shadow is turned off", async () => {
    writeGlobal({ adjudicator: { enabled: true, provider: "embedding" } });
    await run(["features", "on", "swarm"], fakeIo().io);
    const cfg = ConfigSchema.parse({ adjudicator: raw().adjudicator });
    expect(featureRows(cfg, {}).find((r) => r.name === "swarm")?.state).toBe("shadow");
    await run(["features", "shadow", "swarm", "off"], fakeIo().io);
    const cfg2 = ConfigSchema.parse({ adjudicator: raw().adjudicator });
    expect(featureRows(cfg2, {}).find((r) => r.name === "swarm")?.state).toBe("live");
  });
});

describe("status --json", () => {
  it("is parseable, lists every feature, and carries no key", async () => {
    remote();
    await run(["features", "on", "commit", "--yes"], fakeIo({ env: REMOTE_ENV }).io);
    const t = fakeIo({ env: REMOTE_ENV });
    expect(await run(["features", "status", "--json"], t.io)).toBe(0);
    const j = JSON.parse(t.text()) as {
      provider: string;
      remote: boolean;
      origin: string | null;
      features: Array<{ name: string; state: string; consented: boolean }>;
    };
    expect(j.provider).toBe("typesafe");
    expect(j.remote).toBe(true);
    expect(j.origin).toBe(ORIGIN);
    expect(j.features.map((f) => f.name)).toEqual([...DECISION_FEATURES]);
    expect(j.features.find((f) => f.name === "commit")).toMatchObject({
      state: "shadow",
      consented: true,
    });
    expect(t.text()).not.toContain(KEY);
  });
});

describe("purge", () => {
  const seed = () => {
    db.decisions.insertCall({
      ts: Date.now(),
      feature: "docs",
      context: "server",
      subject: "docs:x",
      mode: "shadow",
      status: "ok",
    });
    db.decisions.cachePut("k1", "docs", { a: 1 }, Date.now());
  };
  const count = (t: string) =>
    (db.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;

  it("refuses without a terminal or --yes, and keeps the data", async () => {
    seed();
    const t = fakeIo();
    expect(await run(["features", "purge"], t.io)).toBe(1);
    expect(t.text()).toContain("needs a yes");
    expect(count("decision_calls")).toBe(1);
    expect(count("decision_cache")).toBe(1);
  });

  it("--yes deletes the calls and the cache", async () => {
    seed();
    expect(await run(["features", "purge", "--yes"], fakeIo().io)).toBe(0);
    expect(count("decision_calls")).toBe(0);
    expect(count("decision_cache")).toBe(0);
  });

  it("in a terminal, 'n' keeps and 'y' deletes", async () => {
    seed();
    const no = fakeIo({ tty: true, answers: ["n"] });
    expect(await run(["features", "purge"], no.io)).toBe(0);
    expect(no.text()).toContain("Nothing was deleted");
    expect(count("decision_calls")).toBe(1);
    const yes = fakeIo({ tty: true, answers: ["y"] });
    expect(await run(["features", "purge"], yes.io)).toBe(0);
    expect(count("decision_calls")).toBe(0);
  });

  it("purging an empty store is fine and leaves the config alone", async () => {
    writeGlobal({
      adjudicator: { enabled: true, provider: "embedding", features: { docs: true } },
    });
    const before = rawText();
    expect(await run(["features", "purge", "--yes"], fakeIo().io)).toBe(0);
    expect(rawText()).toBe(before);
  });
});
