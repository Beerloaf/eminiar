import type { JSX } from "preact";
import type { SwarmOverview } from "../api.js";
import { Badge, Segmented } from "../ds.js";
import { navigate } from "../router.js";
import { GLYPH } from "./style.js";

export type SwarmPage = "runs" | "config";

/**
 * The "Runs | Configure" sub-nav on both Swarms pages (#/swarm and #/swarm/config). The
 * counts come from GET /api/swarm, which both pages already read: no extra request.
 */
export function SwarmNav({
  page,
  o,
}: {
  page: SwarmPage;
  o: SwarmOverview | undefined;
}): JSX.Element {
  const active = o ? o.runs.filter((r) => r.status === "active").length : 0;
  const issues = o?.state === "invalid" ? o.issues.length : 0;
  const state = !o
    ? null
    : o.state === "absent"
      ? { tone: "muted" as const, text: "not opted in" }
      : o.state === "invalid"
        ? { tone: "bad" as const, text: `${GLYPH.failed} file invalid` }
        : !o.enabled
          ? { tone: "warn" as const, text: `${GLYPH.stale} disabled` }
          : o.syncNeeded
            ? { tone: "warn" as const, text: `${GLYPH.blocked} agent files out of date` }
            : { tone: "ok" as const, text: `${GLYPH.done} enabled · in sync` };
  return (
    <nav class="sw-nav" aria-label="Swarms pages">
      <Segmented<SwarmPage>
        label="Swarms pages"
        value={page}
        onChange={(p) => navigate(p === "config" ? "swarm/config" : "swarm")}
        options={[
          {
            id: "runs",
            title: "the run dashboard: live topology, workers, tasks and events",
            label: (
              <>
                Runs
                {active ? (
                  <span class="sw-nav-count live" title={`${active} active run(s)`}>
                    {GLYPH.active} {active} active
                  </span>
                ) : null}
              </>
            ),
          },
          {
            id: "config",
            title: "the configuration studio: edit .eminiar/swarm.yaml",
            label: (
              <>
                Configure
                {issues ? (
                  <span class="sw-nav-count bad" title={`${issues} issue(s) in the swarm file`}>
                    ⚠ {issues} issue{issues === 1 ? "" : "s"}
                  </span>
                ) : null}
              </>
            ),
          },
        ]}
      />
      <span class="sw-nav-meta">
        {o ? <code class="sw-nav-file">{o.file}</code> : null}
        {state ? (
          <Badge tone={state.tone} title="swarm file state, re-read every 15 s">
            {state.text}
          </Badge>
        ) : null}
      </span>
    </nav>
  );
}
