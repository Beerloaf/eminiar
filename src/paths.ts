import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Root of all eminiar state. Override with EMINIAR_HOME (used by tests and the installer). */
export function eminiarHome(): string {
  return process.env.EMINIAR_HOME || join(homedir(), ".eminiar");
}

export interface EminiarPaths {
  home: string;
  projects: string;
  models: string;
  tmp: string;
  plugin: string;
  globalDb: string;
  configFile: string;
  nodePathFile: string;
  /** Package root the bin/ shims fall back to when their own copy has no node_modules. */
  rootPathFile: string;
  installFile: string;
  hookLog: string;
  statuslineCache: string;
  /** Adjudicator provider keys (JSON, mode 0600); written only by `eminiar adjudicator key set`. */
  adjudicatorKey: string;
}

export function paths(): EminiarPaths {
  const home = eminiarHome();
  return {
    home,
    projects: join(home, "projects"),
    models: join(home, "models"),
    tmp: join(home, "tmp"),
    plugin: join(home, "plugin"),
    globalDb: join(home, "global.db"),
    configFile: join(home, "config.json"),
    nodePathFile: join(home, "node-path"),
    rootPathFile: join(home, "root-path"),
    installFile: join(home, "install.json"),
    hookLog: join(home, "hook.log"),
    statuslineCache: join(home, "statusline.cache"),
    adjudicatorKey: join(home, "adjudicator.key"),
  };
}

/** Create the data directories. Idempotent and cheap; safe to call from hooks. */
export function ensureDirs(): EminiarPaths {
  const p = paths();
  for (const dir of [p.home, p.projects, p.models, p.tmp]) {
    mkdirSync(dir, { recursive: true });
  }
  return p;
}

export function projectDir(projectId: string): string {
  const dir = join(paths().projects, projectId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function projectDbPath(projectId: string): string {
  return join(projectDir(projectId), "eminiar.db");
}
