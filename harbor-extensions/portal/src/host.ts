/**
 * Embedding in a host shell (Harbor).
 *
 * Harbor's React app keeps its own sidebar and workspace switcher and renders the portal in an iframe:
 *   <iframe src="/extensions/x/<name>?embed=1&ws=<workspace>">
 * In embed mode the portal drops its own top bar and reports to the host instead:
 *   navigate       the user moved inside the portal (sync Harbor's URL / highlight the sidebar item)
 *   auth-required  there is no valid session (Harbor sends the user to its login and reloads the frame)
 * Messages go only to the same-origin parent; anything else is ignored.
 */

const params = new URLSearchParams(window.location.search);
const WS_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** Embed mode is fixed at load: the host sets it in the iframe src; in-portal navigation keeps it. */
export const EMBED = params.get("embed") === "1" && window.parent !== window;

/** The host's current workspace, if it passed one; handed to extensions via harbor.context(). */
export const WORKSPACE: string | null = (() => {
  const ws = params.get("ws");
  return ws && WS_RE.test(ws) ? ws : null;
})();

export type HostEvent =
  | { type: "navigate"; path: string; extension: string | null }
  | { type: "auth-required"; returnTo: string };

export function notifyHost(event: HostEvent): void {
  if (!EMBED) return;
  try {
    // Same-origin target only: if the parent is not on our origin, the message is dropped by the browser
    window.parent.postMessage({ source: "harbor-extensions", ...event }, window.location.origin);
  } catch {
    /* parent unreachable */
  }
}
