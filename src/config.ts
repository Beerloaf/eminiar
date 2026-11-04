import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { MODES, PROVIDER_IDS, TIERS } from "./adjudicator/types.js";
import { paths } from "./paths.js";

export const RoutingMode = z.enum(["off", "annotate", "enforce", "auto"]);
export type RoutingMode = z.infer<typeof RoutingMode>;

/** Field names that look like they hold a credential; only `keyEnv` (an env var NAME) is allowed. */
const SECRET_FIELD = /(api_?key|token|secret|password)/i;

function findSecretFields(v: unknown, path: (string | number)[] = []): (string | number)[][] {
  if (Array.isArray(v)) return v.flatMap((x, i) => findSecretFields(x, [...path, i]));
  if (typeof v !== "object" || v === null) return [];
  const out: (string | number)[][] = [];
  for (const [k, x] of Object.entries(v)) {
    if (k !== "keyEnv" && SECRET_FIELD.test(k)) out.push([...path, k]);
    out.push(...findSecretFields(x, [...path, k]));
  }
  return out;
}

/**
 * The adjudicator section is built on first use, not at import: its ~70 zod nodes cost every
 * hook process ~1 ms to construct and ~1.5 ms to parse for the first time, and the adjudicator
 * is off by default. loadConfig skips it entirely while it is untouched (adjudicatorDefaults).
 */
