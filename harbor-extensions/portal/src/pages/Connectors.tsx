import { useEffect, useState } from "react";
import { api, type ConnectorInfo } from "../api";

export function ConnectorsPage() {
  const [items, setItems] = useState<ConnectorInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ items: ConnectorInfo[] }>("/api/connectors")
      .then((r) => setItems(r.items))
      .catch((e) => setError(e.message));
  }, []);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Connectors</h1>
          <p className="muted">
            Internal systems are integrated once by the platform team and reused everywhere. Extensions declare the capabilities they use in <code>extension.yaml</code>, and users must be in the matching AD group to use them.
          </p>
        </div>
      </div>
      {error && <div className="banner banner-bad">{error}</div>}
      {items === null && !error && <div className="muted">Loading...</div>}
      <div className="stack">
        {items?.map((c) => (
          <section key={c.name} className="card">
            <div className="connector-head">
              <div>
                <h2>
                  {c.title} <code className="muted">{c.name}</code>
                </h2>
                <p className="small muted">{c.description} · Maintained by {c.owner}</p>
              </div>
              <code className="small muted">/gw/{c.name}/…</code>
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th>Capability</th>
                  <th>Open operations</th>
                  <th>Required AD groups</th>
                  <th>Data class</th>
                  <th>You</th>
                </tr>
              </thead>
              <tbody>
                {c.capabilities.map((cap) => (
                  <tr key={cap.id} className={cap.open ? "" : "row-closed"}>
                    <td>
                      <code>{cap.id}</code>
                      {cap.write && <span className="badge badge-sm">Write</span>}
                      <div className="small muted">{cap.description}</div>
                    </td>
                    <td>
                      {cap.allow.map((a) => (
                        <div key={a}>
                          <code className="small">{a}</code>
                        </div>
                      ))}
                    </td>
                    <td>
                      {cap.groups.map((g) => (
                        <code key={g} className="small block">{g}</code>
                      ))}
                    </td>
                    <td>
                      <span className={`badge ${cap.open ? "" : "badge-warn"}`}>{cap.data_class}{cap.open ? "" : " · not open"}</span>
                    </td>
                    <td>{cap.user_has_access ? <span className="ok">✓ Granted</span> : <span className="muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
      </div>
    </div>
  );
}
