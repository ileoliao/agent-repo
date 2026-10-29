import { useCallback, useEffect, useState } from "react";
import { api, type AuditEntry } from "../api";

export function AuditPage() {
  const [items, setItems] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [onlyDeny, setOnlyDeny] = useState(false);

  const load = useCallback(() => {
    api<{ items: AuditEntry[] }>("/api/audit?limit=300")
      .then((r) => setItems(r.items))
      .catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const shown = items?.filter((i) => !onlyDeny || i.decision === "deny");
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Gateway audit</h1>
          <p className="muted">Every gateway decision: who, through which extension, on which capability, and the outcome. In production the same fields are reported as OTel span attributes.</p>
        </div>
        <div className="row">
          <label className="small row">
            <input type="checkbox" checked={onlyDeny} onChange={(e) => setOnlyDeny(e.target.checked)} /> Denied only
          </label>
          <button className="btn btn-sm" onClick={load}>Refresh</button>
        </div>
      </div>
      {error && <div className="banner banner-bad">{error}</div>}
      <section className="card">
        <table className="table audit">
          <thead>
            <tr>
              <th>Time</th>
              <th>User</th>
              <th>Extension</th>
              <th>Capability</th>
              <th>Request</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {shown?.map((i) => (
              <tr key={`${i.request_id}-${i.ts}`}>
                <td className="small nowrap">{new Date(i.ts).toLocaleTimeString("en-GB", { hour12: false })}</td>
                <td>
                  {i.user} <span className="small muted">{i.credential === "pat" ? "PAT" : "Session"}</span>
                </td>
                <td className="small">{i.extension ?? <span className="muted">— (CLI)</span>}</td>
                <td><code className="small">{i.capability ?? i.connector}</code></td>
                <td><code className="small">{i.method} {i.path}</code></td>
                <td className="nowrap">
                  {i.decision === "allow" ? (
                    <span className="badge badge-good">Allowed {i.status}</span>
                  ) : (
                    <span className="badge badge-bad">Denied {i.code}</span>
                  )}
                  {i.latency_ms !== undefined && <span className="small muted"> {i.latency_ms}ms</span>}
                </td>
              </tr>
            ))}
            {shown?.length === 0 && (
              <tr>
                <td colSpan={6} className="empty">No records yet</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
