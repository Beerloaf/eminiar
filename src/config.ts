import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { MODES, PROVIDER_IDS, TIERS } from "./adjudicator/types.js";
import { paths } from "./paths.js";

export const RoutingMode = z.enum(["off", "annotate", "enforce", "auto"]);
export type RoutingMode = z.infer<typeof RoutingMode>;

/**
 * A relative path that stays inside the folder it is joined to: not empty, no leading `/` or
 * `\`, no drive letter, no `..` segment (either separator), no control character (`\p{Cc}`: NUL, newline,
 * ...). Lexical only: symlinks are checked where the path is used (src/docs/manifest.ts). The
 * `..` lookahead reads `[\s\S]` so a line break could never hide a segment from it, and it also
 * refuses `.. ` / `...` segments, which Windows trims to `..` (trailing dots and spaces).
 */
export const PROJECT_RELATIVE_PATH_RE =
  /^(?![/\\])(?![A-Za-z]:)(?!(?:[\s\S]*[/\\])?\.\.[. ]*(?:[/\\]|$))[^\p{Cc}]+$/u;

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
/** The default commit-advice exclusions: lock files, minified output and anything key-shaped. */
export const COMMIT_EXCLUDE = [
  "**/*.lock",
  "**/package-lock.json",
  "**/*.min.*",
  "**/.env*",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/id_rsa*",
  "**/id_ed25519*",
  "**/id_ecdsa*",
  "**/*.pfx",
  "**/*.p8",
  "**/*.ppk",
  "**/*.env.*",
  "**/*.env.json",
  "**/secrets/**",
  "**/secrets.*",
  "**/.secrets*",
  "**/*.secrets.*",
  "**/credentials*",
  "**/*credentials*.json",
  "**/service-account*.json",
  "**/*service-account*.json",
  "**/.netrc",
  "**/.pgpass",
  "**/kubeconfig*",
  "**/.aws/**",
];

/**
 * One decision feature (docs/design/jev-integration-options.md): an object, or true/false as shorthand
 * for {enabled}. Shadow (record only, change nothing) is on by default.
 */
const decisionFeature = <T extends z.ZodRawShape>(maxCallsPerDay: number, shape: T) =>
  z
    .preprocess(
      (v) => (typeof v === "boolean" ? { enabled: v } : v),
      z.object({
        enabled: z.boolean().default(false),
        shadow: z.boolean().default(true),
        maxCallsPerDay: z.number().int().nonnegative().default(maxCallsPerDay),
        ...shape,
      }),
    )
    .prefault({});

const prob = (d: number) => z.number().min(0).max(1).default(d);
const ms = (d: number) => z.number().int().positive().default(d);

/**
 * The provider-generic decision features (adjudicator.features.*): they run on whichever provider
 * the adjudicator is configured with. Personal config only: "features" and "featureConsent" are
 * deliberately not in PROJECT_ADJUDICATOR_KEYS. EMINIAR_ADJUDICATOR_FEATURES=0 withdraws every
 * feature; no env var grants one.
 */
const buildFeaturesObject = () =>
  z
    .object({
      recall: decisionFeature(500, {
        dropBelow: prob(0.25),
        mcpMs: ms(1200),
        jobMs: ms(2500),
        maxChars: ms(600),
      }),
      memory: decisionFeature(100, {
        minProb: prob(0.6),
        k: ms(5),
        mcpMs: ms(1500),
        maxChars: ms(1500),
      }),
      commit: decisionFeature(100, {
        minProb: prob(0.7),
        jobMs: ms(4000),
        maxChars: ms(4000),
        exclude: z
          .array(z.string().max(256))
          .max(64)
          .default([...COMMIT_EXCLUDE]),
      }),
      compaction: decisionFeature(50, {
        output: z.boolean().default(false),
        minKeep: prob(0.3),
        jobMs: ms(4000),
        mcpMs: ms(800),
        maxChars: ms(400),
      }),
      swarm: decisionFeature(300, {
        flagAbove: prob(0.7),
        bgMs: ms(3000),
        maxChars: ms(600),
      }),
      docs: decisionFeature(20, { minScore: prob(0.5), mcpMs: ms(3000) }),
    })
    .prefault({});

