import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureDirs } from "../../src/paths.js";
import { GlobalDb } from "../../src/stats/global.js";
import { SqliteAdapter } from "../../src/storage/sqlite/adapter.js";

const mode = (path: string) => statSync(path).mode & 0o777;
const posix = process.platform !== "win32";

const realHome = process.env.HOME;
afterEach(() => {
  delete process.env.EMINIAR_HOME;
  process.env.HOME = realHome;
});

describe.runIf(posix)("data file modes", () => {
  const dir = (name: string, entries: string[] = []) => {
    const d = join(mkdtempSync(join(tmpdir(), "em-modes-")), name);
    mkdirSync(d);
    for (const e of entries) writeFileSync(join(d, e), "");
    chmodSync(d, 0o755);
    return d;
  };

  it("creates the eminiar home owner-only and tightens an existing one", () => {
    process.env.EMINIAR_HOME = join(mkdtempSync(join(tmpdir(), "em-modes-")), "fresh");
    expect(mode(ensureDirs().home)).toBe(0o700);

    // an older install: nothing but eminiar's state
    const old = dir("old", ["global.db", "global.db-wal", "hook.log"]);
    process.env.EMINIAR_HOME = old;
    ensureDirs();
    expect(mode(old)).toBe(0o700);

    // marked by install.json alone (no global.db yet), with eminiar's own sidecars beside it
    const installed = dir("installed", ["install.json", "config.json", "swarm.key"]);
    process.env.EMINIAR_HOME = installed;
    ensureDirs();
    expect(mode(installed)).toBe(0o700);

    // the default ~/.eminiar, whatever it holds
    delete process.env.EMINIAR_HOME;
    process.env.HOME = mkdtempSync(join(tmpdir(), "em-user-"));
    const dflt = join(process.env.HOME, ".eminiar");
    mkdirSync(dflt, { mode: 0o755 });
    writeFileSync(join(dflt, "notes.txt"), "");
    chmodSync(dflt, 0o755);
    ensureDirs();
    expect(mode(dflt)).toBe(0o700);
  });

  it("leaves a project or shared folder that EMINIAR_HOME points at as its owner set it", () => {
    // a repo's settings can set EMINIAR_HOME, relative to the hook's cwd ("." is the project)
    const project = dir("project", ["package.json", "global.db"]);
    process.env.EMINIAR_HOME = relative(process.cwd(), project);
    ensureDirs();
    expect(mode(project)).toBe(0o755);
    // an empty folder, or one with only folders eminiar would add, carries no mark of eminiar
    for (const entries of [[], ["tmp"]]) {
      const bare = dir("bare");
      for (const e of entries) mkdirSync(join(bare, e));
      process.env.EMINIAR_HOME = bare;
      ensureDirs();
      expect(mode(bare)).toBe(0o755);
    }
  });

  it("creates a project database and its -wal and -shm owner-only", () => {
    const path = join(mkdtempSync(join(tmpdir(), "em-modes-")), "eminiar.db");
    const db = new SqliteAdapter(path, { vectors: false });
    db.metaSet("probe", "1");
    for (const f of [path, `${path}-wal`, `${path}-shm`]) expect(mode(f), f).toBe(0o600);
    db.close();
  });

  it("tightens the files of an existing database when it opens", () => {
    const path = join(mkdtempSync(join(tmpdir(), "em-modes-")), "eminiar.db");
    new SqliteAdapter(path, { vectors: false }).close();
    for (const f of [path, `${path}-wal`, `${path}-shm`]) {
      writeFileSync(f, "", { flag: "a" });
      chmodSync(f, 0o644);
    }
    const db = new SqliteAdapter(path, { vectors: false });
    for (const f of [path, `${path}-wal`, `${path}-shm`]) expect(mode(f), f).toBe(0o600);
    db.close();
  });

  it("keeps the global database owner-only too", () => {
    const path = join(mkdtempSync(join(tmpdir(), "em-modes-")), "global.db");
    const g = new GlobalDb(path);
    g.cacheSet("https://example.com", null, "page", 1000);
    for (const f of [path, `${path}-wal`, `${path}-shm`]) expect(mode(f), f).toBe(0o600);
    g.close();
  });
});
