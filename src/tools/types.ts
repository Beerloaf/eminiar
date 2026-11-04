import type { z } from "zod";
import type { Config } from "../config.js";
import type { ProjectContext } from "../context.js";

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  schema: S;
  handler: (args: z.infer<z.ZodObject<S>>, ctx: ProjectContext) => Promise<ToolResult>;
  /**
   * Whether the server lists the tool for the config loaded at start (default: always). An
   * opt-in feature's tool is left out while the feature is off, so its schema costs nothing.
   */
  available?: (config: Config) => boolean;
}

/** The tools to register for `config`: those without `available`, or whose check passes. */
export function availableTools<T extends Pick<ToolDef, "available">>(
  all: readonly T[],
  config: Config,
): T[] {
  return all.filter((t) => {
    try {
      return t.available ? t.available(config) : true;
    } catch {
      return false;
    }
  });
}

/** Identity helper that pins the generic so handlers get typed args. */
export function defineTool<S extends z.ZodRawShape>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

export function text(s: string): ToolResult {
  return { content: [{ type: "text", text: s }] };
}

export function errorResult(s: string): ToolResult {
  return { content: [{ type: "text", text: s }], isError: true };
}
