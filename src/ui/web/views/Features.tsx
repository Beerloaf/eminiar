import type { JSX } from "preact";
import { type AdjFeaturesPayload, fetchFeatures } from "../api.js";
import { ErrorBox, useAsync } from "../components.js";
import { Badge, Card, EmptyState, Skeleton } from "../ds.js";
import type { Tone } from "./adjudicator-helpers.js";
import {
  agreementText,
  costText,
  errors,
  FEATURE_HELP,
  type FeatureState,
  featureState,
  stateTitle,
  statusTitle,
  unsupported,
} from "./features-helpers.js";

const TONE: Record<FeatureState, Tone> = {
  off: "muted",
  "no consent": "warn",
  waiting: "warn",
  shadow: "accent",
  live: "ok",
};

function Table({ r }: { r: AdjFeaturesPayload }): JSX.Element {
  return (
    <div class="adj-scroll">
      <table class="adj-tiers">
        <thead>
          <tr>
            <th>feature</th>
            <th>state</th>
            <th class="num">calls</th>
            <th class="num">cost</th>
            <th class="num">errors</th>
            <th class="num">unsupported</th>
            <th
              class="num"
              title="answered calls where the provider matched the deterministic baseline"
            >
              agreement
            </th>
          </tr>
        </thead>
        <tbody>
          {r.features.map((f) => {
            const st = featureState(f);
            const s = f.summary;
            return (
              <tr>
                <td title={FEATURE_HELP[f.feature]}>{f.feature}</td>
                <td>
                  <span title={stateTitle(f)}>
                    <Badge tone={TONE[st]}>{st}</Badge>
                  </span>
                </td>
                <td class="num" title={statusTitle(s)}>
                  {s.calls}
                </td>
                <td class="num">{costText(s.costUsd)}</td>
                <td class="num">{errors(s)}</td>
                <td class="num">{unsupported(s)}</td>
                <td class="num">{agreementText(s)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Per-feature decision counts for the opt-in adjudicator features (recall, memory, commit,
 * compaction, swarm, docs), whatever the provider. Shown whenever the adjudicator is on; it makes
 * one request and renders nothing when the server says no feature is enabled. Counts only: no
 * prompt, memory or diff text is stored or shown.
 */
export function Features({ range, tick }: { range: string; tick: number }): JSX.Element | null {
  const d = useAsync(() => fetchFeatures(range), [range, tick]);
  if (d.data && !d.data.active) return null;
  const r = d.data?.active ? d.data : undefined;
  const p = r?.provider;
  const right = p
    ? `${p.effective}${p.model ? ` · ${p.model}` : ""} · ${range}`
    : `decision features · ${range}`;
  const props = { class: "feat-panel ds-block", title: "Features", right };
  if (d.error)
    return (
      <Card {...props}>
        <ErrorBox error={d.error} />
      </Card>
    );
  if (!r)
    return (
      <Card {...props}>
        <Skeleton h={120} />
      </Card>
    );
  const noData = r.features.every((f) => f.summary.calls === 0);
  return (
    <Card {...props}>
      {p?.degraded ? (
        <div class="jev-banner warn small" role="status">
          Provider {p.configured} is not being called ({p.degraded.replace(/_/g, " ")}): features
          use their deterministic path.
        </div>
      ) : null}
      {noData ? (
        <EmptyState compact icon="▸" title="No feature decisions in this range yet">
          Enabled features log a row each time they ask the provider; shadow mode records the answer
          without acting on it.
        </EmptyState>
      ) : null}
      <Table r={r} />
      <div class="muted small jev-foot">
        Counts only; prompts, memory and diff text are never stored.
      </div>
    </Card>
  );
}
