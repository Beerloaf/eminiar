import type { JSX } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { type Architecture as Arch, api, type TreeFile } from "../../api.js";
import { ErrorBox, useAsync } from "../../components.js";
import { Badge, Card, Skeleton, Stat, StatRow } from "../../ds.js";
import { buildTree, layoutTreemap, type Rect } from "../../graph/treemap.js";
import { navigate } from "../../router.js";
import { cls, fmt } from "../../util.js";

const LANG_COLORS: Record<string, string> = {
  typescript: "#2563eb",
  tsx: "#3b82f6",
  javascript: "#d97706",
  python: "#16a34a",
  go: "#0d9488",
  php: "#6366f1",
  other: "#6b7280",
};
function heat(score: number): string {
  // blue → amber ramp on the palette
  const t = Math.max(0, Math.min(1, score));
  const r = Math.round(37 + (217 - 37) * t);
  const g = Math.round(99 + (119 - 99) * t);
  const b = Math.round(235 + (6 - 235) * t);
  return `rgb(${r},${g},${b})`;
}

function FolderMapBody({
  files,
  arch,
}: {
  files: TreeFile[];
  arch: Arch | undefined;
}): JSX.Element {
  const [prefix, setPrefix] = useState("");
  const [colorBy, setColorBy] = useState<"language" | "heat">("language");
  const [sizeBy, setSizeBy] = useState<"loc" | "uniform">("loc");
  const [sel, setSel] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 900, h: 520 });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  const rects = useMemo(() => {
    const tree = buildTree(files, prefix, (f) =>
      sizeBy === "uniform" ? 1 : f.loc || Math.max(1, f.size / 40),
    );
    return layoutTreemap(tree, size.w, size.h);
  }, [files, prefix, sizeBy, size]);
  const info = (p: string) => files.filter((f) => f.path === p || f.path.startsWith(`${p}/`));
  const selected = sel ? info(sel) : [];
  const selFile = selected.length === 1 && selected[0]?.path === sel ? selected[0] : undefined;
  const entry = arch?.entryPoints.filter((e) => e.kind !== "script") ?? [];
  return (
    <>
      {arch && (
        <StatRow>
          <Stat label="files" value={fmt(arch.overview.files)} />
          <Stat label="symbols" value={fmt(arch.overview.symbols)} />
          <Stat label="edges" value={fmt(arch.overview.edges)} />
          <Stat
            label="languages"
            value={Object.keys(arch.overview.languages).length}
            sub={Object.entries(arch.overview.languages)
              .map(([l, n]) => `${l} ${n}`)
              .join(" · ")}
          />
        </StatRow>
      )}
      <div class="ds-grid main-side" style={{ alignItems: "start" }}>
        <div>
          <div class="row" style={{ marginBottom: 8 }}>
            <span class="row tight">
              <a onClick={() => setPrefix("")}>{arch?.project.name ?? "project"}</a>
              {prefix
                .split("/")
                .filter(Boolean)
                .map((seg, i, all) => (
                  <>
                    <span class="muted">›</span>
                    <a onClick={() => setPrefix(all.slice(0, i + 1).join("/"))}>{seg}</a>
                  </>
                ))}
            </span>
            <span class="spacer" />
            <span class="row tight">
              <button
                type="button"
                class={cls("chip", sizeBy === "loc" && "on")}
                onClick={() => setSizeBy("loc")}
              >
                size: loc
              </button>
              <button
                type="button"
                class={cls("chip", sizeBy === "uniform" && "on")}
                onClick={() => setSizeBy("uniform")}
              >
                uniform
              </button>
              <button
                type="button"
                class={cls("chip", colorBy === "language" && "on")}
                onClick={() => setColorBy("language")}
              >
                color: language
              </button>
              <button
                type="button"
                class={cls("chip", colorBy === "heat" && "on")}
                onClick={() => setColorBy("heat")}
              >
                heat
              </button>
            </span>
          </div>
          <div class="treemap" ref={box}>
            {rects.map((r: Rect) => {
              const f = r.node.data as TreeFile | undefined;
              const isDir = !!r.node.children?.length;
              const bg = f
                ? colorBy === "heat"
                  ? heat(f.score)
                  : (LANG_COLORS[f.language ?? "other"] ?? LANG_COLORS.other)
                : undefined;
              return (
                <div
                  class={cls("cell", isDir && "dir", sel === r.node.path && "sel")}
                  style={{
                    left: r.x,
                    top: r.y,
                    width: Math.max(0, r.w),
                    height: Math.max(0, r.h),
                    background: bg,
                  }}
                  title={
                    f
                      ? `${f.path} · ${f.loc} loc · ${f.symbols} symbols · heat ${f.score.toFixed(2)}`
                      : `${r.node.path} · ${r.node.size} loc`
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    setSel(r.node.path);
                  }}
                  onDblClick={(e) => {
                    e.stopPropagation();
                    if (isDir) setPrefix(r.node.path);
                    else if (f) navigate("explore", { file: f.path });
                  }}
                >
                  {isDir ? (
                    <span class="lbl">{r.node.name}/</span>
                  ) : r.w > 50 && r.h > 14 ? (
                    r.node.name
                  ) : (
                    ""
                  )}
                </div>
              );
            })}
          </div>
          <div class="muted small" style={{ marginTop: 6 }}>
            Area is lines of code (or uniform). Double-click a folder to open it, a file to read it.
            Heat mixes fan-in, recent commits and complexity; it is a signal, not a grade.
          </div>
        </div>
        <div class="stack">
          <Card title={sel ?? "Selection"}>
            {selFile ? (
              <>
                <div class="row small">
                  <Badge>{selFile.language ?? "?"}</Badge>
                  <Badge>{selFile.loc} loc</Badge>
                  <Badge>{selFile.symbols} symbols</Badge>
                  <Badge>fan-in {selFile.fanIn}</Badge>
                  <Badge>heat {selFile.score.toFixed(2)}</Badge>
                  <Badge>{selFile.status}</Badge>
                </div>
                <div class="row" style={{ marginTop: 8 }}>
                  <button
                    type="button"
                    class="sm"
                    onClick={() => navigate("explore", { file: selFile.path })}
                  >
                    Open source
                  </button>
                  <button
                    type="button"
                    class="sm"
                    onClick={() => navigate("galaxy", { node: `file:${selFile.path}` })}
                  >
                    Galaxy
                  </button>
                </div>
              </>
            ) : selected.length ? (
              <div class="row small">
                <Badge>{selected.length} files</Badge>
                <Badge>{fmt(selected.reduce((a, f) => a + f.loc, 0))} loc</Badge>
                <Badge>{selected.reduce((a, f) => a + f.symbols, 0)} symbols</Badge>
                <Badge>
                  mean heat{" "}
                  {(selected.reduce((a, f) => a + f.score, 0) / selected.length).toFixed(2)}
                </Badge>
              </div>
            ) : (
              <div class="muted small">Click a cell.</div>
            )}
          </Card>
          <Card title="Entry points" flush>
            {entry.length ? (
              <table>
                <tbody>
                  {entry.map((e) => (
                    <tr class="click" onClick={() => navigate("explore", { file: e.path })}>
                      <td>
                        <Badge>{e.kind}</Badge>
                      </td>
                      <td class="break">{e.name}</td>
                      <td class="muted small break">{e.path}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div class="muted small" style={{ padding: "0 var(--space-3) var(--space-3)" }}>
                none found
              </div>
            )}
          </Card>
          {arch?.project.description ? (
            <Card title="Project">
              <div class="muted small">{arch.project.description}</div>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}

export function FolderMap(): JSX.Element {
  const tree = useAsync(() => api<{ files: TreeFile[] }>("/api/tree"), []);
  const arch = useAsync(
    () => api<Arch>("/api/architecture", { aspects: "overview,entry_points" }),
    [],
  );
  if (tree.error) return <ErrorBox error={tree.error} />;
  if (!tree.data) return <Skeleton h={320} />;
  return <FolderMapBody files={tree.data.files} arch={arch.data} />;
}
