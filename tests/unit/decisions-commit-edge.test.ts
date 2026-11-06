/**
 * Commit advice (option C), the gaps the base file leaves: off / shadow / unsupported / timeout /
 * error leave no trace, a canary secret and excluded files never reach the request body, the hook
 * path makes no network call and stays well inside its budget, and nothing ever blocks a commit.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type AdjudicatorConfig, AdjudicatorConfigSchema, ConfigSchema } from "../../src/config.js";
import { getContext, resetContextCache } from "../../src/context.js";
import { createDecisionClient } from "../../src/decisions/client.js";
import { DIFF_MAX_CHARS, diffFileAllowed, redactDiff } from "../../src/decisions/diff-redact.js";
import { commitMessage, feature } from "../../src/decisions/features/commit.js";
import type { DecisionProvider } from "../../src/decisions/providers/types.js";
import type { DecisionJob } from "../../src/decisions/types.js";
import type { StorageAdapter } from "../../src/storage/adapter.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";

const spawnSpy = vi.hoisted(() => vi.fn(() => true));
vi.mock("../../src/decisions/job.js", async (orig) => ({
  ...(await orig<typeof import("../../src/decisions/job.js")>()),
  spawnDecisionJob: spawnSpy,
}));

const ORIGIN = "https://api.typesafe.ai";
const ENV = { TYPESAFE_API_KEY: "sk-test-key-0123456789" } as NodeJS.ProcessEnv;
const GH = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";
const AWS = "AKIAIOSFODNN7EXAMPLE";
const CMD = 'git commit -m "Tidy things"';

let root: string;
let db: StorageAdapter;
let home: string;
const bodies: string[] = [];

const g = (...a: string[]) => execFileSync("git", a, { cwd: root, stdio: "pipe" });

function cfg(f: Record<string, unknown>): AdjudicatorConfig {
  return AdjudicatorConfigSchema.parse({
    enabled: true,
    provider: "typesafe",
    remoteConsent: true,
    remoteConsentOrigins: [ORIGIN],
    featureConsent: [`diffs@${ORIGIN}`],
    features: { commit: { enabled: true, shadow: false, ...f } },
  }) as AdjudicatorConfig;
}

/** The real typesafe provider over a stubbed fetch: the body is what would leave the machine. */
function fetchAnswering(p: number) {
  return async (_u: string, init: RequestInit) => {
    bodies.push(String(init.body));
    const q = (JSON.parse(String(init.body)) as { questions: Record<string, unknown> }).questions;
    return new Response(
      JSON.stringify({
        answers: Object.fromEntries(Object.keys(q).map((k) => [k, { type: "noul", noul: p }])),
      }),
      { status: 200 },
    );
  };
}

const job = (command: unknown = CMD, sid = "s1"): DecisionJob => ({
  v: 1,
  feature: "commit",
  projectRoot: root,
  sessionId: sid,
  payload: command === undefined ? undefined : { command },
});

const run = (
  c: AdjudicatorConfig,
  deps: { fetch?: unknown; provider?: DecisionProvider },
  j = job(),
) =>
  feature.runJob?.(
    j,
    createDecisionClient("commit", {
      config: c,
      db,
      context: "job",
      env: ENV,
      ...(deps as object),
    }),
    db,
  );