const buildAdjudicatorObject = () =>
  z.object({
    /** Off by default; EMINIAR_ADJUDICATOR=0 is the kill switch. */
    enabled: z.boolean().default(false),
    provider: z.enum(PROVIDER_IDS).default("heuristic"),
    /** advise = hints only; apply = may set the Agent `model` (best effort). */
    mode: z.enum(MODES).default("advise"),
    surfaces: z
      .object({
        prompt: z.boolean().default(true),
        agent: z.boolean().default(true),
        plan: z.boolean().default(true),
        tools: z.boolean().default(false),
      })
      .prefault({}),
    /** The provider's role on UserPromptSubmit. */
    promptMode: z.enum(["heuristic", "async", "blocking"]).default("async"),
    typesafe: z
      .object({
        model: z.string().default("jev-1.14.0"),
        baseUrl: z.string().url().default("https://api.typesafe.ai/v1"),
      })
      .prefault({}),
    openai: z
      .object({
        preset: z
          .enum(["groq", "cerebras", "ollama", "lmstudio", "llamacpp", "custom"])
          .default("groq"),
        /** Overrides the preset's URL; required for `custom`. */
        baseUrl: z.string().url().optional(),
        /** Overrides the preset's model; required for `custom`. */
        model: z.string().optional(),
        json: z.enum(["schema", "object", "auto"]).default("auto"),
        /** USD per million tokens; without it a preset with an unknown price reports no cost. */
        price: z
          .object({ inPerM: z.number().nonnegative(), outPerM: z.number().nonnegative() })
          .optional(),
      })
      .prefault({}),
    embedding: z
      .object({
        k: z.number().int().positive().default(5),
        minSimilarity: z.number().min(0).max(1).default(0.55),
      })
      .prefault({}),
    /** NAME of an env var holding the key, never the key itself. */
    keyEnv: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "keyEnv is the name of an environment variable")
      .optional(),
    /** Consent to send redacted prompt text to a remote provider; read only from ~/.eminiar/config.json or env. */
    remoteConsent: z.boolean().default(false),
    /**
     * The origins (scheme://host[:port]) the user agreed to, written by the CLI's consent prompt;
     * read only from ~/.eminiar/config.json. Consent covers a remote provider only when its origin
     * is listed here, or it is a built-in preset origin under EMINIAR_ADJUDICATOR_REMOTE=1 (or a
     * legacy `remoteConsent: true` without this list). See resolveAdjudicator().
     */
    remoteConsentOrigins: z.array(z.string().max(512)).max(64).optional(),
    timeouts: z
      .object({
        promptMs: z.number().int().positive().default(1200),
        agentMs: z.number().int().positive().default(800),
        planMs: z.number().int().positive().default(3000),
        localMs: z.number().int().positive().default(600),
        connectMs: z.number().int().positive().default(150),
      })
      .prefault({}),
    minPromptChars: z.number().int().min(0).default(12),
    /** Ordered ladder, smallest first; "fable" may be inserted by the user. */
    tiers: z.array(z.enum(TIERS)).min(1).default(["haiku", "sonnet", "opus"]),
    weights: z
      .object({
        providerMax: z.number().min(0).max(1).default(0.7),
        embeddingMax: z.number().min(0).max(1).default(0.4),
        selfReportScale: z.number().min(0).max(1).default(0.6),
        lowConfidence: z.number().min(0).max(1).default(0.55),
        tierCenters: z
          .record(z.string(), z.number())
          .default({ haiku: 0.6, sonnet: 2.0, opus: 3.4 }),
        /** Per-feature weight overrides (§7.2), e.g. {"design": 2.0, "toolProvider": 0.2}. */
        features: z.record(z.string(), z.number()).default({}),
      })
      .prefault({}),
    apply: z
      .object({
        scope: z.enum(["swarm", "all"]).default("swarm"),
        minConfidence: z.number().min(0).max(1).default(0.7),
        floor: z.enum(TIERS).default("haiku"),
        ceiling: z.enum(TIERS).default("opus"),
        respectFrontmatter: z.boolean().default(true),
      })
      .prefault({}),
    advice: z
      .object({
        mainSession: z.enum(["off", "user", "context"]).default("user"),
        cooldownPrompts: z.number().int().min(0).default(8),
      })
      .prefault({}),
    learning: z
      .object({
        enabled: z.boolean().default(true),
        maxBias: z.number().min(0).max(1).default(0.3),
        minSamples: z.number().int().min(0).default(5),
        halfLife: z.number().positive().default(50),
        costWeight: z.number().min(0).default(0.05),
      })
      .prefault({}),
    cache: z
      .object({
        ttlHours: z.number().positive().default(24),
        maxEntries: z.number().int().positive().default(2000),
      })
      .prefault({}),
    breaker: z
      .object({
        failures: z.number().int().positive().default(2),
        cooldownSec: z.number().int().positive().default(120),
      })
      .prefault({}),
    budget: z
      .object({
        dailyUsd: z.number().nonnegative().default(0.5),
        /**
         * Calls per remote provider per UTC day; 0 = unlimited. Caps providers whose price is
         * unknown (cost null), which dailyUsd cannot limit.
         */
        dailyCalls: z.number().int().nonnegative().default(2000),
      })
      .prefault({}),
    privacy: z
      .object({
        maxChars: z.number().int().positive().default(2000),
        storeHead: z.boolean().default(true),
      })
      .prefault({}),
  });

/**
 * The adjudicator section (docs/design/adjudicator.md §5). The secret-field check runs on the
 * raw input, before zod strips unknown keys, so `{"openai": {"apiKey": "..."}}` is rejected
 * instead of silently dropped.
 */
const buildAdjudicatorSchema = () =>
  z
    .preprocess((v, ctx) => {
      for (const path of findSecretFields(v))
        ctx.issues.push({
          code: "custom",
          input: v,
          path,
          message:
            "adjudicator config must not hold keys or tokens: run `eminiar adjudicator key set`, or set keyEnv to the NAME of an env var",
        });
      return v;
    }, buildAdjudicatorObject())
    .prefault({});
let adjudicatorSchema: ReturnType<typeof buildAdjudicatorSchema> | undefined;
export const AdjudicatorConfigSchema = z.lazy(
  () => (adjudicatorSchema ??= buildAdjudicatorSchema()),
);
export type AdjudicatorConfig = z.infer<ReturnType<typeof buildAdjudicatorObject>>;

/**
 * What AdjudicatorConfigSchema.parse({}) returns, without building the schema. A unit test
 * (tests/unit/adjudicator-config.test.ts) pins the two equal: change both together.
 */
