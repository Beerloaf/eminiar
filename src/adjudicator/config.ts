import type { AdjudicatorConfig, Config } from "../config.js";
import type { AdjudicatorProviderState } from "../storage/types.js";
import { authLockout, keyFingerprint } from "./breaker.js";
import { type KeyId, type KeyResolution, type KeySource, mask, resolveKey } from "./secrets.js";
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
/** TypeSafe's default endpoint (the config default of typesafe.baseUrl). */
export const TYPESAFE_BASE_URL = "https://api.typesafe.ai/v1";

/** scheme://host[:port] of a URL (default ports dropped, host lower-cased); undefined if unparsable. */
export function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
    return u.origin;
  } catch {
    return undefined;
  }
}

/**
 * The remote origins eminiar ships: the non-local presets and TypeSafe's default endpoint.
 * EMINIAR_ADJUDICATOR_REMOTE=1 (and a legacy `remoteConsent: true` with no
 * remoteConsentOrigins list) consents to these and nothing else.
 */
export const BUILTIN_REMOTE_ORIGINS: readonly string[] = [
  ...Object.values(PRESETS)
    .filter((p) => !p.local && p.baseUrl)
    .map((p) => originOf(p.baseUrl) as string),
  originOf(TYPESAFE_BASE_URL) as string,
];

/** How remote consent was given for an origin. */
export type ConsentVia = "config" | "env" | "legacy";

/**
 * Whether the user agreed to send text to `origin` (docs/design/adjudicator.md §5; task #33):
 * - EMINIAR_ADJUDICATOR_REMOTE=0, or remoteConsent false, means no consent at all;
 * - "config": the origin is in remoteConsentOrigins of ~/.eminiar/config.json (the CLI writes it
 *   after the notice naming that host was shown and accepted);
 * - "env": EMINIAR_ADJUDICATOR_REMOTE=1 and the origin is a built-in preset origin. The env var is
 *   host-less, and a project's .claude/settings.json `env` block may set it, so it never covers a
 *   custom baseUrl;
 * - "legacy": remoteConsent true with no remoteConsentOrigins list (a config written before
 *   origins were recorded) is treated like the env var: built-in origins only. The CLI asks again
 *   and records the origin the next time the provider changes.
 */
