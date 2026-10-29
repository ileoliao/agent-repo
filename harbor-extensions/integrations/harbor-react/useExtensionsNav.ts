/**
 * Harbor-side hook: the extensions this user may open in the current workspace, for Harbor's sidebar.
 * Copy this folder into Harbor's React app. No dependencies beyond React.
 *
 * Data comes from GET /extensions/api/nav (same origin, user's session cookie). Pins are a per-browser
 * convenience kept in Harbor's own localStorage; the extensions platform stores nothing per user.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

export const EXTENSIONS_BASE = "/extensions";

export interface NavItem {
  name: string;
  title: string;
  description: string;
  tier: "experimental" | "community" | "official";
  owner: string;
  section: string | null; // a Harbor sidebar group (config/nav.yaml), or null
  featured: boolean; // already capped by the platform (config/nav.yaml max_featured)
  order: number;
  href: string; // standalone portal page
  embed_src: string; // what ExtensionFrame loads
}

export interface NavData {
  catalog_href: string;
  max_featured: number;
  sections: { key: string; title: string }[];
  items: NavItem[];
}

const PIN_KEY = "harbor-extensions:pins";
const MAX_PINS = 5;

function readPins(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(PIN_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, MAX_PINS) : [];
  } catch {
    return [];
  }
}

function writePins(pins: string[]): void {
  try {
    localStorage.setItem(PIN_KEY, JSON.stringify(pins));
  } catch {
    /* storage unavailable: pins last for this page only */
  }
}

export function useExtensionsNav(workspace: string | null) {
  const [data, setData] = useState<NavData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pins, setPins] = useState<string[]>(readPins);

  useEffect(() => {
    let cancelled = false;
    const qs = workspace ? `?workspace=${encodeURIComponent(workspace)}` : "";
    fetch(`${EXTENSIONS_BASE}/api/nav${qs}`, { credentials: "same-origin", headers: { Accept: "application/json" } })
      .then(async (r) => {
        if (!r.ok) throw new Error(`extensions nav: HTTP ${r.status}`);
        return (await r.json()) as NavData;
      })
      .then((d) => !cancelled && (setData(d), setError(null)))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [workspace]);

  const togglePin = useCallback((name: string) => {
    setPins((prev) => {
      const next = prev.includes(name) ? prev.filter((n) => n !== name) : [name, ...prev].slice(0, MAX_PINS);
      writePins(next);
      return next;
    });
  }, []);

  const derived = useMemo(() => {
    const items = data?.items ?? [];
    const byName = new Map(items.map((i) => [i.name, i]));
    // Pins the user can no longer see (visibility change, other workspace) simply drop out
    const pinned = pins.map((n) => byName.get(n)).filter((i): i is NavItem => !!i);
    // Featured picks that already sit in a Harbor group are not repeated here (one home per extension)
    const featured = items.filter((i) => i.featured && !i.section && !pins.includes(i.name));
    return {
      /** Sidebar "Extensions" group: the user's pins first, then the platform's featured picks. Bounded by MAX_PINS + max_featured. */
      quick: [...pinned, ...featured],
      /** Extensions to list inside an existing Harbor group, e.g. inSection("release") under "Release". */
      inSection: (key: string) => items.filter((i) => i.section === key),
      total: items.length,
    };
  }, [data, pins]);

  return { data, error, pins, togglePin, ...derived };
}

/** Harbor route for an extension page, e.g. /ext/outage-console; null = the catalog ("All extensions"). */
export function extensionRoute(name: string | null): string {
  return name ? `/ext/${encodeURIComponent(name)}` : "/ext";
}
