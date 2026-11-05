import { z } from "zod";
import type { AdjudicatorConfig } from "../../config.js";
import { keyFor, type Resolved } from "../config.js";
import { buildCatalogue, buildItems, type Catalogue, openaiSchema, rubric } from "../prompt.js";
import type {
  AdjudicationRequest,
  AdjudicatorProvider,
  ProviderAnswer,
  ProviderResult,
} from "../types.js";
import {
  getJson,
  type HttpResult,
  joinUrl,
  PROBE_TIMEOUT_MS,
  type ProviderDeps,
  ProviderError,
  postJson,
  probeDetail,
} from "./http.js";

/**
 * Any OpenAI-shaped /chat/completions endpoint (docs/design/adjudicator.md §8): Groq,
 * Cerebras, OpenAI, OpenRouter, and local Ollama, LM Studio or llama.cpp. The answer is a strict
 * JSON schema; with json "auto", an endpoint that rejects json_schema with a 400 is retried
 * once with json_object plus the schema text in the prompt. Self-reported confidence is not
 * calibrated, so the Dists are one-hot with calibrated = false.
 */

export const MAX_TOKENS_BASE = 64;
export const MAX_TOKENS_PER_ITEM = 48;

/** A 400 that is about the structured-output request, not the prompt. */
export function rejectsSchema(err: unknown): boolean {
  return (
    err instanceof ProviderError &&
    err.status === 400 &&
    /response_format|json_schema/i.test(`${err.body ?? ""} ${err.message}`)
  );
}

const Completion = z.object({
  model: z.string().optional(),
  choices: z
    .array(z.object({ message: z.object({ content: z.string().nullable().optional() }) }))
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().nonnegative().optional(),
      completion_tokens: z.number().nonnegative().optional(),
    })
    .nullable()
    .optional(),
});

/** Parse the model's content: plain JSON, or JSON inside a ``` fence (json_object mode, small local models). */
function parseContent(content: string): unknown {
  const t = content.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  try {
    return JSON.parse(fenced?.[1] ?? t);
  } catch {
    throw new ProviderError("invalid", "the model's answer is not JSON");
  }
}

function itemSchema(cat: Catalogue, askTool: boolean) {
  const names = (xs: Array<{ name: string }>) => xs.map((x) => x.name) as [string, ...string[]];
  return z.object({
    id: z.string(),
    complexity: z.number().min(0).max(4),
    tier: z.enum(names(cat.tiers)),
    role: z.enum(names(cat.roles)),
    tool: askTool ? z.enum(names(cat.tools)) : z.unknown().optional(),
    risky: z.boolean(),
    confidence: z.number().min(0).max(1),
  });
}

