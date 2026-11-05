import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { api, type GraphResult, type VisEdge, type VisNode } from "../api.js";
import { ErrorBox, KindTag, Spinner, toast } from "../components.js";
import { Badge, EmptyState, Segmented, Skeleton } from "../ds.js";
import { GraphCanvas, type GraphHandle } from "../graph/GraphCanvas.js";
import { type GalaxyTab, isGalaxyTab } from "../route.js";
import { navigate } from "../router.js";
import { cls, debounce, EDGE_KINDS } from "../util.js";
import { Behavior } from "./galaxy-tabs/Behavior.js";
import { FolderMap } from "./galaxy-tabs/FolderMap.js";
import { Hotspots } from "./galaxy-tabs/Hotspots.js";
import { Routes } from "./galaxy-tabs/Routes.js";
import { Structure } from "./galaxy-tabs/Structure.js";

type Direction = "both" | "in" | "out";
interface ViewState {
  node: string | null;
  depth: number;
  direction: Direction;
  kinds: string[];
}

const DEFAULT_KINDS = [
  "imports",
  "calls",
  "references",
  "extends",
  "implements",
  "handles",
  "reexports",
];

function NodeSearch({
  value,
  onPick,
}: {
  value: string;
  onPick: (n: VisNode) => void;
}): JSX.Element {
  const [q, setQ] = useState(value);
  const [rows, setRows] = useState<VisNode[]>([]);
  const [open, setOpen] = useState(false);
  const [idx, setIdx] = useState(0);
  useEffect(() => setQ(value), [value]);
  const lookup = useRef(
    debounce(async (text: string) => {
      if (text.trim().length < 2) return setRows([]);
      try {
        setRows(
          await api<VisNode[]>("/api/nodes/search", {
            q: text.trim(),
            limit: 12,
          }),
        );
        setOpen(true);
        setIdx(0);
      } catch {
        setRows([]);
      }
    }, 180),
  ).current;
  return (
    <div style={{ position: "relative" }}>
      <input
        type="text"
        placeholder="search a file, symbol, route or memory…"
        value={q}
        onInput={(e) => {
          const v = (e.target as HTMLInputElement).value;
          setQ(v);
          lookup(v);
        }}
        onFocus={() => rows.length && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") setIdx((i) => Math.min(rows.length - 1, i + 1));
          else if (e.key === "ArrowUp") setIdx((i) => Math.max(0, i - 1));
          else if (e.key === "Enter") {
            const r = rows[idx];
            if (r) {
              onPick(r);
              setOpen(false);
            }
          } else if (e.key === "Escape") setOpen(false);
        }}
      />
      {open && rows.length > 0 && (
        <div class="suggest">
          {rows.map((r, i) => (
            <div class={cls(i === idx && "on")} onMouseDown={() => onPick(r)}>
              <KindTag kind={r.kind} />
              <span class="ellipsis">{r.label}</span>
              {r.path && r.kind !== "file" ? <span class="path">{r.path}</span> : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function GraphExplorer({
  params,
  mode,
}: {
  params: Record<string, string>;
  mode: "galaxy" | "hierarchy";
}): JSX.Element {
  const [state, setState] = useState<ViewState>({
    node: params.node ?? null,
    depth: 1,
    direction: "both",
    kinds: DEFAULT_KINDS,
  });
  const [history, setHistory] = useState<{
    back: ViewState[];
    fwd: ViewState[];
  }>({
    back: [],
    fwd: [],
  });
  const [graph, setGraph] = useState<GraphResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [pathTo, setPathTo] = useState("");
  const [pathEdges, setPathEdges] = useState<Set<string> | undefined>();
  const [legend, setLegend] = useState(true);
  const [grow, setGrow] = useState(false);
  const handle = useRef<GraphHandle | null>(null);

  useEffect(() => {
    if (params.node && params.node !== state.node) go({ ...state, node: params.node });
  }, [params.node]);

  const go = (next: ViewState, record = true) => {
    if (record) setHistory((h) => ({ back: [...h.back, state].slice(-30), fwd: [] }));
    setState(next);
  };

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setGraphError(null);
    setPathEdges(undefined);
    // An empty param is dropped by `api()` and the server then draws every kind;
    // "none" matches no edge kind, so all chips off really means no edges.
    const kinds = state.kinds.join(",") || "none";
    const req = state.node
      ? api<GraphResult>("/api/graph", {
          mode: "expand",
          node: state.node,
          direction: state.direction,
          kinds,
          depth: state.depth,
          limit: 400,
        })
      : api<GraphResult>("/api/graph", { mode: "map", kinds, limit: 200 });
    req
      .then((g) => {
        if (!alive) return;
        setGraph(g);
        setSelected(g.root ?? null);
      })
      .catch((e: Error) => alive && setGraphError(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [state, retryTick]);

  const expand = (id: string) => {
    setGrow(true);
    go({ ...state, node: id });
  };
  const showPath = async () => {
    if (!state.node || !pathTo.trim()) return;
    try {
      const p = await api<{ nodes: VisNode[]; edges: VisEdge[] }>("/api/graph", {
        mode: "path",
        node: state.node,
        to: pathTo.trim(),
      });
      // merge path nodes/edges into the current picture and highlight them
      setGraph((g) => {
        if (!g) return g;
        const ids = new Set(g.nodes.map((n) => n.id));
        const keys = new Set(g.edges.map((e) => `${e.src}|${e.dst}|${e.kind}`));
        return {
          ...g,
          nodes: [...g.nodes, ...p.nodes.filter((n) => !ids.has(n.id))],
          edges: [...g.edges, ...p.edges.filter((e) => !keys.has(`${e.src}|${e.dst}|${e.kind}`))],
        };
      });
      setGrow(true);
      setPathEdges(new Set(p.edges.map((e) => `${e.src}|${e.dst}|${e.kind}`)));
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const sel = graph?.nodes.find((n) => n.id === selected);
  const ins = sel ? graph!.edges.filter((e) => e.dst === sel.id) : [];
  const outs = sel ? graph!.edges.filter((e) => e.src === sel.id) : [];
  const label = (id: string) => graph?.nodes.find((n) => n.id === id)?.label ?? id;
  const fileCount = graph?.nodes.filter((n) => n.kind === "file").length ?? 0;
  const toggleKind = (k: string) =>
    go({
      ...state,
      kinds: state.kinds.includes(k) ? state.kinds.filter((x) => x !== k) : [...state.kinds, k],
    });

  return (
    <div class="ws-graph-pane">
      <div class="gtoolbar">
        <button
          type="button"
          class="sm"
          disabled={!history.back.length}
          title="back"
          onClick={() => {
            const prev = history.back[history.back.length - 1];
            if (!prev) return;
            setHistory((h) => ({
              back: h.back.slice(0, -1),
              fwd: [state, ...h.fwd],
            }));
            setState(prev);
          }}
        >
          ←
        </button>
        <button
          type="button"
          class="sm"
          disabled={!history.fwd.length}
          title="forward"
          onClick={() => {
            const next = history.fwd[0];
            if (!next) return;
            setHistory((h) => ({
              back: [...h.back, state],
              fwd: h.fwd.slice(1),
            }));
            setState(next);
          }}
        >
          →
        </button>
        <NodeSearch value={state.node ?? ""} onPick={(n) => go({ ...state, node: n.id })} />
        <button
          type="button"
          class="sm"
          onClick={() => go({ ...state, node: null })}
          title="whole project (file map)"
        >
          All
        </button>
        <select
          value={state.direction}
          disabled={!state.node}
          title={state.node ? undefined : "pick a node to follow edges in one direction"}
          onChange={(e) =>
            go({
              ...state,
              direction: (e.target as HTMLSelectElement).value as Direction,
            })
          }
        >
          <option value="both">Both directions</option>
          <option value="in">Incoming (who uses it)</option>
          <option value="out">Outgoing (what it uses)</option>
        </select>
        <span class="row tight">
          <button
            type="button"
            class="sm"
            disabled={!state.node || state.depth <= 1}
            onClick={() => go({ ...state, depth: state.depth - 1 })}
          >
            −
          </button>
          <span class="small nowrap">
            {state.depth} layer{state.depth === 1 ? "" : "s"}
          </span>
          <button
            type="button"
            class="sm"
            disabled={!state.node || state.depth >= 4}
            onClick={() => go({ ...state, depth: state.depth + 1 })}
          >
            +1
          </button>
        </span>
        <span class="row tight">
          <input
            type="text"
            placeholder="path to…"
            style={{ width: 160 }}
            value={pathTo}
            onInput={(e) => setPathTo((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => e.key === "Enter" && showPath()}
          />
          <button type="button" class="sm" onClick={showPath} disabled={!state.node}>
            Path
          </button>
        </span>
        <span class="row tight">
          <button
            type="button"
            class={cls("chip", legend && "on")}
            onClick={() => setLegend(!legend)}
          >
            legend
          </button>
        </span>
        <span class="count">
          {loading ? (
            <Spinner />
          ) : graph ? (
            `${graph.nodes.length} nodes · ${graph.edges.length} edges${graph.truncated ? " · truncated" : ""}${graph.total && graph.total > fileCount ? ` · top ${fileCount} of ${graph.total} files` : ""}`
          ) : (
            ""
          )}
        </span>
      </div>
      <div class="gtoolbar" style={{ paddingTop: 4, paddingBottom: 6 }}>
        <span class="muted small">edges:</span>
        {EDGE_KINDS.map((k) => (
          <button
            type="button"
            class={cls("chip", state.kinds.includes(k) && "on")}
            onClick={() => toggleKind(k)}
          >
            {k}
          </button>
        ))}
      </div>
      <div class="ws-body" style={{ gridTemplateColumns: sel ? "minmax(0,1fr) 340px" : "1fr" }}>
        <div style={{ minWidth: 0 }}>
          {graphError ? (
            <ErrorBox error={graphError} onRetry={() => setRetryTick((n) => n + 1)} />
          ) : graph ? (
            graph.nodes.length ? (
              <GraphCanvas
                nodes={graph.nodes}
                edges={graph.edges}
                mode={mode}
                selected={selected}
                highlight={pathEdges}
                onSelect={setSelected}
                onActivate={expand}
                legend={legend}
                handle={handle}
                keepPositions={grow}
              />
            ) : (
              <EmptyState icon="✦" title="The graph is empty">
                Run a reindex from System and the code graph shows up here.
              </EmptyState>
            )
          ) : (
            <div class="ws-skel" aria-busy="true">
              <Skeleton h={180} />
            </div>
          )}
        </div>
        {sel && (
          <div class="panel right">
            <div class="head">
              selection <span class="spacer" />
              <a onClick={() => setSelected(null)}>close</a>
            </div>
            <div class="body">
              <div class="section">
                <div class="row tight">
                  <KindTag kind={sel.kind} />
                  <b class="break">{sel.label}</b>
                </div>
                {sel.path && sel.kind !== "file" ? (
                  <div class="muted small">
                    {sel.path}
                    {sel.line ? `:${sel.line}` : ""}
                  </div>
                ) : null}
                <div class="row" style={{ marginTop: 8 }}>
                  <button type="button" class="sm primary" onClick={() => expand(sel.id)}>
                    Expand from here
                  </button>
                  {sel.path ? (
                    <button
                      type="button"
                      class="sm"
                      onClick={() =>
                        navigate("explore", {
                          file: sel.path!,
                          line: sel.line ? String(sel.line) : undefined,
                          symbol: sel.kind === "file" ? undefined : sel.id,
                        })
                      }
                    >
                      Open source
                    </button>
                  ) : null}
                  {sel.kind === "memory" ? (
                    <button
                      type="button"
                      class="sm"
                      onClick={() => navigate("memory", { name: sel.label })}
                    >
                      Open memory
                    </button>
                  ) : null}
                </div>
              </div>
              <div class="section">
                <h4>incoming · {ins.length}</h4>
                <table>
                  <tbody>
                    {ins.slice(0, 60).map((e) => (
                      <tr class="click" onClick={() => setSelected(e.src)}>
                        <td>
                          <Badge>{e.kind}</Badge>
                        </td>
                        <td class="break">{label(e.src)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div class="section">
                <h4>outgoing · {outs.length}</h4>
                <table>
                  <tbody>
                    {outs.slice(0, 60).map((e) => (
                      <tr class="click" onClick={() => setSelected(e.dst)}>
                        <td>
                          <Badge>{e.kind}</Badge>
                        </td>
                        <td class="break">{label(e.dst)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const TAB_KEY = "eminiar.galaxy.tab";

const TAB_OPTIONS: Array<{ id: GalaxyTab; label: string; title: string }> = [
  { id: "galaxy", label: "Galaxy", title: "force-directed code graph" },
  { id: "hierarchy", label: "Hierarchy", title: "layered code graph" },
  { id: "map", label: "Folder map", title: "treemap of the project by size or heat" },
  { id: "routes", label: "Routes", title: "detected HTTP routes and their handlers" },
  { id: "hotspots", label: "Hotspots", title: "files and functions that attract change" },
  { id: "structure", label: "Structure", title: "clusters and import cycles" },
  { id: "behavior", label: "Behavior", title: "possible call tree from one operation" },
];

/** The tab to show: the URL wins, a node link means the graph, else the last one used. */
function pickTab(params: Record<string, string>): GalaxyTab {
  if (isGalaxyTab(params.tab)) return params.tab;
  if (params.node) return "galaxy";
  try {
    const t = localStorage.getItem(TAB_KEY) ?? undefined;
    if (isGalaxyTab(t)) return t;
  } catch {
    // storage may be unavailable
  }
  return "galaxy";
}

export function Galaxy({ params }: { params: Record<string, string> }): JSX.Element {
  const tab = pickTab(params);
  useEffect(() => {
    try {
      localStorage.setItem(TAB_KEY, tab);
    } catch {
      // storage may be unavailable
    }
  }, [tab]);
  const graph = tab === "galaxy" || tab === "hierarchy";
  return (
    <div class="ws ws-galaxy">
      <div class="gtabs">
        <Segmented
          label="Galaxy views"
          value={tab}
          onChange={(t) => navigate("galaxy", { tab: t })}
          options={TAB_OPTIONS}
        />
      </div>
      {graph ? (
        <GraphExplorer params={params} mode={tab} />
      ) : (
        <div class="gt-page">
          <div class="page ds-page">
            {tab === "map" && <FolderMap />}
            {tab === "routes" && <Routes />}
            {tab === "hotspots" && <Hotspots />}
            {tab === "structure" && <Structure />}
            {tab === "behavior" && <Behavior params={params} />}
          </div>
        </div>
      )}
    </div>
  );
}
