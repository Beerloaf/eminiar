import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getContext, resetContextCache } from "../../src/context.js";
import { closeAllStorage } from "../../src/storage/index.js";
import { resetSwarmConfigCache } from "../../src/swarm/config.js";
import { swarmOverview } from "../../src/ui/swarm-api.js";

const YAML = [
  "swarms:",
  "  s:",
  "    description: d",
  "    agents:",
  "      ranged: { description: x, model: sonnet, model_range: { floor: haiku, ceiling: opus } }",
  "      pinned: { description: x, model: opus }",
  "      inherits: { description: x }",
  "",
].join("\n");

describe("swarm dashboard roles: model_range", () => {
  let root: string;
  beforeAll(() => {
    process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-home-"));
    root = mkdtempSync(join(tmpdir(), "em-swarm-ui-range-"));
    writeFileSync(join(root, "package.json"), "{}");
    mkdirSync(join(root, ".eminiar"), { recursive: true });
    writeFileSync(join(root, ".eminiar", "swarm.yaml"), YAML);
    resetContextCache();
    resetSwarmConfigCache();
  });
  afterAll(() => closeAllStorage());

  it("carries a ranged role's floor..ceiling and null for a fixed pin or inherit", () => {
    const o = swarmOverview(getContext(root));
    expect(o.state).toBe("ok");
    const roles = o.swarms[0]!.roles;
    // The shape SwarmRoleUi.range declares (src/ui/web/api.ts cannot be imported here: DOM globals).
    const range: { floor: string; ceiling: string } | null = roles[0]!.range;
    expect(range).not.toBeNull();
    const by = Object.fromEntries(roles.map((r) => [r.role, r]));
    expect(by.ranged).toMatchObject({
      model: "sonnet",
      range: { floor: "haiku", ceiling: "opus" },
    });
    expect(by.pinned).toMatchObject({ model: "opus", range: null });
    expect(by.inherits).toMatchObject({ model: null, range: null });
    // JSON keeps the null (an undefined would drop the key).
    const wire = JSON.parse(JSON.stringify(roles)) as typeof roles;
    expect(wire.map((r) => r.range)).toEqual([{ floor: "haiku", ceiling: "opus" }, null, null]);
  });
});
