import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { keyFingerprint } from "../../src/adjudicator/breaker.js";
import {
  adjudicatorCommand,
  adjudicatorDoctorChecks,
  adjudicatorLiveChecks,
  type CliDeps,
  detectLocal,
  type Io,
  keyIdFor,
  parseChoice,
  remoteNotice,
  setupAdjudicator,
  writeAdjudicatorPatch,
} from "../../src/adjudicator/cli.js";
import { resolveAdjudicator } from "../../src/adjudicator/config.js";
import { resetSecrets } from "../../src/adjudicator/secrets.js";
import type { AdjudicatorProvider, ProviderResult } from "../../src/adjudicator/types.js";
import { ConfigSchema, loadConfig } from "../../src/config.js";
import type { ProjectContext } from "../../src/context.js";
import { runDoctor } from "../../src/doctor.js";
import { frozenDefaults } from "../../src/install/install.js";
import { paths } from "../../src/paths.js";
import { SqliteAdapter } from "../../src/storage/sqlite/adapter.js";

const SENTINEL = "sk-SENTINEL-adjudicator-key-Zq9X";
const ENV_KEYS = [
  "EMINIAR_HOME",
  "EMINIAR_ADJUDICATOR",
  "EMINIAR_ADJUDICATOR_PROVIDER",
  "EMINIAR_ADJUDICATOR_MODE",
  "EMINIAR_ADJUDICATOR_REMOTE",
];

let home: string;
let root: string;
let db: SqliteAdapter;
let ctx: ProjectContext;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "em-adjcli-home-"));
  root = mkdtempSync(join(tmpdir(), "em-adjcli-root-"));
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

/** A scripted terminal: `answers` feed ask(), `hidden` feeds askHidden(); everything is recorded. */
function fakeIo(
  o: {
    tty?: boolean;
    answers?: string[];
    hidden?: string[];
    stdin?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  const lines: string[] = [];
  const answers = [...(o.answers ?? [])];
  const hidden = [...(o.hidden ?? [])];
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
      return hidden.shift() ?? "";
    },
    readStdin: async () => o.stdin ?? "",
    env: o.env ?? {},
    now: () => Date.UTC(2026, 10, 4, 12),
  };
  return { io, lines, text: () => lines.join("\n") };
}

// biome-ignore lint/suspicious/noExplicitAny: the tests read untyped JSON
type Json = any;

const globalRaw = (): Record<string, Json> =>
  existsSync(paths().configFile)
    ? (JSON.parse(readFileSync(paths().configFile, "utf8")) as Record<string, Json>)
    : {};

async function run(args: string[], io: Io, extra: Partial<CliDeps> = {}) {
  return adjudicatorCommand(args, ctx, { io, db, ...extra });
}

