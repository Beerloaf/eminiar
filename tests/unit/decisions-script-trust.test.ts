/**
 * Review round 2, N4: the detached decision job runs only the running installation's own hook.js.
 * A cloned repo's .claude/settings.json `env` block reaches the MCP server and can set
 * EMINIAR_PLUGIN_ROOT, so neither that variable nor process.argv may pick the script; symlinks,
 * relative paths and a planted hook.js under the project or the working directory are refused.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AdjudicatorConfigSchema, ConfigSchema } from "../../src/config.js";
import { getContext, type ProjectContext, resetContextCache } from "../../src/context.js";
import { kickSwarmJudge } from "../../src/decisions/features/swarm.js";
import {
  type DecisionSpawnDeps,
  isHookScript,
  spawnDecisionJob,
  trustedHookScript,
} from "../../src/decisions/job.js";
import type { DecisionJob } from "../../src/decisions/types.js";
import type { StorageAdapter } from "../../src/storage/adapter.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";

/** Lets the swarm test route the judge's real spawnDecisionJob call into a fixture install. */
const route = vi.hoisted(() => ({
  deps: {} as Record<string, unknown>,
  calls: [] as unknown[][],
}));
vi.mock("../../src/decisions/job.js", async (orig) => {
  const real = await orig<typeof import("../../src/decisions/job.js")>();
  return {
    ...real,
    spawnDecisionJob: (job: DecisionJob, deps?: DecisionSpawnDeps) => {
      route.calls.push([job, deps]);
      return real.spawnDecisionJob(job, { ...deps, ...(route.deps as DecisionSpawnDeps) });
    },
  };
});

const fake = () => {
  const child = { on: vi.fn(), unref: vi.fn(), stdin: { on: vi.fn(), end: vi.fn() } };
  return { spawn: vi.fn(() => child), child };
};

