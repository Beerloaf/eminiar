import type { JSX } from "preact";
import { api, type RouteRow } from "../../api.js";
import { ErrorBox, useAsync } from "../../components.js";
import { Badge, Card, EmptyState, Skeleton } from "../../ds.js";
import { navigate } from "../../router.js";

export function Routes(): JSX.Element {
  const q = useAsync(() => api<RouteRow[]>("/api/routes"), []);
  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.data) return <Skeleton h={160} />;
  if (!q.data.length)
    return (
      <EmptyState icon="↹" title="No routes detected">
        express/fastify/hono/koa/hapi/restify registrations, moleculer service schemas and gateway
        aliases, and Next.js route files are recognised.
      </EmptyState>
    );
  return (
    <Card flush title="Routes" right={`${q.data.length}`}>
      <table>
        <thead>
          <tr>
            <th>method</th>
            <th>path</th>
            <th>framework</th>
            <th>handler</th>
            <th>registered in</th>
          </tr>
        </thead>
        <tbody>
          {q.data.map((r) => (
            <tr>
              <td>
                <Badge>{r.method}</Badge>
              </td>
              <td class="mono">{r.path}</td>
              <td class="muted">{r.framework}</td>
              <td>
                {r.handlers.map((h) => (
                  <div>
                    <a
                      onClick={() =>
                        h.path
                          ? navigate("explore", { file: h.path, symbol: h.id })
                          : navigate("galaxy", { node: h.id })
                      }
                    >
                      {h.name}
                    </a>
                    {h.path ? <span class="muted small"> {h.path}</span> : null}
                  </div>
                ))}
              </td>
              <td class="muted small">
                <a
                  onClick={() =>
                    navigate("explore", { file: r.file, line: r.line ? String(r.line) : undefined })
                  }
                >
                  {r.file}
                  {r.line ? `:${r.line}` : ""}
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
