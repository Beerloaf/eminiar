import type { Resolved } from "../../adjudicator/config.js";
import type { Embedder } from "../../adjudicator/providers/embedding.js";
import type { ProviderDeps } from "../../adjudicator/providers/http.js";
import type { AdjudicatorConfig } from "../../config.js";
import { createEmbeddingDecisionProvider } from "./embedding.js";
import { createJevDecisionProvider } from "./jev.js";
import { createOpenAIDecisionProvider } from "./openai.js";
import type { DecisionProvider } from "./types.js";

/**
 * The decision provider for the adjudicator's effective provider, or undefined for the
 * heuristic (nothing can answer). The embedding provider needs `getEmbedder`, which only the MCP
 * server and CLI supply.
 */
export function createDecisionProvider(
  r: Resolved,
  cfg: AdjudicatorConfig,
  deps: ProviderDeps & { getEmbedder?: (() => Promise<Embedder | undefined>) | undefined } = {},
): DecisionProvider | undefined {
  switch (r.provider) {
    case "typesafe":
      return createJevDecisionProvider(r, cfg, deps);
    case "openai-compatible":
      return createOpenAIDecisionProvider(r, cfg, deps);
    case "embedding":
      return createEmbeddingDecisionProvider(cfg, deps.getEmbedder);
    default:
      return undefined;
  }
}

export type { DecisionProvider } from "./types.js";
