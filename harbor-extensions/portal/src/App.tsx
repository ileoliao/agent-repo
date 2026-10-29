import { useCallback, useEffect, useState } from "react";
import { BrowserRouter, Navigate, NavLink, Route, Routes } from "react-router-dom";
import { api, ApiError, ROUTER_BASENAME, type Me } from "./api";
import { AuditPage } from "./pages/Audit";
import { CatalogPage } from "./pages/Catalog";
import { ConnectorsPage } from "./pages/Connectors";
import { ExtensionPage } from "./pages/Extension";
import { LoginPage } from "./pages/Login";

export function App() {
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

  useEffect(refresh, [refresh]);

  async function logout() {
    await api("/auth/logout", { method: "POST" });
    setMe(null);
  }

  if (error) return <div className="page"><div className="banner banner-bad">Cannot reach the platform: {error}</div></div>;
  if (me === undefined) return <div className="page muted">Loading...</div>;
  if (me === null) return <LoginPage onLogin={refresh} />;

  const isAdmin = me.groups.includes("APP-PLATFORM-ADMIN");
  return (
    <BrowserRouter basename={ROUTER_BASENAME}>
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
          <button className="btn btn-ghost btn-sm" onClick={logout}>Switch user</button>
        </header>
        <main className="content">
          <Routes>
            <Route path="/" element={<CatalogPage />} />
            <Route path="/x/:name" element={<ExtensionPage me={me} onReauthenticate={refresh} />} />
            <Route path="/connectors" element={<ConnectorsPage />} />
            <Route path="/audit" element={isAdmin ? <AuditPage /> : <Navigate to="/" />} />
            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
