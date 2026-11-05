import type { JSX } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import {
  api,
  type FileData,
  type FileImpact,
  type FileSymbol,
  type SymbolDetail,
  type TreeFile,
} from "../api.js";
import { CodeView } from "../code/CodeView.js";
import { ErrorBox, KindTag, Split, useAsync } from "../components.js";
import { Badge, EmptyState, Skeleton } from "../ds.js";
import { GraphCanvas } from "../graph/GraphCanvas.js";
import { navigate } from "../router.js";
import { basename, cls, fmt, langOf } from "../util.js";

// --- file tree ------------------------------------------------------------------------

interface Dir {
  name: string;
  path: string;
  dirs: Map<string, Dir>;
  files: TreeFile[];
}

function buildDirs(files: TreeFile[]): Dir {
  const root: Dir = { name: "", path: "", dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let cur = root;
    for (const p of parts.slice(0, -1)) {
      let d = cur.dirs.get(p);
      if (!d) {
        d = {
          name: p,
          path: cur.path ? `${cur.path}/${p}` : p,
          dirs: new Map(),
          files: [],
        };
        cur.dirs.set(p, d);
      }
      cur = d;
    }
    cur.files.push(f);
  }
  return root;
}

function DirNode({
  dir,
  depth,
  open,
  toggle,
  selected,
  onSelect,
  filter,
}: {
  dir: Dir;
  depth: number;
  open: Set<string>;
  toggle: (p: string) => void;
  selected: string | undefined;
  onSelect: (p: string) => void;
  filter: string;
}): JSX.Element {
  const dirs = [...dir.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
  const files = [...dir.files].sort((a, b) => a.path.localeCompare(b.path));
  const pad = { paddingLeft: `${8 + depth * 14}px` };
  return (
    <>
      {dirs.map((d) => {
        const isOpen = open.has(d.path) || !!filter;
        return (
          <>
            <div class="node" style={pad} onClick={() => toggle(d.path)}>
              <span class="arrow">{isOpen ? "▾" : "▸"}</span>
              <span class="name">{d.name}</span>
            </div>
            {isOpen && (
              <DirNode
                dir={d}
                depth={depth + 1}
                open={open}
                toggle={toggle}
                selected={selected}
                onSelect={onSelect}
                filter={filter}
              />
            )}
          </>
        );
      })}
      {files.map((f) => (
        <div
          class={cls("node", selected === f.path && "sel")}
          style={pad}
          title={`${f.status}${f.reason ? ` (${f.reason})` : ""} · ${f.symbols} symbols · ${f.loc} loc`}
          onClick={() => onSelect(f.path)}
        >
          <span class="arrow" />
          <i class={cls("st", f.status)} />
          <span class="name">{basename(f.path)}</span>
          <span class={cls("heat", f.score > 0.6 && "hot")}>
            {f.score ? f.score.toFixed(2) : ""}
          </span>
        </div>
      ))}
    </>
  );
}

function FileTree({
  files,
  selected,
  onSelect,
}: {
  files: TreeFile[];
  selected: string | undefined;
  onSelect: (p: string) => void;
}): JSX.Element {
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<Set<string>>(() => {
    const s = new Set<string>();
    if (selected) {
      const parts = selected.split("/");
      for (let i = 1; i < parts.length; i++) s.add(parts.slice(0, i).join("/"));
    } else {
      // open the top-level folders with the most files
      const counts = new Map<string, number>();
      for (const f of files) {
        const top = f.path.split("/")[0]!;
        if (f.path.includes("/")) counts.set(top, (counts.get(top) ?? 0) + 1);
      }
      for (const [k] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 2)) s.add(k);
    }
    return s;
  });
  useEffect(() => {
    if (!selected) return;
    setOpen((o) => {
      const n = new Set(o);
      const parts = selected.split("/");
      for (let i = 1; i < parts.length; i++) n.add(parts.slice(0, i).join("/"));
      return n;
    });
  }, [selected]);
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f ? files.filter((x) => x.path.toLowerCase().includes(f)) : files;
  }, [files, filter]);
  const root = useMemo(() => buildDirs(shown), [shown]);
  return (
    <div class="panel">
      <div class="head">
        explorer <span class="spacer" />
        <span>{files.length} files</span>
      </div>
      <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--line)" }}>
        <input
          type="search"
          placeholder="filter files…"
          style={{ width: "100%" }}
          value={filter}
          onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
        />
      </div>
      <div class="body tree">
        <DirNode
          dir={root}
          depth={0}
          open={open}
          toggle={(p) =>
            setOpen((o) => {
              const n = new Set(o);
              if (n.has(p)) n.delete(p);
              else n.add(p);
              return n;
            })
          }
          selected={selected}
          onSelect={onSelect}
          filter={filter}
        />
      </div>
    </div>
  );
}

// --- side panel -----------------------------------------------------------------------

