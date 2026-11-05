import type { AdjudicatorConfig } from "../../config.js";
import type { Resolved } from "../config.js";
import type { AdjudicatorProvider, ProviderId } from "../types.js";
import type { ProviderDeps } from "./http.js";
import { createOpenAIProvider } from "./openai.js";
import { createTypesafeProvider } from "./typesafe.js";

/**
 * Provider registry (docs/design/adjudicator.md §3, §8). typesafe and openai-compatible are
 * built in. The embedding provider is registered at runtime by the MCP server and the CLI with
 * registerProvider("embedding", ...): this module must never import it, statically or
 * dynamically, so the hook bundle stays free of the embedding model.
 */

export type ProviderFactory = (
  r: Resolved,
  cfg: AdjudicatorConfig,
  deps: ProviderDeps,
) => AdjudicatorProvider;

const factories = new Map<ProviderId, ProviderFactory>([
  ["typesafe", createTypesafeProvider],
  ["openai-compatible", createOpenAIProvider],
]);

/** Add or replace the factory for a provider id (the server registers "embedding"). */
export function registerProvider(id: ProviderId, factory: ProviderFactory): void {
  factories.set(id, factory);
}

/** Test seam: drop runtime registrations and restore the built-ins. */
export function resetProviders(): void {
  factories.clear();
  factories.set("typesafe", createTypesafeProvider);
  factories.set("openai-compatible", createOpenAIProvider);
}

export function hasProvider(id: ProviderId): boolean {
  return factories.has(id);
}

/**
 * The provider for the effective (resolved) provider id, or null when it is the heuristic or no
 * factory is registered (embedding in a hook): the caller then scores with the heuristic alone.
 * It does not check `enabled`; the engine does, and the CLI's `test` runs while disabled.
 */
export function createProvider(
  r: Resolved,
  cfg: AdjudicatorConfig,
  deps: ProviderDeps = {},
): AdjudicatorProvider | null {
  if (r.provider === "heuristic") return null;
  const factory = factories.get(r.provider);
  return factory ? factory(r, cfg, deps) : null;
}

export type { ProviderDeps } from "./http.js";
export { ProviderError, type ProviderErrorKind } from "./http.js";