/** The adjudicator section's fields except `features`, which has a schema of its own. */
const adjudicatorFields = () => ({
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
  /**
   * Consent to send redacted prompt text to a remote provider; granted only by
   * ~/.eminiar/config.json. EMINIAR_ADJUDICATOR_REMOTE=0 withdraws it; no env var grants it.
   */
  remoteConsent: z.boolean().default(false),
  /**
   * The origins (scheme://host[:port]) the user agreed to, written by the CLI's consent prompt;
   * read only from ~/.eminiar/config.json. Consent covers a remote provider only when its origin
   * is listed here (or, for a legacy `remoteConsent: true` without this list, a built-in preset
   * origin of a provider the env did not pick). See resolveAdjudicator().
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
  /**
   * Ordered ladder, smallest first; "fable" may be inserted by the user. Every provider request
   * carries the whole ladder and a committed project file may set it, so it is bounded: each
   * tier at most once (task #56).
   */
  tiers: z
    .array(z.enum(TIERS))
    .min(1)
    .max(TIERS.length)
    .refine((t) => new Set(t).size === t.length, "adjudicator.tiers must not repeat a tier")
    .meta({ uniqueItems: true })
    .default(["haiku", "sonnet", "opus"]),
  weights: z
    .object({
      providerMax: z.number().min(0).max(1).default(0.7),
      embeddingMax: z.number().min(0).max(1).default(0.4),
      selfReportScale: z.number().min(0).max(1).default(0.6),
      lowConfidence: z.number().min(0).max(1).default(0.55),
      tierCenters: z
        .record(z.string().max(32), z.number())
        .refine((o) => Object.keys(o).length <= 16, "at most 16 tier centers")
        .meta({ maxProperties: 16 })
        .default({ haiku: 0.6, sonnet: 2.0, opus: 3.4 }),
      /** Per-feature weight overrides (§7.2), e.g. {"design": 2.0, "toolProvider": 0.2}. */
      features: z
        .record(z.string().max(64), z.number())
        .refine((o) => Object.keys(o).length <= 64, "at most 64 feature weights")
        .meta({ maxProperties: 64 })
        .default({}),
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
      /**
       * Keep the newest 100 requests sent to Jev and its answers (redacted prompt text
       * included). Personal ~/.eminiar/config.json only; eminiar.config.json cannot set it.
       * EMINIAR_ADJUDICATOR_CAPTURE=0 turns it off; no env var turns it on.
       */
      captureExchanges: z.boolean().default(false),
    })
    .prefault({}),
});

/** "<dataClass>@<origin>" lines written by `eminiar adjudicator features on`; personal config only. */
const featureConsentField = () => z.array(z.string().max(512)).max(32).default([]);

const buildAdjudicatorObject = () =>
  z.object({
    ...adjudicatorFields(),
    features: buildFeaturesObject(),
    featureConsent: featureConsentField(),
  });

/**
 * The adjudicator section (docs/design/adjudicator.md §5). The secret-field check runs on the
 * raw input, before zod strips unknown keys, so `{"openai": {"apiKey": "..."}}` is rejected
 * instead of silently dropped. `lean` leaves the `features` schema out (parseConfig fills in
 * featureDefaults() when the input has no `features` key), so an adjudicator without feature
 * settings does not build and run that schema in every hook process (F7).
 */
const withSecretCheck = <T extends z.ZodType>(inner: T) =>
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
    }, inner)
    .prefault({});