const notes = (sid = "s1") => db.decisions.pendingNotes(sid, Date.now());
const rows = () => db.decisions.list({ feature: "commit" });

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "em-dce-home-"));
  process.env.EMINIAR_HOME = home;
  process.env.EMINIAR_EMBEDDINGS = "0";
  root = mkdtempSync(join(tmpdir(), "em-dce-"));
  writeFileSync(join(root, "package.json"), "{}");
  g("init", "-q");
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  g("add", "-A");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  mkdirSync(join(root, "secrets"));
  mkdirSync(join(root, "sub"));
  writeFileSync(
    join(root, "a.ts"),
    `export const a = 1;\nconst ghToken = "${GH}";\nconst aws = "${AWS}";\nconsole.log("dbg");\n`,
  );
  writeFileSync(join(root, ".env"), "SECRET_CANARY_ENV=zzz-env-value\n");
  writeFileSync(join(root, "sub", ".env.production"), "SECRET_CANARY_PROD=zzz-prod-value\n");
  writeFileSync(join(root, "id_rsa"), "-----BEGIN PRIVATE KEY-----\nzzz-rsa-value\n");
  writeFileSync(join(root, "server.pem"), "zzz-pem-value\n");
  writeFileSync(join(root, "package-lock.json"), '{"zzz-lock-value":1}\n');
  writeFileSync(join(root, "yarn.lock"), "zzz-yarn-value\n");
  writeFileSync(join(root, "secrets", "x.ts"), "export const zzzSecretsDir = 1;\n");
  writeFileSync(join(root, "logo.png"), "zzz-binary-value\n");
  g("add", "-A");
  resetContextCache();
  db = getStorage(getContext(root));
});
afterAll(() => {
  closeAllStorage();
  delete process.env.EMINIAR_HOME;
  delete process.env.EMINIAR_EMBEDDINGS;
});
beforeEach(() => {
  bodies.length = 0;
  spawnSpy.mockClear();
});
afterEach(() => {
  db.decisions.markDelivered(
    notes().map((n) => n.id),
    Date.now(),
  );
});

describe("redactDiff edges", () => {
  const sec = (path: string, line: string) =>
    `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +1 @@\n+${line}\n`;

  it("denies by the floor, case-insensitively and in nested paths, whatever exclude says", () => {
    for (const p of [
      ".env",
      ".ENV",
      "a/b/.env.production",
      "k/server.PEM",
      "x/id_rsa.pub",
      "pnpm-lock.yaml",
      "web/yarn.lock",
      "secrets/deep/a.ts",
      "dist/app.min.js",
      "db/app.sqlite3",
      "credentials.json",
    ])
      expect(diffFileAllowed(p, []), p).toBe(false);
    expect(diffFileAllowed(".env", ["!nothing"])).toBe(false);
    expect(diffFileAllowed("src/ok.ts")).toBe(true);
    expect(diffFileAllowed("Makefile")).toBe(true);
  });

  it("sends no name and no content of a denied file", () => {
    const d = [".env", "id_rsa", "yarn.lock", "logo.png", "secrets/a.ts"]
      .map((p) => sec(p, `zzz-${p}-content`))
      .join("");
    const r = redactDiff(d + sec("ok.ts", "ok();"), { maxChars: 4000 });
    expect(r.text).toBe("file ok.ts\nok();");
    expect(r.skipped).toBe(5);
  });

  it("drops binary patches, deletion-only files, and empty input", () => {
    const bin = "diff --git a/img.ts b/img.ts\nBinary files a/img.ts and b/img.ts differ\n";
    const del = "diff --git a/g.ts b/g.ts\n--- a/g.ts\n+++ b/g.ts\n@@ -1 +0,0 @@\n-gone\n";
    expect(redactDiff(bin + del, { maxChars: 4000 }).text).toBe("");
    expect(redactDiff("", { maxChars: 4000 })).toEqual({ text: "", files: 0, skipped: 0 });
    expect(redactDiff("not a diff at all", { maxChars: 4000 }).text).toBe("");
  });

  it("scrubs tokens, secret-named values, hex and blobs; cuts long lines", () => {
    const d = sec(
      "s.ts",
      [
        `const t = "${GH}";`,
        `const k = "${AWS}";`,
        `export const API_SECRET = "plainvalue99";`,
        `const h = "${"ab12".repeat(16)}";`,
        `const b = "${"Zy9/".repeat(20)}";`,
        `x = "${"q".repeat(400)}"`,
      ].join("\n+"),
    );
    const { text } = redactDiff(d, { maxChars: 4000 });
    expect(text).not.toMatch(new RegExp(`${GH}|${AWS}|plainvalue99|ab12ab12|Zy9/Zy9/`));
    expect(text).toContain("API_SECRET");
    expect(Math.max(...text.split("\n").map((l) => l.length))).toBeLessThanOrEqual(161);
  });

  it("caps the text at the ceiling and the config value, and survives a huge diff", () => {
    const big = sec("big.ts", Array.from({ length: 5000 }, (_, i) => `line${i}();`).join("\n+"));
    expect(redactDiff(big, { maxChars: 10 ** 9 }).text.length).toBeLessThanOrEqual(DIFF_MAX_CHARS);
    expect(redactDiff(big, { maxChars: 0 }).text).toBe("");
  });

  it("honours a configured exclude glob", () => {
    const d = sec("gen/out.ts", "gen();") + sec("src/in.ts", "in();");
    expect(redactDiff(d, { maxChars: 4000, exclude: ["gen/**"] }).text).toBe(
      "file src/in.ts\nin();",
    );
  });
});

