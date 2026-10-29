/**
 * Extension bridge: portal side.
 *
 * Extensions run in a sandboxed iframe (opaque origin) and cannot send any request themselves. They use postMessage
 * to hand requests to this bridge, which sends them with the current user's session and adds X-Harbor-Extension.
 *
 * Key constraints:
 *  - only accept messages from "this iframe" (compared via event.source); the portal decides the extension identity, so an extension cannot impersonate another;
 *  - only /gw, /api/me and /api/can are reachable, not the portal's other APIs;
 *  - paths get the same validation as the gateway, so the browser cannot normalize ../ and escape the /gw prefix.
 */

import { platformUrl } from "./api";

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const NAME_RE = /^[a-z][a-z0-9-]{1,40}$/;
const CAPABILITY_RE = /^[a-z][a-z0-9_.-]{0,80}$/;

export interface BridgeResult {
  ok: boolean;
  status: number;
  headers: Record<string, string>;
  gatewayError: string | null;
  data: unknown;
  text?: string;
}

export interface BridgeMessage {
  harbor: 1;
  id: string;
  op: string;
  [key: string]: unknown;
}

export class BridgeError extends Error {
  constructor(
    public code: string,
    public reason: string,
  ) {
    super(reason);
  }
}

export function safePath(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.length > 4096) {
    throw new BridgeError("bad_path", "Path must be a string starting with /");
  }
  const [path] = value.split("?", 1);
  if (path.startsWith("//") || /[\\\u0000-\u001f\u007f#]/.test(path)) {
    throw new BridgeError("bad_path", "Path contains disallowed characters");
  }
  for (const seg of path.split("/")) {
    if (seg === "." || seg === ".." || /%2e|%2f|%5c|%00/i.test(seg)) {
      throw new BridgeError("bad_path", "'.' / '..' segments and encoded separators are not allowed in the path");
    }
  }
  return value;
}

async function toResult(res: Response): Promise<BridgeResult> {
  const contentType = res.headers.get("content-type") ?? "";
  const text = await res.text();
  let data: unknown = null;
  let rawText: string | undefined = text;
  if (contentType.includes("json") && text) {
    try {
      data = JSON.parse(text);
      rawText = undefined;
    } catch {
      /* keep the original text */
    }
  }
  return {
    ok: res.ok,
    status: res.status,
    headers: { "content-type": contentType },
    gatewayError: res.headers.get("x-harbor-gateway-error"),
    data,
    text: rawText,
  };
}

function encodeBody(body: unknown, contentType: unknown): { body?: BodyInit; type?: string } {
  if (body === undefined || body === null) return {};
  if (typeof body === "string") return { body, type: typeof contentType === "string" ? contentType : "text/plain" };
  return { body: JSON.stringify(body), type: "application/json" };
}

export async function handleBridgeMessage(extension: string, msg: BridgeMessage): Promise<BridgeResult> {
  const headers: Record<string, string> = { "X-Harbor-Extension": extension, Accept: "application/json" };
  const call = (url: string, init: RequestInit = {}) =>
    fetch(platformUrl(url), { credentials: "same-origin", ...init, headers: { ...headers, ...(init.headers as Record<string, string>) } }).then(toResult);

  switch (msg.op) {
    case "me":
      return call("/api/me");

    case "can": {
      const { connector, capability } = msg;
      if (typeof connector !== "string" || !NAME_RE.test(connector) || typeof capability !== "string" || !CAPABILITY_RE.test(capability)) {
        throw new BridgeError("bad_request", "Invalid connector or capability");
      }
      const qs = new URLSearchParams({ connector, capability });
      return call(`/api/can?${qs}`);
    }

    case "gw": {
      const { connector, method, path, body, contentType } = msg;
      if (typeof connector !== "string" || !NAME_RE.test(connector)) throw new BridgeError("bad_request", "Invalid connector");
      if (typeof method !== "string" || !METHODS.has(method)) throw new BridgeError("bad_request", "Invalid method");
      const encoded = encodeBody(body, contentType);
      return call(`/gw/${connector}${safePath(path)}`, {
        method,
        body: encoded.body,
        headers: encoded.type ? { "Content-Type": encoded.type } : {},
      });
    }

    default:
      throw new BridgeError("unknown_op", `Unsupported operation ${String(msg.op)}`);
  }
}

/** Session expired: handled by the portal (renewal or re-login); extensions do not need to care about login. */
const SESSION_ERRORS = new Set(["unauthenticated", "invalid_token"]);

export function isSessionExpired(result: BridgeResult): boolean {
  return result.status === 401 && result.gatewayError !== null && SESSION_ERRORS.has(result.gatewayError);
}

/** Attach the bridge to an iframe and return the detach function. */
export function attachBridge(iframe: HTMLIFrameElement, extension: string, onSessionExpired?: () => void): () => void {
  function reply(id: string, payload: { result?: BridgeResult; error?: { code: string; reason: string } }) {
    // The extension has an opaque origin, so "*" is the only option; messages go only to this iframe's own window
    iframe.contentWindow?.postMessage({ harbor: 1, id, ...payload }, "*");
  }

  async function onMessage(event: MessageEvent) {
    if (!iframe.contentWindow || event.source !== iframe.contentWindow) return;
    const msg = event.data as BridgeMessage;
    if (!msg || msg.harbor !== 1 || typeof msg.id !== "string" || typeof msg.op !== "string") return;
    try {
      const result = await handleBridgeMessage(extension, msg);
      if (isSessionExpired(result)) onSessionExpired?.();
      reply(msg.id, { result });
    } catch (e) {
      const err = e instanceof BridgeError ? e : new BridgeError("bridge_error", String(e));
      reply(msg.id, { error: { code: err.code, reason: err.reason } });
    }
  }

  window.addEventListener("message", onMessage);
  return () => window.removeEventListener("message", onMessage);
}