const buildAdjudicatorSchema = () => withSecretCheck(buildAdjudicatorObject());
let adjudicatorSchema: ReturnType<typeof buildAdjudicatorSchema> | undefined;
export const AdjudicatorConfigSchema = z.lazy(
  () => (adjudicatorSchema ??= buildAdjudicatorSchema()),
);
const buildLeanConfigSchema = () =>
  BaseConfigSchema.extend({
    adjudicator: withSecretCheck(
      z.object({ ...adjudicatorFields(), featureConsent: featureConsentField() }),
    ),
  });
let leanConfigSchema: ReturnType<typeof buildLeanConfigSchema> | undefined;
export type AdjudicatorConfig = z.infer<ReturnType<typeof buildAdjudicatorObject>>;

/**
 * What AdjudicatorConfigSchema.parse({}) returns, without building the schema. A unit test
 * (tests/unit/adjudicator-config.test.ts) pins the two equal: change both together.
 */
function featureDefaults(): AdjudicatorConfig["features"] {
  const f = { enabled: false, shadow: true };
  return {
    recall: {
      ...f,
      maxCallsPerDay: 500,
      dropBelow: 0.25,
      mcpMs: 1200,
      jobMs: 2500,
      maxChars: 600,
    },
    memory: { ...f, maxCallsPerDay: 100, minProb: 0.6, k: 5, mcpMs: 1500, maxChars: 1500 },
    commit: {
      ...f,
      maxCallsPerDay: 100,
      minProb: 0.7,
      jobMs: 4000,
      maxChars: 4000,
      exclude: [...COMMIT_EXCLUDE],
    },
    compaction: {
      ...f,
      maxCallsPerDay: 50,
      output: false,
      minKeep: 0.3,
      jobMs: 4000,
      mcpMs: 800,
      maxChars: 400,
    },
    swarm: { ...f, maxCallsPerDay: 300, flagAbove: 0.7, bgMs: 3000, maxChars: 600 },
    docs: { ...f, maxCallsPerDay: 20, minScore: 0.5, mcpMs: 3000 },
  };
}

/**
 * Is any decision feature switched on? A pure property walk, so a hook can decide whether to import
 * src/decisions at all: with every feature off, no hook loads a decisions module.
 */
export function featuresWanted(cfg: AdjudicatorConfig): boolean {
  if (!cfg.enabled) return false;
  const f = cfg.features;
  return (
    f.recall.enabled ||
    f.memory.enabled ||
    f.commit.enabled ||
    f.compaction.enabled ||
    f.swarm.enabled ||
    f.docs.enabled
  );
}

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
    privacy: { maxChars: 2000, storeHead: true, captureExchanges: false },
    features: featureDefaults(),
    featureConsent: [],
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
      /**
       * Project-relative manifest of documentation sources (`em_docs`); commit it. Absolute
       * paths and `..` segments are refused: em_docs rewrites this file.
       */
      manifest: z
        .string()
        .regex(PROJECT_RELATIVE_PATH_RE, "must be a path inside the project (no leading / or ..)")
        .default(".eminiar/docs.json"),
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

/**
 * Keys a config object never has and must never be copied (task #62): JSON.parse makes
 * `"__proto__"` an OWN key, and assigning it (`out[k] = v`, as a merge does) calls the prototype
 * setter, so a committed file could hand every later read inherited keys that no allowlist sees.
 * `constructor` and `prototype` are the other two steps of the usual pollution chain.
 */
const UNSAFE_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/**
 * A plain copy of a JSON value: own enumerable keys only, without __proto__, constructor and
 * prototype at any depth, every object an ordinary one created here. Everything read from a
 * config file goes through it before it is merged, cut down or parsed.
 */
export function ownJson(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(ownJson);
  if (typeof v !== "object" || v === null) return v;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v)) {
    if (UNSAFE_KEYS.has(k)) continue;
    out[k] = ownJson((v as Record<string, unknown>)[k]);
  }
  return out;
}