function EdgeList({
  title,
  rows,
  onPick,
}: {
  title: string;
  rows: SymbolDetail["callers"];
  onPick: (id: string, path: string | null, line: number | null) => void;
}): JSX.Element | null {
  if (!rows.length) return null;
  return (
    <div class="section">
      <h4>
        {title} · {rows.length}
      </h4>
      <table>
        <tbody>
          {rows.slice(0, 40).map((e) => (
            <tr class="click" onClick={() => onPick(e.node.id, e.node.path, e.node.line)}>
              <td>
                <Badge>{e.kind}</Badge>
              </td>
              <td class="break">
                <KindTag kind={e.node.kind} /> {e.node.label}
                {e.node.path && e.node.kind !== "file" ? (
                  <div class="muted small">
                    {e.node.path}
                    {e.lines?.length ? ` · L${e.lines.join(", L")}` : ""}
                  </div>
                ) : null}
              </td>
              <td class="num muted">{e.count ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 40 ? <div class="muted small">… {rows.length - 40} more</div> : null}
    </div>
  );
}

function SidePanel({
  file,
  impact,
  symbol,
  onPick,
}: {
  file: string | undefined;
  impact: FileImpact | undefined;
  symbol: SymbolDetail | undefined;
  onPick: (id: string, path: string | null, line: number | null) => void;
}): JSX.Element {
  if (!file)
    return (
      <div class="panel right">
        <EmptyState compact icon="◇" title="No file selected">
          Select a file to see what depends on it.
        </EmptyState>
      </div>
    );
  return (
    <div class="panel right">
      <div class="head">
        {symbol ? "code details" : "file impact"} <span class="spacer" />
        <a onClick={() => navigate("history", { file })}>history</a>
        <a
          onClick={() =>
            navigate("galaxy", {
              node: symbol ? symbol.node.id : `file:${file}`,
            })
          }
        >
          open in Galaxy →
        </a>
      </div>
      <div class="body">
        {symbol ? (
          <>
            <div class="section">
              <div class="row tight">
                <KindTag kind={symbol.node.kind} />
                <b class="break">{symbol.node.label}</b>
              </div>
              <div class="muted small">
                {symbol.node.path}
                {symbol.node.line ? `:${symbol.node.line}` : ""}
                {symbol.node.exported ? " · exported" : ""}
              </div>
              {symbol.metrics && (
                <div class="row small" style={{ marginTop: 6 }}>
                  <Badge>fan-in {symbol.metrics.fan_in}</Badge>
                  <Badge>fan-out {symbol.metrics.fan_out}</Badge>
                  <Badge>complexity {symbol.metrics.complexity}</Badge>
                  <Badge>{symbol.metrics.loc} loc</Badge>
                  <Badge>heat {symbol.metrics.score.toFixed(2)}</Badge>
                </div>
              )}
              {symbol.routes.length ? (
                <div class="small" style={{ marginTop: 6 }}>
                  handles{" "}
                  {symbol.routes.map((r) => (
                    <code>{r.label}</code>
                  ))}
                </div>
              ) : null}
            </div>
            <EdgeList title="callers and references" rows={symbol.callers} onPick={onPick} />
            <EdgeList title="calls and uses" rows={symbol.callees} onPick={onPick} />
            {symbol.members.length ? (
              <div class="section">
                <h4>members · {symbol.members.length}</h4>
                {symbol.members.map((m) => (
                  <div class="small">
                    <a onClick={() => onPick(m.id, m.path, m.line)}>
                      <KindTag kind={m.kind} />
                      {m.label}
                    </a>
                  </div>
                ))}
              </div>
            ) : null}
            {symbol.memories.length ? (
              <div class="section">
                <h4>memories mentioning it</h4>
                {symbol.memories.map((m) => (
                  <div class="small">
                    <a onClick={() => navigate("memory", { name: m.name })}>{m.name}</a>{" "}
                    <Badge>{m.kind}</Badge>
                  </div>
                ))}
              </div>
            ) : null}
          </>
        ) : impact ? (
          <>
            <div class="section">
              <div class="row small">
                <Badge>{impact.directDependents} direct dependents</Badge>
                <Badge>{impact.affected} affected files</Badge>
                <Badge>
                  {impact.tests} test file{impact.tests === 1 ? "" : "s"}
                </Badge>
                <Badge>{impact.coChanged.length} co-changed</Badge>
              </div>
              <div class="muted small" style={{ marginTop: 4 }}>
                Structural edges from the index plus git co-change history. Files outside the index
                are invisible here.
              </div>
            </div>
            {impact.graph.nodes.length > 1 && (
              <div class="section" style={{ padding: 0, height: 240 }}>
                <GraphCanvas
                  nodes={impact.graph.nodes}
                  edges={impact.graph.edges}
                  legend={false}
                  onActivate={(id) => id.startsWith("file:") && onPick(id, id.slice(5), null)}
                />
              </div>
            )}
            <div class="section">
              <h4>affected · {impact.hits.length}</h4>
              <table>
                <tbody>
                  {impact.hits.map((h) => (
                    <tr class="click" onClick={() => onPick(h.id, h.path, null)}>
                      <td class="break">
                        <KindTag kind={h.kind} />
                        {h.label.replace(/^[a-z]+ /, "")}
                        <div class="muted small">{h.reasons.join("; ")}</div>
                      </td>
                      <td class="num muted">{h.score.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {impact.memories.length ? (
              <div class="section">
                <h4>memories</h4>
                {impact.memories.map((m) => (
                  <div class="small">
                    <a onClick={() => navigate("memory", { name: m })}>{m}</a>
                  </div>
                ))}
              </div>
            ) : null}
          </>
        ) : (
          <div class="section ws-skel" aria-busy="true">
            <Skeleton h={14} w="60%" />
            <Skeleton h={14} />
            <Skeleton h={14} w="80%" />
          </div>
        )}
      </div>
    </div>
  );
}

// --- view ---------------------------------------------------------------------------

export function Explore({ params }: { params: Record<string, string> }): JSX.Element {
  const file = params.file;
  const line = params.line ? Number(params.line) : undefined;
  const tree = useAsync(() => api<{ files: TreeFile[] }>("/api/tree"), []);
  const data = useAsync(
    () => (file ? api<FileData>("/api/file", { path: file }) : Promise.resolve(undefined)),
    [file],
  );
  const impact = useAsync(
    () => (file ? api<FileImpact>("/api/file-impact", { path: file }) : Promise.resolve(undefined)),
    [file],
  );
  const [symId, setSymId] = useState<string | null>(params.symbol ?? null);
  useEffect(() => setSymId(params.symbol ?? null), [params.symbol, file]);
  const symbol = useAsync(
    () => (symId ? api<SymbolDetail>("/api/symbol", { id: symId }) : Promise.resolve(undefined)),
    [symId],
  );
  const openFile = (p: string, l?: number | null, sym?: string) =>
    navigate("explore", {
      file: p,
      line: l ? String(l) : undefined,
      symbol: sym,
    });
  const pick = (id: string, path: string | null, ln: number | null) => {
    if (id.startsWith("file:")) openFile(id.slice(5));
    else if (path) openFile(path, ln, id);
    else navigate("galaxy", { node: id });
  };
  const current = symbol.data && symId ? symbol.data : undefined;
  const selSym: FileSymbol | undefined = data.data?.symbols.find((s) => s.id === symId);
  const d = data.data;
  return (
    <div class="ws ws-explore">
      <Split
        left={
          tree.data ? (
            <FileTree files={tree.data.files} selected={file} onSelect={(p) => openFile(p)} />
          ) : (
            <div class="panel">
              {tree.error ? (
                <EmptyState compact tone="bad" icon="!" title="Could not load the file tree">
                  {tree.error}
                </EmptyState>
              ) : (
                <div class="ws-skel" aria-busy="true">
                  <Skeleton h={14} w="70%" />
                  <Skeleton h={14} />
                  <Skeleton h={14} w="85%" />
                </div>
              )}
            </div>
          )
        }
        center={
          <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
            <div class="crumbs">
              {file ? (
                file.split("/").map((seg, i, all) => (
                  <>
                    {i > 0 && <span class="sep">›</span>}
                    <span class={i === all.length - 1 ? "" : "muted"}>{seg}</span>
                  </>
                ))
              ) : (
                <span class="muted">no file selected</span>
              )}
              <span class="spacer" />
              {d?.status && d.status !== "indexed" ? (
                <Badge tone="warn">
                  {d.status}
                  {d.reason ? ` · ${d.reason}` : ""}
                </Badge>
              ) : null}
              {d ? (
                <span class="muted small">
                  {d.symbols.length} symbols · {fmt(d.size ?? 0)} B
                </span>
              ) : null}
              {symId ? (
                <button type="button" class="sm" onClick={() => setSymId(null)}>
                  ← file impact
                </button>
              ) : null}
            </div>
            <div style={{ flex: 1, minHeight: 0 }}>
              {!file ? (
                <EmptyState icon="❯" title="Pick a file">
                  Choose a file in the explorer. Click a line number to inspect the symbol around
                  it.
                </EmptyState>
              ) : data.error ? (
                <ErrorBox error={data.error} />
              ) : !d ? (
                <div class="ws-skel" aria-busy="true">
                  <Skeleton h={14} w="40%" />
                  <Skeleton h={14} />
                  <Skeleton h={14} w="90%" />
                  <Skeleton h={14} w="70%" />
                </div>
              ) : d.tooLarge ? (
                <EmptyState icon="⤓" title="File too large">
                  {d.path} is over the 1.5 MB limit and is not shown.
                </EmptyState>
              ) : (
                <CodeView
                  code={d.content ?? ""}
                  lang={langOf(d.path)}
                  symbols={d.symbols}
                  highlight={
                    selSym?.start_line && selSym.end_line
                      ? [selSym.start_line, selSym.end_line]
                      : null
                  }
                  scrollTo={line ?? selSym?.start_line ?? null}
                  onLine={(_l, s) => setSymId(s?.id ?? null)}
                />
              )}
            </div>
          </div>
        }
        right={<SidePanel file={file} impact={impact.data} symbol={current} onPick={pick} />}
      />
    </div>
  );
}
