import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, TIER_LABEL, type ExtensionInfo } from "../api";

export function CatalogPage() {
  const [items, setItems] = useState<ExtensionInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    api<{ items: ExtensionInfo[] }>("/api/extensions")
      .then((r) => setItems(r.items))
      .catch((e) => setError(e.message));
  }, []);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!items || !needle) return items;
    return items.filter((e) => [e.title, e.description, e.name, e.owner].some((s) => s.toLowerCase().includes(needle)));
  }, [items, q]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Extensions</h1>
          <p className="muted">Community-built tools that run on the Harbor Extensions platform and use internal systems through a single gateway.</p>
        </div>
        <input className="input search" placeholder="Search extensions" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search extensions" />
      </div>

      {error && <div className="banner banner-bad">{error}</div>}
      {shown === null && !error && <div className="muted">Loading...</div>}
      {shown?.length === 0 && (
        <div className="empty">
          <strong>{items?.length === 0 ? "No extensions available" : "No matching extensions"}</strong>
          {items?.length === 0 && <p className="muted small">Extension visibility is controlled by AD group. To use them, request to join APP-DEV-ALL.</p>}
        </div>
      )}

      <div className="grid">
        {shown?.map((e) => {
          const connectors = [...new Set(e.capabilities.map((c) => c.id.split(".")[0]))];
          return (
            <Link key={e.name} to={`/x/${e.name}`} className="card ext-card" data-extension={e.name}>
              <div className="ext-card-top">
                <span className="ext-icon" aria-hidden>{e.title.slice(0, 1)}</span>
                <span className={`badge tier-${e.tier}`}>{TIER_LABEL[e.tier]}</span>
              </div>
              <h2>{e.title}</h2>
              <p className="ext-desc">{e.description}</p>
              <div className="ext-foot">
                <span className="small muted">Maintained by {e.owner}</span>
                <span className="chips">
                  {connectors.map((c) => (
                    <span key={c} className="chip">{c}</span>
                  ))}
                </span>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