/** JSON.parse, then ownJson: no prototype keys survive at any depth. Throws like JSON.parse. */
export function parseJsonSafe(text: string): unknown {
  return ownJson(JSON.parse(text));
}

function readJson(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  try {
    const raw = parseJsonSafe(readFileSync(file, "utf8"));
    return isPlainObject(raw) ? raw : {};
  } catch (err) {
    process.stderr.write(`eminiar: ignoring malformed ${file}: ${(err as Error).message}\n`);
    return {};
  }
}

/** `b` over `a`, recursively for objects; own keys only, the UNSAFE_KEYS never copied. */
function deepMerge(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(a)) if (!UNSAFE_KEYS.has(k)) out[k] = a[k];
  for (const k of Object.keys(b)) {
    if (UNSAFE_KEYS.has(k)) continue;
    const v = b[k];
    const cur = Object.hasOwn(out, k) ? out[k] : undefined;
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
  // A remote provider picked here runs only when remoteConsentOrigins in ~/.eminiar/config.json
  // lists its origin; otherwise resolveAdjudicator() degrades it with no_consent.
  const provider = process.env.EMINIAR_ADJUDICATOR_PROVIDER;
  if (provider && (PROVIDER_IDS as readonly string[]).includes(provider)) adj.provider = provider;
  const amode = process.env.EMINIAR_ADJUDICATOR_MODE;
  if (amode && (MODES as readonly string[]).includes(amode)) adj.mode = amode;
  // Env vars can only WITHDRAW remote consent (task #48): a cloned repo's .claude/settings.json
  // `env` block reaches the session and its hooks, so EMINIAR_ADJUDICATOR_REMOTE=1 grants
  // nothing. Consent comes only from ~/.eminiar/config.json (remoteConsentOrigins, written by the
  // CLI after an explicit yes). =0 revokes every consent.
  if (process.env.EMINIAR_ADJUDICATOR_REMOTE === "0") adj.remoteConsent = false;
  // The same rule for the Jev exchange log: =0 turns capture off, =1 grants nothing.
  if (process.env.EMINIAR_ADJUDICATOR_CAPTURE === "0") adj.privacy = { captureExchanges: false };
  if (Object.keys(adj).length) o.adjudicator = adj;
  return o;
}

/**
 * The adjudicator keys a committed <root>/eminiar.config.json may set (docs/design/adjudicator.md
 * §5 "Trust boundary"). A project file comes with any cloned repo, so it must never decide where
 * text or keys go, which key is sent, how much text leaves the machine, or how much is spent:
 * provider, typesafe, openai (preset, baseUrl, model, price), keyEnv, remoteConsent,
 * remoteConsentOrigins, privacy, budget, timeouts and breaker come only from ~/.eminiar/config.json
 * and EMINIAR_* env (which can withdraw remote consent but never grant it). What is
 * left only turns the adjudicator on and tunes how verdicts are scored and used locally.
 * privacy also holds captureExchanges (storing Jev requests with prompt text), one more reason
 * it stays out.
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
 * One line for doctor/status/dashboard when adjudicator keys that only the personal config may
 * set are ignored: set by <root>/eminiar.config.json, or by a "personal" config.json that lives
 * inside the project (personalConfigTrusted). Undefined when nothing is ignored.
 */
export function projectAdjudicatorWarning(projectRoot: string): string | undefined {
  const lines: string[] = [];
  const personal = personalAdjudicatorWarning(projectRoot);
  if (personal) lines.push(personal);
  const raw = readJsonQuiet(join(projectRoot, "eminiar.config.json"));
  const dropped = raw ? droppedProjectAdjudicatorKeys(raw) : [];
  if (dropped.length)
    lines.push(
      `eminiar.config.json sets adjudicator.${dropped.join(", adjudicator.")}: ignored, only ~/.eminiar/config.json may set ${dropped.length === 1 ? "it" : "them"}`,
    );
  return lines.length ? lines.join(" · ") : undefined;
}

