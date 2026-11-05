// The template gallery: one card per GET /api/swarm/templates entry, with a live mini
// topology of its roles, "use when" and role chips, and a name field. Used in a drawer for
// "+ New swarm" and inline when the project has no swarm file yet.
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { SwarmTemplateUi } from "../../api.js";
import { Badge, Card, Field, Skeleton } from "../../ds.js";
import { cls } from "../../util.js";
import { RoleChip } from "../bits.js";
import { ConfigTopology } from "../ConfigTopology.js";
import { TOPOLOGY_GLYPH } from "../style.js";
import { nameProblem, uniqueName } from "./draft.js";

export function TemplateGallery({
  templates,
  error,
  taken,
  action = "Add swarm",
  onCreate,
}: {
  templates: SwarmTemplateUi[] | undefined;
  error?: string | undefined;
  /** Swarm names already in the draft. */
  taken: string[];
  action?: string;
  onCreate: (name: string, t: SwarmTemplateUi) => void;
}): JSX.Element {
  const [pick, setPick] = useState<string>();
  const [name, setName] = useState("");
  const chosen = templates?.find((t) => t.id === pick) ?? templates?.[0];
  useEffect(() => {
    if (chosen) setName(uniqueName(chosen.id === "blank" ? "swarm" : chosen.id, taken));
  }, [chosen?.id]);
  if (error) return <div class="swc-note bad small">Templates could not be loaded: {error}</div>;
  if (!templates)
    return (
      <div class="swc-tpls" aria-busy="true">
        {[0, 1, 2, 3].map(() => (
          <Skeleton h={150} class="swc-skel-card" />
        ))}
      </div>
    );
  const problem = nameProblem(name, taken);
  return (
    <div class="swc-gallery">
      <div class="swc-tpls" role="radiogroup" aria-label="swarm templates">
        {templates.map((t) => {
          const roles = t.roles.map((r) => r.role);
          const on = chosen?.id === t.id;
          return (
            <Card
              raised
              selected={on}
              class={cls("swc-tpl", on && "on")}
              onClick={() => setPick(t.id)}
            >
              <div class="swc-tpl-head">
                <span class="swc-tpl-glyph" aria-hidden="true">
                  {TOPOLOGY_GLYPH[t.topology]}
                </span>
                <span class="swc-tpl-title">
                  <b>{t.name}</b>
                  <span class="muted small">
                    {t.topology} · {t.roles.length} role{t.roles.length === 1 ? "" : "s"}
                  </span>
                </span>
                {on ? <Badge tone="accent">✓ selected</Badge> : null}
              </div>
              {t.roles.length ? (
                <ConfigTopology
                  class="swc-tpl-topo"
                  topology={t.topology}
                  roles={t.roles.map((r) => ({ name: r.role, count: r.count }))}
                  stages={t.swarm.stages}
                />
              ) : (
                <div class="swc-tpl-blank" aria-hidden="true">
                  ＋
                </div>
              )}
              <p class="small swc-tpl-desc">{t.description}</p>
              <p class="small muted swc-tpl-when">{t.useWhen}</p>
              <div class="swc-tpl-roles">
                {t.roles.map((r) => (
                  <RoleChip role={r.role} roles={roles} title={`${r.role} · ${r.model}`}>
                    {r.count > 1 ? <span class="n">×{r.count}</span> : null}
                  </RoleChip>
                ))}
              </div>
            </Card>
          );
        })}
      </div>
      {chosen ? (
        <div class="swc-tpl-go">
          <Field
            label="Swarm name"
            htmlFor="swc-tpl-name"
            hint="you start a run with /eminiar:em-swarm <name> <goal>"
          >
            <input
              id="swc-tpl-name"
              type="text"
              class="mono"
              value={name}
              spellcheck={false}
              autocomplete="off"
              onInput={(e) => setName((e.target as HTMLInputElement).value.trim())}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !problem && chosen) onCreate(name, chosen);
              }}
            />
            {problem ? <div class="ds-field-error">{problem}</div> : null}
          </Field>
          <button
            type="button"
            class="primary"
            disabled={!!problem}
            title={problem}
            onClick={() => onCreate(name, chosen)}
          >
            {action}: {chosen.name}
          </button>
        </div>
      ) : null}
    </div>
  );
}
