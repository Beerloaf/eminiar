import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, ownJson, parseJsonSafe } from "../../src/config.js";
import { findProjectRoot, projectId } from "../../src/project.js";

describe("config", () => {
  let home: string;
  let root: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "em-home-"));
    root = mkdtempSync(join(tmpdir(), "em-root-"));
    process.env.EMINIAR_HOME = home;
  });
  afterEach(() => {
    delete process.env.EMINIAR_HOME;
    delete process.env.EMINIAR_ROUTING_MODE;
  });

  it("uses defaults with no files", () => {
    const c = loadConfig(root);
    expect(c.routing.mode).toBe("auto");
    expect(c.sandbox.indexThreshold).toBe(5120);
  });

  it("project file overrides home file, env overrides both", () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ routing: { mode: "off" } }));
    expect(loadConfig(root).routing.mode).toBe("off");
    writeFileSync(
      join(root, "eminiar.config.json"),
      JSON.stringify({ routing: { mode: "annotate" } }),
    );
    expect(loadConfig(root).routing.mode).toBe("annotate");
    process.env.EMINIAR_ROUTING_MODE = "enforce";
    expect(loadConfig(root).routing.mode).toBe("enforce");
  });

  it("falls back to defaults on invalid config", () => {
    writeFileSync(
      join(root, "eminiar.config.json"),
      JSON.stringify({ routing: { mode: "bogus" } }),
    );
    expect(loadConfig(root).routing.mode).toBe("auto");
  });
});

describe("prototype keys in config files (#62)", () => {
  let home: string;
  let root: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "em-home-"));
    root = mkdtempSync(join(tmpdir(), "em-root-"));
    process.env.EMINIAR_HOME = home;
  });
  afterEach(() => {
    delete process.env.EMINIAR_HOME;
  });

  const unpolluted = () => {
    const probe: Record<string, unknown> = {};
    for (const k of ["routing", "mode", "adjudicator", "sandbox", "polluted"])
      expect(probe[k]).toBeUndefined();
    expect(Object.getOwnPropertyNames(Object.prototype)).not.toContain("routing");
  };

  it("parseJsonSafe drops __proto__, constructor and prototype at every depth", () => {
    const v = parseJsonSafe(
      '{"a": {"__proto__": {"x": 1}, "b": [{"constructor": {"prototype": {"y": 2}}, "c": 3}]}, "prototype": 1, "__proto__": {"polluted": true}}',
    ) as { a: Record<string, unknown>; polluted?: unknown };
    expect(v).toEqual({ a: { b: [{ c: 3 }] } });
    expect(Object.getPrototypeOf(v)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(v.a)).toBe(Object.prototype);
    expect(v.a.x).toBeUndefined();
    expect(v.polluted).toBeUndefined();
    // ownJson copies own enumerable keys only: inherited ones are not read.
    const inherited = Object.create({ routing: { mode: "off" } }) as Record<string, unknown>;
    inherited.own = 1;
    expect(ownJson(inherited)).toEqual({ own: 1 });
    unpolluted();
  });

  it("a top-level __proto__ in the project file sets nothing, in any section", () => {
    writeFileSync(
      join(root, "eminiar.config.json"),
      '{"__proto__": {"routing": {"mode": "off"}, "sandbox": {"indexThreshold": 1}}, "embeddings": {"enabled": false}}',
    );
    const c = loadConfig(root);
    expect(c.routing.mode).toBe("auto");
    expect(c.sandbox.indexThreshold).toBe(5120);
    expect(c.embeddings.enabled).toBe(false); // the rest of the file still applies
    unpolluted();
  });

  it("a nested __proto__ or constructor.prototype in either file sets nothing", () => {
    writeFileSync(
      join(home, "config.json"),
      '{"routing": {"constructor": {"prototype": {"mode": "off"}}}, "constructor": {"prototype": {"sandbox": {"indexThreshold": 7}}}}',
    );
    writeFileSync(
      join(root, "eminiar.config.json"),
      '{"routing": {"__proto__": {"mode": "off"}}, "prototype": {"routing": {"mode": "off"}}}',
    );
    const c = loadConfig(root);
    expect(c.routing.mode).toBe("auto");
    expect(c.sandbox.indexThreshold).toBe(5120);
    unpolluted();
  });

  it("ordinary keys still merge: personal < project, nested objects combined", () => {
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ sandbox: { indexThreshold: 9000 }, routing: { mode: "off" } }),
    );
    writeFileSync(
      join(root, "eminiar.config.json"),
      '{"__proto__": {}, "routing": {"mode": "annotate"}}',
    );
    const c = loadConfig(root);
    expect([c.routing.mode, c.sandbox.indexThreshold]).toEqual(["annotate", 9000]);
    unpolluted();
  });
});

describe("project", () => {
  it("finds the root by marker and hashes it stably", () => {
    const root = mkdtempSync(join(tmpdir(), "em-proj-"));
    writeFileSync(join(root, "package.json"), "{}");
    const nested = join(root, "src", "deep");
    expect(findProjectRoot(nested)).toBe(root);
    expect(projectId(root)).toHaveLength(16);
    expect(projectId(root)).toBe(projectId(root));
  });
});
