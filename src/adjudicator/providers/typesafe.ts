import { z } from "zod";
import type { AdjudicatorConfig } from "../../config.js";
import { keyFor, type Resolved } from "../config.js";
import {
  buildCatalogue,
  buildItems,
  type Catalogue,
  COMPLEXITY_CRITERIA,
  jevQuestionId,
  jevQuestions,
  jevState,
  type StateItem,
} from "../prompt.js";
import type {
  AdjudicationRequest,
  AdjudicatorProvider,
  Dist,
  ProviderAnswer,
  ProviderResult,
} from "../types.js";
import {
  getJson,
  joinUrl,
  PROBE_TIMEOUT_MS,
  type ProviderDeps,
  ProviderError,
  postJson,
  probeDetail,
} from "./http.js";

/**
 * TypeSafe's Jev ("System One", docs/design/adjudicator.md §8): typed questions over a state,
 * answered with calibrated probabilities. One request per batch of up to 10 items; a larger
 * plan is split into at most 2 parallel requests.
 */

/** The version thresholds were tuned against; aliases are replaced by it. */
export const JEV_PINNED = "jev-1.14.0";
export const JEV_DEFAULT_BASE_URL = "https://api.typesafe.ai/v1";
/** USD per input token; output tokens are free. */
export const JEV_PRICE_IN = 0.042 / 1_000_000;
export const JEV_BATCH = 10;
export const JEV_MAX_REQUESTS = 2;

/** Moving aliases (jev-latest, jev-preview) are never sent: they change silently under tuned thresholds. */
export function pinJevModel(model: string | undefined): string {
  if (!model || /^jev-(latest|preview)$/i.test(model.trim())) return JEV_PINNED;
  return model.trim();
}

const Probabilities = z.record(z.string(), z.number().min(0).max(1));
const Answer = z.union([
  z.object({
    type: z.literal("choice"),
    choice: z.string(),
    confidence: z.number().min(0).max(1).optional(),
    probabilities: Probabilities.optional(),
  }),
  z.object({
    type: z.literal("score"),
    // On the rubric's own levels (0..criteria-1), echoed in `legend`; not 0..1.
    score: z.number().min(0),
    confidence: z.number().min(0).max(1).optional(),
    probabilities: Probabilities.optional(),
    legend: z.record(z.string(), z.string()).optional(),
  }),
  z.object({ type: z.literal("noul"), noul: z.number().min(0).max(1) }),
]);
type Answer = z.infer<typeof Answer>;
const JevResponse = z.object({
  model: z.string().optional(),
  answers: z.record(z.string(), z.unknown()),
  usage: z
    .object({
      input_tokens: z.number().nonnegative().optional(),
      output_tokens: z.number().nonnegative().optional(),
    })
    .optional(),
});

export function createTypesafeProvider(
  r: Resolved,
  cfg: AdjudicatorConfig,
  deps: ProviderDeps = {},
): AdjudicatorProvider {
  const baseUrl = r.baseUrl ?? JEV_DEFAULT_BASE_URL;
  const model = pinJevModel(r.model);
  const askTool = (cfg.weights.features.toolProvider ?? 0) > 0;
  const key = (): string => {
    // A loopback baseUrl gets only a key stored in the key file, never an env secret.
    const k = keyFor({ ...r, keyId: r.keyId ?? "typesafe" }, deps.env)?.key;
    if (!k) throw new ProviderError("no_key", "no key for typesafe");
    return k;
  };

  async function one(
    reqs: AdjudicationRequest[],
    offset: number,
    cat: Catalogue,
    o: { signal: AbortSignal; deadlineMs: number },
  ) {
    const items = buildItems(reqs, cfg.privacy.maxChars, offset);
    const k = key();
    const res = await postJson(
      joinUrl(baseUrl, "systemone"),
      { model, state: jevState(cat, items), questions: jevQuestions(items, cat, { askTool }) },
      {
        deadlineMs: o.deadlineMs,
        signal: o.signal,
        key: k,
        fetch: deps.fetch,
        now: deps.now,
        log: deps.log,
      },
    );
    const parsed = JevResponse.safeParse(res.json);
    if (!parsed.success)
      throw new ProviderError("invalid", "the Jev response has an unexpected shape");
    const answers = mapAnswers(reqs, items, parsed.data.answers, cat);
    if (answers.length === 0)
      throw new ProviderError("invalid", "the Jev response answered no item");
    const inTok = parsed.data.usage?.input_tokens ?? 0;
    return {
      answers,
      inTok,
      outTok: parsed.data.usage?.output_tokens ?? 0,
      latencyMs: res.latencyMs,
      model: parsed.data.model ?? model,
    };
  }

  return {
    id: "typesafe",
    remote: r.remote,
    dims: askTool ? ["complexity", "tier", "role", "tool"] : ["complexity", "tier", "role"],

    async adjudicate(reqs, o): Promise<ProviderResult> {
      if (reqs.length === 0)
        return { answers: [], usage: { inTok: 0, outTok: 0, costUsd: 0 }, latencyMs: 0, model };
      const cat = buildCatalogue(reqs, { tiers: cfg.tiers, tools: deps.tools });
      // Items past JEV_BATCH × JEV_MAX_REQUESTS get no answer; the engine scores them heuristically.
      const chunks: Array<{ reqs: AdjudicationRequest[]; offset: number }> = [];
      for (let i = 0; i < reqs.length && chunks.length < JEV_MAX_REQUESTS; i += JEV_BATCH)
        chunks.push({ reqs: reqs.slice(i, i + JEV_BATCH), offset: i });
      const settled = await Promise.allSettled(chunks.map((c) => one(c.reqs, c.offset, cat, o)));
      const ok = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
      if (ok.length === 0) {
        const first = settled.find((s) => s.status === "rejected");
        throw first && first.status === "rejected"
          ? first.reason
          : new ProviderError("invalid", "no answer");
      }
      const inTok = ok.reduce((n, x) => n + x.inTok, 0);
      return {
        answers: ok.flatMap((x) => x.answers),
        usage: {
          inTok,
          outTok: ok.reduce((n, x) => n + x.outTok, 0),
          costUsd: inTok * JEV_PRICE_IN,
        },
        latencyMs: Math.max(...ok.map((x) => x.latencyMs)),
        model: ok[0]?.model ?? model,
      };
    },

    async probe(o) {
      const t0 = (deps.now ?? Date.now)();
      try {
        const res = await getJson<{ data?: Array<{ id?: string }> }>(joinUrl(baseUrl, "models"), {
          deadlineMs: PROBE_TIMEOUT_MS,
          signal: o.signal,
          key: key(),
          fetch: deps.fetch,
          now: deps.now,
          retry: false,
        });
        const ids = Array.isArray(res.json?.data) ? res.json.data.map((m) => m.id) : [];
        const listed = ids.length === 0 || ids.includes(model);
        return {
          ok: true,
          latencyMs: res.latencyMs,
          detail: listed
            ? `typesafe ${model} reachable`
            : `typesafe reachable, but ${model} is not listed`,
        };
      } catch (err) {
        return { ok: false, latencyMs: (deps.now ?? Date.now)() - t0, detail: probeDetail(err) };
      }
    },
  };
}

