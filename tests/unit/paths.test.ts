import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config.js";
import { getContext, type ProjectContext, resetContextCache } from "../../src/context.js";
import { filePayload } from "../../src/ui/graph-api.js";

describe("dashboard file viewer containment", () => {
  let root: string;
  let outside: string;
  let ctx: ProjectContext;
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "em-viewer-")));
    outside = realpathSync(mkdtempSync(join(tmpdir(), "em-viewer-out-")));
    writeFileSync(join(root, "package.json"), "{}");
    // Names that start with `..` are ordinary files inside the project.
    writeFileSync(join(root, "..notes.md"), "dots\n");
    mkdirSync(join(root, "..cache"));
    writeFileSync(join(root, "..cache", "a.txt"), "cached\n");
    writeFileSync(join(outside, "secret.txt"), "outside\n");
    symlinkSync(join(outside, "secret.txt"), join(root, "leak.txt"));
    resetContextCache();
    ctx = getContext(root);
  });
  afterAll(() => {
    resetContextCache();
    for (const d of [root, outside]) rmSync(d, { recursive: true, force: true });
  });

  it("serves a file whose name starts with `..`", () => {
    expect(filePayload(ctx, "..notes.md")).toMatchObject({ path: "..notes.md", content: "dots\n" });
    expect(filePayload(ctx, "..cache/a.txt")).toMatchObject({ content: "cached\n" });
  });

  it("refuses a `..` segment, an absolute path and a symlink out of the project", () => {
    for (const p of ["../x.txt", "a/../../x.txt", "..", join(outside, "secret.txt"), "leak.txt"])
      expect(() => filePayload(ctx, p), p).toThrow(/outside the project/);
  });
});

describe("unsafe project paths in one config layer", () => {
  let home: string;
  let root: string;
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "em-home-"));
    root = mkdtempSync(join(tmpdir(), "em-root-"));
    process.env.EMINIAR_HOME = home;
  });
  afterAll(() => {
    delete process.env.EMINIAR_HOME;
    vi.restoreAllMocks();
    for (const d of [home, root]) rmSync(d, { recursive: true, force: true });
  });

  it("drops every unsafe path key of one layer and keeps that layer's other keys", () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    writeFileSync(
      join(root, "eminiar.config.json"),
      JSON.stringify({
        docs: { manifest: "../x.json", ttlHours: 3 },
        memories: { dir: "/abs/mem" },
        recall: { maxMemories: 4 },
      }),
    );
    const c = loadConfig(root);
    expect([c.docs.manifest, c.docs.ttlHours, c.memories.dir, c.recall.maxMemories]).toEqual([
      ".eminiar/docs.json",
      3,
      ".eminiar/memories",
      4,
    ]);
    const out = err.mock.calls.map((a) => String(a[0])).join("");
    expect(out).toContain("ignoring docs.manifest");
    expect(out).toContain("ignoring memories.dir");
    expect(out).not.toContain("invalid config");
  });

  it("a safe key in one layer survives an unsafe one in the other", () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ docs: { manifest: "/abs.json" }, memories: { dir: "notes/mem" } }),
    );
    writeFileSync(
      join(root, "eminiar.config.json"),
      JSON.stringify({ docs: { manifest: "p/docs.json" }, memories: { dir: "../up" } }),
    );
    const c = loadConfig(root);
    expect([c.docs.manifest, c.memories.dir]).toEqual(["p/docs.json", "notes/mem"]);
  });
});
