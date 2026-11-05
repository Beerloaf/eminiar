import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { swarmFile } from "./config.js";
import { checkSwarmText, hashText, SWARM_FILE_MAX_CHARS } from "./edit.js";
import type { ConfigIssue } from "./types.js";

/**
 * The only way the dashboard writes `.eminiar/swarm.yaml`. The target is always the project's
 * swarm file, never a path from the client. The write is guarded three ways: the file must lie
 * inside the project with no symlink on the way (the logic of docs/manifest.ts locationProblem),
 * the text must be what the sha256 `baseHash` says the client last saw (else nothing is
 * overwritten), and it lands through a temp file and a rename, so a reader never sees half a file.
 *
 * Nothing imports this from config.ts or a hook.
 */

/** Where the target is not allowed to be written. */
export class SwarmSaveRefused extends Error {
  constructor(readonly reason: string) {
    super(`refusing to write the swarm file: ${reason}`);
    this.name = "SwarmSaveRefused";
  }
}

/** The file on disk is not what the client based its edit on. */
export class SwarmSaveConflict extends Error {
  constructor(
    /** `exists`: a create found a file; `changed`: the hash differs; `missing`: it was removed. */
    readonly reason: "exists" | "changed" | "missing",
    /** What is on disk now (null when nothing is). */
    readonly current: { text: string; hash: string } | null,
  ) {
    super(
      reason === "exists"
        ? "a swarm file already exists"
        : reason === "missing"
          ? "the swarm file was removed since it was loaded"
          : "the swarm file changed since it was loaded",
    );
    this.name = "SwarmSaveConflict";
  }
}

/** The text does not validate as a swarm file (or its `enforce:` line is not greppable). */
export class SwarmSaveInvalid extends Error {
  constructor(readonly issues: ConfigIssue[]) {
    super(`the swarm file is not valid: ${issues[0]?.message ?? "see the issues"}`);
    this.name = "SwarmSaveInvalid";
  }
}

export interface SwarmSaved {
  /** Project-relative path that was written. */
  rel: string;
  /** sha256 of the text now on disk: the next `baseHash`. */
  hash: string;
  created: boolean;
}

/** `child` is `parent` or below it (both absolute and resolved alike). */
function within(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Why `file` is not a place to write inside `root`, or undefined: it must be below the root; its
 * nearest existing folder must resolve (realpath) inside the resolved root, so a committed
 * `.eminiar` symlink cannot lead out; and the file itself must not be a symlink.
 */
function locationProblem(file: string, root: string): string | undefined {
  if (file === root || !within(file, root)) return "it is outside the project";
  let realRoot: string;
  try {
    realRoot = realpathSync.native(root);
  } catch (err) {
    return `the project root could not be resolved (${(err as NodeJS.ErrnoException).code ?? (err as Error).message})`;
  }
  try {
    let dir = dirname(file);
    // The nearest entry that exists (lstat: a dangling folder symlink stops the walk and then
    // fails realpath below, rather than being created through).
    while (!lstatSync(dir, { throwIfNoEntry: false }) && within(dirname(dir), root) && dir !== root)
      dir = dirname(dir);
    if (!within(realpathSync.native(dir), realRoot))
      return "its folder resolves outside the project (a symlink)";
    const lst = lstatSync(file, { throwIfNoEntry: false });
    if (lst?.isSymbolicLink()) return "it is a symlink, and writes replace only a regular file";
    if (lst && !lst.isFile()) return "it is not a regular file";
    return undefined;
  } catch (err) {
    return `its location could not be resolved (${(err as NodeJS.ErrnoException).code ?? (err as Error).message})`;
  }
}

/** writeSync is one write(2): it may return a short count (a full disk or a quota) without throwing. */
function writeAll(fd: number, buf: Buffer): void {
  let off = 0;
  while (off < buf.length) {
    const n = writeSync(fd, buf, off, buf.length - off);
    if (n <= 0) throw new Error("short write: the disk did not take the whole swarm file");
    off += n;
  }
}

function readCurrent(file: string): { text: string; hash: string } | null {
  try {
    const bytes = readFileSync(file);
    // Hash the bytes as they are, the way readSwarmDoc does, so the two always agree.
    return {
      text: bytes.toString("utf8"),
      hash: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Write `text` as the project's swarm file. `baseHash` is the sha256 of the file the edit was
 * based on; null means "create": the file must not exist. Throws SwarmSaveRefused (location),
 * SwarmSaveConflict (changed on disk, or a create over a file) or SwarmSaveInvalid (the text does
 * not validate); a failed write leaves no temp file behind.
 */
export function saveSwarmFile(root: string, text: string, baseHash: string | null): SwarmSaved {
  const projectRoot = resolve(root);
  if (text.length > SWARM_FILE_MAX_CHARS)
    throw new SwarmSaveInvalid([
      { path: "", message: `the file is larger than ${SWARM_FILE_MAX_CHARS / 1000} KB` },
    ]);
  const { result, enforceOk } = checkSwarmText(text);
  if (result.state === "invalid") throw new SwarmSaveInvalid(result.issues);
  if (!enforceOk)
    throw new SwarmSaveInvalid([
      { path: "enforce", message: "enforce must be on a plain top-level `enforce:` line" },
    ]);

  const { file, rel } = swarmFile(projectRoot);
  const problem = locationProblem(file, projectRoot);
  if (problem) throw new SwarmSaveRefused(problem);

  const current = readCurrent(file);
  if (baseHash === null) {
    if (current) throw new SwarmSaveConflict("exists", current);
  } else if (!current) {
    throw new SwarmSaveConflict("missing", null);
  } else if (current.hash !== baseHash) {
    throw new SwarmSaveConflict("changed", current);
  }
  const hash = hashText(text);
  // Saving what is already there changes nothing, not even the modification time.
  if (current && current.hash === hash) return { rel, hash, created: false };

  if (!current) mkdirSync(dirname(file), { recursive: true });
  // The folder may have just been created through something unexpected; look again.
  const again = locationProblem(file, projectRoot);
  if (again) throw new SwarmSaveRefused(again);

  const mode = current ? statSync(file).mode & 0o777 : 0o644;
  const tmp = resolve(
    dirname(file),
    `.${basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
  );
  try {
    const fd = openSync(tmp, "wx", mode);
    try {
      writeAll(fd, Buffer.from(text, "utf8"));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // Look once more right before the swap: the closest a rename can get to compare-and-swap.
    const now = readCurrent(file);
    if (current === null) {
      if (now) throw new SwarmSaveConflict("exists", now);
      try {
        // link fails with EEXIST rather than replacing a file that appeared meanwhile
        linkSync(tmp, file);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EEXIST") throw new SwarmSaveConflict("exists", readCurrent(file));
        // a filesystem without hard links: the check above is what is left
        renameSync(tmp, file);
      }
    } else {
      if (!now) throw new SwarmSaveConflict("missing", null);
      if (now.hash !== baseHash) throw new SwarmSaveConflict("changed", now);
      renameSync(tmp, file);
    }
  } finally {
    rmSync(tmp, { force: true });
  }
  return { rel, hash, created: current === null };
}