describe("choices and config writes", () => {
  it("maps install/enable choices to providers and presets", () => {
    expect(parseChoice("jev")).toEqual({ provider: "typesafe" });
    expect(parseChoice("TypeSafe")).toEqual({ provider: "typesafe" });
    expect(parseChoice("ollama")).toEqual({ provider: "openai-compatible", preset: "ollama" });
    expect(parseChoice("embedding")).toEqual({ provider: "embedding" });
    expect(parseChoice("heuristic")).toEqual({ provider: "heuristic" });
    expect(parseChoice("nope")).toBeUndefined();
  });

  it("merges into the adjudicator section only, null deletes, and refuses secrets", () => {
    writeFileSync(paths().configFile, JSON.stringify({ routing: { mode: "auto" } }));
    writeAdjudicatorPatch(paths().configFile, {
      enabled: true,
      openai: { preset: "groq", model: "m" },
    });
    writeAdjudicatorPatch(paths().configFile, { openai: { model: null } });
    const raw = globalRaw();
    expect(raw.routing).toEqual({ mode: "auto" });
    expect(raw.adjudicator).toEqual({ enabled: true, openai: { preset: "groq" } });
    expect(() =>
      writeAdjudicatorPatch(paths().configFile, { openai: { apiKey: SENTINEL } }),
    ).toThrow(/must not hold keys/);
    expect(readFileSync(paths().configFile, "utf8")).not.toContain(SENTINEL);
  });

  it("install's frozen defaults leave the adjudicator section out", () => {
    const d = frozenDefaults();
    expect(d).not.toHaveProperty("adjudicator");
    expect(d).toHaveProperty("routing");
  });

  it("states exactly what leaves the machine", () => {
    const cfg = ConfigSchema.parse({ adjudicator: { provider: "typesafe" } }).adjudicator;
    const r = resolveAdjudicator(cfg, { context: "cli", env: {} });
    expect(remoteNotice(r, cfg)).toBe(
      "The text of your prompts and subagent tasks (redacted, at most 2000 chars) is sent to api.typesafe.ai to score them.",
    );
  });

  it("resolves key ids from provider names", () => {
    const r = resolveAdjudicator(ConfigSchema.parse({}).adjudicator, { context: "cli", env: {} });
    expect(keyIdFor("jev", r)).toBe("typesafe");
    expect(keyIdFor("groq", r)).toBe("openai:groq");
    expect(keyIdFor("openai:cerebras", r)).toBe("openai:cerebras");
    expect(keyIdFor(undefined, r)).toBeUndefined();
  });
});

describe("install / onboarding question", () => {
  it("--yes skips the question and writes nothing", async () => {
    const t = fakeIo({ tty: true, answers: ["y"] });
    const res = await setupAdjudicator(t.io, { yes: true });
    expect(res.enabled).toBe(false);
    expect(t.lines.some((l) => l.includes("[y/N]"))).toBe(false);
    expect(globalRaw().adjudicator).toBeUndefined();
  });

  it("defaults to No without a terminal", async () => {
    const t = fakeIo({ tty: false });
    const res = await setupAdjudicator(t.io, {});
    expect(res.enabled).toBe(false);
    expect(t.text()).toContain(
      "Use the adjudicator for tool, model and agent selection? [y/N] (non-interactive: no)",
    );
    expect(globalRaw().adjudicator).toBeUndefined();
  });

  it("Enter at the question means No", async () => {
    const t = fakeIo({ tty: true, answers: [""] });
    expect((await setupAdjudicator(t.io, {})).enabled).toBe(false);
    expect(globalRaw().adjudicator).toBeUndefined();
  });

  it("yes + heuristic writes enabled and the provider, no consent", async () => {
    const t = fakeIo({ tty: true, answers: ["y", ""] });
    const res = await setupAdjudicator(t.io, {});
    expect(res).toMatchObject({ enabled: true, provider: "heuristic", remote: false });
    expect(globalRaw().adjudicator).toEqual({ enabled: true, provider: "heuristic" });
  });

  it("yes + Jev asks consent, then stores the key from the hidden prompt in the 0600 key file", async () => {
    const t = fakeIo({ tty: true, answers: ["y", "3", "y"], hidden: [SENTINEL] });
    const res = await setupAdjudicator(t.io, {});
    expect(res).toMatchObject({
      enabled: true,
      provider: "typesafe",
      remote: true,
      keyStored: true,
    });
    expect(globalRaw().adjudicator).toEqual({
      enabled: true,
      provider: "typesafe",
      remoteConsent: true,
    });
    expect(readFileSync(paths().configFile, "utf8")).not.toContain(SENTINEL);
    const st = statSync(paths().adjudicatorKey);
    if (process.platform !== "win32") expect(st.mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(paths().adjudicatorKey, "utf8"))).toEqual({
      typesafe: SENTINEL,
    });
    const out = t.text();
    expect(out).toContain("is sent to api.typesafe.ai to score them.");
    expect(out).not.toContain(SENTINEL);
    expect(out).toContain("****Zq9X");
  });

  it("declining consent for a hosted preset keeps everything local", async () => {
    const t = fakeIo({ tty: true, answers: ["y", "4", "4", "n"] });
    const res = await setupAdjudicator(t.io, {});
    expect(res.provider).toBe("heuristic");
    expect(globalRaw().adjudicator).toEqual({ enabled: true, provider: "heuristic" });
    expect(existsSync(paths().adjudicatorKey)).toBe(false);
  });

  it("a local preset needs neither consent nor key", async () => {
    const t = fakeIo({ tty: true, answers: ["y", "4", ""] });
    const res = await setupAdjudicator(t.io, {});
    expect(res).toMatchObject({ provider: "openai-compatible", preset: "ollama", remote: false });
    expect(t.text()).not.toContain("is sent to");
    expect(t.lines.some((l) => l.includes("[hidden]"))).toBe(false);
  });

  it("--adjudicator=groq without a terminal needs --accept-remote; --yes never grants it", async () => {
    const t = fakeIo({ tty: false });
    await setupAdjudicator(t.io, { choice: "groq", yes: true });
    expect(globalRaw().adjudicator).toEqual({ enabled: true, provider: "heuristic" });
    const t2 = fakeIo({ tty: false });
    await setupAdjudicator(t2.io, { choice: "groq", acceptRemote: true });
    expect(globalRaw().adjudicator).toMatchObject({
      enabled: true,
      provider: "openai-compatible",
      openai: { preset: "groq" },
      remoteConsent: true,
    });
    expect(t2.text()).toContain("eminiar adjudicator key set groq");
  });

  it("does not ask again once the global config says on or off", async () => {
    writeAdjudicatorPatch(paths().configFile, { enabled: false });
    const t = fakeIo({ tty: true, answers: ["y"] });
    expect((await setupAdjudicator(t.io, {})).enabled).toBe(false);
    expect(t.text()).toContain("already configured");
  });
});