/**
 * The warning for an untrusted personal config (task #54); the keys come first, before any
 * ":", so the dashboard can read them out of the line.
 */
function personalAdjudicatorWarning(projectRoot: string): string | undefined {
  const file = paths().configFile;
  const raw = readJsonQuiet(file);
  const dropped = raw ? droppedProjectAdjudicatorKeys(raw) : [];
  if (!dropped.length) return undefined;
  const problem = personalConfigProblem(projectRoot, file);
  if (!problem) return undefined;
  return `adjudicator.${dropped.join(", adjudicator.")} ignored: ${file} ${problem}, and only a config at an absolute path outside the project may set ${dropped.length === 1 ? "it" : "them"}`;
}

/** A JSON object file, or undefined when it is missing, malformed or not an object. */
function readJsonQuiet(file: string): Record<string, unknown> | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const raw = parseJsonSafe(readFileSync(file, "utf8"));
    return isPlainObject(raw) ? raw : undefined;
  } catch {
    return undefined; // loadConfig already reports a malformed file
  }
}

// --- trust anchor for the personal config (task #54) ---------------------------------------

const CASE_INSENSITIVE_FS = process.platform === "darwin" || process.platform === "win32";

/**
 * realpath (canonical case where the OS gives it); for a path that does not exist yet, the real
 * path of its nearest existing ancestor plus the rest, so a file about to be written is placed too.
 */
function realPath(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync.native(abs);
  } catch {
    const parent = dirname(abs);
    return parent === abs ? abs : join(realPath(parent), basename(abs));
  }
}

function samePath(a: string, b: string): boolean {
  return CASE_INSENSITIVE_FS ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** `child` is `parent` or below it (both real paths). */
function isInside(child: string, parent: string): boolean {
  const rel = relative(
    CASE_INSENSITIVE_FS ? parent.toLowerCase() : parent,
    CASE_INSENSITIVE_FS ? child.toLowerCase() : child,
  );
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * The OS account's home directory from the user database (os.userInfo(), i.e. getpwuid on
 * POSIX), never $HOME: an env block cannot move it. Undefined when the lookup fails.
 */
function accountHome(): string | undefined {
  try {
    return userInfo().homedir || undefined;
  } catch {
    return undefined;
  }
}

/** How many ancestors gitWorktrees climbs, and how many work trees it lists, at most. */
const MAX_GIT_DEPTH = 128;
const MAX_WORKTREES = 256;

/**
 * Every git work tree that encloses `start` or shares a repository with one: each ancestor
 * holding `.git` (not only the nearest, so the superproject of a submodule and a repo nested in
 * another are both found), the main and linked work trees of each (`git worktree`), and the
 * superproject that owns a submodule's git dir (`gitdir: <super>/.git/modules/<name>`), with the
 * same walk from there. Read from the files git keeps (`.git` file → gitdir → commondir →
 * worktrees/<name>/gitdir), so no git process is spawned.
 */
function gitWorktrees(start: string): string[] {
  const out = new Set<string>();
  const visited = new Set<string>();
  const modulesMark = `${sep}.git${sep}modules${sep}`;

  /** One directory holding `.git`: it, its repository's other work trees, its superproject. */
  const visit = (dir: string, isFile: boolean): void => {
    if (visited.has(dir) || out.size >= MAX_WORKTREES) return;
    visited.add(dir);
    out.add(dir);
    const dotGit = join(dir, ".git");
    try {
      let gitDir = dotGit;
      if (isFile) {
        const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
        if (!m?.[1]) return;
        gitDir = resolve(dir, m[1].trim());
      }
      // A submodule's git dir lives in its superproject's .git/modules: anchor that work tree.
      const cmp = CASE_INSENSITIVE_FS ? gitDir.toLowerCase() : gitDir;
      const at = cmp.indexOf(modulesMark);
      if (at > 0) climb(gitDir.slice(0, at));
      let common = gitDir;
      try {
        common = resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim());
      } catch {
        // a main work tree's .git directory is its own common dir
      }
      if (basename(common) === ".git") out.add(dirname(common));
      const wt = join(common, "worktrees");
      let names: string[] = [];
      try {
        names = readdirSync(wt).slice(0, MAX_WORKTREES);
      } catch {
        // no linked work trees
      }
      for (const name of names) {
        try {
          const g = readFileSync(join(wt, name, "gitdir"), "utf8").trim();
          if (g) out.add(dirname(resolve(wt, name, g)));
        } catch {
          // a pruned or half-written entry
        }
      }
    } catch {
      // an unreadable .git: the enclosing work tree alone is still an anchor
    }
  };

  /** `from` and every ancestor of it that holds `.git`. */
  const climb = (from: string): void => {
    let dir = from;
    for (let i = 0; i < MAX_GIT_DEPTH; i++) {
      let isFile: boolean | undefined;
      try {
        isFile = statSync(join(dir, ".git")).isFile();
      } catch {
        isFile = undefined;
      }
      if (isFile !== undefined) visit(dir, isFile);
      const parent = dirname(dir);
      if (parent === dir) return;
      dir = parent;
    }
  };

  climb(start);
  return [...out];
}