export function adjudicatorDefaults(): AdjudicatorConfig {
  return {
    enabled: false,
    provider: "heuristic",
    mode: "advise",
    surfaces: { prompt: true, agent: true, plan: true, tools: false },
    promptMode: "async",
    typesafe: { model: "jev-1.14.0", baseUrl: "https://api.typesafe.ai/v1" },
    openai: { preset: "groq", json: "auto" },
    embedding: { k: 5, minSimilarity: 0.55 },
    remoteConsent: false,
    timeouts: { promptMs: 1200, agentMs: 800, planMs: 3000, localMs: 600, connectMs: 150 },
    minPromptChars: 12,
    tiers: ["haiku", "sonnet", "opus"],
    weights: {
      providerMax: 0.7,
      embeddingMax: 0.4,
      selfReportScale: 0.6,
      lowConfidence: 0.55,
      tierCenters: { haiku: 0.6, sonnet: 2.0, opus: 3.4 },
      features: {},
    },
    apply: {
      scope: "swarm",
      minConfidence: 0.7,
      floor: "haiku",
      ceiling: "opus",
      respectFrontmatter: true,
    },
    advice: { mainSession: "user", cooldownPrompts: 8 },
    learning: { enabled: true, maxBias: 0.3, minSamples: 5, halfLife: 50, costWeight: 0.05 },
    cache: { ttlHours: 24, maxEntries: 2000 },
    breaker: { failures: 2, cooldownSec: 120 },
    budget: { dailyUsd: 0.5, dailyCalls: 2000 },
    privacy: { maxChars: 2000, storeHead: true },
  };
}

