import { dispatch, gate } from "./hooks/dispatch.js";
import { hookLog } from "./hooks/log.js";

/**
 * Single hook entry point. hooks.json (Claude Code) and ~/.cursor/hooks.json (Cursor)
 * route every event here; we dispatch on `hook_event_name` from stdin and answer in the
 * dialect of whichever client called (`--client cursor`, or detected from the payload).
 * Contract: stdout is JSON only, exit 0 means "continue". We never exit non-zero — a
 * broken hook must not block the model — except `--gate` (decide-only swarm enforcement for a
 * user's `onFailure: "block"` entry), where any error exits 1.
 * `--adjudicate` is the adjudicator's detached async job (src/adjudicator/async.ts): the job JSON
 * arrives on stdin, nobody reads stdout, and a hard timer ends the process however the job goes.
 * `--decision` is the same for the Jev feature jobs (src/decisions/job.ts).
 */
/** The Jev job child's hard limit; the longest feature budget stays below it. */
const DECISION_JOB_MAX_MS = 29_000;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const raw = await readStdin();
  if (process.argv.includes("--gate")) {
    process.stdout.write(gate(raw));
    return;
  }
  if (process.argv.includes("--adjudicate")) {
    // Loaded only here: the engine, providers and their config parsing stay out of every
    // ordinary hook process (the adjudicator is off by default).
    const { ASYNC_JOB_MAX_MS, runAsyncJob } = await import("./adjudicator/async.js");
    setTimeout(() => process.exit(0), ASYNC_JOB_MAX_MS).unref();
    await runAsyncJob(raw, { log: (line) => hookLog("info", line) });
    return;
  }
  if (process.argv.includes("--decision")) {
    // The Jev feature job (src/decisions/job.ts): its own chunk, loaded only here.
    const { runDecisionJob } = await import("./decisions/job.js");
    setTimeout(() => process.exit(0), DECISION_JOB_MAX_MS).unref();
    await runDecisionJob(raw, { log: (line) => hookLog("info", line) });
    return;
  }
  process.stdout.write(await dispatch(raw, process.argv.slice(2)));
}

main().catch((err) => {
  hookLog("error", `fatal: ${(err as Error).stack ?? String(err)}`);
  if (process.argv.includes("--gate")) {
    // Gate mode fails closed: a non-zero exit makes the user's onFailure:"block" entry block.
    process.stderr.write(`eminiar hook --gate: ${(err as Error).message ?? String(err)}\n`);
    process.exit(1);
  }
  process.stdout.write("{}");
});
