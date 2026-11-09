import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/ui/api.js", async (orig) => ({
  ...(await orig<typeof import("../../src/ui/api.js")>()),
  listProjects: () => [{ id: "a", root: "/work/listed" }],
}));

const { requestRoot } = await import("../../src/ui/server.js");

describe("requestRoot", () => {
  it("accepts listed projects and the default root", () => {
    expect(requestRoot("/work/listed", "/work/home")).toBe("/work/listed");
    expect(requestRoot("/work/home", "/work/home")).toBe("/work/home");
  });
  it("ignores an unlisted root and falls back to the default", () => {
    expect(requestRoot("/etc", "/work/home")).toBe("/work/home");
    expect(requestRoot("/etc")).toBeUndefined();
  });
  it("uses the default when no root is asked for", () => {
    expect(requestRoot(null, "/work/home")).toBe("/work/home");
  });
});