describe("eminiar adjudicator enable / disable / provider", () => {
  it("refuses a remote provider without a terminal or --accept-remote and changes nothing", async () => {
    const t = fakeIo();
    expect(await run(["enable", "--provider", "typesafe"], t.io)).toBe(1);
    expect(globalRaw().adjudicator).toBeUndefined();
    expect(t.text()).toContain("--accept-remote");
  });

  it("enables with --accept-remote, tells the user to /mcp reconnect", async () => {
    const t = fakeIo();
    expect(
      await run(["enable", "--provider", "groq", "--accept-remote", "--mode", "apply"], t.io),
    ).toBe(0);
    expect(globalRaw().adjudicator).toMatchObject({
      enabled: true,
      provider: "openai-compatible",
      mode: "apply",
      remoteConsent: true,
    });
    expect(t.text()).toContain("/mcp reconnect");
    expect(t.text()).toContain("key set groq");
  });

  it("--project writes only enabled to eminiar.config.json", async () => {
    writeFileSync(join(root, "eminiar.config.json"), JSON.stringify({ routing: { mode: "auto" } }));
    const t = fakeIo();
    expect(await run(["enable", "--project"], t.io)).toBe(0);
    const proj = JSON.parse(readFileSync(join(root, "eminiar.config.json"), "utf8"));
    expect(proj).toEqual({ routing: { mode: "auto" }, adjudicator: { enabled: true } });
    expect(globalRaw().adjudicator).toBeUndefined();
    expect(loadConfig(root).adjudicator.enabled).toBe(true);
  });

  it("disable turns it off and keeps keys", async () => {
    await run(["enable"], fakeIo().io);
    const t = fakeIo();
    expect(await run(["disable"], t.io)).toBe(0);
    expect(loadConfig(root).adjudicator.enabled).toBe(false);
    expect(t.text()).toContain("off");
  });

  it("rejects unknown providers and modes", async () => {
    expect(await run(["enable", "--provider", "bogus"], fakeIo().io)).toBe(2);
    expect(await run(["enable", "--mode", "bogus"], fakeIo().io)).toBe(2);
  });

  it("provider --detect suggests a local server and changes nothing", async () => {
    const t = fakeIo();
    const portProbe = async (port: number) => port === 1234;
    expect(await run(["provider", "--detect"], t.io, { portProbe })).toBe(0);
    expect(t.text()).toContain("--preset lmstudio");
    expect(globalRaw().adjudicator).toBeUndefined();
    expect(await detectLocal(10, async () => false)).toEqual([]);
  });

  it("provider switches the preset and clears the old preset's overrides", async () => {
    writeAdjudicatorPatch(paths().configFile, {
      provider: "openai-compatible",
      openai: { preset: "ollama", model: "llama3" },
    });
    expect(await run(["provider", "openai-compatible", "--preset", "lmstudio"], fakeIo().io)).toBe(
      0,
    );
    expect(globalRaw().adjudicator.openai).toEqual({ preset: "lmstudio" });
  });
});

