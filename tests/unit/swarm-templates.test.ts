import { describe, expect, it } from "vitest";
import { parseSwarmYaml } from "../../src/swarm/config.js";
import { renderSwarmDoc } from "../../src/swarm/edit.js";
import { getTemplate, instantiateTemplate, SWARM_TEMPLATES } from "../../src/swarm/templates.js";

const MINIMAL = `version: 1
swarms:
  base:
    description: A base swarm
    agents:
      worker:
        description: Does work
        prompt: Work.
`;

describe("swarm templates", () => {
  it("offers the six documented templates with unique ids", () => {
    const ids = SWARM_TEMPLATES.map((t) => t.id);
    expect(ids).toEqual(["feature", "review", "research", "bugfix", "docs", "blank"]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of SWARM_TEMPLATES) {
      expect(t.name).toBeTruthy();
      expect(t.description).toBeTruthy();
      expect(t.useWhen).toBeTruthy();
    }
  });

  it.each(SWARM_TEMPLATES.map((t) => [t.id]))(
    "template %s inserted into a minimal file parses ok",
    (id) => {
      const swarm = instantiateTemplate(id as string);
      expect(swarm).toBeDefined();
      const doc = {
        version: 1 as const,
        swarms: { base: structuredClone(parseBase()), added: swarm as NonNullable<typeof swarm> },
      };
      const out = renderSwarmDoc(MINIMAL, doc);
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.result.state).toBe("ok");
      const again = parseSwarmYaml(out.text, "swarm.yaml", "swarm.yaml");
      expect(again.state).toBe("ok");
      if (again.state === "ok") expect(again.config.swarms.map((s) => s.name)).toContain("added");
    },
  );

  it("pipeline template lists every role in stages", () => {
    const docs = getTemplate("docs")?.swarm;
    expect(docs?.topology).toBe("pipeline");
    expect([...(docs?.stages ?? [])].sort()).toEqual(Object.keys(docs?.agents ?? {}).sort());
  });

  it("read-only roles disallow the editing tools", () => {
    for (const [swarmId, role] of [
      ["feature", "architect"],
      ["feature", "reviewer"],
      ["review", "security"],
      ["research", "synthesizer"],
    ] as const) {
      const r = getTemplate(swarmId)?.swarm.agents[role];
      expect(r?.disallowed_tools).toEqual(
        expect.arrayContaining(["Edit", "Write", "NotebookEdit"]),
      );
    }
  });

  it("instantiateTemplate returns an independent copy and undefined for unknown ids", () => {
    const a = instantiateTemplate("feature");
    const b = instantiateTemplate("feature");
    expect(a).toEqual(b);
    if (a) a.agents.coder = { description: "changed" };
    expect(getTemplate("feature")?.swarm.agents.coder?.description).not.toBe("changed");
    expect(instantiateTemplate("nope")).toBeUndefined();
    expect(getTemplate("nope")).toBeUndefined();
  });
});

function parseBase() {
  return {
    description: "A base swarm",
    agents: { worker: { description: "Does work", prompt: "Work." } },
  };
}