/** Everything but the adjudicator section; loadConfig parses this alone while it is untouched. */
const BaseConfigSchema = z.object({
  routing: z
    .object({
      /** auto = annotate while context-mode is installed, enforce once it is gone. */
      mode: RoutingMode.default("auto"),
      deferToContextMode: z.boolean().default(true),
    })
    .prefault({}),
  sandbox: z
    .object({
      timeoutMs: z.number().int().positive().default(60_000),
      maxOutputBytes: z
        .number()
        .int()
        .positive()
        .default(2 * 1024 * 1024),
      /** Outputs larger than this are indexed and only matching sections are returned. */
      indexThreshold: z
        .number()
        .int()
        .positive()
        .default(5 * 1024),
      /** Extra env var names/globs passed through to sandboxed processes. */
      envAllow: z.array(z.string()).default([]),
      /** Disable specific languages per project (e.g. "javascript" when Bash rules must be enforced). */
      disabledLanguages: z.array(z.string()).default([]),
    })
    .prefault({}),
  search: z
    .object({
      defaultLimit: z.number().int().positive().default(5),
      defaultMaxTokens: z.number().int().positive().default(2000),
    })
    .prefault({}),
  embeddings: z
    .object({
      enabled: z.boolean().default(true),
      model: z.string().default("Xenova/bge-small-en-v1.5"),
      dims: z.number().int().positive().default(384),
    })
    .prefault({}),
  graph: z
    .object({
      include: z
        .array(z.string())
        .default([
          "**/*.ts",
          "**/*.tsx",
          "**/*.js",
          "**/*.jsx",
          "**/*.mjs",
          "**/*.cjs",
          "**/*.py",
          "**/*.go",
          "**/*.php",
        ]),
      exclude: z
        .array(z.string())
        .default([
          "**/node_modules/**",
          "**/dist/**",
          "**/build/**",
          "**/.git/**",
          "**/coverage/**",
          "**/*.d.ts",
          "**/.venv/**",
          "**/venv/**",
          "**/__pycache__/**",
          "**/site-packages/**",
          "**/vendor/**",
          "**/*.min.js",
          "**/*.blade.php",
        ]),
    })
    .prefault({}),
  git: z
    .object({
      maxCommits: z.number().int().positive().default(3000),
    })
    .prefault({}),
  index: z
    .object({
      /** Doc globs indexed by `em_reindex docs` / `eminiar index`. */
      docs: z.array(z.string()).default(["**/*.md", "**/*.mdx"]),
    })
    .prefault({}),
  permissions: z
    .object({
      /** Extra deny rules in Claude Code syntax, e.g. "Bash(rm -rf *)". */
      extraDeny: z.array(z.string()).default([]),
    })
    .prefault({}),
  code: z
    .object({
      /** Symbol backend for parsing and references; tree-sitter ships in the box. */
      backend: z.enum(["tree-sitter"]).default("tree-sitter"),
    })
    .prefault({}),
  memories: z
    .object({
      /** Project-relative directory of markdown memory files (`<topic>/<name>.md`); commit it. */
      dir: z.string().default(".eminiar/memories"),
    })
    .prefault({}),
  recall: z
    .object({
      /** Inject the memories and doc pages that match each prompt (UserPromptSubmit). */
      onPrompt: z.boolean().default(true),
      /**
       * Before a file is read or edited: the memories linked to it; before an edit, also its
       * fix history (bug-prone files) and fan-in (widely imported files).
       */
      onFile: z.boolean().default(true),
      /** Brief subagents with the memories and doc pages that match their task. */
      onAgent: z.boolean().default(true),
      /** Before `git commit`: the bug-prone and widely imported files it includes. */
      onCommit: z.boolean().default(true),
      /** After a failed tool call: earlier occurrences of the error and their resolutions. */
      onError: z.boolean().default(true),
      /** Before WebSearch / WebFetch: the indexed doc pages that already answer it. */
      onWeb: z.boolean().default(true),
      maxMemories: z.number().int().min(0).max(10).default(3),
      maxDocs: z.number().int().min(0).max(10).default(2),
      /**
       * Prompts after which an item already shown in this context window may be injected
       * again when it matches (0 = once per context window only).
       */
      repeatAfter: z.number().int().min(0).max(1000).default(10),
    })
    .prefault({}),
  docs: z
    .object({
      /** Project-relative manifest of documentation sources (`em_docs`); commit it. */
      manifest: z.string().default(".eminiar/docs.json"),
      /** How long fetched documentation pages stay cached before a sync refetches them. */
      ttlHours: z
        .number()
        .positive()
        .default(24 * 7),
      crawl: z
        .object({
          /** Link depth followed from each seed URL (same origin, under the seed's path). */
          depth: z.number().int().min(0).max(3).default(1),
          /** Pages per source per sync; catalogue entries and `add {max_pages}` can raise it. */
          maxPages: z.number().int().positive().max(200).default(8),
          /** A page larger than this is truncated before indexing (reference pages can be megabytes). */
          maxPageBytes: z
            .number()
            .int()
            .positive()
            .default(120 * 1024),
          /**
           * Budget for external APIs — hosts called from code, documentation linked from code,
           * probed docs sites and service-tier catalogue entries. These are indexed in full;
           * `depth`/`maxPages` above only cap dependencies (libraries, infrastructure).
           */
          api: z
            .object({
              depth: z.number().int().min(0).max(3).default(2),
              maxPages: z.number().int().positive().max(200).default(150),
            })
            .prefault({}),
        })
        .prefault({}),
      /**
       * Embed documentation chunks for semantic search. Off by default: lexical search covers
       * documentation well and a crawl should never queue hours of model work.
       */
      embed: z.boolean().default(false),
      discover: z
        .object({
          /** Also propose documentation for devDependencies. */
          includeDev: z.boolean().default(false),
          /** Scan one level of sub-projects (multi-repo workspaces, monorepos). */
          subprojects: z.boolean().default(true),
        })
        .prefault({}),
      /** Extra catalogue entries: {id, title, urls, npm?, pypi?, go?, env?, image?, files?, crawl?}. */
      catalog: z
        .array(
          z.object({
            id: z.string(),
            title: z.string(),
            urls: z.array(z.string()),
            npm: z.array(z.string()).optional(),
            pypi: z.array(z.string()).optional(),
            go: z.array(z.string()).optional(),
            env: z.array(z.string()).optional(),
            image: z.array(z.string()).optional(),
            files: z.array(z.string()).optional(),
            hosts: z.array(z.string()).optional(),
            tags: z.array(z.string()).optional(),
            tier: z.enum(["service", "infra", "library"]).optional(),
            crawl: z
              .object({
                depth: z.number().int().min(0).max(3).optional(),
                maxPages: z.number().int().positive().max(200).optional(),
              })
              .optional(),
          }),
        )
        .default([]),
    })
    .prefault({}),
  usage: z
    .object({
      /** Ingest Claude Code transcripts (tokens, cache, cost per model call) and record statusline snapshots. */
      enabled: z.boolean().default(true),
      /** Soft budgets; crossing one adds a one-line warning to the next prompt (never blocks). */
      budgets: z
        .object({
          sessionUsd: z.number().positive().optional(),
          dailyUsd: z.number().positive().optional(),
          /** A single API call above this is flagged as an expensive turn. */
          turnUsd: z.number().positive().optional(),
        })
        .prefault({}),
      /**
       * Price overrides per model, USD per million tokens, matched by substring of the model id
       * (first match wins). Missing fields fall back to the bundled table.
       */
      pricing: z
        .record(
          z.string(),
          z.object({
            input: z.number().nonnegative().optional(),
            output: z.number().nonnegative().optional(),
            cacheWrite5m: z.number().nonnegative().optional(),
            cacheWrite1h: z.number().nonnegative().optional(),
            cacheRead: z.number().nonnegative().optional(),
          }),
        )
        .default({}),
      /** Show cost, context and plan usage segments in `eminiar statusline`. */
      statusline: z.boolean().default(true),
    })
    .prefault({}),
});

