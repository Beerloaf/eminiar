import { describe, expect, it } from "vitest";
import {
  createRouteSync,
  entryPos,
  leaveDelta,
  type Route,
  reconcile,
  rootSync,
  SETTLE_MS,
  settleWalk,
  statePos,
  vetoStep,
  WALK_TRIES,
  withPos,
} from "../../src/ui/web/route.js";

describe("leave guard history bookkeeping", () => {
  it("undoes a pushed entry with one step back", () => {
    expect(entryPos(3, undefined)).toBe(4);
    expect(leaveDelta(3, undefined)).toBe(-1);
  });
  it("undoes Back by going forward and Forward by going back", () => {
    expect(leaveDelta(3, 2)).toBe(1);
    expect(leaveDelta(3, 5)).toBe(-2);
  });
  it("reads only numeric positions from history.state", () => {
    expect(statePos({ pos: 2 })).toBe(2);
    expect(statePos(null)).toBeUndefined();
    expect(statePos({ pos: "x" })).toBeUndefined();
  });
  it("keeps other state fields when stamping", () => {
    expect(withPos({ a: 1, pos: 0 }, 4)).toEqual({ a: 1, pos: 4 });
    expect(withPos(null, 2)).toEqual({ pos: 2 });
  });
  it("never walks zero steps: an in-place change is restored instead", () => {
    expect(vetoStep(3, 3)).toEqual({ kind: "restore" });
    expect(vetoStep(3, 1)).toEqual({ kind: "go", delta: 2 });
    expect(vetoStep(3, undefined)).toEqual({ kind: "go", delta: -1 });
  });
  it("classifies events: the second of a pair, a real move, a walk's landings", () => {
    expect(reconcile(2, "#/a", null, 2, "#/a")).toBe("same");
    expect(reconcile(2, "#/a", null, 1, "#/b")).toBe("moved");
    expect(reconcile(2, "#/a", null, 2, "#/b")).toBe("moved");
    expect(reconcile(2, "#/a", null, undefined, "#/a")).toBe("moved");
    expect(reconcile(2, "#/a", { target: 2, tries: 0 }, 2, "#/a")).toBe("home");
    expect(reconcile(2, "#/a", { target: 2, tries: 0 }, 1, "#/b")).toBe("walking");
  });
  it("settles a walk from where it actually landed, bounded by WALK_TRIES", () => {
    expect(settleWalk({ target: 3, tries: 0 }, 3)).toEqual({ kind: "home" });
    expect(settleWalk({ target: 3, tries: 0 }, 1)).toEqual({ kind: "go", delta: 2 });
    expect(settleWalk({ target: 3, tries: 1 }, 5)).toEqual({ kind: "go", delta: -2 });
    expect(settleWalk({ target: 3, tries: WALK_TRIES }, 2)).toEqual({ kind: "restore", pos: 2 });
    expect(settleWalk({ target: 3, tries: 0 }, undefined)).toEqual({ kind: "moved" });
  });
  it("follows ?root= after a move, asking the guard only when the project differs", () => {
    let asked = 0;
    const yes = () => {
      asked++;
      return true;
    };
    const no = () => {
      asked++;
      return false;
    };
    expect(rootSync("/a", "/a", yes)).toEqual({ kind: "keep" });
    expect(rootSync(null, "/a", yes)).toEqual({ kind: "keep" });
    expect(rootSync("", "/a", yes)).toEqual({ kind: "keep" });
    expect(asked).toBe(0);
    expect(rootSync("/b", "/a", yes)).toEqual({ kind: "switch", root: "/b" });
    expect(rootSync("/b", "/a", no)).toEqual({ kind: "restore", root: "/a" });
    expect(asked).toBe(2);
  });
});

// A fake browser history: traversals and their events run as queued tasks, as in Chrome.
// popstate fires on every traversal; hashchange only when the fragment differs and the
// query does not (Chrome fires no hashchange when ?root= differs as well).
interface Entry {
  query: string;
  hash: string;
  state: unknown;
}

