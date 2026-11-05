import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { api, type Hotspot } from "../../api.js";
import { Bar, ErrorBox, KindTag, useAsync, useSort } from "../../components.js";
import { Card, EmptyState, Skeleton } from "../../ds.js";
import { navigate } from "../../router.js";
import { cls } from "../../util.js";

export function Hotspots(): JSX.Element {
  const [kind, setKind] = useState<"file" | "symbol">("file");
  const [path, setPath] = useState("");
  const q = useAsync(
    () => api<Hotspot[]>("/api/hotspots", { kind, path: path.trim() || undefined, limit: 80 }),
    [kind, path],
  );
  const { sorted, th } = useSort(q.data, "score");
  const max = {
    fan_in: Math.max(1, ...sorted.map((h) => h.fan_in)),
    commits_90d: Math.max(1, ...sorted.map((h) => h.commits_90d)),
    complexity: Math.max(1, ...sorted.map((h) => h.complexity)),
  };
  return (
    <>
      <div class="row" style={{ marginBottom: 10 }}>
        <button
          type="button"
          class={cls("chip", kind === "file" && "on")}
          onClick={() => setKind("file")}
        >
          files
        </button>
        <button
          type="button"
          class={cls("chip", kind === "symbol" && "on")}
          onClick={() => setKind("symbol")}
        >
          functions and classes
        </button>
        <input
          type="text"
          placeholder="folder prefix, e.g. src/graph/"
          value={path}
          onInput={(e) => setPath((e.target as HTMLInputElement).value)}
          style={{ width: 260 }}
        />
        <span class="muted small">
          Score = 0.4·fan-in + 0.4·commits/90d + 0.2·complexity, log-scaled. A signal of where
          attention goes, not a quality grade.
        </span>
      </div>
      {q.error ? (
        <ErrorBox error={q.error} />
      ) : !q.data ? (
        <Skeleton h={160} />
      ) : !sorted.length ? (
        <EmptyState icon="♨" title="No hotspots yet">
          Run a reindex from System (or widen the folder prefix) and the most changed, most used
          code shows up here.
        </EmptyState>
      ) : (
        <Card
          flush
          title={kind === "file" ? "Hot files" : "Hot functions and classes"}
          right={`${sorted.length}`}
        >
          <table>
            <thead>
              <tr>
                {th("path", kind === "file" ? "file" : "symbol")}
                {th("fan_in", "fan-in", true)}
                {th("commits_90d", "commits/90d", true)}
                {th("complexity", "complexity", true)}
                {th("loc", "loc", true)}
                {th("score", "score", true)}
                <th>last</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((h) => (
                <tr
                  class="click"
                  onClick={() =>
                    h.kind === "file"
                      ? navigate("explore", { file: h.path })
                      : navigate("explore", { file: h.path.split(" > ")[0]!, symbol: h.id })
                  }
                >
                  <td class="break">
                    {h.kind !== "file" ? <KindTag kind={h.kind} /> : null}
                    {h.path}
                  </td>
                  <td class="num">
                    <Bar value={h.fan_in} max={max.fan_in} width={60} /> {h.fan_in}
                  </td>
                  <td class="num">
                    <Bar value={h.commits_90d} max={max.commits_90d} width={60} /> {h.commits_90d}
                  </td>
                  <td class="num">
                    <Bar value={h.complexity} max={max.complexity} width={60} /> {h.complexity}
                  </td>
                  <td class="num">{h.loc}</td>
                  <td class="num">
                    <b>{h.score.toFixed(2)}</b>
                  </td>
                  <td class="muted small">{h.last_touched}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}