export const ConfigSchema = BaseConfigSchema.extend({ adjudicator: AdjudicatorConfigSchema });

export type Config = z.infer<typeof ConfigSchema>;

function readJson(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch (err) {
    process.stderr.write(`eminiar: ignoring malformed ${file}: ${(err as Error).message}\n`);
    return {};
  }
}

function deepMerge(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const cur = out[k];
    if (isPlainObject(cur) && isPlainObject(v)) out[k] = deepMerge(cur, v);
    else out[k] = v;
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function envOverrides(): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  const mode = process.env.EMINIAR_ROUTING_MODE;
  if (mode && RoutingMode.safeParse(mode).success) o.routing = { mode };
  if (process.env.EMINIAR_EMBEDDINGS === "0") o.embeddings = { enabled: false };
  const adj: Record<string, unknown> = {};
  const on = process.env.EMINIAR_ADJUDICATOR;
  if (on === "0" || on === "1") adj.enabled = on === "1";
  const provider = process.env.EMINIAR_ADJUDICATOR_PROVIDER;
  if (provider && (PROVIDER_IDS as readonly string[]).includes(provider)) adj.provider = provider;
  const amode = process.env.EMINIAR_ADJUDICATOR_MODE;
  if (amode && (MODES as readonly string[]).includes(amode)) adj.mode = amode;
  // EMINIAR_ADJUDICATOR_REMOTE=1 consents only to the built-in preset origins and =0 revokes
  // every consent; resolveAdjudicator() reads the variable itself to tell the two apart.
  const remote = process.env.EMINIAR_ADJUDICATOR_REMOTE;
  if (remote === "0" || remote === "1") adj.remoteConsent = remote === "1";
  if (Object.keys(adj).length) o.adjudicator = adj;
  return o;
}

/**
 * The adjudicator keys a committed <root>/eminiar.config.json may set (docs/design/adjudicator.md
 * §5 "Trust boundary"). A project file comes with any cloned repo, so it must never decide where
 * text or keys go, which key is sent, how much text leaves the machine, or how much is spent:
 * provider, typesafe, openai (preset, baseUrl, model, price), keyEnv, remoteConsent,
 * remoteConsentOrigins, privacy, budget, timeouts and breaker come only from ~/.eminiar/config.json and EMINIAR_* env. What is
 * left only turns the adjudicator on and tunes how verdicts are scored and used locally.
 */