export function consentFor(
  a: Pick<AdjudicatorConfig, "remoteConsent" | "remoteConsentOrigins">,
  origin: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ConsentVia | undefined {
  const flag = env.EMINIAR_ADJUDICATOR_REMOTE;
  if (!origin || flag === "0" || !a.remoteConsent) return undefined;
  if (consentedOrigins(a).includes(origin)) return "config";
  if (!BUILTIN_REMOTE_ORIGINS.includes(origin)) return undefined;
  if (flag === "1") return "env";
  return a.remoteConsentOrigins === undefined ? "legacy" : undefined;
}

/** remoteConsentOrigins normalised to origins; entries that are not http(s) URLs are dropped. */
export function consentedOrigins(a: Pick<AdjudicatorConfig, "remoteConsentOrigins">): string[] {
  const out: string[] = [];
  for (const s of a.remoteConsentOrigins ?? []) {
    const o = originOf(s);
    if (o && !out.includes(o)) out.push(o);
  }
  return out;
}

/**
 * The remoteConsentOrigins list the CLI writes after the user accepted `origin`: the current list
 * plus `origin`. A legacy config (remoteConsent true, no list) is migrated by also keeping
 * `previous`, the origin of the provider configured before the change, which that consent covered.
 */
export function withConsentedOrigin(
  a: Pick<AdjudicatorConfig, "remoteConsent" | "remoteConsentOrigins">,
  origin: string,
  previous?: string,
): string[] {
  const list = consentedOrigins(a);
  if (
    a.remoteConsentOrigins === undefined &&
    a.remoteConsent &&
    previous &&
    !list.includes(previous)
  )
    list.push(previous);
  if (!list.includes(origin)) list.push(origin);
  return list;
}

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

/**
 * Degraded plus "auth_failed": resolveAdjudicator() never returns it (it reads no state);
 * withAuthLockout() sets it from the store while a rejected key locks the provider out.
 */
export type DegradedReason = Degraded | "auth_failed";

/** A Resolved whose `degraded` may also be "auth_failed" (withAuthLockout). */
export type ResolvedWithLockout = Omit<Resolved, "degraded"> & { degraded?: DegradedReason };

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
  /** The configured remote target's origin (scheme://host[:port]); absent for local targets. */
  origin?: string;
  /**
   * For a remote target: consent covers `origin` (consentFor). Local targets need none; for
   * them it is the bare remoteConsent flag.
   */
  consent: boolean;
  /** How that consent was given. */
  consentVia?: ConsentVia;
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
    ? resolveKey(t.keyId, {
        keyEnv: a.keyEnv,
        providerEnv: t.providerEnv,
        env: opts.env,
        fileOnly: !t.remote,
      })
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
  const origin = t.remote ? originOf(t.baseUrl) : undefined;
  const via = t.remote ? consentFor(a, origin, opts.env) : undefined;
  if (t.remote) r.consent = via !== undefined;
  if (via) r.consentVia = via;
  if (origin) r.origin = origin;
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
  if (t.remote && !via)
    return degrade(
      "no_consent",
      `${a.provider} sends redacted prompt text to ${origin ?? hostOf(t.baseUrl)}${
        a.remoteConsent && origin ? ", which you have not agreed to (consent is per origin)" : ""
      }: run \`eminiar adjudicator enable --accept-remote\``,
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

/**
 * The key a provider sends to `r`, looked up at send time. A local (loopback) target gets only
 * a key stored in the key file for its id: never one from keyEnv, the provider's env var or
 * EMINIAR_ADJUDICATOR_KEY, so a port on this machine cannot collect an env secret.
 */
export function keyFor(
  r: Pick<Resolved, "keyId" | "keyEnv" | "providerEnv" | "configuredRemote">,
  env?: NodeJS.ProcessEnv,
): KeyResolution | undefined {
  if (!r.keyId) return undefined;
  return resolveKey(r.keyId, {
    keyEnv: r.keyEnv,
    providerEnv: r.providerEnv,
    env,
    fileOnly: !r.configuredRemote,
  });
}

/**
 * keyFingerprint() of the key the effective provider would send; null when it uses no key or
 * none is set. Never the key itself.
 */
export function currentKeyFingerprint(
  r: Pick<Resolved, "keyId" | "keyEnv" | "providerEnv" | "configuredRemote">,
  env?: NodeJS.ProcessEnv,
): string | null {
  const k = keyFor(r, env);
  return k?.key ? keyFingerprint(k.key) : null;
}

/**
 * For status/doctor/dashboard: `r` degraded to "auth_failed" ("API key rejected") while the
 * stored provider state is locked out for the key in use; otherwise `r` unchanged.
 */
export function withAuthLockout(
  r: Resolved,
  state: AdjudicatorProviderState | undefined,
  o: { now?: number; env?: NodeJS.ProcessEnv } = {},
): ResolvedWithLockout {
  if (r.provider === "heuristic") return r;
  const lock = authLockout(state, o.now ?? Date.now(), currentKeyFingerprint(r, o.env));
  if (!lock?.locked) return r;
  const code = lock.errorClass?.split(":")[1];
  const until = lock.until !== null ? ` until ${new Date(lock.until).toISOString()}` : "";
  return {
    ...r,
    provider: "heuristic",
    degraded: "auth_failed",
    detail: `API key rejected${code ? ` (HTTP ${code})` : ""}: skipped${until} or until the key changes (\`eminiar adjudicator key set\`)`,
    remote: false,
    local: false,
  };
}

function hostOf(url: string | undefined): string {
  if (!url) return "a remote host";
  try {
    return new URL(url).host;
  } catch {
    return "a remote host";
  }
}
