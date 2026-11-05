#!/usr/bin/env node
// PostToolUse hook for swarm coders: format only the file that was just edited.
// Formatting the whole tree would rewrite files other workers are still editing.
import { spawnSync } from "node:child_process";

let raw = "";
process.stdin.on("data", (c) => {
  raw += c;
});
process.stdin.on("end", () => {
  let file;
  try {
    file = JSON.parse(raw)?.tool_input?.file_path;
  } catch {
    process.exit(0);
  }
  if (typeof file !== "string" || !/\.(ts|tsx|js|mjs|json)$/.test(file)) process.exit(0);
  spawnSync(
    "npx",
    ["--no-install", "biome", "check", "--write", "--no-errors-on-unmatched", "--files-ignore-unknown=true", file],
    { stdio: "ignore", timeout: 25_000 },
  );
  process.exit(0); // never block the worker; lint errors surface in `npm run lint`
});
