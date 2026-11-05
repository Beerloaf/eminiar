import type { Config } from "../config.js";
import { TransformersProvider } from "./transformers.js";

export interface EmbeddingProvider {
  readonly model: string;
  readonly dims: number;
  /** True once the model is loaded and embed() will not block on a download. */
  ready(): boolean;
  /** Kick off loading without waiting. */
  warm(): void;
  /** Loads the model if needed, then embeds. Passages and queries use different prefixes. */
  embed(texts: string[], kind: "query" | "passage"): Promise<Float32Array[]>;
  /** Last load error, if any. */
  error(): string | undefined;
}

let instance: EmbeddingProvider | undefined;
let disabled = false;

/**
 * Lazily constructed singleton. TransformersProvider defers the @huggingface/transformers
 * import to its first load, so no process pays for onnxruntime until it embeds. Internal
 * modules are imported statically: the server is one file (tsup.config.ts).
 */
export async function getProvider(config: Config): Promise<EmbeddingProvider | undefined> {
  if (!config.embeddings.enabled || disabled) return undefined;
  if (instance) return instance;
  try {
    instance = new TransformersProvider(config.embeddings.model, config.embeddings.dims);
    return instance;
  } catch (err) {
    disabled = true;
    process.stderr.write(`eminiar: embeddings unavailable: ${(err as Error).message}\n`);
    return undefined;
  }
}

export function providerIfLoaded(): EmbeddingProvider | undefined {
  return instance;
}
