/**
 * `eminiar adjudicator exchanges [status|on|off|purge]` (src/adjudicator/cli.ts; task #186 / X8,
 * design blackboard design-xchg-3 section 7). A temp EMINIAR_HOME, a real SQLite file, a scripted
 * terminal. Capture is a personal setting that stores redacted prompt text, so: `on` refuses
 * --project and an untrusted personal file, asks y/N (--yes without a terminal), merges into the
 * existing privacy settings; `off` and `purge` delete this project's rows only.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  adjudicatorCommand,
  type CliDeps,
  type Io,
  writeAdjudicatorPatch,
} from "../../src/adjudicator/cli.js";
import { resetSecrets } from "../../src/adjudicator/secrets.js";
import { ConfigSchema, loadConfig } from "../../src/config.js";
import type { ProjectContext } from "../../src/context.js";
import { paths } from "../../src/paths.js";
import type { StorageAdapter } from "../../src/storage/adapter.js";
import { SqliteAdapter } from "../../src/storage/sqlite/adapter.js";
import type { ExchangeInput } from "../../src/storage/types.js";

const KEY = "sk-XCHGSENTINEL0123456789abcdef";
const ENV_KEYS = [
  "EMINIAR_HOME",
  "EMINIAR_ADJUDICATOR",
  "EMINIAR_ADJUDICATOR_PROVIDER",
  "EMINIAR_ADJUDICATOR_MODE",
  "EMINIAR_ADJUDICATOR_REMOTE",
  "EMINIAR_ADJUDICATOR_CAPTURE",
];

let home: string;
let root: string;
let db: SqliteAdapter;
let ctx: ProjectContext;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "em-xchgcli-home-"));
  root = mkdtempSync(join(tmpdir(), "em-xchgcli-root-"));
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

/** A scripted terminal; every line is recorded. */
function fakeIo(o: { tty?: boolean; answers?: string[]; env?: NodeJS.ProcessEnv } = {}) {
  const lines: string[] = [];
  const answers = [...(o.answers ?? [])];
  const io: Io = {
    out: (l) => lines.push(l),
    err: (l) => lines.push(`ERR ${l}`),
    isTTY: o.tty ?? false,
    ask: async (q) => {
      const a = answers.shift() ?? "";
      lines.push(`${q}${a}`);
      return a;
    },
    askHidden: async (q) => {
      lines.push(`${q}[hidden]`);
      return "";
    },
    readStdin: async () => "",
    env: o.env ?? {},
    now: () => Date.UTC(2026, 10, 4, 12),
  };
  return { io, lines, text: () => lines.join("\n") };
}

// biome-ignore lint/suspicious/noExplicitAny: the tests read untyped JSON
type Json = any;

const configFile = () => paths().configFile;
const globalRaw = (): Record<string, Json> =>
  existsSync(configFile())
    ? (JSON.parse(readFileSync(configFile(), "utf8")) as Record<string, Json>)
    : {};
const writeGlobal = (o: unknown) => writeFileSync(configFile(), JSON.stringify(o));

async function run(args: string[], io: Io, extra: Partial<CliDeps> = {}): Promise<number> {
  return adjudicatorCommand(args, ctx, { io, db, ...extra });
}

function seed(n: number): void {
  const xs: ExchangeInput[] = Array.from({ length: n }, (_, i) => ({
    ts: Date.UTC(2026, 10, 4, 11, i),
    callId: `c${i}`,
    provider: "typesafe",
    method: "POST",
    target: "api.typesafe.ai/v1/systemone",
    items: 1,
    outcome: "ok",
    deadlineMs: 800,
    requestBody: '{"state":{"items":[{"text":"PLUGH-prompt-text"}]}}',
    requestBytes: 50,
  }));
  db.adjudicator.exchangeInsert(xs);
}

const count = () => db.adjudicator.exchangeCount();

/** Everything a run printed, scanned for what must never be there. */
function expectClean(...texts: string[]): void {
  for (const t of texts) {
    expect(t).not.toContain(KEY);
    expect(t).not.toContain("PLUGH-prompt-text");
    expect(t.toLowerCase()).not.toContain("authorization");
  }
}

// ---------------------------------------------------------------------------------------------

