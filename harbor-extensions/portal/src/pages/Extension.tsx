import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, TIER_LABEL, type ExtensionInfo, type Me } from "../api";
import { attachBridge } from "../bridge";
import { notifyHost } from "../host";

export function ExtensionPage({ me, onReauthenticate }: { me: Me; onReauthenticate: () => void }) {
  const { name = "" } = useParams();
  const [ext, setExt] = useState<ExtensionInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showPerms, setShowPerms] = useState(false);
  const [expired, setExpired] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    setExt(null);
    setError(null);
    api<ExtensionInfo>(`/api/extensions/${encodeURIComponent(name)}`)
      .then(setExt)
      .catch((e) => setError(e.message));
  }, [name]);

  // The bridge must be attached before the iframe loads so the extension's first request is not lost
  useEffect(() => {
    if (!ext || !frame.current) return;
    // Session expiry is handled by the portal: in production this redirects to corporate SSO for a silent renewal, and the extension never notices
    return attachBridge(frame.current, ext.name, () => {
      setExpired(true);
      // Embedded in Harbor: Harbor owns sign-in, so tell it right away (no-op when standalone)
      notifyHost({ type: "auth-required", returnTo: window.location.href });
    });
  }, [ext]);

  if (error) {
    return (
      <div className="page">
        <Link to="/" className="back">← Extensions</Link>
        <div className="banner banner-bad">{error}</div>
      </div>
    );
  }
  if (!ext) return <div className="page muted">Loading...</div>;

  const missing = ext.capabilities.filter((c) => !c.user_has_access);
  return (
    <div className="ext-view">
      <div className="ext-bar">
        <Link to="/" className="back" aria-label="Back to extensions">←</Link>
        <span className="ext-icon ext-icon-sm" aria-hidden>{ext.title.slice(0, 1)}</span>
        <strong className="ext-bar-title">{ext.title}</strong>
        <span className={`badge tier-${ext.tier}`}>{TIER_LABEL[ext.tier]}</span>
        <span className="small muted">Maintained by {ext.owner}</span>
        <div className="spacer" />
        {missing.length > 0 && <span className="badge badge-warn">You lack access to {missing.length} {missing.length === 1 ? "capability" : "capabilities"}</span>}
        <div className="perm-wrap">
          <button className="btn btn-sm" onClick={() => setShowPerms((v) => !v)} aria-expanded={showPerms}>
            Permissions
          </button>
          {showPerms && (
            <div className="perm-pop" role="dialog" aria-label="Capabilities used by this extension">
              <div className="perm-head">
                <strong>Capabilities used by this extension</strong>
                <span className="small muted">As {me.display_name}</span>
              </div>
              {ext.capabilities.map((c) => (
                <div key={c.id} className="perm-row">
                  <span className={c.user_has_access && c.granted ? "ok" : "no"}>{c.user_has_access && c.granted ? "✓" : "✗"}</span>
                  <span>
                    <code>{c.id}</code>
                    {c.write && <span className="badge badge-sm">Write</span>}
                    <span className="small muted block">{c.description}</span>
                    {!c.user_has_access && <span className="small warn block">Join {c.groups.join(" or ")} to get access</span>}
                    {!c.granted && <span className="small warn block">Awaiting platform-team grant</span>}
                  </span>
                </div>
              ))}
              {ext.capabilities.length === 0 && <div className="small muted">Does not access any system</div>}
            </div>
          )}
        </div>
        {ext.contact && (
          <a className="btn btn-sm" href={`mailto:${ext.contact}?subject=${encodeURIComponent(`[Harbor Extensions feedback] ${ext.title}`)}`}>
            Feedback
          </a>
        )}
      </div>
      <div className="ext-stage">
        <iframe
          ref={frame}
          key={ext.name}
          className="ext-frame"
          title={ext.title}
          src={ext.entry}
          sandbox={EXTENSION_SANDBOX}
          referrerPolicy="no-referrer"
        />
        {expired && (
          <div className="session-overlay" role="alertdialog" aria-label="Session expired">
            <div className="session-box">
              <strong>Session expired</strong>
              <p className="small muted">You will return to this extension after signing in again.</p>
              <button className="btn btn-primary" onClick={onReauthenticate}>Sign in again</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// allow-popups-to-escape-sandbox: external links with target="_blank" in an extension open normally in a new tab (the target system handles its own SSO).
// No allow-same-origin or allow-top-navigation: the extension always keeps an opaque origin and cannot navigate the portal page away.
// Must stay consistent with the sandbox directive in the backend EXTENSION_CSP.
const EXTENSION_SANDBOX = "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox";
