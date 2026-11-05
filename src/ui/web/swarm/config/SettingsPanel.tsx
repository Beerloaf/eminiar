// File-wide settings of the swarm file: enabled, sync, enforce (+ allowed_agents) and the
// defaults every role inherits (model policy, skills, context). Switching swarms off or
// enforcement on asks first, inline, because both change what Claude Code may run.
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import type { SwarmConfigMeta } from "../../api.js";
import { Card, ChipInput, Field, Segmented, Switch } from "../../ds.js";
import { GLYPH } from "../style.js";
import { isLocked, issuesUnder, type PathIssue, type SwarmDoc, setIn } from "./draft.js";
import { ContextEditor, ModelPolicyControl, mergedContext } from "./fields.js";

type Ask = "disable" | "enforce" | null;

export function SettingsPanel({
  doc,
  meta,
  issues,
  locked,
  onChange,
}: {
  doc: SwarmDoc;
  meta: SwarmConfigMeta;
  issues: PathIssue[];
  locked: string[];
  onChange: (d: SwarmDoc) => void;
}): JSX.Element {
  const [ask, setAsk] = useState<Ask>(null);
  const err = (p: string) => {
    const l = issuesUnder(issues, p);
    return l.length ? l.map((i) => i.message).join("; ") : undefined;
  };
  const lk = (p: string) => isLocked(locked, p);
  const set = (path: string[], v: unknown) => onChange(setIn(doc, path, v));
  const enabled = doc.enabled !== false;
  const enforce = doc.enforce === true;
  const d = doc.defaults ?? {};
  const setDefaults = (next: typeof d) =>
    set(["defaults"], Object.values(next).some((v) => v !== undefined) ? next : undefined);
  return (
    <div class="swc-settings">
      <Card title="Swarms in this project" sub="enabled · sync · enforce" raised>
        <div class="swc-set-row">
          <div class="swc-set-text">
            <b>Enabled</b>
            <span class="small muted">
              Off: the hooks ignore every swarm, and a sync removes the generated agent files.
            </span>
          </div>
          <Switch
            checked={enabled}
            disabled={lk("enabled")}
            label={enabled ? "on" : "off"}
            onChange={(on) => (on ? set(["enabled"], true) : setAsk("disable"))}
          />
        </div>
        {ask === "disable" ? (
          <div class="swc-confirm" role="alertdialog" aria-label="turn swarms off">
            <span>
              {GLYPH.blocked} Turn swarms off? The hooks stop coordinating runs, and the next sync
              deletes <code>.claude/agents/swarm-*.md</code>.
            </span>
            <span class="row tight">
              <button type="button" class="sm" onClick={() => setAsk(null)}>
                Cancel
              </button>
              <button
                type="button"
                class="sm danger"
                onClick={() => {
                  set(["enabled"], false);
                  setAsk(null);
                }}
              >
                Turn off
              </button>
            </span>
          </div>
        ) : null}
        <div class="swc-set-row">
          <div class="swc-set-text">
            <b>Sync</b>
            <span class="small muted">
              auto: regenerate the agent files at session start when this file changes · manual:
              only on Sync.
            </span>
          </div>
          <Segmented<"auto" | "manual">
            label="sync"
            value={doc.sync ?? "auto"}
            onChange={(v) =>
              !lk("sync") && set(["sync"], v === "auto" && doc.sync === undefined ? undefined : v)
            }
            options={[
              { id: "auto", label: "auto" },
              { id: "manual", label: "manual" },
            ]}
          />
        </div>
        <div class="swc-set-row">
          <div class="swc-set-text">
            <b>Enforce</b>
            <span class="small muted">
              Only this file's swarm workers may run as subagents, and only during a run of their
              swarm.
            </span>
          </div>
          <Switch
            checked={enforce}
            disabled={lk("enforce")}
            label={enforce ? "on" : "off"}
            onChange={(on) => (on ? setAsk("enforce") : set(["enforce"], false))}
          />
        </div>
        {err("enforce") ? <div class="ds-field-error">{err("enforce")}</div> : null}
        {ask === "enforce" ? (
          <div class="swc-confirm" role="alertdialog" aria-label="turn enforcement on">
            <span>
              {GLYPH.blocked} With enforce on, any other subagent (Explore, general-purpose, your
              own agents) is denied unless it is listed in allowed agents.
            </span>
            <span class="row tight">
              <button type="button" class="sm" onClick={() => setAsk(null)}>
                Cancel
              </button>
              <button
                type="button"
                class="sm primary"
                onClick={() => {
                  set(["enforce"], true);
                  setAsk(null);
                }}
              >
                Turn on
              </button>
            </span>
          </div>
        ) : null}
        {enforce ? (
          <Field
            label="Allowed agents"
            hint="subagent types that may still run outside a run (e.g. Explore)"
            error={err("allowed_agents")}
          >
            <ChipInput
              label="allowed agents"
              value={doc.allowed_agents ?? []}
              disabled={lk("allowed_agents")}
              placeholder="Explore, general-purpose"
              onChange={(v) => set(["allowed_agents"], v.length ? v : undefined)}
            />
          </Field>
        ) : null}
      </Card>

      <Card title="Defaults" sub="every role inherits these unless it sets its own" raised>
        <Field
          label="Model"
          hint="the default model, and the default range the adjudicator may move every role within"
          error={err("defaults.model") ?? err("defaults.model_range")}
        >
          <ModelPolicyControl
            isDefaults
            doc={doc}
            value={{ model: d.model, model_range: d.model_range }}
            models={meta.models}
            modelDisabled={lk("defaults.model")}
            rangeDisabled={lk("defaults.model_range")}
            onChange={(v) => setDefaults({ ...d, model: v.model, model_range: v.model_range })}
          />
        </Field>
        <Field label="Skills" hint="preloaded into every worker" error={err("defaults.skills")}>
          <ChipInput
            label="default skills"
            value={d.skills ?? []}
            disabled={lk("defaults.skills")}
            placeholder="eminiar:em-history"
            onChange={(v) => setDefaults({ ...d, skills: v.length ? v : undefined })}
          />
        </Field>
        <Field
          label="Context"
          hint="what eminiar tells each worker when it starts"
          error={err("defaults.context")}
        >
          <ContextEditor
            value={d.context}
            inherited={mergedContext(meta.defaultContext)}
            inheritedFrom="eminiar's built-in defaults"
            disabled={lk("defaults.context")}
            onChange={(c) => setDefaults({ ...d, context: c })}
          />
        </Field>
      </Card>
    </div>
  );
}