describe("exchanges status", () => {
  it("off by default: says so, with the count of stored requests and how to turn it on", async () => {
    const t = fakeIo();
    expect(await run(["exchanges"], t.io)).toBe(0);
    expect(t.text()).toContain("capture: off");
    expect(t.text()).toContain("stored here: 0 of 100");
    expect(t.text()).toContain("eminiar adjudicator exchanges on");
    expect(t.text()).toContain("db ");
    const t2 = fakeIo();
    expect(await run(["exchanges", "status"], t2.io)).toBe(0);
    expect(t2.text()).toContain("capture: off");
  });

  it("on with rows: the count, the newest time", async () => {
    writeGlobal({ adjudicator: { privacy: { captureExchanges: true } } });
    seed(3);
    const t = fakeIo();
    expect(await run(["exchanges", "status"], t.io)).toBe(0);
    expect(t.text()).toContain("capture: on");
    expect(t.text()).toContain("stored here: 3 of 100");
    expect(t.text()).toContain("newest 2026-11-04T11:02:00.000Z");
    expect(t.text()).not.toContain("turn it on");
  });

  it("--json is machine-readable", async () => {
    writeGlobal({ adjudicator: { privacy: { captureExchanges: true } } });
    seed(2);
    const t = fakeIo();
    expect(await run(["exchanges", "status", "--json"], t.io)).toBe(0);
    const j = JSON.parse(t.lines.join("\n")) as Json;
    expect(j).toMatchObject({ on: true, forcedOff: false, personal: true, keep: 100, stored: 2 });
    expect(j.db).toBe(ctx.dbPath);
  });

  it("EMINIAR_ADJUDICATOR_CAPTURE=0 shows it forced off while the personal setting stays on", async () => {
    writeGlobal({ adjudicator: { privacy: { captureExchanges: true } } });
    process.env.EMINIAR_ADJUDICATOR_CAPTURE = "0";
    const t = fakeIo({ env: { EMINIAR_ADJUDICATOR_CAPTURE: "0" } });
    expect(await run(["exchanges", "status", "--json"], t.io)).toBe(0);
    expect(JSON.parse(t.lines.join("\n"))).toMatchObject({
      on: false,
      forcedOff: true,
      personal: true,
    });
    const t2 = fakeIo({ env: { EMINIAR_ADJUDICATOR_CAPTURE: "0" } });
    await run(["exchanges"], t2.io);
    expect(t2.text()).toContain("capture: off");
    expect(t2.text()).toContain("EMINIAR_ADJUDICATOR_CAPTURE=0 is forcing it off");
  });

  it("the adjudicator status line mentions capture once Jev is the provider or capture is on", async () => {
    writeGlobal({
      adjudicator: {
        enabled: true,
        provider: "typesafe",
        remoteConsent: true,
        privacy: { captureExchanges: true },
      },
    });
    seed(4);
    const t = fakeIo();
    expect(await run(["status"], t.io)).toBe(0);
    expect(t.text()).toContain("jev request capture: on · 4 stored (newest 100 kept)");
  });

  it("an unknown subcommand is a usage error", async () => {
    const t = fakeIo();
    expect(await run(["exchanges", "bogus"], t.io)).toBe(2);
    expect(t.text()).toContain("unknown exchanges command: bogus");
  });
});

