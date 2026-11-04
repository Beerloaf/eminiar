import type { AdjudicatorConfig, Config } from "../config.js";
import { type KeyId, type KeySource, mask, resolveKey } from "./secrets.js";
import type { ProviderId } from "./types.js";

/**
 * Which provider actually runs (docs/design/adjudicator.md §5): the configured one when its
 * consent, key and runtime requirements hold, otherwise the heuristic with a `degraded`
 * reason. The result never carries a key, so it is safe to log or return in a payload.
 */

export type PresetId = AdjudicatorConfig["openai"]["preset"];

export interface Preset {
  id: PresetId;
  /** Undefined for `custom`: openai.baseUrl is required. */
  baseUrl?: string;
  /** Undefined when the server reports it (lmstudio, llamacpp) or the user must set it (custom). */
  model?: string;
  /** The provider's own key env var. */
  keyEnv?: string;
  /** USD per million tokens; null = unknown (cost stays null unless openai.price is set). */
  price: { inPerM: number; outPerM: number } | null;
  /** Local by default; the effective locality is still checked with isLoopback(baseUrl). */
  local: boolean;
  /** Extra request body fields. */
  extra?: Record<string, unknown>;
}

export const PRESETS: Record<PresetId, Preset> = {
  groq: {
    id: "groq",
    baseUrl: "https://api.groq.com/openai/v1",
    model: "openai/gpt-oss-20b",
    keyEnv: "GROQ_API_KEY",
    price: { inPerM: 0.075, outPerM: 0.3 },
    local: false,
  },
  cerebras: {
    id: "cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    model: "gpt-oss-120b",
    keyEnv: "CEREBRAS_API_KEY",
    price: null,
    local: false,
  },
  ollama: {
    id: "ollama",
    baseUrl: "http://localhost:11434/v1",
    model: "qwen2.5:1.5b-instruct",
    price: { inPerM: 0, outPerM: 0 },
    local: true,
    extra: { keep_alive: "30m", options: { temperature: 0, num_predict: 256 } },
  },
  lmstudio: {
    id: "lmstudio",
    baseUrl: "http://localhost:1234/v1",
    price: { inPerM: 0, outPerM: 0 },
    local: true,
  },
  llamacpp: {
    id: "llamacpp",
    baseUrl: "http://localhost:8080/v1",
    price: { inPerM: 0, outPerM: 0 },
    local: true,
  },
  custom: { id: "custom", price: null, local: false },
};

export const TYPESAFE_KEY_ENV = "TYPESAFE_API_KEY";

/** True only for URLs whose host is this machine: localhost, 127.0.0.0/8, ::1. */
export function isLoopback(url: string | undefined): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  const v4 = host.replace(/^::ffff:/, "");
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v4);
  return !!m && m.slice(1).every((o) => Number(o) <= 255) && m[1] === "127";
}

/** Where the adjudicator is running: the embedding provider is never loaded in a hook. */
export type RuntimeContext = "hook" | "server" | "cli";

export type Degraded = "no_key" | "no_consent" | "hook_context" | "misconfigured";

export interface Resolved {
  enabled: boolean;
  configured: ProviderId;
  /** The provider that actually runs. */
  provider: ProviderId;
  /** Why `provider` fell back to the heuristic. */
  degraded?: Degraded;
  /** Human-readable detail for status/doctor; never contains a key. */
  detail?: string;
  /** The effective provider sends text off this machine. */
  remote: boolean;
  /** The configured provider would send text off this machine. */
  configuredRemote: boolean;
  preset?: PresetId;
  baseUrl?: string;
  model?: string;
  price?: { inPerM: number; outPerM: number } | null;
  extra?: Record<string, unknown>;
  /** Look the key up with resolveKey(keyId, {keyEnv, providerEnv}) when sending; it is not stored here. */
  keyId?: KeyId;
  keyEnv?: string;
  providerEnv?: string;
  keySource: KeySource;
  /** mask() of the key, e.g. "****abcd". */
  keyMasked: string;
  /** The key file exists but is not 0600, so it was ignored. */
  keyFileRefused?: boolean;
  consent: boolean;
  /** The deadline hooks use for this provider's calls: timeouts.localMs for local providers. */
  local: boolean;
}