export function createOpenAIProvider(
  r: Resolved,
  cfg: AdjudicatorConfig,
  deps: ProviderDeps = {},
): AdjudicatorProvider {
  const baseUrl = r.baseUrl;
  const askTool = (cfg.weights.features.toolProvider ?? 0) > 0;
  const json = cfg.openai.json;
  const price = r.local ? { inPerM: 0, outPerM: 0 } : (r.price ?? null);
  /** Learned once per process: this endpoint rejects json_schema, so go straight to json_object. */
  let schemaRejected = false;

  const key = (): string | undefined => {
    if (!r.keyId) return undefined;
    // A loopback server gets only a key stored for it in the key file, never an env secret.
    const k = keyFor(r, deps.env)?.key;
    // Local servers usually take no key; a remote one cannot work without it.
    if (!k && r.remote) throw new ProviderError("no_key", `no key for ${r.keyId}`);
    return k;
  };

  function body(
    cat: Catalogue,
    items: ReturnType<typeof buildItems>,
    schema: Record<string, unknown>,
    mode: "schema" | "object",
  ): Record<string, unknown> {
    const b: Record<string, unknown> = {
      ...r.extra,
      temperature: 0,
      max_tokens: MAX_TOKENS_BASE + MAX_TOKENS_PER_ITEM * items.length,
      messages: [
        {
          role: "system",
          content: rubric(cat, mode === "object" ? { askTool, schema } : { askTool }),
        },
        { role: "user", content: JSON.stringify({ items }) },
      ],
      response_format:
        mode === "schema"
          ? { type: "json_schema", json_schema: { name: "adjudication", strict: true, schema } }
          : { type: "json_object" },
    };
    if (r.model) b.model = r.model;
    // gpt-oss models reason before answering; keep that short so the answer fits max_tokens.
    if (r.model && /gpt-oss/i.test(r.model) && b.reasoning_effort === undefined)
      b.reasoning_effort = "low";
    return b;
  }

  return {
    id: "openai-compatible",
    remote: r.remote,
    dims: askTool ? ["complexity", "tier", "role", "tool"] : ["complexity", "tier", "role"],

    async adjudicate(reqs, o): Promise<ProviderResult> {
      if (reqs.length === 0)
        return {
          answers: [],
          usage: { inTok: 0, outTok: 0, costUsd: 0 },
          latencyMs: 0,
          model: r.model ?? "",
        };
      if (!baseUrl)
        throw new ProviderError("invalid", "no baseUrl for the openai-compatible provider");
      const now = deps.now ?? Date.now;
      const start = now();
      const cat = buildCatalogue(reqs, { tiers: cfg.tiers, tools: deps.tools });
      const items = buildItems(reqs, cfg.privacy.maxChars);
      const schema = openaiSchema(
        cat,
        items.map((i) => i.id),
        { askTool },
      );
      const k = key();
      const send = (mode: "schema" | "object"): Promise<HttpResult> =>
        postJson(joinUrl(baseUrl, "chat/completions"), body(cat, items, schema, mode), {
          deadlineMs: o.deadlineMs - (now() - start),
          signal: o.signal,
          key: k,
          fetch: deps.fetch,
          now: deps.now,
          log: deps.log,
        });

      let res: HttpResult;
      const first = json === "object" || (json === "auto" && schemaRejected) ? "object" : "schema";
      try {
        res = await send(first);
      } catch (err) {
        if (first !== "schema" || json !== "auto" || !rejectsSchema(err)) throw err;
        schemaRejected = true;
        deps.log?.("adjudicator openai: json_schema rejected, retrying with json_object");
        res = await send("object");
      }

      const parsed = Completion.safeParse(res.json);
      if (!parsed.success)
        throw new ProviderError("invalid", "the completion has an unexpected shape");
      const content = parsed.data.choices[0]?.message.content;
      if (!content) throw new ProviderError("invalid", "the completion has no content");
      const answers = mapAnswers(reqs, items, parseContent(content), cat, askTool);
      if (answers.length === 0) throw new ProviderError("invalid", "the answer matched no item");
      const inTok = parsed.data.usage?.prompt_tokens ?? 0;
      const outTok = parsed.data.usage?.completion_tokens ?? 0;
      return {
        answers,
        // An unknown price (cerebras, custom without openai.price) is null, not 0: the spend cap
        // and stats tell "unknown" apart from "free".
        usage: {
          inTok,
          outTok,
          costUsd: price ? (inTok * price.inPerM + outTok * price.outPerM) / 1e6 : null,
        },
        latencyMs: now() - start,
        model: parsed.data.model ?? r.model ?? "",
      };
    },

    async probe(o) {
      const t0 = (deps.now ?? Date.now)();
      try {
        if (!baseUrl) throw new ProviderError("invalid", "no baseUrl");
        const res = await getJson<{ data?: Array<{ id?: string }> }>(joinUrl(baseUrl, "models"), {
          deadlineMs: PROBE_TIMEOUT_MS,
          signal: o.signal,
          key: key(),
          fetch: deps.fetch,
          now: deps.now,
          retry: false,
        });
        const ids = Array.isArray(res.json?.data)
          ? res.json.data.flatMap((m) => (m.id ? [m.id] : []))
          : [];
        const detail = !r.model
          ? `reachable${ids[0] ? `, serving ${ids[0]}` : ""}`
          : ids.length === 0 || ids.includes(r.model)
            ? `${r.model} reachable`
            : `reachable, but ${r.model} is not listed`;
        return { ok: true, latencyMs: res.latencyMs, detail };
      } catch (err) {
        return { ok: false, latencyMs: (deps.now ?? Date.now)() - t0, detail: probeDetail(err) };
      }
    },
  };
}

/** Validate each item with zod; invalid or unknown items are dropped (the engine falls back for them). */
function mapAnswers(
  reqs: AdjudicationRequest[],
  items: ReturnType<typeof buildItems>,
  raw: unknown,
  cat: Catalogue,
  askTool: boolean,
): ProviderAnswer[] {
  const list =
    raw && typeof raw === "object" && Array.isArray((raw as { items?: unknown }).items)
      ? ((raw as { items: unknown[] }).items as unknown[])
      : undefined;
  if (!list) throw new ProviderError("invalid", "the answer has no items array");
  const Item = itemSchema(cat, askTool);
  const byId = new Map<string, z.infer<typeof Item>>();
  for (const x of list) {
    const p = Item.safeParse(x);
    if (p.success && !byId.has(p.data.id)) byId.set(p.data.id, p.data);
  }
  const out: ProviderAnswer[] = [];
  reqs.forEach((req, i) => {
    const id = items[i]?.id;
    const x = id ? byId.get(id) : undefined;
    if (!x) return;
    const conf = x.confidence;
    const a: ProviderAnswer = {
      key: req.key,
      complexity: { value: Math.round(x.complexity), confidence: conf },
      tier: { probs: { [x.tier]: 1 }, confidence: conf, calibrated: false },
      role: { probs: { [x.role]: 1 }, confidence: conf, calibrated: false },
      risky: x.risky ? 1 : 0,
    };
    if (askTool && typeof x.tool === "string")
      a.tool = { probs: { [x.tool]: 1 }, confidence: conf, calibrated: false };
    out.push(a);
  });
  return out;
}