describe("exchanges on", () => {
  it("--project is refused: nothing is written", async () => {
    const t = fakeIo();
    expect(await run(["exchanges", "on", "--project", "--yes"], t.io)).toBe(2);
    expect(t.text()).toContain("personal setting");
    expect(existsSync(configFile())).toBe(false);
    expect(existsSync(join(root, "eminiar.config.json"))).toBe(false);
    // The same for off and purge.
    seed(1);
    for (const sub of ["off", "purge"]) {
      const t2 = fakeIo();
      expect(await run(["exchanges", sub, "--project", "--yes"], t2.io)).toBe(2);
    }
    expect(count()).toBe(1);
  });

  it("a personal config inside the project is refused", async () => {
    process.env.EMINIAR_HOME = join(root, ".em");
    mkdirSync(process.env.EMINIAR_HOME, { recursive: true });
    const t = fakeIo();
    expect(await run(["exchanges", "on", "--yes"], t.io)).toBe(2);
    expect(t.text()).toContain("inside this project");
    expect(existsSync(configFile())).toBe(false);
  });

  it("without a terminal it needs --yes: exit 1 and nothing is written", async () => {
    const t = fakeIo({ tty: false });
    expect(await run(["exchanges", "on"], t.io)).toBe(1);
    expect(t.text()).toContain("pass --yes");
    expect(t.text()).toContain("Nothing was changed");
    expect(existsSync(configFile())).toBe(false);
  });

  it("with a terminal it asks y/N: no, empty and anything else mean no", async () => {
    for (const answer of ["n", "", "no", "maybe"]) {
      const t = fakeIo({ tty: true, answers: [answer] });
      expect(await run(["exchanges", "on"], t.io)).toBe(0);
      expect(t.text()).toContain("Turn on? [y/N]");
      expect(t.text()).toContain("Nothing was changed");
      expect(existsSync(configFile())).toBe(false);
    }
  });

  it("with a terminal, y turns it on; the notice names what is kept, where, and the 100 limit", async () => {
    const t = fakeIo({ tty: true, answers: ["y"] });
    expect(await run(["exchanges", "on"], t.io)).toBe(0);
    expect(globalRaw().adjudicator.privacy.captureExchanges).toBe(true);
    expect(t.text()).toContain("redacted");
    expect(t.text()).toContain("api.typesafe.ai");
    expect(t.text()).toContain("up to 2000 chars per item");
    expect(t.text()).toContain("Only the newest 100 are kept");
    expect(t.text()).toContain("exchanges purge");
    expect(t.text()).toContain("Jev request capture is on");
    expect(loadConfig(root).adjudicator.privacy.captureExchanges).toBe(true);
  });

  it("--yes writes only privacy.captureExchanges and keeps maxChars, storeHead and everything else", async () => {
    writeGlobal({
      routing: { mode: "auto" },
      adjudicator: {
        enabled: true,
        provider: "typesafe",
        remoteConsent: true,
        privacy: { maxChars: 500, storeHead: false },
      },
    });
    const t = fakeIo();
    expect(await run(["exchanges", "on", "--yes"], t.io)).toBe(0);
    const raw = globalRaw();
    expect(raw.routing).toEqual({ mode: "auto" });
    expect(raw.adjudicator).toEqual({
      enabled: true,
      provider: "typesafe",
      remoteConsent: true,
      privacy: { maxChars: 500, storeHead: false, captureExchanges: true },
    });
    expect(t.text()).toContain("up to 500 chars per item");
    const cfg = loadConfig(root).adjudicator.privacy;
    expect(cfg).toEqual({ maxChars: 500, storeHead: false, captureExchanges: true });
    // Nothing was written to the project.
    expect(existsSync(join(root, "eminiar.config.json"))).toBe(false);
  });

  it("is idempotent", async () => {
    for (let i = 0; i < 2; i++)
      expect(await run(["exchanges", "on", "--yes"], fakeIo().io)).toBe(0);
    expect(globalRaw()).toEqual({ adjudicator: { privacy: { captureExchanges: true } } });
  });

  it("warns, but does not refuse, when Jev is not the provider yet", async () => {
    const t = fakeIo();
    expect(await run(["exchanges", "on", "--yes"], t.io)).toBe(0);
    expect(t.text()).toContain("nothing is captured until Jev is the provider");
    writeGlobal({ adjudicator: { enabled: true, provider: "typesafe", remoteConsent: true } });
    const t2 = fakeIo();
    expect(await run(["exchanges", "on", "--yes"], t2.io)).toBe(0);
    expect(t2.text()).not.toContain("nothing is captured until");
  });

  it("warns when EMINIAR_ADJUDICATOR_CAPTURE=0 keeps it off", async () => {
    const t = fakeIo({ env: { EMINIAR_ADJUDICATOR_CAPTURE: "0" } });
    process.env.EMINIAR_ADJUDICATOR_CAPTURE = "0";
    expect(await run(["exchanges", "on", "--yes"], t.io)).toBe(0);
    expect(t.text()).toContain("EMINIAR_ADJUDICATOR_CAPTURE=0 is set in this shell");
    expect(loadConfig(root).adjudicator.privacy.captureExchanges).toBe(false);
  });

  it("will not write a key into the config even if one is asked of the patch", () => {
    expect(() =>
      writeAdjudicatorPatch(configFile(), { privacy: { captureExchanges: true, apiKey: KEY } }),
    ).toThrow(/must not hold keys/);
    expect(existsSync(configFile()) ? readFileSync(configFile(), "utf8") : "").not.toContain(KEY);
  });
});