interface Target {
  remote: boolean;
  needsKey: boolean;
  keyId?: KeyId;
  providerEnv?: string;
  preset?: PresetId;
  baseUrl?: string;
  model?: string;
  price?: { inPerM: number; outPerM: number } | null;
  extra?: Record<string, unknown>;
  misconfigured?: string;
}

function target(a: AdjudicatorConfig): Target {
  switch (a.provider) {
    case "heuristic":
    case "embedding":
      return { remote: false, needsKey: false };
    case "typesafe":
      return {
        remote: !isLoopback(a.typesafe.baseUrl),
        needsKey: true,
        keyId: "typesafe",
        providerEnv: TYPESAFE_KEY_ENV,
        baseUrl: a.typesafe.baseUrl,
        model: a.typesafe.model,
        price: null,
      };
    case "openai-compatible": {
      const p = PRESETS[a.openai.preset];
      const baseUrl = a.openai.baseUrl ?? p.baseUrl;
      const model = a.openai.model ?? p.model;
      // Locality is decided by the URL actually used, so a "local" preset pointed at a remote
      // host still needs consent.
      const remote = !isLoopback(baseUrl);
      const t: Target = {
        remote,
        needsKey: remote,
        keyId: `openai:${p.id}`,
        preset: p.id,
        price: a.openai.price ?? p.price,
      };
      if (p.keyEnv) t.providerEnv = p.keyEnv;
      if (baseUrl) t.baseUrl = baseUrl;
      if (model) t.model = model;
      if (p.extra) t.extra = p.extra;
      if (p.id === "custom" && (!a.openai.baseUrl || !a.openai.model))
        t.misconfigured = "the custom preset needs openai.baseUrl and openai.model";
      return t;
    }
  }
}

/**
 * The effective provider: the configured one when (remote ⇒ consent && key) and
 * (embedding ⇒ server or CLI); otherwise "heuristic" with `degraded` set.
 */
export function resolveAdjudicator(
  config: Config | AdjudicatorConfig,
  opts: { context?: RuntimeContext; env?: NodeJS.ProcessEnv } = {},
): Resolved {
  const a: AdjudicatorConfig = "adjudicator" in config ? config.adjudicator : config;
  const context = opts.context ?? "hook";
  const t = target(a);
  const key = t.keyId
    ? resolveKey(t.keyId, { keyEnv: a.keyEnv, providerEnv: t.providerEnv, env: opts.env })
    : undefined;

  const r: Resolved = {
    enabled: a.enabled,
    configured: a.provider,
    provider: a.provider,
    remote: t.remote,
    configuredRemote: t.remote,
    keySource: key?.source ?? "none",
    keyMasked: mask(key?.key),
    consent: a.remoteConsent,
    local: !t.remote && a.provider !== "heuristic",
  };
  if (t.preset) r.preset = t.preset;
  if (t.baseUrl) r.baseUrl = t.baseUrl;
  if (t.model) r.model = t.model;
  if (t.price !== undefined) r.price = t.price;
  if (t.extra) r.extra = t.extra;
  if (t.keyId) r.keyId = t.keyId;
  if (a.keyEnv) r.keyEnv = a.keyEnv;
  if (t.providerEnv) r.providerEnv = t.providerEnv;
  if (key?.refused) r.keyFileRefused = true;

  const degrade = (why: Degraded, detail: string): Resolved => ({
    ...r,
    provider: "heuristic",
    degraded: why,
    detail,
    remote: false,
    local: false,
  });

  if (t.misconfigured) return degrade("misconfigured", t.misconfigured);
  if (a.provider === "embedding" && context === "hook")
    return degrade("hook_context", "the embedding provider runs only in the MCP server and CLI");
  if (t.remote && !a.remoteConsent)
    return degrade(
      "no_consent",
      `${a.provider} sends redacted prompt text to ${hostOf(t.baseUrl)}: run \`eminiar adjudicator enable --accept-remote\``,
    );
  if (t.needsKey && key?.source !== "env" && key?.source !== "file")
    return degrade(
      "no_key",
      key?.refused
        ? "the key file is readable by others and was ignored: chmod 600 ~/.eminiar/adjudicator.key"
        : `no key for ${t.keyId}: run \`eminiar adjudicator key set\``,
    );
  return r;
}

function hostOf(url: string | undefined): string {
  if (!url) return "a remote host";
  try {
    return new URL(url).host;
  } catch {
    return "a remote host";
  }
}
