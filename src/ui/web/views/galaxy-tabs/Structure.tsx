import type { JSX } from "preact";
import { useMemo, useState } from "preact/hooks";
import { api, type ClusterSummary, type VisEdge, type VisNode } from "../../api.js";
import { ErrorBox, useAsync } from "../../components.js";
import { Card, EmptyState, Skeleton } from "../../ds.js";
import { GraphCanvas } from "../../graph/GraphCanvas.js";
import { navigate } from "../../router.js";
import { cls } from "../../util.js";

interface Clusters {
  clusters: ClusterSummary[];
  cycles: string[][];
  members: Record<string, Array<{ path: string; score: number; fanIn: number }>>;
}

export function Structure(): JSX.Element {
  const q = useAsync(() => api<Clusters>("/api/clusters"), []);
  const [sel, setSel] = useState<string | null>(null);
  const [cycle, setCycle] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const graph = useMemo(() => {
    const d = q.data;
    if (!d) return { nodes: [] as VisNode[], edges: [] as VisEdge[] };
    const nodes: VisNode[] = [];
    const edges: VisEdge[] = [];
    if (cycle !== null) {
      const files = d.cycles[cycle] ?? [];
      for (const f of files)
        nodes.push({ id: `file:${f}`, label: f, kind: "file", path: f, line: null });
      for (let i = 0; i < files.length; i++)
        edges.push({
          src: `file:${files[i]}`,
          dst: `file:${files[(i + 1) % files.length]}`,
          kind: "imports",
          weight: 1,
        });
      return { nodes, edges };
    }
    for (const c of d.clusters) {
      if (expanded.has(c.id)) {
        for (const m of d.members[String(c.id)] ?? [])
          nodes.push({
            id: `file:${m.path}`,
            label: m.path,
            kind: "file",
            path: m.path,
            line: null,
            score: m.score,
          });
        // members link to their cluster hub through the hub node
      }
      nodes.push({
        id: `cluster:${c.id}`,
        label: `#${c.id} ${c.label} (${c.size})`,
        kind: "cluster",
        path: null,
        line: null,
      });
      if (expanded.has(c.id))
        for (const m of d.members[String(c.id)] ?? [])
          edges.push({ src: `file:${m.path}`, dst: `cluster:${c.id}`, kind: "link", weight: 0.5 });
      for (const [to, n] of Object.entries(c.links))
        edges.push({
          src: `cluster:${c.id}`,
          dst: `cluster:${to}`,
          kind: "imports",
          weight: Math.min(1, n / 10),
          count: n,
        });
    }
    return { nodes, edges };
  }, [q.data, cycle, expanded]);
  if (q.error) return <ErrorBox error={q.error} />;
  const d = q.data;
  if (!d) return <Skeleton h={320} />;
  const selCluster = sel?.startsWith("cluster:")
    ? d.clusters.find((c) => String(c.id) === sel.slice(8))
    : undefined;
  return (
    <div class="ds-grid main-side" style={{ alignItems: "start" }}>
      <Card flush class="gt-canvas">
        {graph.nodes.length ? (
          <GraphCanvas
            nodes={graph.nodes}
            edges={graph.edges}
            selected={sel}
            onSelect={setSel}
            onActivate={(id) => {
              if (id.startsWith("cluster:")) {
                const n = Number(id.slice(8));
                setExpanded((s) => {
                  const next = new Set(s);
                  if (next.has(n)) next.delete(n);
                  else next.add(n);
                  return next;
                });
              } else if (id.startsWith("file:")) navigate("explore", { file: id.slice(5) });
            }}
          />
        ) : (
          <EmptyState icon="✦" title="No clusters yet">
            Run a reindex from System and the connectivity groups show up here.
          </EmptyState>
        )}
      </Card>
      <div class="stack">
        <Card title="Clusters" right={String(d.clusters.length)}>
          <div class="muted small" style={{ marginBottom: 6 }}>
            Connectivity groups from imports and co-change (label propagation). Double-click a
            cluster to expand its files; they are not proof of architectural boundaries.
          </div>
          <div class="list" style={{ maxHeight: 260 }}>
            {d.clusters.map((c) => (
              <div
                class={cls("item", sel === `cluster:${c.id}` && "sel")}
                onClick={() => {
                  setCycle(null);
                  setSel(`cluster:${c.id}`);
                }}
              >
                <div class="n">
                  #{c.id} {c.label} <span class="muted">· {c.size} files</span>
                </div>
                <div class="p">{c.files.slice(0, 3).join(", ")}</div>
              </div>
            ))}
          </div>
        </Card>
        {selCluster && (
          <Card title={`Cluster #${selCluster.id} members`}>
            <div class="list" style={{ maxHeight: 220 }}>
              {(d.members[String(selCluster.id)] ?? []).map((m) => (
                <div class="item" onClick={() => navigate("explore", { file: m.path })}>
                  <div class="p">
                    {m.path} <span class="muted">· heat {m.score.toFixed(2)}</span>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}
        <Card title="Import cycles" right={String(d.cycles.length)}>
          {d.cycles.length ? (
            <div class="list" style={{ maxHeight: 220 }}>
              {d.cycles.map((c, i) => (
                <div
                  class={cls("item", cycle === i && "sel")}
                  onClick={() => {
                    setCycle(cycle === i ? null : i);
                    setSel(null);
                  }}
                >
                  <div class="p">
                    {c.length} files: {c.slice(0, 4).join(" → ")}
                    {c.length > 4 ? " …" : ""}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div class="muted small">none</div>
          )}
          {cycle !== null ? (
            <button
              type="button"
              class="sm"
              style={{ marginTop: 6 }}
              onClick={() => setCycle(null)}
            >
              show clusters
            </button>
          ) : null}
        </Card>
      </div>
    </div>
  );
}