describe("exchanges off", () => {
  it("writes false and deletes this project's captured requests, and says how many", async () => {
    writeGlobal({ adjudicator: { privacy: { captureExchanges: true, maxChars: 900 } } });
    seed(3);
    const t = fakeIo();
    expect(await run(["exchanges", "off"], t.io)).toBe(0);
    expect(globalRaw().adjudicator.privacy).toEqual({ captureExchanges: false, maxChars: 900 });
    expect(count()).toBe(0);
    expect(t.text()).toContain("deleted 3 captured requests here");
    expect(t.text()).toContain("Other projects keep theirs");
    expect(loadConfig(root).adjudicator.privacy.captureExchanges).toBe(false);
  });

  it("needs no confirmation, uses the singular, and works with nothing stored", async () => {
    seed(1);
    const t = fakeIo({ tty: false });
    expect(await run(["exchanges", "off"], t.io)).toBe(0);
    expect(t.text()).toContain("deleted 1 captured request here");
    const t2 = fakeIo();
    expect(await run(["exchanges", "off"], t2.io)).toBe(0);
    expect(t2.text()).toContain("deleted 0 captured requests here");
    expect(globalRaw().adjudicator.privacy.captureExchanges).toBe(false);
  });

  it("when the database cannot be read the setting is still off and the retry command is named", async () => {
    writeGlobal({ adjudicator: { privacy: { captureExchanges: true } } });
    const broken = {
      adjudicator: {
        exchangePurge: () => {
          throw new Error("database is locked");
        },
      },
    } as unknown as StorageAdapter;
    const t = fakeIo();
    expect(await run(["exchanges", "off"], t.io, { db: broken })).toBe(1);
    expect(globalRaw().adjudicator.privacy.captureExchanges).toBe(false);
    expect(t.text()).toContain("exchanges purge --yes");
  });
});

describe("exchanges purge", () => {
  beforeEach(() => writeGlobal({ adjudicator: { privacy: { captureExchanges: true } } }));

  it("without a terminal it needs --yes: exit 1, nothing deleted", async () => {
    seed(2);
    const t = fakeIo({ tty: false });
    expect(await run(["exchanges", "purge"], t.io)).toBe(1);
    expect(t.text()).toContain("pass --yes");
    expect(count()).toBe(2);
  });

  it("with a terminal it asks y/N and names the count; n deletes nothing", async () => {
    seed(2);
    const t = fakeIo({ tty: true, answers: ["n"] });
    expect(await run(["exchanges", "purge"], t.io)).toBe(0);
    expect(t.text()).toContain("Delete 2 captured requests from this project? [y/N]");
    expect(t.text()).toContain("Nothing was deleted");
    expect(count()).toBe(2);
    const t2 = fakeIo({ tty: true, answers: ["yes"] });
    expect(await run(["exchanges", "purge"], t2.io)).toBe(0);
    expect(count()).toBe(0);
  });

  it("--yes deletes the rows and leaves the setting as it was", async () => {
    seed(5);
    const before = readFileSync(configFile(), "utf8");
    const t = fakeIo();
    expect(await run(["exchanges", "purge", "--yes"], t.io)).toBe(0);
    expect(count()).toBe(0);
    expect(t.text()).toContain("Deleted 5 captured requests");
    expect(t.text()).toContain("capture setting is unchanged");
    expect(readFileSync(configFile(), "utf8")).toBe(before);
    expect(loadConfig(root).adjudicator.privacy.captureExchanges).toBe(true);
  });

  it("with nothing stored it says so and succeeds", async () => {
    const t = fakeIo();
    expect(await run(["exchanges", "purge"], t.io)).toBe(0);
    expect(t.text()).toContain("No captured requests in this project");
  });

  it("deletes only this project's database: another project's rows are untouched", async () => {
    seed(2);
    const other = new SqliteAdapter(join(root, "other.sqlite"), { vectors: false });
    try {
      other.adjudicator.exchangeInsert([
        {
          ts: 1,
          callId: "o",
          provider: "typesafe",
          method: "POST",
          target: "x/y",
          items: 1,
          outcome: "ok",
          deadlineMs: 1,
          requestBody: "{}",
          requestBytes: 2,
        },
      ]);
      expect(await run(["exchanges", "purge", "--yes"], fakeIo().io)).toBe(0);
      expect(count()).toBe(0);
      expect(other.adjudicator.exchangeCount()).toBe(1);
    } finally {
      other.close();
    }
  });
});

