/**
 * Harbor-side page body for an extension: renders the extensions portal in embed mode inside Harbor's layout,
 * so Harbor's sidebar and workspace switcher stay around it.
 *
 *   <Route path="/ext/:name?" element={<ExtensionRoute />} />   // see README.md
 *
 * The portal (same origin) reports two events, which this component forwards:
 *   navigate       the user moved inside the portal -> update Harbor's URL / sidebar highlight
 *   auth-required  the session is gone -> send the user through Harbor's login
 */
import { useEffect, useRef, useState } from "react";
import { EXTENSIONS_BASE } from "./useExtensionsNav";

export interface ExtensionFrameProps {
  /** Extension to show; null shows the catalog ("All extensions"). */
  name: string | null;
  /** Harbor's current workspace; changing it reloads the extension so it can re-scope its data. */
  workspace: string | null;
  /** The user navigated inside the portal (to another extension, or back to the catalog). */
  onNavigate?: (name: string | null) => void;
  /** No valid session: Harbor should re-authenticate the user, then come back to returnTo. */
  onAuthRequired?: (returnTo: string) => void;
  title?: string;
}

type PortalEvent =
  | { source: "harbor-extensions"; type: "navigate"; path: string; extension: string | null }
  | { source: "harbor-extensions"; type: "auth-required"; returnTo: string };

function srcFor(name: string | null, workspace: string | null): string {
  const qs = new URLSearchParams({ embed: "1" });
  if (workspace) qs.set("ws", workspace);
  const path = name ? `/x/${encodeURIComponent(name)}` : "/";
  return `${EXTENSIONS_BASE}${path}?${qs}`;
}

export function ExtensionFrame({ name, workspace, onNavigate, onAuthRequired, title }: ExtensionFrameProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  // What the portal is showing right now. When Harbor's route catches up with a navigate event, the name prop
  // changes to what is already on screen; comparing against this avoids reloading the frame for nothing.
  const shown = useRef<string | null>(name);
  const [src, setSrc] = useState(() => srcFor(name, workspace));

  useEffect(() => {
    if (name !== shown.current) {
      shown.current = name;
      setSrc(srcFor(name, workspace));
    }
  }, [name, workspace]);

  useEffect(() => {
    shown.current = name;
    setSrc(srcFor(name, workspace)); // workspace switch: reload so the extension re-reads harbor.context()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace]);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      // Only our own frame, only same origin
      if (event.source !== frame.current?.contentWindow || event.origin !== window.location.origin) return;
      const msg = event.data as PortalEvent;
      if (!msg || msg.source !== "harbor-extensions") return;
      if (msg.type === "navigate") {
        shown.current = msg.extension;
        onNavigate?.(msg.extension);
      } else if (msg.type === "auth-required") {
        onAuthRequired?.(msg.returnTo);
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onNavigate, onAuthRequired]);

  return (
    <iframe
      ref={frame}
      src={src}
      title={title ?? "Harbor Extensions"}
      style={{ display: "block", width: "100%", height: "100%", border: 0 }}
    />
  );
}