export const PROJECT_ADJUDICATOR_KEYS: readonly string[] = [
  "enabled",
  "mode",
  "surfaces",
  "promptMode",
  "minPromptChars",
  "tiers",
  "weights",
  "apply",
  "advice",
  "embedding",
  "learning",
  "cache",
];

/** The adjudicator keys of a raw project file that projectLayer drops, sorted. */
export function droppedProjectAdjudicatorKeys(raw: Record<string, unknown>): string[] {
  const adj = raw.adjudicator;
  if (!isPlainObject(adj)) return [];
  return Object.keys(adj)
    .filter((k) => !PROJECT_ADJUDICATOR_KEYS.includes(k))
    .sort();
}

/**
 * One line for doctor/status when <root>/eminiar.config.json sets adjudicator keys that only the
 * personal config may set; undefined when it sets none.
 */
export function projectAdjudicatorWarning(projectRoot: string): string | undefined {
  const file = join(projectRoot, "eminiar.config.json");
  if (!existsSync(file)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined; // loadConfig already reports a malformed file
  }
  if (!isPlainObject(raw)) return undefined;
  const dropped = droppedProjectAdjudicatorKeys(raw);
  if (!dropped.length) return undefined;
  return `eminiar.config.json sets adjudicator.${dropped.join(", adjudicator.")}: ignored, only ~/.eminiar/config.json may set ${dropped.length === 1 ? "it" : "them"}`;
}

/**
 * The project layer with its adjudicator section cut down to PROJECT_ADJUDICATOR_KEYS. A section
 * holding a key-like field stays whole instead, so the schema's secret check still refuses it
 * (the whole config falls back to defaults, the adjudicator off) rather than dropping it quietly.
 */
function projectLayer(raw: Record<string, unknown>): Record<string, unknown> {
  const adj = raw.adjudicator;
  if (!isPlainObject(adj)) return raw;
  if (findSecretFields(adj).length) return raw;
  const kept: Record<string, unknown> = {};
  for (const k of PROJECT_ADJUDICATOR_KEYS) if (k in adj) kept[k] = adj[k];
  return { ...raw, adjudicator: kept };
}

/**
 * Precedence: defaults < ~/.eminiar/config.json < <root>/eminiar.config.json < EMINIAR_* env.
 * The project file is the one teams commit.
 */
export function loadConfig(projectRoot: string): Config {
  const merged = deepMerge(
    deepMerge(
      readJson(paths().configFile),
      projectLayer(readJson(join(projectRoot, "eminiar.config.json"))),
    ),
    envOverrides(),
  );
  const parsed = parseConfig(merged);
  if (parsed.success) return parsed.data;
  process.stderr.write(`eminiar: invalid config, using defaults: ${parsed.error.message}\n`);
  return { ...BaseConfigSchema.parse({}), adjudicator: adjudicatorDefaults() };
}

/**
 * ConfigSchema.safeParse, except that an untouched adjudicator section (absent, or only
 * `enabled: false`, e.g. the EMINIAR_ADJUDICATOR=0 kill switch) takes its defaults without
 * building or parsing the adjudicator schema. Anything else in it, including keys the secret
 * check must refuse, goes through the full schema.
 */
function parseConfig(merged: Record<string, unknown>) {
  const { adjudicator: adj, ...rest } = merged;
  const untouched =
    adj === undefined ||
    (isPlainObject(adj) &&
      Object.keys(adj).every((k) => k === "enabled") &&
      (adj.enabled === undefined || adj.enabled === false));
  if (!untouched) return ConfigSchema.safeParse(merged);
  const base = BaseConfigSchema.safeParse(rest);
  if (!base.success) return base;
  return { success: true as const, data: { ...base.data, adjudicator: adjudicatorDefaults() } };
}