describe("no key, header or prompt text in any output", () => {
  it("across status, on, off and purge, with a key in the key file, the env and the db", async () => {
    writeFileSync(paths().adjudicatorKey, JSON.stringify({ typesafe: KEY }), { mode: 0o600 });
    resetSecrets();
    const env = { TYPESAFE_API_KEY: KEY, EMINIAR_ADJUDICATOR_KEY: KEY } as NodeJS.ProcessEnv;
    seed(2);
    const outs: string[] = [];
    for (const args of [
      ["exchanges"],
      ["exchanges", "status", "--json"],
      ["exchanges", "on", "--yes"],
      ["exchanges", "status"],
      ["status"],
      ["exchanges", "purge", "--yes"],
      ["exchanges", "off"],
      ["exchanges", "on"],
      ["exchanges", "purge"],
    ]) {
      const t = fakeIo({ env });
      await run(args, t.io);
      outs.push(t.text());
    }
    expectClean(...outs);
    expect(readFileSync(configFile(), "utf8")).not.toContain(KEY);
  });
});

describe("`adjudicator test` never captures", () => {
  it("with capture on, a Jev test call writes and reads no exchange", async () => {
    writeGlobal({
      adjudicator: {
        enabled: true,
        provider: "typesafe",
        remoteConsent: true,
        privacy: { captureExchanges: true },
      },
    });
    const calls: string[] = [];
    const fetchStub = async (url: string, init: RequestInit) => {
      calls.push(`${init.method} ${url}`);
      if (init.method === "GET") return new Response(JSON.stringify({ data: [] }), { status: 200 });
      const body = JSON.parse(String(init.body)) as Json;
      const answers: Record<string, unknown> = {};
      for (const [id, q] of Object.entries(body.questions as Record<string, Json>)) {
        if (q.type === "score")
          answers[id] = {
            type: "score",
            score: 2,
            confidence: 0.8,
            legend: { "0": "a", "1": "b", "2": "c", "3": "d", "4": "e" },
          };
        else if (q.type === "noul") answers[id] = { type: "noul", noul: 0.2 };
        else {
          const opts = Object.keys(q.criteria as object);
          answers[id] = {
            type: "choice",
            choice: opts[0],
            confidence: 0.7,
            probabilities: { [opts[0] as string]: 1 },
          };
        }
      }
      return new Response(JSON.stringify({ model: "jev-1.14.0", answers }), { status: 200 });
    };
    const env = { TYPESAFE_API_KEY: KEY } as NodeJS.ProcessEnv;
    const t = fakeIo({ env });
    const tripwired = new Proxy(db, {
      get(target, k, rcv) {
        const v = Reflect.get(target, k, rcv);
        if (k !== "adjudicator") return typeof v === "function" ? v.bind(target) : v;
        return new Proxy(v as object, {
          get(a, ak, arcv) {
            if (typeof ak === "string" && ak.startsWith("exchange"))
              throw new Error(`touched ${ak}`);
            const av = Reflect.get(a, ak, arcv);
            return typeof av === "function" ? av.bind(a) : av;
          },
        });
      },
    }) as StorageAdapter;
    const code = await run(["test", "refactor the storage layer across every adapter"], t.io, {
      db: tripwired,
      providerDeps: { fetch: fetchStub as never, env },
    });
    expect(code).toBe(0);
    expect(calls.some((c) => c.startsWith("POST") && c.includes("/systemone"))).toBe(true);
    expect(count()).toBe(0);
    expectClean(t.text());
  });
});