describe("eminiar adjudicator key", () => {
  it("never takes a key from argv", async () => {
    const t = fakeIo();
    expect(await run(["key", "set", "typesafe", SENTINEL], t.io)).toBe(2);
    expect(existsSync(paths().adjudicatorKey)).toBe(false);
    expect(await run(["key", "set", SENTINEL], fakeIo().io)).toBe(2);
    expect(existsSync(paths().adjudicatorKey)).toBe(false);
  });

  it("reads the key from stdin, stores it 0600 and shows it masked", async () => {
    const t = fakeIo({ stdin: `${SENTINEL}\n` });
    expect(await run(["key", "set", "jev"], t.io)).toBe(0);
    if (process.platform !== "win32")
      expect(statSync(paths().adjudicatorKey).mode & 0o777).toBe(0o600);
    const s = fakeIo();
    expect(await run(["key", "status"], s.io)).toBe(0);
    expect(s.text()).toContain("typesafe: file ****Zq9X");
    expect(`${t.text()}\n${s.text()}`).not.toContain(SENTINEL);
    expect(await run(["key", "clear", "typesafe"], fakeIo().io)).toBe(0);
    expect(existsSync(paths().adjudicatorKey)).toBe(false);
  });

  it("uses the hidden prompt on a terminal", async () => {
    const t = fakeIo({ tty: true, hidden: [SENTINEL] });
    expect(await run(["key", "set", "groq"], t.io)).toBe(0);
    expect(t.text()).toContain("[hidden]");
    expect(JSON.parse(readFileSync(paths().adjudicatorKey, "utf8"))).toEqual({
      "openai:groq": SENTINEL,
    });
  });

  it("--from-env stores the variable's name, not a key", async () => {
    expect(await run(["key", "set", "--from-env", "MY_JEV_KEY"], fakeIo().io)).toBe(0);
    expect(globalRaw().adjudicator).toEqual({ keyEnv: "MY_JEV_KEY" });
    expect(existsSync(paths().adjudicatorKey)).toBe(false);
    expect(await run(["key", "set", "--from-env", "not a name"], fakeIo().io)).toBe(2);
  });

  it("an empty stdin is an error", async () => {
    expect(await run(["key", "set", "typesafe"], fakeIo({ stdin: "" }).io)).toBe(1);
  });
});