function browser(start: { hash: string; query?: string; state?: unknown }) {
  const entries: Entry[] = [
    { query: start.query ?? "", hash: start.hash, state: start.state ?? null },
  ];
  let index = 0;
  const tasks: Array<() => void> = [];
  const timers = new Map<number, { at: number; fn: () => void }>();
  let now = 0;
  let nextTimer = 1;
  let dropNextGo = false;
  let veto = false;
  let asked = 0;
  let shown: Route | null = null;
  const cur = () => entries[index] as Entry;

  const fire = (from: Entry, to: Entry) => {
    tasks.push(() => sync.onLocation());
    if (from.hash !== to.hash && from.query === to.query) tasks.push(() => sync.onLocation());
  };
  const history = {
    get state() {
      return cur().state;
    },
    replaceState(data: unknown, _u: string, url?: string) {
      cur().state = structuredClone(data);
      if (url !== undefined) {
        const u = new URL(url);
        cur().query = u.search;
        cur().hash = u.hash;
      }
    },
    /** The router's own go(): the one a test can make Chrome drop. */
    go(delta: number) {
      if (delta === 0) throw new Error("history.go(0) reloads the page");
      gos++;
      if (dropNextGo) {
        dropNextGo = false;
        return;
      }
      traverse(delta);
    },
  };
  let gos = 0;
  function traverse(delta: number): void {
    tasks.push(() => {
      const to = index + delta;
      if (to < 0 || to >= entries.length) return; // no entry there: nothing happens
      const from = cur();
      index = to;
      fire(from, cur());
    });
  }
  const sync = createRouteSync({
    history,
    hash: () => cur().hash,
    urlWithHash: (h) => `http://x/${cur().query}${h}`,
    allow: () => {
      if (!veto) return true;
      asked++;
      return false;
    },
    show: (r) => {
      shown = r;
    },
    setTimer: (fn, ms) => {
      const id = nextTimer++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (t) => {
      timers.delete(t as number);
    },
  });
  sync.start();

  const drain = () => {
    for (let n = 0; tasks.length && n < 100; n++) tasks.shift()?.();
  };
  const b = {
    sync,
    /** Run queued tasks, then let time pass until nothing is pending. */
    settle() {
      for (let n = 0; n < 50; n++) {
        drain();
        const due = [...timers.entries()].sort((a, c) => a[1].at - c[1].at)[0];
        if (!due) return;
        now = Math.max(now, due[1].at);
        timers.delete(due[0]);
        due[1].fn();
      }
      throw new Error("history never settled");
    },
    /** location.hash = h (a link click or navigate()). */
    push(hash: string) {
      const from = cur();
      entries.splice(index + 1);
      entries.push({ query: from.query, hash, state: null });
      index++;
      fire(from, cur());
    },
    back: () => traverse(-1),
    forward: () => traverse(1),
    go: (delta: number) => traverse(delta),
    /** setRoot: rewrite the query of the current entry, keeping its state. */
    setQuery(q: string) {
      cur().query = q;
    },
    /** The old setRoot: replaceState(null) wiped the stamp. */
    eraseState() {
      cur().state = null;
    },
    /** A replaceState elsewhere that rewrote the current entry's fragment. */
    replaceHash(h: string) {
      cur().hash = h;
    },
    get gos() {
      return gos;
    },
    veto(on: boolean) {
      veto = on;
    },
    dropNextGo() {
      dropNextGo = true;
    },
    get index() {
      return index;
    },
    get hash() {
      return cur().hash;
    },
    get length() {
      return entries.length;
    },
    get asked() {
      return asked;
    },
    get shown() {
      return shown;
    },
  };
  return b;
}

/** Overview → Usage → Swarm → Studio, each stamped with its position. */
function fourPages() {
  const b = browser({ hash: "#/overview", query: "?root=/p" });
  for (const h of ["#/usage", "#/swarm", "#/swarm/config"]) {
    b.push(h);
    b.settle();
  }
  expect(b.sync.pos()).toBe(3);
  expect(b.index).toBe(3);
  return b;
}

describe("route sync against a browser-like history", () => {
  it("accepts a navigation once although popstate and hashchange both fire", () => {
    const b = fourPages();
    b.back();
    b.settle();
    expect(b.sync.pos()).toBe(2);
    expect(b.shown?.view).toBe("swarm");
    expect(b.shown?.sub).toBeNull();
  });

  it("walks a vetoed Back forward again and stays responsive", () => {
    const b = fourPages();
    b.veto(true);
    b.back();
    b.settle();
    expect(b.asked).toBe(1);
    expect(b.index).toBe(3);
    expect(b.hash).toBe("#/swarm/config");
    expect(b.sync.walking()).toBe(false);
    // The next navigation is put to the guard, not swallowed.
    b.push("#/overview");
    b.settle();
    expect(b.asked).toBe(2);
    expect(b.hash).toBe("#/swarm/config");
    b.veto(false);
    b.push("#/overview");
    b.settle();
    expect(b.shown?.view).toBe("overview");
    expect(b.sync.pos()).toBe(4);
  });

  it("walks a vetoed Forward back", () => {
    const b = fourPages();
    b.back();
    b.settle();
    b.back();
    b.settle();
    expect(b.sync.pos()).toBe(1);
    b.veto(true);
    b.forward();
    b.settle();
    expect(b.index).toBe(1);
    expect(b.hash).toBe("#/usage");
    expect(b.length).toBe(4);
  });

  it("first load without ?root=: the stamp survives setRoot, so the walk is right", () => {
    const b = browser({ hash: "#/swarm/config" });
    b.setQuery("?root=/p"); // setRoot keeps history.state now
    b.push("#/swarm");
    b.settle();
    b.back();
    b.settle();
    expect(b.sync.pos()).toBe(0);
    b.veto(true);
    b.forward();
    b.settle();
    expect(b.index).toBe(0);
    expect(b.hash).toBe("#/swarm/config");
    expect(b.sync.walking()).toBe(false);
  });

  it("an erased stamp cannot leave the walk stuck: it gives up and restores the URL", () => {
    // Repro A with the old setRoot: replaceState(null) wiped entry 0's stamp, so Back
    // re-stamps it as pos 2 and a vetoed Forward walks +1 where no entry exists.
    const b = browser({ hash: "#/swarm/config" });
    b.eraseState();
    b.push("#/swarm");
    b.settle();
    b.back();
    b.settle();
    expect(b.sync.pos()).toBe(2);
    b.veto(true);
    b.forward();
    b.settle();
    expect(b.sync.walking()).toBe(false);
    expect(b.index).toBe(1);
    expect(b.hash).toBe("#/swarm/config");
    expect(b.sync.pos()).toBe(1);
    expect(b.gos).toBe(1 + 3); // the walk plus WALK_TRIES corrective steps, then no more
    // The next navigation is put to the guard instead of being swallowed.
    b.push("#/overview");
    b.settle();
    expect(b.asked).toBe(2);
    expect(b.hash).toBe("#/swarm/config");
  });

  it("retries a walk whose go() Chrome dropped", () => {
    const b = fourPages();
    b.veto(true);
    b.dropNextGo();
    b.back();
    b.settle();
    expect(b.index).toBe(3);
    expect(b.hash).toBe("#/swarm/config");
    expect(b.sync.walking()).toBe(false);
    expect(b.gos).toBe(2);
  });

  it("project switch: a move to an entry whose ?root= differs fires only popstate, still guarded", () => {
    const b = fourPages();
    b.back();
    b.settle(); // on #/swarm, pos 2
    b.setQuery("?root=/q"); // switch project: same entry, new query, stamp kept
    b.push("#/swarm/config");
    b.settle();
    expect(b.sync.pos()).toBe(3);
    b.veto(true);
    b.back();
    b.settle();
    expect(b.index).toBe(3);
    // Two back is the old project's #/usage: popstate alone, both ways.
    b.go(-2);
    b.settle();
    expect(b.asked).toBe(2);
    expect(b.index).toBe(3);
    expect(b.hash).toBe("#/swarm/config");
    expect(b.sync.walking()).toBe(false);
    b.veto(false);
    b.go(-2);
    b.settle();
    expect(b.shown?.view).toBe("usage");
    expect(b.sync.pos()).toBe(1);
  });

  it("two Backs in one task: ends on the page shown, whatever Chrome does with the go()", () => {
    for (const drop of [false, true]) {
      const b = fourPages();
      b.veto(true);
      b.back();
      b.back();
      if (drop) b.dropNextGo();
      b.settle();
      expect(b.index, `drop=${drop}`).toBe(3);
      expect(b.hash).toBe("#/swarm/config");
      expect(b.sync.pos()).toBe(3);
      expect(b.sync.walking()).toBe(false);
      expect(b.length).toBe(4);
      b.veto(false);
      b.push("#/overview");
      b.settle();
      expect(b.shown?.view, `drop=${drop}`).toBe("overview");
    }
  });

  it("a vetoed in-place hash change is put back without history.go(0)", () => {
    const b = fourPages();
    b.veto(true);
    b.replaceHash("#/overview");
    b.sync.onLocation();
    b.settle();
    expect(b.index).toBe(3);
    expect(b.hash).toBe("#/swarm/config");
    expect(b.gos).toBe(0);
  });

  it("bounds the walk's settle time", () => {
    expect(SETTLE_MS).toBeLessThanOrEqual(500);
    expect(WALK_TRIES).toBeLessThanOrEqual(5);
  });
});