describe("commitMessage edges", () => {
  it("handles none, single quotes, --message=, combined flags and truncation", () => {
    expect(commitMessage("git commit")).toBe("");
    expect(commitMessage("git commit -am 'x y'")).toBe("x y");
    expect(commitMessage('git commit --message="a b"')).toBe("a b");
    expect(commitMessage(`git commit -m "${"z".repeat(2000)}"`).length).toBeLessThanOrEqual(600);
  });
});

describe("what the request carries", () => {
  it("never carries a canary secret or an excluded file, but does carry the clean change", async () => {
    await run(cfg({}), { fetch: fetchAnswering(0.01) });
    expect(bodies).toHaveLength(1);
    const wire = bodies.join("");
    expect(wire).toContain("console.log");
    expect(wire).not.toContain(GH);
    expect(wire).not.toContain(AWS);
    expect(wire).not.toMatch(/zzz-|SECRET_CANARY|\.env|id_rsa|server\.pem|yarn\.lock|package-lock/);
    expect(wire).not.toMatch(/logo\.png|zzzSecretsDir|secrets\/x/);
    expect(wire).not.toContain(ENV.TYPESAFE_API_KEY as string);
  });

  it("a secret in the commit message is redacted too", async () => {
    await run(cfg({}), { fetch: fetchAnswering(0.01) }, job(`git commit -m "key ${GH} here"`));
    expect(bodies.join("")).not.toContain(GH);
  });
});

describe("off, shadow, unsupported, timeout and error leave no trace of advice", () => {
  it("off: no call, no row, no note", async () => {
    await run(cfg({ enabled: false }), { fetch: fetchAnswering(0.99) });
    expect(bodies).toHaveLength(0);
    expect(notes()).toHaveLength(0);
  });

  it("a live yes writes one note whose text only advises", async () => {
    await run(cfg({}), { fetch: fetchAnswering(0.99) }, job('git commit -m "live"'));
    const n = notes();
    expect(n).toHaveLength(1);
    expect(n[0]?.note).toMatch(/^commit advice: /);
    expect(n[0]?.note).not.toMatch(/block|abort|refuse|deny/i);
  });

  it("shadow: asks, records a shadow row, leaves no note", async () => {
    await run(cfg({ shadow: true }), { fetch: fetchAnswering(0.99) }, job('git commit -m "sh"'));
    expect(bodies.length).toBeGreaterThan(0);
    expect(notes()).toHaveLength(0);
    expect(rows().some((r) => r.mode === "shadow" && !r.applied)).toBe(true);
  });

  it("unsupported: no note", async () => {
    const p: DecisionProvider = {
      id: "typesafe",
      remote: true,
      model: "m",
      maxPairs: 10,
      maxRequests: 1,
      supports: () => false,
      ask: async () => {
        throw new Error("must not be asked");
      },
    };
    await run(cfg({}), { provider: p }, job('git commit -m "uns"'));
    expect(notes()).toHaveLength(0);
    expect(rows().some((r) => r.status === "unsupported")).toBe(true);
  });

  it("timeout: a hanging provider is cut at the budget, no note", async () => {
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ adjudicator: { features: { commit: { jobMs: 60 } } } }),
    );
    let hung = 0;
    const hang = (_u: string, init: RequestInit) =>
      new Promise<Response>((_r, rej) => {
        hung++;
        init.signal?.addEventListener("abort", () => rej(new Error("aborted")));
      });
    const t0 = Date.now();
    await run(cfg({ jobMs: 60 }), { fetch: hang }, job('git commit -m "slow"'));
    expect(hung).toBe(1);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(notes()).toHaveLength(0);
    writeFileSync(join(home, "config.json"), "{}");
  });

  it("error: an HTTP 500 and a thrown fetch leave no note and never reject", async () => {
    await expect(
      run(
        cfg({}),
        { fetch: async () => new Response("boom", { status: 500 }) },
        job('git commit -m "e1"'),
      ),
    ).resolves.toBeUndefined();
    await expect(
      run(
        cfg({}),
        {
          fetch: async () => {
            throw new Error("net down");
          },
        },
        job('git commit -m "e2"'),
      ),
    ).resolves.toBeUndefined();
    expect(notes()).toHaveLength(0);
  });

  it("malformed or missing payload, a non-commit command, and a clean tree do nothing", async () => {
    const c = cfg({});
    await run(c, { fetch: fetchAnswering(0.99) }, job(undefined));
    await run(c, { fetch: fetchAnswering(0.99) }, job(42));
    await run(c, { fetch: fetchAnswering(0.99) }, job("git status"));
    await run(c, { fetch: fetchAnswering(0.99) }, { ...job(), projectRoot: "/nonexistent-dir-x" });
    expect(bodies).toHaveLength(0);
    expect(notes()).toHaveLength(0);
  });
});

