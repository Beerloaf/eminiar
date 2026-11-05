import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SwarmDoc } from "../../src/swarm/doc-types.js";
import { hashText, readSwarmDoc, renderSwarmDoc } from "../../src/swarm/edit.js";
import { SwarmSaveConflict, SwarmSaveRefused, saveSwarmFile } from "../../src/swarm/save.js";

// The project's real swarm file is read at test time (never hardcoded) and only ever copied.
const REAL_ROOT = resolve(__dirname, "../..");
const REAL_FILE = join(REAL_ROOT, ".eminiar/swarm.yaml");
const realText = readFileSync(REAL_FILE, "utf8");
const realMtime = statSync(REAL_FILE).mtimeMs;

let root: string;
let outside: string;
const file = () => join(root, ".eminiar/swarm.yaml");
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "em-rt-"));
  outside = mkdtempSync(join(tmpdir(), "em-rt-out-"));
  mkdirSync(join(root, ".eminiar"));
  writeFileSync(file(), realText);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

interface Agent {
  model_range?: unknown;
}
interface Swarm {
  description?: string;
  max_agents?: number;
  agents: Record<string, Agent>;
}
interface Shape {
  sync?: string;
  defaults: { model?: string; model_range?: unknown };
  swarms: Record<string, Swarm>;
}
const shape = (d: unknown): Shape => d as Shape;
const firstSwarm = (d: Shape): string => {
  const n = Object.keys(d.swarms)[0];
  if (n === undefined) throw new Error("no swarms in the real file");
  return n;
};

const parseDoc = (text: string): Shape => {
  const dir = mkdtempSync(join(tmpdir(), "em-rt-parse-"));
  mkdirSync(join(dir, ".eminiar"));
  writeFileSync(join(dir, ".eminiar/swarm.yaml"), text);
  const doc = readSwarmDoc(dir).doc;
  rmSync(dir, { recursive: true, force: true });
  return shape(doc);
};

