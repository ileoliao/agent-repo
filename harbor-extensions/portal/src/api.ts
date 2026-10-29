export interface Me {
  user: string;
  display_name: string;
  groups: string[];
  credential: string;
}

export interface ExtensionCapability {
  id: string;
  description: string;
  write: boolean;
  granted: boolean;
  user_has_access: boolean;
  groups: string[];
}

export interface ExtensionInfo {
  name: string;
  title: string;
  description: string;
  owner: string;
  contact: string;
  tier: "experimental" | "community" | "official";
  entry: string;
  capabilities: ExtensionCapability[];
}

export interface ConnectorCapability {
  id: string;
  description: string;
  allow: string[];
  groups: string[];
  data_class: string;
  write: boolean;
  open: boolean;
  user_has_access: boolean;
}

export interface ConnectorInfo {
  name: string;
  title: string;
  description: string;
  owner: string;
  capabilities: ConnectorCapability[];
}

export interface AuditEntry {
  ts: string;
  request_id: string;
  user: string;
  credential: string;
  extension: string | null;
  connector: string;
  capability?: string | null;
  method: string;
  path: string;
  decision: "allow" | "deny";
  code?: string;
  status?: number;
  latency_ms?: number;
}

export interface DevUser {
  user: string;
  display_name: string;
  title: string;
  groups: string[];
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: { Accept: "application/json", ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error ?? "error", body.reason ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

export const TIER_LABEL: Record<ExtensionInfo["tier"], string> = {
  experimental: "Experimental",
  community: "Community",
  official: "Official",
};
