import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hashText } from "../../src/swarm/edit.js";
import {
  SwarmSaveConflict,
  SwarmSaveInvalid,
  SwarmSaveRefused,
  saveSwarmFile,
} from "../../src/swarm/save.js";

type Write = (fd: number, buf: Buffer, off: number, len: number) => number;
const fsCtl = vi.hoisted(() => ({
  write: null as null | ((real: Write, a: Parameters<Write>) => number),
}));
vi.mock("node:fs", async (orig) => {
  const real = await orig<typeof import("node:fs")>();
  const w = real.writeSync as unknown as Write;
  return {
    ...real,
    writeSync: (...a: Parameters<Write>) => (fsCtl.write ? fsCtl.write(w, a) : w(...a)),
  };
});

const A =
  "version: 1\nswarms:\n  one:\n    description: One\n    agents:\n      a:\n        description: A\n        prompt: P\n";
const B = A.replace("description: One", "description: Two");

let root: string;
let outside: string;
const file = () => join(root, ".eminiar/swarm.yaml");
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "em-save-"));
  outside = mkdtempSync(join(tmpdir(), "em-save-out-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const tmps = () =>
  existsSync(join(root, ".eminiar"))
    ? readdirSync(join(root, ".eminiar")).filter((f) => f.endsWith(".tmp"))
    : [];

describe("saveSwarmFile", () => {
  it("creates the folder and file when baseHash is null", () => {
    const r = saveSwarmFile(root, A, null);
    expect(r).toEqual({ rel: ".eminiar/swarm.yaml", hash: hashText(A), created: true });
    expect(readFileSync(file(), "utf8")).toBe(A);
    expect(tmps()).toEqual([]);
  });

  it("refuses to create over an existing file (conflict: exists)", () => {
    mkdirSync(join(root, ".eminiar"));
    writeFileSync(file(), A);
    try {
      saveSwarmFile(root, B, null);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SwarmSaveConflict);
      expect((e as SwarmSaveConflict).reason).toBe("exists");
      expect((e as SwarmSaveConflict).current?.hash).toBe(hashText(A));
    }
    expect(readFileSync(file(), "utf8")).toBe(A);
  });

  it("overwrites when the hash matches", () => {
    saveSwarmFile(root, A, null);
    const r = saveSwarmFile(root, B, hashText(A));
    expect(r.created).toBe(false);
    expect(r.hash).toBe(hashText(B));
    expect(readFileSync(file(), "utf8")).toBe(B);
    expect(tmps()).toEqual([]);
  });

  it("rejects a stale baseHash with the current text and leaves the file alone", () => {
    saveSwarmFile(root, A, null);
    try {
      saveSwarmFile(root, B, hashText("something else"));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SwarmSaveConflict);
      const c = e as SwarmSaveConflict;
      expect(c.reason).toBe("changed");
      expect(c.current).toEqual({ text: A, hash: hashText(A) });
    }
    expect(readFileSync(file(), "utf8")).toBe(A);
    expect(tmps()).toEqual([]);
  });

  it("reports a removed file as missing", () => {
    mkdirSync(join(root, ".eminiar"));
    try {
      saveSwarmFile(root, A, hashText(A));
      expect.unreachable();
    } catch (e) {
      expect((e as SwarmSaveConflict).reason).toBe("missing");
    }
  });

  it("is a no-op when the text is already on disk", () => {
    saveSwarmFile(root, A, null);
    const r = saveSwarmFile(root, A, hashText(A));
    expect(r).toEqual({ rel: ".eminiar/swarm.yaml", hash: hashText(A), created: false });
  });

  it("rejects text that does not validate, before touching the disk", () => {
    expect(() => saveSwarmFile(root, "version: 1\nswarms: {}\nenabled: maybe\n", null)).toThrow(
      SwarmSaveInvalid,
    );
    expect(() => saveSwarmFile(root, "swarms: [oops\n", null)).toThrow(SwarmSaveInvalid);
    expect(() => saveSwarmFile(root, "x".repeat(256_001), null)).toThrow(SwarmSaveInvalid);
    expect(existsSync(join(root, ".eminiar"))).toBe(false);
  });

  it("refuses a symlinked swarm file", () => {
    mkdirSync(join(root, ".eminiar"));
    const target = join(outside, "real.yaml");
    writeFileSync(target, A);
    symlinkSync(target, file());
    expect(() => saveSwarmFile(root, B, hashText(A))).toThrow(SwarmSaveRefused);
    expect(readFileSync(target, "utf8")).toBe(A);
  });

  it("refuses a symlinked .eminiar folder that leads outside the project", () => {
    symlinkSync(outside, join(root, ".eminiar"));
    expect(() => saveSwarmFile(root, A, null)).toThrow(SwarmSaveRefused);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("leaves no temp file when the final swap fails", () => {
    mkdirSync(join(root, ".eminiar"));
    // a directory where the file should be: the target is not a regular file
    mkdirSync(file());
    expect(() => saveSwarmFile(root, A, null)).toThrow();
    expect(tmps()).toEqual([]);
  });

  it("loops over short writes and installs the whole file", () => {
    fsCtl.write = (real, a) => real(a[0], a[1], a[2], Math.min(a[3], 7));
    try {
      saveSwarmFile(root, A, null);
    } finally {
      fsCtl.write = null;
    }
    expect(readFileSync(file(), "utf8")).toBe(A);
  });

  it("errors before the swap and cleans up when the disk takes no more bytes", () => {
    saveSwarmFile(root, A, null);
    let calls = 0;
    fsCtl.write = (real, a) => (calls++ === 0 ? real(a[0], a[1], a[2], 5) : 0);
    try {
      expect(() => saveSwarmFile(root, B, hashText(A))).toThrow(/short write/);
    } finally {
      fsCtl.write = null;
    }
    expect(readFileSync(file(), "utf8")).toBe(A);
    expect(tmps()).toEqual([]);
  });
});