/** Every comment's text (whole-line or trailing), ignoring where it sits and its padding. */
const comments = (t: string) =>
  t
    .split("\n")
    .map((l) => /(?:^|\s)#\s.*$/.exec(l)?.[0].trim())
    .filter((c): c is string => !!c);

describe("real swarm.yaml round trip", () => {
  it("reads as ok with a draft; only role hooks are locked (no anchors or aliases)", () => {
    const r = readSwarmDoc(root);
    expect(r.state).toBe("ok");
    expect(r.text).toBe(realText);
    expect(r.hash).toBe(hashText(realText));
    expect(r.doc).not.toBeNull();
    expect(r.locked.length).toBeGreaterThan(0);
    expect(r.locked.every((p) => p.endsWith(".hooks"))).toBe(true);
  });

  it("a no-op draft renders byte-identical and unchanged", () => {
    const r = readSwarmDoc(root);
    const out = renderSwarmDoc(r.text, r.doc!);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.text).toBe(realText);
    expect(out.changed).toBe(false);
    expect(out.result.state).toBe("ok");
  });

  it("saving the no-op text leaves the file and its mtime alone", () => {
    const before = statSync(file()).mtimeMs;
    const r = readSwarmDoc(root);
    const saved = saveSwarmFile(root, realText, r.hash);
    expect(saved.created).toBe(false);
    expect(saved.hash).toBe(hashText(realText));
    expect(readFileSync(file(), "utf8")).toBe(realText);
    expect(statSync(file()).mtimeMs).toBe(before);
  });

  it("an edit keeps every comment's text and changes no other value", () => {
    const r = readSwarmDoc(root);
    const draft = shape(structuredClone(r.doc!));
    const name = firstSwarm(draft);
    const oldDesc = draft.swarms[name]?.description ?? "";
    draft.swarms[name]!.description = "Round trip edited description";
    const out = renderSwarmDoc(r.text, draft as unknown as SwarmDoc);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.changed).toBe(true);
    expect(out.result.state).toBe("ok");
    expect(out.text).toContain("Round trip edited description");
    expect(out.text).not.toContain(oldDesc);
    expect(comments(out.text)).toEqual(comments(realText));
    const back = readSwarmDoc(root);
    const expected = shape(structuredClone(back.doc));
    expected.swarms[name]!.description = "Round trip edited description";
    expect(out.result.state).toBe("ok");
    expect(draft).toEqual(expected);
  });

  // Pins that an edit leaves every untouched line byte-identical.
  it("an edit changes only the edited line", () => {
    const r = readSwarmDoc(root);
    const draft = shape(structuredClone(r.doc!));
    const name = firstSwarm(draft);
    draft.swarms[name]!.description = "Round trip edited description";
    const out = renderSwarmDoc(r.text, draft as unknown as SwarmDoc);
    if (!out.ok) throw new Error("render failed");
    const a = realText.split("\n");
    const b = out.text.split("\n");
    expect(b.length).toBe(a.length);
    expect(b.filter((l, i) => l !== a[i]).length).toBe(1);
  });

  it("editing a top-level setting keeps comments and round-trips through save", () => {
    const r = readSwarmDoc(root);
    const draft = shape(structuredClone(r.doc!));
    draft.sync = draft.sync === "auto" ? "manual" : "auto";
    const out = renderSwarmDoc(r.text, draft as unknown as SwarmDoc);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(comments(out.text)).toEqual(comments(realText));
    const saved = saveSwarmFile(root, out.text, r.hash);
    expect(readFileSync(file(), "utf8")).toBe(out.text);
    const again = readSwarmDoc(root);
    expect(again.state).toBe("ok");
    expect(again.hash).toBe(saved.hash);
    const back = renderSwarmDoc(again.text, again.doc!);
    expect(back.ok && back.text).toBe(out.text);
  });

  it("leaves the pinned model_range and reviewer models as the file has them", () => {
    const r = readSwarmDoc(root);
    const draft = shape(structuredClone(r.doc!));
    const name = firstSwarm(draft);
    draft.swarms[name]!.max_agents = (draft.swarms[name]!.max_agents ?? 1) + 1;
    const out = renderSwarmDoc(r.text, draft as unknown as SwarmDoc);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const re = readSwarmDoc(root);
    expect(out.result.state).toBe("ok");
    const again = parseDoc(out.text);
    expect(again.defaults.model_range).toEqual(shape(r.doc).defaults.model_range);
    for (const [k, a] of Object.entries(shape(r.doc).swarms[name]!.agents))
      expect(again.swarms[name]!.agents[k]?.model_range).toEqual(a.model_range);
    expect(again.swarms[name]!.max_agents).toBe(draft.swarms[name]!.max_agents);
    expect(re.doc).toEqual(r.doc);
  });

  it("refuses to render an edit through an anchor or alias", () => {
    const anchored = realText.replace(/^defaults:\n/m, "defaults: &dflt\n");
    expect(anchored).not.toBe(realText);
    const withAlias = `${anchored.trimEnd()}\nx-copy: *dflt\n`;
    writeFileSync(file(), withAlias);
    const r = readSwarmDoc(root);
    expect(r.locked.length).toBeGreaterThan(0);
    expect(r.locked).toContain("defaults");
    const draft = shape(structuredClone(r.doc!));
    draft.defaults.model = draft.defaults.model === "opus" ? "haiku" : "opus";
    const out = renderSwarmDoc(r.text, draft as unknown as SwarmDoc);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("locked");
  });

  it("refuses to save over a stale baseHash and keeps the file", () => {
    const r = readSwarmDoc(root);
    const other = `${realText}# changed elsewhere\n`;
    writeFileSync(file(), other);
    try {
      saveSwarmFile(root, realText.replace("sync: auto", "sync: manual"), r.hash);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SwarmSaveConflict);
      expect((e as SwarmSaveConflict).reason).toBe("changed");
    }
    expect(readFileSync(file(), "utf8")).toBe(other);
  });

  it("refuses a project root that is a path outside, via a symlinked .eminiar", () => {
    rmSync(join(root, ".eminiar"), { recursive: true, force: true });
    writeFileSync(join(outside, "swarm.yaml"), realText);
    symlinkSync(outside, join(root, ".eminiar"));
    expect(() => saveSwarmFile(root, realText, hashText(realText))).toThrow(SwarmSaveRefused);
    expect(readFileSync(join(outside, "swarm.yaml"), "utf8")).toBe(realText);
  });

  it("refuses when swarm.yaml itself is a symlink", () => {
    const target = join(outside, "real.yaml");
    writeFileSync(target, realText);
    rmSync(file());
    symlinkSync(target, file());
    expect(() =>
      saveSwarmFile(root, realText.replace("sync: auto", "sync: manual"), hashText(realText)),
    ).toThrow(SwarmSaveRefused);
    expect(readFileSync(target, "utf8")).toBe(realText);
  });

  it("never touched the real project file", () => {
    expect(readFileSync(REAL_FILE, "utf8")).toBe(realText);
    expect(statSync(REAL_FILE).mtimeMs).toBe(realMtime);
  });
});