/** A fake installed plugin: dist/server.js (the running module) and dist/hook.js beside it. */
function install(parent: string, hookBody = "", name = "plugin"): { dist: string; url: string } {
  const dist = join(parent, name, "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "server.js"), "// server\n");
  writeFileSync(join(dist, "hook.js"), hookBody || "// hook\n");
  return { dist, url: pathToFileURL(join(dist, "server.js")).href };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let scratch: string;
let project: string;
let plugin: { dist: string; url: string };
let realHook: string;
const savedRoot = process.env.EMINIAR_PLUGIN_ROOT;

beforeAll(() => {
  // realpath: macOS tmpdir is a symlink (/var -> /private/var)
  scratch = mkdtempSync(join(tmpdir(), "em-trust-"));
  project = join(scratch, "project");
  mkdirSync(project);
  plugin = install(join(scratch, "home"));
  realHook = trustedHookScript(plugin.url) ?? "";
});
afterAll(() => {
  if (savedRoot === undefined) delete process.env.EMINIAR_PLUGIN_ROOT;
  else process.env.EMINIAR_PLUGIN_ROOT = savedRoot;
});

describe("trustedHookScript", () => {
  it("is the real hook.js next to the running module", () => {
    expect(realHook).toMatch(/[/\\]home[/\\]plugin[/\\]dist[/\\]hook\.js$/);
    expect(existsSync(realHook)).toBe(true);
  });

  it("ignores EMINIAR_PLUGIN_ROOT entirely", () => {
    const evil = install(project, "", "evilroot");
    process.env.EMINIAR_PLUGIN_ROOT = join(project, "evilroot");
    try {
      expect(trustedHookScript(plugin.url)).toBe(realHook);
      expect(trustedHookScript(plugin.url)).not.toContain("evilroot");
      expect(evil.dist).toContain("evilroot");
    } finally {
      delete process.env.EMINIAR_PLUGIN_ROOT;
    }
  });

  it("is undefined from src/ (no hook.js beside src/decisions/job.ts) and for a missing install", () => {
    expect(trustedHookScript()).toBeUndefined();
    expect(trustedHookScript(pathToFileURL(join(scratch, "nowhere", "server.js")).href)).toBe(
      undefined,
    );
  });

  it("refuses a hook.js that is a symlink, even to a real file", () => {
    const dist = join(scratch, "linked", "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "server.js"), "");
    writeFileSync(join(project, "planted.js"), "");
    symlinkSync(join(project, "planted.js"), join(dist, "hook.js"));
    expect(trustedHookScript(pathToFileURL(join(dist, "server.js")).href)).toBeUndefined();
  });
});

describe("isHookScript checks the resolved path, not the basename", () => {
  it("accepts only the running installation's hook.js", () => {
    expect(isHookScript(realHook, { moduleUrl: plugin.url, cwd: project })).toBe(true);
  });

  it("refuses another file named hook.js, including one under the project", () => {
    const evil = install(project, "", "evilroot");
    expect(isHookScript(join(evil.dist, "hook.js"), { moduleUrl: plugin.url, cwd: project })).toBe(
      false,
    );
    expect(isHookScript("/p/dist/hook.js", { moduleUrl: plugin.url })).toBe(false);
    expect(isHookScript(join(plugin.dist, "server.js"), { moduleUrl: plugin.url })).toBe(false);
  });

  it("refuses a relative path, even one that resolves to the real hook", () => {
    const rel = join("..", "..", realHook);
    expect(isHookScript("evilroot/dist/hook.js", { moduleUrl: plugin.url })).toBe(false);
    expect(isHookScript(`./${rel}`, { moduleUrl: plugin.url })).toBe(false);
  });

  it("refuses a symlink named hook.js that points at the real hook", () => {
    const link = join(project, "hook.js");
    symlinkSync(realHook, link);
    // the real path matches and the basename is fine, but the path is a link in the project
    expect(isHookScript(link, { moduleUrl: plugin.url, cwd: project })).toBe(false);
    expect(isHookScript(link, { moduleUrl: plugin.url, cwd: scratch })).toBe(false);
  });

  it("a project root or cwd that holds the running module too (Claude Code in $HOME) stays allowed", () => {
    expect(isHookScript(realHook, { moduleUrl: plugin.url, projectRoot: project })).toBe(true);
    expect(
      isHookScript(realHook, {
        moduleUrl: plugin.url,
        projectRoot: join(scratch, "home"),
        cwd: scratch,
      }),
    ).toBe(true);
  });

  it("a planted hook.js under the project is refused even when it is named exactly like the real one", () => {
    const planted = install(project, "", "plugin");
    const path = trustedHookScript(planted.url) ?? "";
    expect(path).toContain(project.split(/[/\\]/).pop() ?? "project");
    // judged against the running module (elsewhere), the project's copy is not the hook
    expect(isHookScript(path, { moduleUrl: plugin.url, projectRoot: project })).toBe(false);
  });

  it("refuses non-strings and empty paths without throwing", () => {
    expect(isHookScript("", { moduleUrl: plugin.url })).toBe(false);
    expect(isHookScript(undefined as never, { moduleUrl: plugin.url })).toBe(false);
  });
});

describe("spawnDecisionJob", () => {
  const job: DecisionJob = { v: 1, feature: "swarm", projectRoot: "/p", payload: {} };

  it("spawns the running installation's hook.js with --decision and no shell", () => {
    const f = fake();
    expect(
      spawnDecisionJob(job, { spawn: f.spawn as never, moduleUrl: plugin.url, execPath: "/node" }),
    ).toBe(true);
    expect(f.spawn).toHaveBeenCalledWith(
      "/node",
      [realHook, "--decision"],
      expect.objectContaining({ detached: true, shell: false }),
    );
  });

  it("takes no script from the caller (an extra `script` dep is ignored)", () => {
    const f = fake();
    const evil = install(project, "", "evilroot");
    spawnDecisionJob(job, {
      spawn: f.spawn as never,
      moduleUrl: plugin.url,
      ...({ script: join(evil.dist, "hook.js") } as object),
    });
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect((f.spawn.mock.calls[0] as unknown[])[1]).toEqual([realHook, "--decision"]);
  });

  it("does not spawn from src/ (no installed hook.js), whatever process.argv[1] is", () => {
    const f = fake();
    const argv1 = process.argv[1];
    process.argv[1] = join(plugin.dist, "hook.js");
    try {
      expect(spawnDecisionJob(job, { spawn: f.spawn as never })).toBe(false);
    } finally {
      process.argv[1] = argv1 as string;
    }
    expect(f.spawn).not.toHaveBeenCalled();
  });
});

describe("repro r2spawn: EMINIAR_PLUGIN_ROOT=./evilroot never runs the repo's script", () => {
  const evilBody = (mark: string) =>
    `require("node:fs").writeFileSync(${JSON.stringify(mark)}, "evil " + process.argv.slice(2).join(" "));\n`;

  it("prints marker none with the real spawn, from src/ (refused)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "em-r2spawn-"));
    const mark = join(cwd, "evilroot", "marker.txt");
    mkdirSync(join(cwd, "evilroot", "dist"), { recursive: true });
    writeFileSync(join(cwd, "evilroot", "dist", "hook.js"), evilBody(mark));
    writeFileSync(join(cwd, "evilroot", "package.json"), '{"type":"commonjs"}');
    process.env.EMINIAR_PLUGIN_ROOT = join(cwd, "evilroot");
    try {
      // what the judge passed before the fix: script = <EMINIAR_PLUGIN_ROOT>/dist/hook.js
      const legacy = { script: join(process.env.EMINIAR_PLUGIN_ROOT, "dist", "hook.js") } as object;
      const ok = spawnDecisionJob(
        { v: 1, feature: "swarm", projectRoot: cwd, payload: {} },
        { cwd, ...legacy },
      );
      await wait(800);
      expect(ok).toBe(false);
      expect(existsSync(mark) ? readFileSync(mark, "utf8") : "none").toBe("none");
    } finally {
      delete process.env.EMINIAR_PLUGIN_ROOT;
    }
  });

  it("runs the real installed hook.js instead, with the env var pointing at the repo", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "em-r2spawn-"));
    const evilMark = join(cwd, "evilroot", "marker.txt");
    const realMark = join(cwd, "real-marker.txt");
    mkdirSync(join(cwd, "evilroot", "dist"), { recursive: true });
    writeFileSync(join(cwd, "evilroot", "dist", "hook.js"), evilBody(evilMark));
    const inst = install(
      mkdtempSync(join(tmpdir(), "em-r2inst-")),
      `require("node:fs").writeFileSync(${JSON.stringify(realMark)}, "real " + process.argv.slice(2).join(" "));\n`,
    );
    writeFileSync(join(inst.dist, "package.json"), '{"type":"commonjs"}');
    process.env.EMINIAR_PLUGIN_ROOT = join(cwd, "evilroot");
    try {
      const ok = spawnDecisionJob(
        { v: 1, feature: "swarm", projectRoot: cwd, payload: {} },
        { moduleUrl: inst.url, cwd },
      );
      expect(ok).toBe(true);
      for (let i = 0; i < 50 && !existsSync(realMark); i++) await wait(50);
      expect(existsSync(evilMark) ? readFileSync(evilMark, "utf8") : "none").toBe("none");
      expect(readFileSync(realMark, "utf8")).toBe("real --decision");
    } finally {
      delete process.env.EMINIAR_PLUGIN_ROOT;
    }
  });
});

