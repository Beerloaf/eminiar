import { describe, expect, it } from "vitest";
import { isGitCommit } from "../../src/decisions/features/commit.js";

describe("commit command matching", () => {
  it("matches git global options and ignores quoted text", () => {
    expect(isGitCommit('git commit -m "x"')).toBe(true);
    expect(isGitCommit("git -C sub commit -m x")).toBe(true);
    expect(isGitCommit("git -c user.name=a commit -m x")).toBe(true);
    expect(isGitCommit("npm test && git commit -m x")).toBe(true);
    expect(isGitCommit('echo "next; git commit later"')).toBe(false);
    expect(isGitCommit("git status")).toBe(false);
  });
});
