import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stagedDiff } from "../../src/decisions/features/commit.js";

function git(cwd: string, ...args: string[]) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

describe("stagedDiff path prefixes", () => {
  it("keeps a/ and b/ when the user sets diff.noprefix or mnemonicPrefix", () => {
    const root = mkdtempSync(join(tmpdir(), "em-prefix-"));
    git(root, "init", "-q");
    git(root, "config", "user.email", "t@example.com");
    git(root, "config", "user.name", "t");
    git(root, "config", "diff.noprefix", "true");
    git(root, "config", "diff.mnemonicPrefix", "true");
    writeFileSync(join(root, "app.txt"), "one\n");
    git(root, "add", "app.txt");
    const diff = stagedDiff(root, "git commit -m x");
    expect(diff).toContain("diff --git a/app.txt b/app.txt");
    expect(diff).toContain("+++ b/app.txt");
  });
});
