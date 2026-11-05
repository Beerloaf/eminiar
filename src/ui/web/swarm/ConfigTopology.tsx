import type { JSX } from "preact";
import type { SwarmTopology } from "../api.js";
import { cls } from "../util.js";
import { pure } from "./bits.js";
import { GLYPH, roleColor, TOPOLOGY_GLYPH } from "./style.js";
import { clipLabel, FOLD_AT, type Item, layout, spoke } from "./Topology.js";

/** A configured role for the preview: its name and how many workers it may run. */
export interface PreviewRole {
  name: string;
  count: number;
}

/** Per role, at most this many nodes once the swarm is large; the rest fold into "+N". */
const PER_ROLE_CAP = 3;

function items(roles: PreviewRole[]): Item[][] {
  const total = roles.reduce((a, r) => a + Math.max(1, r.count), 0);
  const fold = total > FOLD_AT;
  return roles.map((r) => {
    const n = Math.max(1, r.count);
    const shown = fold ? Math.min(n, PER_ROLE_CAP) : n;
    const out: Item[] = [];
    for (let i = 0; i < shown; i++)
      out.push({ type: "idle", id: `cfg:${r.name}:${i}`, role: r.name });
    if (n > shown)
      out.push({
        type: "group",
        id: `cfg:${r.name}:+`,
        role: r.name,
        n: n - shown,
        running: 0,
        stale: 0,
        done: 0,
      });
    return out;
  });
}

/**
 * A static picture of a configured swarm: the coordinator and one node per worker slot
 * (roles × count), laid out by the same function as the live run canvas. Used by the run
 * dashboard's empty state and by the Configuration Studio's live preview.
 */
function ConfigTopologyView({
  topology,
  roles,
  stages = [],
  maxAgents,
  label,
  class: c,
}: {
  topology: SwarmTopology;
  roles: PreviewRole[];
  stages?: string[] | undefined;
  maxAgents?: number | undefined;
  /** Accessible name; defaults to a description of the shape. */
  label?: string | undefined;
  class?: string | undefined;
}): JSX.Element {
  const names = roles.map((r) => r.name);
  const groups = items(roles);
  const L = layout(topology, groups, stages, names);
  const slots = roles.reduce((a, r) => a + Math.max(1, r.count), 0);
  return (
    <svg
      class={cls("sw-topo sw-topo-preview", `topo-${topology}`, c)}
      viewBox={`0 0 ${L.w} ${L.h}`}
      role="img"
      aria-label={
        label ??
        `${topology} swarm preview: coordinator and ${slots} worker slot${slots === 1 ? "" : "s"} over ${roles.length} role${roles.length === 1 ? "" : "s"}${maxAgents ? `, at most ${maxAgents} at once` : ""}`
      }
    >
      {L.lanes.map((lane, i) => (
        <g class="sw-lane">
          <rect x={lane.x} y={8} width={lane.w} height={L.h - 16} rx={8} />
          <text x={lane.x + lane.w / 2} y={26}>
            {lane.label}
          </text>
          {i < L.lanes.length - 1 ? (
            <text class="arrow" x={lane.x + lane.w + 6} y={26}>
              →
            </text>
          ) : null}
        </g>
      ))}
      {L.peers.map(([a, b]) => (
        <line class="sw-edge peer" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
      ))}
      {L.nodes.map((n) => (
        <path
          key={n.item.id}
          class="sw-edge spoke cfg"
          d={spoke(topology, L.hub, n)}
          style={{ stroke: roleColor(n.item.role, names) }}
        />
      ))}
      <g class="sw-node hub" transform={`translate(${L.hub.x},${L.hub.y})`}>
        <circle class="sw-core" r={22} />
        <text class="sw-glyph" dy={6}>
          {GLYPH.coordinator}
        </text>
        <text class="sw-l1" y={topology === "hierarchical" ? -32 : 40}>
          coordinator
        </text>
      </g>
      {L.nodes.map(({ item, x, y }) => {
        const color = roleColor(item.role, names);
        const group = item.type === "group";
        return (
          <g
            key={item.id}
            class={cls("sw-node cfg", group && "group")}
            transform={`translate(${x},${y})`}
            style={{ "--rc": color } as JSX.CSSProperties}
          >
            <circle class="sw-core" r={group ? 15 : 16} style={{ stroke: color }} />
            <text
              class={cls("sw-glyph", group && "sw-plus")}
              dy={group ? 4 : 5}
              style={{ fill: color }}
            >
              {group ? `+${item.n}` : (item.role[0] ?? "?").toUpperCase()}
            </text>
            <text class="sw-l1" y={32} style={{ fill: color }}>
              {clipLabel(item.role, 16)}
            </text>
            <title>
              {group ? `${item.n} more ${item.role} slot(s)` : `${item.role} worker slot`}
            </title>
          </g>
        );
      })}
    </svg>
  );
}

export const ConfigTopology = pure(ConfigTopologyView);

/** The topology glyph and word, for headers next to a preview. */
export const topologyWord = (t: SwarmTopology): string => `${TOPOLOGY_GLYPH[t]} ${t}`;
