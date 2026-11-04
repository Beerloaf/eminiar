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
import { addTasks, callerOf, startRun, updateTask } from "../../src/swarm/runtime.js";
import type { RunRow } from "../../src/swarm/types.js";

/**
 * `eminiar swarm watch | head -1` (or `| grep -m1 swarm.idle`) closes the pipe after the line it
 * wanted. The next change watch printed used to die on an unhandled 'error' event (write EPIPE)
 * with a stack trace and exit 1; a CLI whose reader went away should stop quietly with 0.
 * Runs the built CLI: `npm run build` first.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = join(ROOT, "dist", "cli.js");

let home: string;
let root: string;
let run: RunRow;
const saved = { home: process.env.EMINIAR_HOME, emb: process.env.EMINIAR_EMBEDDINGS };

beforeAll(() => {
  if (!existsSync(CLI)) throw new Error(`${CLI} is missing: run \`npm run build\` first`);
  home = mkdtempSync(join(tmpdir(), "em-watch-home-"));
  root = mkdtempSync(join(tmpdir(), "em-watch-root-"));
  process.env.EMINIAR_HOME = home;
  process.env.EMINIAR_EMBEDDINGS = "0";
  writeFileSync(join(root, "package.json"), '{"name":"watch-pipe-demo"}');
  const file = swarmFile(root).file;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, STARTER_YAML);
  resetContextCache();
  resetSwarmConfigCache();

  const ctx = getContext(root);
  const db = getStorage(ctx);
  const cfg = activeSwarmConfig(root)!;
  const swarm = cfg.swarms[0]!;
  run = startRun(db, cfg, { swarm: swarm.name, goal: "watch into a closed pipe", sessionId: "S1" });
  addTasks(
    db,
    ctx,
    run,
    swarm,
    callerOf(cfg, {}),
    Array.from({ length: 20 }, (_, i) => ({ title: `task ${i}` })),
  );
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

describe("eminiar swarm watch writing to a pipe whose reader goes away", () => {
  it("exits 0 with nothing on stderr once the pipe is closed", async () => {
    const child = spawn(
      process.execPath,
      [CLI, "swarm", "watch", "--run", run.id, "--interval", "0.25"],
      {
        cwd: root,
        env: { ...process.env, EMINIAR_HOME: home, EMINIAR_EMBEDDINGS: "0" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    const exited = new Promise<number | null>((done) => child.on("close", (code) => done(code)));

    // Read the first line, then close the read end the way `head -1` does.
    const first = await new Promise<string>((done, fail) => {
      let buf = "";
      child.stdout.on("data", (c: Buffer) => {
        buf += c.toString("utf8");
        const nl = buf.indexOf("\n");
        if (nl >= 0) done(buf.slice(0, nl));
      });
      child.on("error", fail);
    });
    expect(JSON.parse(first)).toMatchObject({ type: "swarm.snapshot", run: run.id });
    child.stdout.destroy();

    // Change the run until watch has printed into the closed pipe and gone.
    const ctx = getContext(root);
    const db = getStorage(ctx);
    const caller = callerOf(activeSwarmConfig(root)!, {});
    let code: number | null | undefined;
    const tasks = db.swarm.tasks(run.id);
    for (const t of tasks) {
      updateTask(db, run, caller, { task: t.id, status: "done" });
      code = await Promise.race([
        exited,
        new Promise<undefined>((r) => setTimeout(() => r(undefined), 600)),
      ]);
      if (code !== undefined) break;
    }
    if (code === undefined) child.kill();
    expect(code).toBe(0);
    expect(stderr).toBe("");
  }, 30_000);
});
