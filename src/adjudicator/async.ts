/**
 * The async provider job (docs/design/adjudicator.md §10 "Async job"). With promptMode "async"
 * the UserPromptSubmit hook answers from the heuristic at once and hands the provider call to a
 * detached child of itself:
 *
 *   spawnAsyncJob(job): process.execPath <hook script> --adjudicate, detached, stdin piped. The
 *     job JSON goes down the pipe and the child is unref'd (~3-5 ms).
 *   runAsyncJob(raw): the child entry (src/hook.ts `--adjudicate`). It resolves the key itself,
 *     calls the provider with the job's budget (2 × promptMs), writes the cache entry and updates
 *     the row the hook inserted, so the same turn's PreToolUse(Agent) can use the verdict.
 *
 * The prompt text exists only in the pipe and in the provider request; it is never written to
 * disk. The job never carries a key: the config holds at most the NAME of an env var.
 */

import { spawn as nodeSpawn } from "node:child_process";
import type { AdjudicatorConfig } from "../config.js";
import { AdjudicatorConfigSchema } from "../config.js";
// Static on purpose: hook.ts already imports both, and a dynamic import() here made each its own
// split chunk that every hook process loaded (src/hook.ts, tsup.config.ts).
import { getContext } from "../context.js";
import { getStorage } from "../storage/index.js";
import type { AdjudicatorStore } from "../storage/types.js";
import type { RuntimeContext } from "./config.js";
import { adjudicate, type EngineOptions, verdictColumns } from "./engine.js";
import type { AdjudicationRequest, AdjudicatorProvider } from "./types.js";
import { SURFACES } from "./types.js";

/** The child's hard limit (src/hook.ts), matching the pending marker's lifetime. */
export const ASYNC_JOB_MAX_MS = 30_000;

export interface AsyncJob {
  v: 1;
  projectRoot: string;
  request: AdjudicationRequest;
  /** The row the hook inserted; the child updates it. */
  rowId?: number;
  cacheKey: string;
  /** The adjudicator config as the hook resolved it (never a key). */
  config: AdjudicatorConfig;
  context: RuntimeContext;
  /** The child's provider budget in ms (2 × the surface budget). */
  budgetMs: number;
  bias?: Record<string, number>;
  tools?: string[];
  roles?: Array<{ name: string; description?: string }>;
}

type SpawnFn = typeof nodeSpawn;

export interface SpawnDeps {
  spawn?: SpawnFn;
  execPath?: string;
  /** The hook script (default process.argv[1], i.e. dist/hook.js inside a hook). */
  script?: string;
  env?: NodeJS.ProcessEnv;
}

