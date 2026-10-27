import { useEffect, useState } from "react";
import { api, type DevUser } from "../api";

export function LoginPage({ onLogin }: { onLogin: () => void }) {
  const [users, setUsers] = useState<DevUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    api<DevUser[]>("/api/dev/users").then(setUsers).catch((e) => setError(e.message));
  }, []);

  async function login(user: string) {
    setBusy(user);
    try {
      await api("/auth/dev-login", { method: "POST", body: JSON.stringify({ user }) });
      onLogin();
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  }

  return (
    <div className="login">
      <div className="login-head">
        <span className="brand-mark brand-mark-lg" aria-hidden>H</span>
        <h1>Harbor Extensions</h1>
        <p className="muted">Paved roads for the internal ecosystem: integrate a system once, reuse it everywhere.</p>
      </div>
      <section className="login-panel">
        <div className="login-panel-head">
          <h2>Dev environment sign-in</h2>
          <span className="badge badge-warn">Simulated SSO</span>
        </div>
        <p className="muted small">In production the PAT service issues sessions via Kerberos. Pick a simulated user here to see how permissions differ across AD groups.</p>
        {error && <div className="banner banner-bad">{error}</div>}
        <div className="user-list">
          {users === null && !error && <div className="muted">Loading...</div>}
          {users?.map((u) => (
            <button key={u.user} className="user-option" onClick={() => login(u.user)} disabled={busy !== null} data-user={u.user}>
              <span className="avatar avatar-lg" aria-hidden>{u.display_name.slice(0, 1)}</span>
              <span className="user-option-main">
                <span className="user-option-name">
                  {u.display_name} <span className="user-id">{u.user}</span>
                </span>
                <span className="small muted">{u.title}</span>
                <span className="groups">
                  {u.groups.map((g) => (
                    <code key={g}>{g}</code>
                  ))}
                </span>
              </span>
              <span className="user-option-go" aria-hidden>{busy === u.user ? "…" : "→"}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
