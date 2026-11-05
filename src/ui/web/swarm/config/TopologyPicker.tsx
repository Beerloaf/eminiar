// The topology picker: three visual cards (hierarchical, mesh, pipeline), each with a mini
// diagram of how the coordinator and the workers talk, and a one-line "use when".
import type { JSX } from "preact";
import type { SwarmTopology } from "../../api.js";
import { cls } from "../../util.js";
import { TOPOLOGY_GLYPH } from "../style.js";

export const TOPOLOGIES: SwarmTopology[] = ["hierarchical", "mesh", "pipeline"];

const ABOUT: Record<SwarmTopology, { what: string; when: string }> = {
  hierarchical: {
    what: "The coordinator plans, assigns and reviews; workers report back to it.",
    when: "Use when one lead should split a feature into disjoint tasks.",
  },
  mesh: {
    what: "Peers share one task board and blackboard and take whatever is open.",
    when: "Use when several angles look at the same thing at once (reviews, research).",
  },
  pipeline: {
    what: "Work moves stage by stage, in the order of the stages list.",
    when: "Use when each step needs the previous one's output (write → edit → check).",
  },
};

/** A small schematic of a topology (not the configured roles: see ConfigTopology for that). */
export function MiniTopology({
  topology,
  size = 96,
}: {
  topology: SwarmTopology;
  size?: number;
}): JSX.Element {
  const w = size;
  const h = Math.round(size * 0.62);
  const r = Math.max(4, size / 16);
  const hub = { x: w / 2, y: h * 0.24 };
  let nodes: Array<{ x: number; y: number }> = [];
  let edges: Array<[{ x: number; y: number }, { x: number; y: number }]> = [];
  if (topology === "hierarchical") {
    nodes = [0.16, 0.39, 0.61, 0.84].map((f) => ({ x: w * f, y: h * 0.78 }));
    edges = nodes.map((n) => [hub, n]);
  } else if (topology === "mesh") {
    const cx = w / 2;
    const cy = h * 0.56;
    const rad = h * 0.32;
    nodes = [0, 1, 2, 3, 4].map((i) => {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
      return { x: cx + rad * 1.35 * Math.cos(a), y: cy + rad * Math.sin(a) };
    });
    for (let i = 0; i < nodes.length; i++)
      for (let j = i + 1; j < nodes.length; j++) edges.push([nodes[i]!, nodes[j]!]);
  } else {
    nodes = [0.12, 0.37, 0.63, 0.88].map((f) => ({ x: w * f, y: h * 0.56 }));
    for (let i = 0; i < nodes.length - 1; i++) edges.push([nodes[i]!, nodes[i + 1]!]);
  }
  return (
    <svg
      class={cls("swc-mini-topo", `topo-${topology}`)}
      viewBox={`0 0 ${w} ${h}`}
      width={w}
      height={h}
      aria-hidden="true"
    >
      {edges.map(([a, b]) => (
        <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
      ))}
      {topology === "pipeline"
        ? nodes.slice(0, -1).map((n, i) => {
            const m = nodes[i + 1]!;
            const x = (n.x + m.x) / 2;
            return (
              <path
                class="arrow"
                d={`M${x - 3},${n.y - 3} L${x + 2},${n.y} L${x - 3},${n.y + 3}`}
              />
            );
          })
        : null}
      {topology === "hierarchical" ? (
        <circle class="hub" cx={hub.x} cy={hub.y} r={r * 1.35} />
      ) : null}
      {nodes.map((n, i) => (
        <circle
          class="node"
          cx={n.x}
          cy={n.y}
          r={r}
          style={{ "--i": String(i) } as JSX.CSSProperties}
        />
      ))}
    </svg>
  );
}

export function TopologyPicker({
  value,
  disabled,
  onChange,
}: {
  value: SwarmTopology;
  disabled?: boolean | undefined;
  onChange: (t: SwarmTopology) => void;
}): JSX.Element {
  return (
    <div class="swc-topos" role="radiogroup" aria-label="topology">
      {TOPOLOGIES.map((t) => (
        <button
          type="button"
          role="radio"
          aria-checked={t === value}
          disabled={disabled}
          class={cls("swc-topo", t === value && "on")}
          onClick={() => onChange(t)}
        >
          <MiniTopology topology={t} />
          <span class="swc-topo-name">
            <span aria-hidden="true">{TOPOLOGY_GLYPH[t]}</span> {t}
            {t === value ? <span class="swc-check">✓</span> : null}
          </span>
          <span class="swc-topo-what">{ABOUT[t].what}</span>
          <span class="swc-topo-when">{ABOUT[t].when}</span>
        </button>
      ))}
    </div>
  );
}