/**
 * Whether `file` (default: paths().configFile; also the key file) is the user's own and may set
 * the adjudicator keys that decide where text and keys go (tasks #54, #63). A trusted project's
 * .claude/settings.json `env` block reaches the hooks, so it could point EMINIAR_HOME (or HOME,
 * which os.homedir() reads) at a config.json the repo ships. The rules:
 * - a relative path (a relative EMINIAR_HOME or HOME) is never trusted: it resolves against
 *   whatever directory the process starts in, which the repo decides;
 * - the anchor the repo cannot move is the account's own home from the user database: a file
 *   directly in <account home>/.eminiar is always trusted;
 * - any other location is trusted only when its real path is neither inside nor an ancestor of
 *   (its folder is not at or above) the project root, the current directory, or any git work
 *   tree enclosing either, including the superproject of a submodule and linked work trees. A
 *   cloned repo cannot write outside its own checkout without running code.
 * The file need not exist yet.
 */
export function personalConfigTrusted(
  projectRoot: string,
  file: string = paths().configFile,
): boolean {
  return personalConfigProblem(projectRoot, file) === undefined;
}

/**
 * Why personalConfigTrusted refuses `file`, as a phrase that follows the path ("<file> is …"),
 * or undefined when it is trusted.
 */
export function personalConfigProblem(
  projectRoot: string,
  file: string = paths().configFile,
): string | undefined {
  if (!isAbsolute(file))
    return "is a relative path (EMINIAR_HOME or HOME is relative, so the directory a session starts in decides where it points)";
  const real = realPath(file);
  const home = accountHome();
  if (home && samePath(dirname(real), realPath(join(home, ".eminiar")))) return undefined;
  const anchors = new Set<string>();
  for (const start of [projectRoot, process.cwd()]) {
    if (!start) continue;
    const r = realPath(start);
    anchors.add(r);
    for (const w of gitWorktrees(r)) anchors.add(realPath(w));
  }
  const folder = dirname(real);
  for (const a of anchors)
    if (isInside(real, a) || isInside(a, folder))
      return "is inside this project or a folder above it (EMINIAR_HOME or HOME points there)";
  return undefined;
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
  for (const k of PROJECT_ADJUDICATOR_KEYS) if (Object.hasOwn(adj, k)) kept[k] = adj[k];
  return { ...(ownJson(raw) as Record<string, unknown>), adjudicator: kept };
}

