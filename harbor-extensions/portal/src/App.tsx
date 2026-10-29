import { useCallback, useEffect, useState } from "react";
import { BrowserRouter, matchPath, Navigate, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { api, ApiError, ROUTER_BASENAME, type Me, type PortalConfig } from "./api";
import { EMBED, notifyHost } from "./host";
import { AuditPage } from "./pages/Audit";
import { CatalogPage } from "./pages/Catalog";
import { ConnectorsPage } from "./pages/Connectors";
import { ExtensionPage } from "./pages/Extension";
import { LoginPage } from "./pages/Login";

export function App() {
  const [config, setConfig] = useState<PortalConfig | null>(null);
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api<Me>("/api/me")
      .then((m) => {
        setMe(m);
        setError(null);
      })
      .catch((e) => {
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) setMe(null);
        else setError(e.message);
      });
  }, []);

  useEffect(() => {
    api<PortalConfig>("/api/portal-config").then(setConfig).catch((e) => setError(e.message));
    refresh();
  }, [refresh]);

  async function logout() {
    await api("/auth/logout", { method: "POST" });
    setMe(null);
  }

  if (error) return <div className="page"><div className="banner banner-bad">Cannot reach the platform: {error}</div></div>;
  if (me === undefined || config === null) return <div className="page muted">Loading...</div>;
  if (me === null) {
    if (config.dev_login) return <LoginPage onLogin={refresh} />;
    return <SignInElsewhere config={config} />;
  }

  const isAdmin = me.groups.includes("APP-PLATFORM-ADMIN");
  const routes = (
    <Routes>
      <Route path="/" element={<CatalogPage />} />
      <Route path="/x/:name" element={<ExtensionPage me={me} onReauthenticate={refresh} />} />
      <Route path="/connectors" element={<ConnectorsPage />} />
      <Route path="/audit" element={isAdmin ? <AuditPage /> : <Navigate to="/" />} />
      <Route path="*" element={<Navigate to="/" />} />
    </Routes>
  );

  return (
    <BrowserRouter basename={ROUTER_BASENAME}>
      <HostSync />
      {EMBED ? (
        // Inside Harbor: Harbor's sidebar and workspace switcher are the chrome; the portal shows only the page
        <div className="shell shell-embed">
          <main className="content">{routes}</main>
        </div>
      ) : (
        <div className="shell">
          <header className="topbar">
            <NavLink to="/" className="brand" aria-label="Harbor Extensions home">
              <span className="brand-mark" aria-hidden>H</span>
              <span className="brand-name">Harbor</span>
              <span className="brand-sub">Extensions</span>
            </NavLink>
            <nav className="nav">
              <NavLink to="/" end>Extensions</NavLink>
              <NavLink to="/connectors">Connectors</NavLink>
              {isAdmin && <NavLink to="/audit">Audit</NavLink>}
            </nav>
            <div className="spacer" />
            <div className="user" title={me.groups.join("\n")}>
              <span className="avatar" aria-hidden>{me.display_name.slice(0, 1)}</span>
              <span className="user-name">{me.display_name}</span>
              <span className="user-id">{me.user}</span>
            </div>
            {/* With Harbor's shared login, signing out belongs to Harbor */}
            {config.dev_login && <button className="btn btn-ghost btn-sm" onClick={logout}>Switch user</button>}
          </header>
          <main className="content">{routes}</main>
        </div>
      )}
    </BrowserRouter>
  );
}

/** Tells the host shell where the user is, so Harbor can keep its URL and sidebar highlight in step. */
function HostSync() {
  const location = useLocation();
  useEffect(() => {
    const m = matchPath("/x/:name", location.pathname);
    notifyHost({ type: "navigate", path: location.pathname, extension: m?.params.name ?? null });
  }, [location.pathname]);
  return null;
}

/** No session and no dev login: the host (Harbor) owns sign-in. */
function SignInElsewhere({ config }: { config: PortalConfig }) {
  const returnTo = window.location.href;
  const target = config.login_url ? config.login_url.replace("{next}", encodeURIComponent(returnTo)) : "";

  useEffect(() => {
    if (EMBED) notifyHost({ type: "auth-required", returnTo });
    else if (target) window.location.assign(target);
  }, [returnTo, target]);

  return (
    <div className="page">
      <div className="banner">
        Your session has ended. {EMBED || !target ? "Sign in to Harbor again to continue." : "Redirecting to sign-in..."}
      </div>
    </div>
  );
}