describe("the swarm judge spawns through the trusted script only", () => {
  let root: string;
  let home: string;
  let ctx: ProjectContext;
  let db: StorageAdapter;
  const ORIGIN = "https://api.typesafe.ai";

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "em-trust-home-"));
    process.env.EMINIAR_HOME = home;
    process.env.TYPESAFE_API_KEY = "sk-test-key-0123456789";
    root = mkdtempSync(join(tmpdir(), "em-trust-swarm-"));
    writeFileSync(join(root, "package.json"), "{}");
    resetContextCache();
    const base = getContext(root);
    ctx = {
      ...base,
      config: ConfigSchema.parse({
        adjudicator: AdjudicatorConfigSchema.parse({
          enabled: true,
          provider: "typesafe",
          remoteConsent: true,
          remoteConsentOrigins: [ORIGIN],
          featureConsent: [`swarm@${ORIGIN}`],
          features: { swarm: { enabled: true, shadow: false } },
        }),
      }),
    };
    db = getStorage(base, { vectors: false });
  });
  afterAll(() => {
    route.deps = {};
    closeAllStorage();
    delete process.env.EMINIAR_HOME;
    delete process.env.TYPESAFE_API_KEY;
    delete process.env.EMINIAR_PLUGIN_ROOT;
  });
  beforeEach(() => {
    route.calls.length = 0;
  });

  it("passes no script and spawns the installed hook.js, not <EMINIAR_PLUGIN_ROOT>/dist/hook.js", () => {
    const evil = install(root, "", "evilroot");
    process.env.EMINIAR_PLUGIN_ROOT = join(root, "evilroot");
    const f = fake();
    route.deps = { spawn: f.spawn, moduleUrl: plugin.url };
    const runId = "run-trust";
    const task = {
      id: 1,
      run_id: runId,
      title: "implement",
      status: "active",
      agent_id: "agent-1",
      result: null,
    } as never;
    const ok = kickSwarmJudge(ctx, db, runId, [task], "sess-1");
    expect(ok).toBe(true);
    expect(route.calls).toHaveLength(1);
    // the judge names no script: the only spawn option it may pass is none at all
    expect(route.calls[0]?.[1]).toBeUndefined();
    expect(f.spawn).toHaveBeenCalledTimes(1);
    const argv = (f.spawn.mock.calls[0] as unknown[])[1] as string[];
    expect(argv).toEqual([realHook, "--decision"]);
    expect(argv[0]).not.toContain(evil.dist);
  });
});