/** Jev answers → ProviderAnswer per request; an item whose answers are missing or malformed is skipped. */
function mapAnswers(
  reqs: AdjudicationRequest[],
  items: StateItem[],
  raw: Record<string, unknown>,
  cat: Catalogue,
): ProviderAnswer[] {
  const get = (id: string): Answer | undefined => {
    const p = Answer.safeParse(raw[id]);
    return p.success ? p.data : undefined;
  };
  const out: ProviderAnswer[] = [];
  reqs.forEach((req, i) => {
    const item = items[i];
    if (!item) return;
    const a: ProviderAnswer = { key: req.key };
    const c = complexityOf(get(jevQuestionId(item.id, "complexity")));
    if (c) a.complexity = c;
    const tier = choiceDist(
      get(jevQuestionId(item.id, "tier")),
      cat.tiers.map((t) => t.name),
    );
    if (tier) a.tier = tier;
    const role = choiceDist(
      get(jevQuestionId(item.id, "role")),
      cat.roles.map((x) => x.name),
    );
    if (role) a.role = role;
    const tool = choiceDist(
      get(jevQuestionId(item.id, "tool")),
      cat.tools.map((t) => t.name),
    );
    if (tool) a.tool = tool;
    const risky = get(jevQuestionId(item.id, "risky"));
    if (risky?.type === "noul") a.risky = risky.noul;
    const plan = get(jevQuestionId(item.id, "needs_plan"));
    if (plan?.type === "noul") a.needsPlan = plan.noul;
    if (a.complexity || a.tier || a.role) out.push(a);
  });
  return out;
}

/**
 * Jev scores on the rubric's levels: 0..4 for COMPLEXITY_CRITERIA, with the levels echoed in
 * `legend`. The top level comes from the legend when it has one, else from the rubric; a score
 * above it is malformed and skipped. Rescaled to the 0..4 complexity axis.
 */
function complexityOf(a: Answer | undefined): ProviderAnswer["complexity"] {
  if (a?.type !== "score") return undefined;
  const levels = Object.keys(a.legend ?? {})
    .map(Number)
    .filter(Number.isInteger);
  const top = levels.length > 1 ? Math.max(...levels) : COMPLEXITY_CRITERIA.length - 1;
  if (top <= 0 || a.score > top) return undefined;
  return { value: (a.score * 4) / top, confidence: a.confidence ?? 0.5 };
}

/** A calibrated Dist over the catalogue's options; probabilities for unknown options are dropped. */
function choiceDist(a: Answer | undefined, options: string[]): Dist | undefined {
  if (a?.type !== "choice" || !options.includes(a.choice)) return undefined;
  const probs: Record<string, number> = {};
  let sum = 0;
  for (const o of options) {
    const p = a.probabilities?.[o];
    if (p !== undefined && p > 0) {
      probs[o] = p;
      sum += p;
    }
  }
  if (sum <= 0)
    return { probs: { [a.choice]: 1 }, confidence: a.confidence ?? 0.5, calibrated: true };
  for (const o of Object.keys(probs)) probs[o] = (probs[o] ?? 0) / sum;
  return { probs, confidence: a.confidence ?? probs[a.choice] ?? 0.5, calibrated: true };
}