describe("eminiar adjudicator status", () => {
  it("shows off by default", async () => {
    const t = fakeIo();
    expect(await run(["status"], t.io)).toBe(0);
    expect(t.text()).toContain("adjudicator: off (default)");
  });

  it("--json shows the degraded reason and never the key", async () => {
    writeAdjudicatorPatch(paths().configFile, {
      enabled: true,
      provider: "typesafe",
      remoteConsent: true,
    });
    const t = fakeIo();
    await run(["status", "--json"], t.io);
    const s = JSON.parse(t.lines[0] ?? "{}");
    expect(s).toMatchObject({
      enabled: true,
      configured: "typesafe",
      effective: "heuristic",
      degraded: "no_key",
      remote: true,
      host: "api.typesafe.ai",
      consent: true,
    });
  });

  it("shows API key rejected while the provider is locked out", async () => {
    writeAdjudicatorPatch(paths().configFile, {
      enabled: true,
      provider: "typesafe",
      remoteConsent: true,
    });
    const env = { TYPESAFE_API_KEY: SENTINEL };
    const now = Date.UTC(2026, 10, 4, 12);
    db.adjudicator.saveProviderState("typesafe", {
      state: "auth_failed",
      authFingerprint: keyFingerprint(SENTINEL),
      retryAt: now + 3_600_000,
      lastErrorClass: "http_error:401",
    });
    const t = fakeIo({ env });
    await run(["status"], t.io);
    expect(t.text()).toContain("API key rejected (HTTP 401)");
    expect(t.text()).not.toContain(SENTINEL);
    const checks = adjudicatorDoctorChecks(loadConfig(root), { root, db, env, now });
    const main = checks.find((c) => c.name === "adjudicator");
    expect(main?.ok).toBe(false);
    expect(main?.detail).toContain("API key rejected");
  });
});

