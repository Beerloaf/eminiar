import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getContext, resetContextCache } from "../../src/context.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";
import {
  activeSwarmConfig,
  resetSwarmConfigCache,
  STARTER_YAML,
  swarmFile,
} from "../../src/swarm/config.js";
import { addTasks, callerOf, startRun } from "../../src/swarm/runtime.js";

/**
 * The built CLI (dist/cli.js) must hand every byte to a pipe before it exits. It used to call
 * process.exit right after printing, so piped output stopped at 64 KiB (the pipe buffer) while
 * a redirect to a file was complete. Run `npm run build` first.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = join(ROOT, "dist", "cli.js");

let home: string;
let root: string;
let runId: string;
const saved = { home: process.env.EMINIAR_HOME, emb: process.env.EMINIAR_EMBEDDINGS };

/** Runs the CLI with stdout and stderr on pipes; resolves with the bytes and the exit code. */
function cli(
  args: string[],
): Promise<{ code: number | null; stdout: Buffer; stderr: string; ms: number }> {
  const started = Date.now();
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: root,
      env: { ...process.env, EMINIAR_HOME: home, EMINIAR_EMBEDDINGS: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("error", fail);
    child.on("close", (code) =>
      done({
        code,
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err).toString("utf8"),
        ms: Date.now() - started,
      }),
    );
  });
}

beforeAll(() => {
  if (!existsSync(CLI)) throw new Error(`${CLI} is missing: run \`npm run build\` first`);
  home = mkdtempSync(join(tmpdir(), "em-pipe-home-"));
  root = mkdtempSync(join(tmpdir(), "em-pipe-root-"));
  process.env.EMINIAR_HOME = home;
  process.env.EMINIAR_EMBEDDINGS = "0";
  writeFileSync(join(root, "package.json"), '{"name":"pipe-demo"}');
  const file = swarmFile(root).file;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, STARTER_YAML);
  resetContextCache();
  resetSwarmConfigCache();

  // A run whose status JSON is far over the 64 KiB pipe buffer: 100 tasks with ~3.5 KB details.
  const ctx = getContext(root);
  const db = getStorage(ctx);
  const cfg = activeSwarmConfig(root)!;
  const swarm = cfg.swarms[0]!;
  const run = startRun(db, cfg, { swarm: swarm.name, goal: "print a lot", sessionId: "S1" });
  runId = run.id;
  for (let batch = 0; batch < 2; batch++)
    addTasks(
      db,
      ctx,
      run,
      swarm,
      callerOf(cfg, {}),
      Array.from({ length: 50 }, (_, i) => ({
        title: `task ${batch}-${i}`,
        detail: `${batch}-${i} `.padEnd(3500, "x"),
      })),
    );
  closeAllStorage();
});

afterAll(() => {
  closeAllStorage();
  resetContextCache();
  resetSwarmConfigCache();
  if (saved.home === undefined) delete process.env.EMINIAR_HOME;
  else process.env.EMINIAR_HOME = saved.home;
  if (saved.emb === undefined) delete process.env.EMINIAR_EMBEDDINGS;
  else process.env.EMINIAR_EMBEDDINGS = saved.emb;
  for (const d of [home, root]) rmSync(d, { recursive: true, force: true });
});

describe("eminiar CLI writing to a pipe", () => {
  it("delivers more than 200 KB of --json output in full and exits 0", async () => {
    const r = await cli(["swarm", "status", runId, "--json"]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(200 * 1024);
    // The whole document arrived: it parses, ends with the newline console.log adds, and
    // carries every task.
    expect(r.stdout.at(-1)).toBe(0x0a);
    const snap = JSON.parse(r.stdout.toString("utf8")) as { tasks: Array<{ title: string }> };
    expect(snap.tasks).toHaveLength(100);
    expect(snap.tasks.map((t) => t.title)).toContain("task 1-49");
    // Exiting still happens promptly once the output is flushed (no handle keeps it alive).
    expect(r.ms).toBeLessThan(15_000);
  });

  it("propagates a non-zero exit code from a command, after flushing stderr", async () => {
    const r = await cli(["swarm", "status", "no-such-run", "--json"]);
    expect(r.code).toBe(1);
    expect(r.stdout.length).toBe(0);
    expect(r.stderr).toBe('unknown run "no-such-run"\n');
  });

  it("exits 2 for an unknown command with the full usage on stdout", async () => {
    const r = await cli(["no-such-command"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("unknown command: no-such-command");
    const usage = r.stdout.toString("utf8");
    expect(usage.startsWith("eminiar v")).toBe(true);
    expect(usage).toContain("swarm watch [--run id]");
  });
});