/**
 * A config layer without a docs.manifest that could leave the project (absolute, `..`, not a
 * string): em_docs rewrites that file, so a cloned repo must not aim it at ../settings.json, and a
 * bad personal value must not cost the rest of the personal config. Only that key is dropped, so
 * the next layer's or the default value applies and everything else stays. `source` names the
 * file in the stderr note. The real guard stays at write time (src/docs/manifest.ts).
 */
function withoutUnsafeDocsManifest(
  raw: Record<string, unknown>,
  source: string,
): Record<string, unknown> {
  const docs = raw.docs;
  if (!isPlainObject(docs) || !Object.hasOwn(docs, "manifest")) return raw;
  const m = docs.manifest;
  if (typeof m === "string" && PROJECT_RELATIVE_PATH_RE.test(m)) return raw;
  process.stderr.write(
    `eminiar: ignoring docs.manifest ${JSON.stringify(m)} in ${source}: it must be a path inside the project\n`,
  );
  const { manifest: _dropped, ...rest } = ownJson(docs) as Record<string, unknown>;
  return { ...(ownJson(raw) as Record<string, unknown>), docs: rest };
}

/**
 * The personal layer: paths().configFile as it is, unless it sets adjudicator keys outside
 * PROJECT_ADJUDICATOR_KEYS from a location the project could have put there
 * (personalConfigTrusted, task #54); then it gets the project layer's cut.
 */
function personalLayer(projectRoot: string): Record<string, unknown> {
  const file = paths().configFile;
  const raw = readJson(file);
  const layer =
    !droppedProjectAdjudicatorKeys(raw).length || personalConfigTrusted(projectRoot, file)
      ? raw
      : projectLayer(raw);
  return withoutUnsafeDocsManifest(layer, file);
}

/**
 * A personal "off" that neither the project file nor the env can switch back on (task #313).
 * eminiar.config.json comes with any cloned repo and a repo's .claude/settings.json `env` block
 * reaches the session, so both may only make the adjudicator MORE conservative than the user's
 * own ~/.eminiar/config.json says, for every project key that decides whether text is sent:
 * - adjudicator.enabled: false (the adjudicator and every decision feature; features need it on)
 *   wins over a project `enabled: true` and EMINIAR_ADJUDICATOR=1;
 * - adjudicator.surfaces.<name>: false wins over a project true;
 * - adjudicator.promptMode: "heuristic" (no provider call on prompts) wins over a project
 *   "async"/"blocking";
 * - adjudicator.minPromptChars: a project value below the personal one is raised to it.
 * When the personal file says nothing, the project layer still applies as before (a team can turn
 * the adjudicator on; consent and keys still come only from the personal file). The other project
 * keys (mode, tiers, weights, apply, advice, embedding, learning, cache) send nothing.
 */
function withPersonalVetoes(
  personal: Record<string, unknown>,
  merged: Record<string, unknown>,
): Record<string, unknown> {
  const p = personal.adjudicator;
  const m = merged.adjudicator;
  if (!isPlainObject(p) || !isPlainObject(m)) return merged;
  const adj: Record<string, unknown> = { ...m };
  if (p.enabled === false) adj.enabled = false;
  if (isPlainObject(p.surfaces) && isPlainObject(m.surfaces)) {
    const s: Record<string, unknown> = { ...m.surfaces };
    for (const k of Object.keys(p.surfaces)) if (p.surfaces[k] === false) s[k] = false;
    adj.surfaces = s;
  }
  if (p.promptMode === "heuristic") adj.promptMode = "heuristic";
  if (
    typeof p.minPromptChars === "number" &&
    typeof m.minPromptChars === "number" &&
    m.minPromptChars < p.minPromptChars
  )
    adj.minPromptChars = p.minPromptChars;
  return { ...merged, adjudicator: adj };
}