describe("doctor", () => {
  it("one ok line while off", () => {
    const checks = adjudicatorDoctorChecks(ConfigSchema.parse({}), { root, env: {} });
    expect(checks).toEqual([
      { name: "adjudicator", ok: true, detail: "off (opt-in: `eminiar adjudicator enable`)" },
    ]);
    expect(
      runDoctor({ config: ConfigSchema.parse({}), root }).some((c) => c.name === "adjudicator"),
    ).toBe(true);
  });

  it("flags no key, no consent, an insecure key file, invalid config and a forced model in apply mode", () => {
    writeFileSync(paths().adjudicatorKey, JSON.stringify({ "openai:groq": SENTINEL }), {
      mode: 0o644,
    });
    writeFileSync(
      join(root, "eminiar.config.json"),
      JSON.stringify({ adjudicator: { mode: "bogus" } }),
    );
    const config = ConfigSchema.parse({
      adjudicator: { enabled: true, provider: "openai-compatible", mode: "apply" },
    });
    const checks = adjudicatorDoctorChecks(config, {
      root,
      db,
      env: { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1" },
    });
    const by = Object.fromEntries(checks.map((c) => [c.name, c]));
    expect(by["adjudicator config"]?.ok).toBe(false);
    expect(by.adjudicator?.ok).toBe(false);
    expect(by["adjudicator consent"]?.ok).toBe(false);
    if (process.platform !== "win32") expect(by["adjudicator key"]?.ok).toBe(false);
    expect(by["adjudicator apply"]?.ok).toBe(false);
    expect(JSON.stringify(checks)).not.toContain(SENTINEL);
  });

  it("the live check probes the configured provider", async () => {
    const config = ConfigSchema.parse({
      adjudicator: { enabled: true, provider: "openai-compatible", openai: { preset: "ollama" } },
    });
    const checks = await adjudicatorLiveChecks(config, {
      env: {},
      deps: { provider: fakeProvider().provider },
    });
    expect(checks).toEqual([expect.objectContaining({ name: "adjudicator probe", ok: true })]);
  });
});

function fakeProvider() {
  let calls = 0;
  const provider: AdjudicatorProvider = {
    id: "openai-compatible",
    remote: false,
    dims: ["complexity", "tier", "role", "tool"],
    async adjudicate(reqs): Promise<ProviderResult> {
      calls++;
      return {
        answers: reqs.map((r) => ({
          key: r.key,
          complexity: { value: 3.5, confidence: 0.9 },
          tier: {
            probs: { haiku: 0.05, sonnet: 0.15, opus: 0.8 },
            confidence: 0.8,
            calibrated: true,
          },
        })),
        usage: { inTok: 120, outTok: 20, costUsd: 0 },
        latencyMs: 42,
        model: "fake-1",
      };
    },
    async probe() {
      return { ok: true, latencyMs: 3, detail: "fake-1 listed" };
    },
  };
  return { provider, calls: () => calls };
}

describe("eminiar adjudicator test / eval / stats", () => {
  it("test shows heuristic, raw and blended with one provider call, and persists nothing", async () => {
    writeAdjudicatorPatch(paths().configFile, {
      provider: "openai-compatible",
      openai: { preset: "ollama" },
    });
    const f = fakeProvider();
    const t = fakeIo();
    const code = await run(
      ["test", "redesign the storage layer across every module and migrate the schema"],
      t.io,
      { provider: f.provider },
    );
    expect(code).toBe(0);
    expect(f.calls()).toBe(1);
    const out = t.text();
    expect(out).toMatch(/^probe: +ok/m);
    expect(out).toMatch(/^heuristic /m);
    expect(out).toMatch(/^raw .*tier opus \(0\.80\).*fake-1.*120\+20 tok/m);
    expect(out).toMatch(/^blended /m);
    expect(db.adjudicator.summary().total).toBe(0);
  });

  it("test --json reports a failed provider and exits 1", async () => {
    writeAdjudicatorPatch(paths().configFile, {
      provider: "openai-compatible",
      openai: { preset: "ollama" },
    });
    const f = fakeProvider();
    f.provider.adjudicate = async () => {
      throw Object.assign(new Error("connection refused"), { kind: "http_error" });
    };
    const t = fakeIo();
    expect(
      await run(["test", "fix the typo in README", "--json"], t.io, { provider: f.provider }),
    ).toBe(1);
    const j = JSON.parse(t.lines[0] ?? "{}");
    expect(j.rawError).toContain("connection refused");
    expect(j.blended.source).not.toBe("blend");
    expect(j.persisted).toBe(false);
  });

  it("test needs text", async () => {
    expect(await run(["test"], fakeIo().io)).toBe(2);
  });

  it("eval runs the heuristic on the built-in set and checks fixture types", async () => {
    const t = fakeIo();
    expect(await run(["eval", "--json"], t.io)).toBe(0);
    const report = JSON.parse(t.lines.join("\n"));
    expect(report.set.source).toBe("builtin");
    expect(report.rows.some((r: { kind: string }) => r.kind === "heuristic")).toBe(true);
    expect(await run(["eval", "--fixture", "x.yaml"], fakeIo().io)).toBe(2);
    expect(await run(["eval", "--repeat", "0"], fakeIo().io)).toBe(2);
  });

  it("eval --fixture merges a .json fixture and --save stores the report", async () => {
    const file = join(root, "fx.json");
    writeFileSync(
      file,
      JSON.stringify([
        {
          text: "rename a variable in utils",
          tool: "Edit",
          tier: "haiku",
          role: "coder",
          complexity: 0,
        },
      ]),
    );
    const t = fakeIo();
    expect(await run(["eval", "--fixture", file, "--save"], t.io)).toBe(0);
    expect(t.text()).toContain("saved as the last eval");
    expect(db.metaGet("adjudicator:eval:last")).toContain('"fixture":"fx.json"');
  });

  it("stats reports none yet, --json gives summary and savings, --reset-learning clears bias", async () => {
    const t = fakeIo();
    expect(await run(["stats"], t.io)).toBe(0);
    expect(t.text()).toContain("No adjudicator decisions");
    const j = fakeIo();
    expect(await run(["stats", "--json", "--since", "7d"], j.io)).toBe(0);
    const parsed = JSON.parse(j.lines.join("\n"));
    expect(parsed.summary.total).toBe(0);
    expect(parsed.savings).toHaveProperty("assumptions");
    const r = fakeIo();
    expect(await run(["stats", "--reset-learning"], r.io)).toBe(0);
    expect(r.text()).toContain("Learned bias reset");
    expect(await run(["stats", "--since", "yesterday"], fakeIo().io)).toBe(2);
  });

  it("unknown subcommands print usage and exit 2", async () => {
    const t = fakeIo();
    expect(await run(["frobnicate"], t.io)).toBe(2);
    expect(t.text()).toContain("eminiar adjudicator <command>");
  });
});
