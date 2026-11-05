import { useEffect, useState } from "preact/hooks";
import { createRouteSync, parseHash, type Route, routeHash, type View } from "./route.js";

export { parseHash, type Route, routeHash, SUBS, VIEWS, type View } from "./route.js";

export function navigate(
  to: View | `${View}/${string}`,
  params: Record<string, string | undefined> = {},
): void {
  location.hash = routeHash(to, params);
}

/** Asked before the route changes; false keeps the current page (the hash is put back). */
type LeaveGuard = (to: Route) => boolean;
let leaveGuard: LeaveGuard | null = null;

/**
 * Let a page with unsaved work veto leaving it (the Configuration Studio). The router asks the
 * guard before it re-renders, so the page is still mounted when it decides. Returns the
 * function that removes the guard.
 */
export function setLeaveGuard(guard: LeaveGuard): () => void {
  leaveGuard = guard;
  return () => {
    if (leaveGuard === guard) leaveGuard = null;
  };
}

/**
 * Ask the guard about a change that is not a route change (switching project remounts the
 * page). True when nothing guards, or the guard allows leaving.
 */
export function confirmLeave(): boolean {
  return !leaveGuard || leaveGuard({ view: "overview", sub: null, params: {} });
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash));
  useEffect(() => {
    // The guard is asked synchronously in the event, before Preact re-renders, so the page
    // is still mounted when it decides. popstate also covers a traversal to an entry whose
    // query differs (?root=), for which Chrome fires no hashchange.
    const sync = createRouteSync({
      history,
      hash: () => location.hash,
      urlWithHash: (h) => {
        const u = new URL(location.href);
        u.hash = h;
        return u.toString();
      },
      allow: (to) => !leaveGuard || leaveGuard(to),
      show: setRoute,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout> | undefined),
    });
    sync.start();
    const on = () => sync.onLocation();
    window.addEventListener("popstate", on);
    window.addEventListener("hashchange", on);
    return () => {
      window.removeEventListener("popstate", on);
      window.removeEventListener("hashchange", on);
      sync.stop();
    };
  }, []);
  return route;
}
