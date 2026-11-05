import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GALAXY_TABS, legacyArchitectureTab, parseHash, VIEWS } from "../../src/ui/web/route.js";

describe("dashboard routes after folding Architecture into Galaxy", () => {
  it("no longer lists an architecture view", () => {
    expect(VIEWS).not.toContain("architecture");
    expect(VIEWS).toContain("galaxy");
  });

  it("redirects old #/architecture links to the equivalent Galaxy tab", () => {
    expect(parseHash("#/architecture")).toEqual({
      view: "galaxy",
      sub: null,
      params: { tab: "map" },
    });
    expect(parseHash("#/architecture?tab=overview").params.tab).toBe("map");
    for (const t of ["routes", "hotspots", "structure", "behavior"]) {
      const r = parseHash(`#/architecture?tab=${t}&node=x`);
      expect(r.view).toBe("galaxy");
      expect(r.params).toEqual({ tab: t, node: "x" });
    }
  });

  it("falls back to the folder map for an unknown legacy tab, never a blank page", () => {
    expect(parseHash("#/architecture?tab=nope").params.tab).toBe("map");
    expect(legacyArchitectureTab(undefined)).toBe("map");
  });

  it("deep-links Galaxy tabs through the tab param", () => {
    expect(parseHash("#/galaxy?tab=hotspots")).toEqual({
      view: "galaxy",
      sub: null,
      params: { tab: "hotspots" },
    });
    expect(GALAXY_TABS).toEqual([
      "galaxy",
      "hierarchy",
      "map",
      "routes",
      "hotspots",
      "structure",
      "behavior",
    ]);
  });

  it("keeps the nav bar to views that exist, without an Architecture entry", () => {
    const src = readFileSync("src/ui/web/app.tsx", "utf8");
    const block = src.slice(
      src.indexOf("const TABS"),
      src.indexOf("];", src.indexOf("const TABS")),
    );
    const ids = [...block.matchAll(/\["(\w+)", "/g)].map((m) => m[1]);
    expect(ids).not.toContain("architecture");
    expect(ids).toEqual(expect.arrayContaining(["overview", "galaxy", "history", "system"]));
    for (const id of ids) expect(VIEWS as readonly (string | undefined)[]).toContain(id);
    expect(src).not.toContain("Architecture.js");
  });
});