/** Start the detached child and write the job to its stdin. Never throws; false when it could not. */
export function spawnAsyncJob(job: AsyncJob, deps: SpawnDeps = {}): boolean {
  try {
    const script = deps.script ?? process.argv[1];
    if (!script) return false;
    const child = (deps.spawn ?? nodeSpawn)(
      deps.execPath ?? process.execPath,
      [script, "--adjudicate"],
      {
        detached: true,
        stdio: ["pipe", "ignore", "ignore"],
        env: deps.env ?? process.env,
      },
    );
    child.on("error", () => {});
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify(job));
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export interface RunDeps {
  /** Default: the project's SQLite store (getStorage(getContext(job.projectRoot))). */
  store?: AdjudicatorStore;
  provider?: AdjudicatorProvider | null;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  log?: (line: string) => void;
  fetch?: NonNullable<EngineOptions["deps"]>["fetch"];
}

export interface RunResult {
  ok: boolean;
  /** Why nothing happened (bad job, disabled, no store). */
  reason?: string;
  source?: string;
  providerStatus?: string;
  rowUpdated?: boolean;
}

/** Parse and sanity-check the job JSON; undefined when it is not a job. */
export function parseJob(raw: string): AsyncJob | undefined {
  try {
    const j = JSON.parse(raw) as Partial<AsyncJob>;
    const req = j?.request;
    if (j?.v !== 1 || typeof j.projectRoot !== "string" || typeof j.cacheKey !== "string")
      return undefined;
    if (!req || typeof req.text !== "string" || typeof req.key !== "string") return undefined;
    if (!(SURFACES as readonly string[]).includes(req.surface)) return undefined;
    const config = AdjudicatorConfigSchema.safeParse(j.config);
    if (!config.success) return undefined;
    const budgetMs = typeof j.budgetMs === "number" && j.budgetMs > 0 ? j.budgetMs : 2400;
    const context: RuntimeContext =
      j.context === "server" || j.context === "cli" ? j.context : "hook";
    const job: AsyncJob = {
      v: 1,
      projectRoot: j.projectRoot,
      request: req,
      cacheKey: j.cacheKey,
      config: config.data,
      context,
      budgetMs: Math.min(budgetMs, ASYNC_JOB_MAX_MS - 1000),
    };
    if (typeof j.rowId === "number") job.rowId = j.rowId;
    if (j.bias && typeof j.bias === "object") job.bias = j.bias;
    if (Array.isArray(j.tools)) job.tools = j.tools;
    if (Array.isArray(j.roles)) job.roles = j.roles;
    return job;
  } catch {
    return undefined;
  }
}

/** The child entry: provider call → cache → row update. Never throws. */
export async function runAsyncJob(raw: string, deps: RunDeps = {}): Promise<RunResult> {
  const log = deps.log ?? (() => {});
  try {
    const job = parseJob(raw);
    if (!job) return { ok: false, reason: "invalid job" };
    if (!job.config.enabled) return { ok: false, reason: "disabled" };
    const store = deps.store ?? (await openStore(job.projectRoot));
    if (!store) return { ok: false, reason: "no store" };

    const opts: EngineOptions = {
      config: job.config,
      store,
      context: job.context,
      call: "inline",
      budgetMs: job.budgetMs,
      persist: false,
      log,
    };
    if (job.bias) opts.bias = job.bias;
    if (job.tools) opts.tools = job.tools;
    if (job.roles) opts.roles = job.roles;
    if (deps.env) opts.env = deps.env;
    if (deps.now) opts.now = deps.now;
    if (deps.provider !== undefined) opts.provider = deps.provider;
    if (deps.fetch) opts.deps = { fetch: deps.fetch };

    const [out] = await adjudicate([job.request], opts);
    if (!out) return { ok: false, reason: "no verdict" };
    const v = out.verdict;
    const res: RunResult = { ok: true, source: v.source, providerStatus: v.providerStatus };
    // Only a provider-backed verdict improves on the heuristic row the hook already wrote; a
    // failure still records its status so stats show why the job fell back.
    if (job.rowId !== undefined) {
      try {
        if (v.source === "blend" || v.source === "cache") {
          // latency_ms stays the hook's own inline latency; the child's time is not the user's wait.
          const { latencyMs: _childLatency, ...cols } = verdictColumns(v, {
            features: out.features,
            providerModel: out.providerModel,
          });
          res.rowUpdated = store.update(job.rowId, cols);
        } else {
          res.rowUpdated = store.update(job.rowId, {
            providerStatus: v.providerStatus,
            providerLatencyMs:
              v.providerLatencyMs !== undefined ? Math.round(v.providerLatencyMs) : null,
          });
        }
      } catch (err) {
        log(`adjudicator: async row update failed: ${(err as Error).message}`);
        res.rowUpdated = false;
      }
    }
    return res;
  } catch (err) {
    log(`adjudicator: async job failed: ${(err as Error)?.message ?? String(err)}`);
    return { ok: false, reason: "error" };
  }
}

async function openStore(projectRoot: string): Promise<AdjudicatorStore | undefined> {
  return getStorage(getContext(projectRoot), { vectors: false }).adjudicator;
}