describe("the hook path", () => {
  const input = (command: string) =>
    ({ tool_name: "Bash", tool_input: { command }, session_id: "s1", cwd: root }) as never;

  const ctxOf = (feat: Record<string, unknown>) => ({
    root,
    id: "t",
    dbPath: join(root, "x.db"),
    config: ConfigSchema.parse({
      adjudicator: {
        enabled: true,
        // a job has no embedder, so the embedding provider spawns nothing; use a local server
        provider: "openai-compatible",
        openai: { preset: "ollama", baseUrl: "http://127.0.0.1:9/v1", model: "m" },
        features: { commit: feat },
      },
    }),
  });

  it("feature.preToolUse is pure: no network, bounded payload, never throws", () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    try {
      const long = `git commit -m "${"x".repeat(9000)}"`;
      const p = feature.preToolUse?.({} as never, input(long)) as { command: string };
      expect(p.command.length).toBeLessThanOrEqual(4000);
      expect(feature.preToolUse?.({} as never, { tool_name: "Bash" } as never)).toBeUndefined();
      expect(
        feature.preToolUse?.({} as never, { tool_name: "Bash", tool_input: null } as never),
      ).toBeUndefined();
      expect(feature.preToolUse?.({} as never, input("echo git commit"))).toBeUndefined();
      expect(f).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("decisionPreToolUse queues exactly one job, with no fetch, inside the hook budget", async () => {
    const { decisionPreToolUse } = await import("../../src/decisions/hooks.js");
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    try {
      const t0 = Date.now();
      await decisionPreToolUse(ctxOf({ enabled: true }) as never, db, input(CMD), "s1");
      expect(Date.now() - t0).toBeLessThan(500);
      expect(spawnSpy).toHaveBeenCalledTimes(1);
      expect(f).not.toHaveBeenCalled();
      await decisionPreToolUse(ctxOf({ enabled: true }) as never, db, input("git status"), "s1");
      await decisionPreToolUse(ctxOf({ enabled: false }) as never, db, input(CMD), "s1");
      expect(spawnSpy).toHaveBeenCalledTimes(1);
      expect(f).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a spawn that throws is swallowed", async () => {
    const { decisionPreToolUse } = await import("../../src/decisions/hooks.js");
    spawnSpy.mockImplementationOnce(() => {
      throw new Error("no spawn");
    });
    await expect(
      decisionPreToolUse(ctxOf({ enabled: true }) as never, db, input(CMD), "s1"),
    ).resolves.toBeUndefined();
  });

  it("the routing hook's output for git commit is byte-identical off and on", async () => {
    const { preToolUse } = await import("../../src/hooks/routing.js");
    const cfgFile = (a: unknown) => {
      writeFileSync(join(home, "config.json"), JSON.stringify({ adjudicator: a }));
      resetContextCache();
    };
    cfgFile({});
    const off = await preToolUse(input(CMD));
    expect(spawnSpy).not.toHaveBeenCalled();
    cfgFile({ enabled: true, provider: "embedding", features: { commit: { enabled: true } } });
    const on = await preToolUse(input(CMD));
    expect(JSON.stringify(on)).toBe(JSON.stringify(off));
    expect(JSON.stringify(on ?? {})).not.toMatch(/"deny"|"block"/);
    cfgFile({});
  });
});