/** The env vars loadConfig reads (envOverrides), in configSourceSignature. */
const CONFIG_ENV = [
  "EMINIAR_ROUTING_MODE",
  "EMINIAR_EMBEDDINGS",
  "EMINIAR_ADJUDICATOR",
  "EMINIAR_ADJUDICATOR_PROVIDER",
  "EMINIAR_ADJUDICATOR_MODE",
  "EMINIAR_ADJUDICATOR_REMOTE",
  "EMINIAR_ADJUDICATOR_CAPTURE",
] as const;

function fileSignature(file: string): string {
  try {
    const s = statSync(file, { throwIfNoEntry: false });
    return s ? `${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}` : "-";
  } catch {
    return "?";
  }
}

/**
 * What loadConfig(projectRoot) read: the identity of the personal and project files (inode, size,
 * mtime, ctime; two stat calls) and the env vars it looks at. A long-lived process (MCP server,
 * dashboard) compares it before reusing a loaded Config, so `features off`, a removed consent or a
 * personal `enabled: false` reaches it on the next call without a restart (task #307).
 */
export function configSourceSignature(projectRoot: string): string {
  let env = "";
  for (const k of CONFIG_ENV) env += `${process.env[k] ?? ""}\u0000`;
  return `${fileSignature(paths().configFile)}|${fileSignature(join(projectRoot, "eminiar.config.json"))}|${env}`;
}

/**
 * Precedence: defaults < ~/.eminiar/config.json < <root>/eminiar.config.json < EMINIAR_* env,
 * except that a personal "off" for anything that sends text wins (withPersonalVetoes).
 * The project file is the one teams commit.
 */
export function loadConfig(projectRoot: string): Config {
  const personal = personalLayer(projectRoot);
  const merged = withPersonalVetoes(
    personal,
    deepMerge(
      deepMerge(
        personal,
        withoutUnsafeDocsManifest(
          projectLayer(readJson(join(projectRoot, "eminiar.config.json"))),
          "eminiar.config.json",
        ),
      ),
      envOverrides(),
    ),
  );
  // zod reads inherited properties: hand it a plain own-key copy, never the merged object.
  const parsed = parseConfig(ownJson(merged) as Record<string, unknown>);
  if (parsed.success) return parsed.data;
  process.stderr.write(`eminiar: invalid config, using defaults: ${parsed.error.message}\n`);
  return { ...BaseConfigSchema.parse({}), adjudicator: adjudicatorDefaults() };
}

/**
 * ConfigSchema.safeParse, except that an untouched adjudicator section (absent, or only
 * `enabled: false`, e.g. the EMINIAR_ADJUDICATOR=0 kill switch) takes its defaults without
 * building or parsing the adjudicator schema. Anything else in it, including keys the secret
 * check must refuse, goes through the adjudicator schema: the full one when it has a `features`
 * key, else the lean one (no features schema) plus featureDefaults().
 */
function parseConfig(merged: Record<string, unknown>) {
  const { adjudicator: adj, ...rest } = merged;
  const untouched =
    adj === undefined ||
    (isPlainObject(adj) &&
      Object.keys(adj).every((k) => k === "enabled") &&
      (adj.enabled === undefined || adj.enabled === false));
  if (!untouched) {
    // No feature settings: the lean schema plus featureDefaults() (pinned equal by a unit test).
    if (!isPlainObject(adj) || Object.hasOwn(adj, "features"))
      return ConfigSchema.safeParse(merged);
    leanConfigSchema ??= buildLeanConfigSchema();
    const lean = leanConfigSchema.safeParse(merged);
    if (!lean.success) return lean;
    // Same key order as the full schema: features, then featureConsent.
    const { featureConsent, ...fields } = lean.data.adjudicator;
    const adjudicator = { ...fields, features: featureDefaults(), featureConsent };
    return { success: true as const, data: { ...lean.data, adjudicator } as Config };
  }
  const base = BaseConfigSchema.safeParse(rest);
  if (!base.success) return base;
  return { success: true as const, data: { ...base.data, adjudicator: adjudicatorDefaults() } };
}
