import { type Config, configSourceSignature, loadConfig } from "./config.js";
import { ensureDirs, projectDbPath } from "./paths.js";
import { projectId, resolveProjectRoot } from "./project.js";

/** Everything a tool or hook needs that is scoped to one project. */
export interface ProjectContext {
  root: string;
  id: string;
  dbPath: string;
  config: Config;
}

const cache = new Map<string, { ctx: ProjectContext; sig: string }>();

/**
 * Resolve (and memoise per root) the project context. Cheap after the first call: two stat calls
 * check that the personal and project config files (and the EMINIAR_* env loadConfig reads) are
 * unchanged; when they changed, `config` is reloaded in place, so a long-lived MCP server or
 * dashboard honours `features off` or a withdrawn consent on its next call (task #307).
 */
export function getContext(rootHint?: string): ProjectContext {
  const root = resolveProjectRoot(rootHint);
  const hit = cache.get(root);
  if (hit) {
    const sig = configSourceSignature(root);
    if (sig !== hit.sig) {
      hit.sig = sig;
      hit.ctx.config = loadConfig(root);
    }
    return hit.ctx;
  }
  ensureDirs();
  const id = projectId(root);
  // The signature is taken before the files are read, so a write racing the load reloads next time.
  const sig = configSourceSignature(root);
  const ctx: ProjectContext = { root, id, dbPath: projectDbPath(id), config: loadConfig(root) };
  cache.set(root, { ctx, sig });
  return ctx;
}

export function resetContextCache(): void {
  cache.clear();
}
