import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { REPO_ROOT, log } from "./lib.mjs";
import { allowedCapability, inspectStandalone, validateStandalone } from "./standalone.mjs";

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".woff": "font/woff", ".woff2": "font/woff2" };
const EXT_CSP = "sandbox allow-scripts allow-forms; default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";

function result(status, data, gatewayError = null, headers = {}) {
  return { ok: status >= 200 && status < 300, status, headers, gatewayError, data };
}

function validPath(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.length > 4096 || value.startsWith("//") || /[\\\u0000-\u001f\u007f#]/.test(value)) return false;
  return !value.split("?")[0].split("/").some((part) => part === "." || part === ".." || /%2e|%2f|%5c|%00/i.test(part));
}

function devGateway() {
  // TODO: read the trusted Dev endpoint and PAT from the existing Harbor CLI's local credential file when the CLIs are integrated.
  const raw = process.env.HARBOR_DEV_GATEWAY_URL;
  if (!raw) return { error: result(500, { reason: "Set HARBOR_DEV_GATEWAY_URL in the CLI process" }, "missing_dev_gateway") };
  let url;
  try { url = new URL(raw); } catch { return { error: result(500, { reason: "HARBOR_DEV_GATEWAY_URL is invalid" }, "invalid_dev_gateway") }; }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((!loopback && url.protocol !== "https:") || (loopback && !["http:", "https:"].includes(url.protocol)) || url.username || url.password || url.search || url.hash) {
    return { error: result(500, { reason: "HARBOR_DEV_GATEWAY_URL must be HTTPS, with no credentials or query" }, "invalid_dev_gateway") };
  }
  const pat = process.env.HARBOR_DEV_PAT;
  if (!pat) return { error: result(500, { reason: "Set HARBOR_DEV_PAT in the CLI process" }, "missing_dev_pat") };
  return { base: url.toString().replace(/\/$/, ""), pat };
}

async function gatewayApi(project, path) {
  const settings = devGateway();
  if (settings.error) return settings.error;
  try {
    const response = await fetch(settings.base + path, { headers: { Authorization: `Bearer ${settings.pat}`, "X-Harbor-Extension": project.manifest.name }, redirect: "manual", signal: AbortSignal.timeout(15000) });
    const data = await response.json();
    return result(response.status, data, response.headers.get("x-harbor-gateway-error"));
  } catch (error) {
    return result(502, { reason: `Dev gateway unavailable: ${error.message}` }, "gateway_unavailable");
  }
}

async function bridge(project, msg, staffId) {
  const me = { user: staffId, display_name: staffId === "local" ? "Local Developer" : staffId, groups: ["LOCAL-PREVIEW"], credential: "local-preview" };
  if (msg.op === "me") return project.gateway ? gatewayApi(project, "/api/me") : result(200, me);
  if (msg.op === "context") return result(200, { workspace: null, embedded: false });
  if (msg.op === "can") {
    if (project.gateway) return gatewayApi(project, `/api/can?connector=${encodeURIComponent(msg.connector)}&capability=${encodeURIComponent(msg.capability)}`);
    const cap = project.connectors.get(msg.connector)?.capabilities.get(String(msg.capability || "").replace(`${msg.connector}.`, ""));
    return result(200, { allowed: !!cap && project.manifest.capabilities?.includes(`${msg.connector}.${String(msg.capability).replace(`${msg.connector}.`, "")}`) });
  }
  if (msg.op !== "gw") return result(400, { reason: "Unknown SDK operation" }, "bad_request");
  const { connector, method, path: requestPath } = msg;
  if (typeof connector !== "string" || !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method) || !validPath(requestPath)) {
    return result(400, { reason: "Invalid connector request" }, "bad_request");
  }
  const pathname = requestPath.split("?")[0];
  const matched = allowedCapability(project, connector, method, pathname);
  if (!project.gateway && !matched) return result(403, { reason: "Route is not in a capability declared by this extension" }, "no_capability");
  if (project.gateway && !project.manifest.capabilities?.some((id) => id.startsWith(`${connector}.`))) return result(403, { reason: "Connector is not declared by this extension" }, "no_capability");
  if (matched?.cap.cli_only) return result(403, { reason: "This capability is CLI-only" }, "cli_only");
  const headers = {};
  let target;
  if (project.gateway) {
    const settings = devGateway();
    if (settings.error) return settings.error;
    target = `${settings.base}/gw/${connector}${requestPath}`;
    headers.Authorization = `Bearer ${settings.pat}`;
    headers["X-Harbor-Extension"] = project.manifest.name;
  } else {
    const configured = matched.connector;
    const remote = !["localhost", "127.0.0.1", "[::1]"].includes(new URL(configured.upstream).hostname);
    target = configured.upstream + requestPath;
    if ((configured.auth?.type || "service-account") === "service-account") {
      const secret = process.env[`HARBOR_SECRET_${configured.auth.secret}`];
      if (!secret) return result(500, { reason: `Set HARBOR_SECRET_${configured.auth.secret} in the CLI process` }, "missing_connector_secret");
      headers.Authorization = `Bearer ${secret}`;
    } else if (remote) {
      return result(400, { reason: "Remote identity-only services require a Dev gateway entry in env/local.yaml" }, "remote_identity_requires_gateway");
    }
    if (!remote) headers["X-Harbor-Local-User"] = staffId;
  }
  try {
    const body = msg.body == null ? undefined : typeof msg.body === "string" ? msg.body : JSON.stringify(msg.body);
    const response = await fetch(target, { method, body, redirect: "manual", headers: { ...headers, ...(body ? { "Content-Type": typeof msg.contentType === "string" ? msg.contentType : "application/json" } : {}) }, signal: AbortSignal.timeout(15000) });
    const text = await response.text();
    const type = response.headers.get("content-type") || "text/plain";
    let data = null;
    let raw = text;
    if (type.includes("json")) { try { data = JSON.parse(text); raw = undefined; } catch { /* plain response */ } }
    const gatewayError = project.gateway ? response.headers.get("x-harbor-gateway-error") : null;
    return { ...result(response.status, data, gatewayError, { "content-type": type }), ...(raw === undefined ? {} : { text: raw }) };
  } catch (error) {
    return result(502, { reason: `${project.gateway ? "Dev gateway" : "Local backend"} unavailable: ${error.message}` }, "upstream_unavailable");
  }
}

function portal(name) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Harbor preview · ${name}</title><link rel="stylesheet" href="/preview/shell.css"></head><body>
<div class="shell"><aside class="rail"><div class="brand">HARBOR</div><div class="rail-caption">WORKSPACE</div><div class="nav-item"><span class="nav-symbol">⌂</span> Overview</div><div class="nav-item active"><span class="nav-symbol">▧</span> Extensions</div><div class="nav-item"><span class="nav-symbol">◷</span> Activity</div><div class="rail-bottom"><div class="rail-note">LOCAL DEVELOPMENT</div></div></aside>
<div class="main"><header class="topbar"><div class="breadcrumbs">Workspace <span>/</span> Extensions <span>/</span> <strong>${name}</strong></div><div class="top-actions"><span class="preview-badge"><span class="pulse"></span><span id="preview-mode">LOCAL PREVIEW</span></span><button id="reload" class="top-button" type="button" title="Reload extension">↻ Reload</button><button id="debug-toggle" class="top-button debug-button" type="button" aria-controls="debug-panel" aria-expanded="false">Debug tools</button><div class="identity-control"><button id="identity-toggle" class="identity-toggle" type="button" aria-controls="identity-form" aria-expanded="false"><span id="identity-avatar" class="top-avatar">LD</span><span id="identity-label">Local Developer</span><span class="identity-chevron">⌄</span></button><form id="identity-form" class="identity-form" hidden><label for="staff-id">Preview as Staff ID</label><input id="staff-id" name="staff-id" type="text" maxlength="64" autocomplete="off" spellcheck="false" placeholder="Enter Staff ID" pattern="[A-Za-z0-9._-]{1,64}" required><p>Simulated local identity for SDK and connector calls.</p><div class="identity-actions"><button id="identity-reset" type="button">Reset</button><button type="submit">Apply</button></div></form></div></div></header>
<iframe id="extension" class="extension-frame" title="${name}" src="/ext/${name}/index.html" sandbox="allow-scripts allow-forms"></iframe></div>
<aside id="debug-panel" class="inspector" aria-label="Debug tools" hidden><div class="inspector-heading"><div><div class="overline">DEVELOPER PANEL</div><h2>Debug tools</h2><p>Connector checks for this preview.</p></div><button id="debug-close" class="close-button" type="button" aria-label="Close debug tools">×</button></div><div class="inspect-section"><div class="inspect-label">CONNECTORS</div><div id="connectors" class="connectors"><span class="muted">Loading configuration…</span></div></div><div class="inspect-section"><div class="inspect-label">LAST SDK REQUEST</div><div id="request-state" class="request-state"><span class="request-dot idle"></span><span>Waiting for extension</span></div><pre id="response-detail" class="response-detail" hidden></pre></div><div class="inspector-foot">Read-only checks use declared routes and the address in <code>env/local.yaml</code>.</div></aside></div><script src="/preview/shell.js"></script></body></html>`;
}

function staticFile(root, relative, res, extension = false) {
  let decoded;
  try { decoded = decodeURIComponent(relative); } catch { res.writeHead(400).end(); return; }
  const target = path.resolve(root, decoded);
  if (!target.startsWith(path.resolve(root) + path.sep) || decoded.split("/").some((part) => part.startsWith(".") || ["connectors", "env", "node_modules"].includes(part)) || /\.(pem|key|p12|pfx)$/i.test(target)) {
    res.writeHead(404).end(); return;
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile() || !fs.realpathSync(target).startsWith(fs.realpathSync(root) + path.sep) || path.basename(target) === "extension.yaml") { res.writeHead(404).end(); return; }
  res.writeHead(200, { "Content-Type": MIME[path.extname(target).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff", ...(extension ? { "Content-Security-Policy": EXT_CSP } : {}) });
  fs.createReadStream(target).pipe(res);
}

export async function runStandaloneDev({ name, dir }, port) {
  validateStandalone(dir);
  const server = http.createServer(async (req, res) => {
    const origin = `http://127.0.0.1:${port}`;
    if (req.headers.host !== `127.0.0.1:${port}` || (req.headers.origin && req.headers.origin !== origin)) {
      res.writeHead(403).end("Local preview accepts its own origin only"); return;
    }
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" }).end(portal(name)); return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/preview/")) return staticFile(path.join(REPO_ROOT, "cli", "preview"), url.pathname.slice(9), res);
    if (req.method === "GET" && url.pathname === "/api/preview-config") {
      const project = inspectStandalone(dir);
      const gatewayBase = project.gateway ? devGateway().base || null : null;
      const owned = [...project.connectors].map(([id, connector]) => ({ id, upstream: gatewayBase || connector.upstream, via: connector.via, probes: project.gateway ? [] : [...connector.capabilities].filter(([key, cap]) => project.manifest.capabilities?.includes(`${id}.${key}`) && !cap.cli_only).flatMap(([, cap]) => cap.allow.filter((rule) => /^GET \/[^*]*$/.test(rule)).map((rule) => rule.slice(4))) }));
      const existing = [...new Set((project.manifest.capabilities || []).map((id) => String(id).split(".")[0]))].filter((id) => !project.connectors.has(id)).map((id) => ({ id, upstream: gatewayBase, via: "gateway", probes: [] }));
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" }).end(JSON.stringify({ gateway: !!project.gateway, connectors: [...owned, ...existing] })); return;
    }
    if (req.method === "GET" && url.pathname.startsWith(`/ext/${name}/`)) return staticFile(path.join(dir, "web"), url.pathname.slice(`/ext/${name}/`.length), res, true);
    if (req.method === "GET" && url.pathname.startsWith("/sdk/")) return staticFile(path.join(REPO_ROOT, "sdk"), url.pathname.slice(5), res);
    if (req.method === "POST" && url.pathname === "/api/bridge") {
      try {
        const staffId = req.headers["x-harbor-preview-staff-id"] ?? "local";
        if (typeof staffId !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(staffId)) throw new Error("Invalid preview Staff ID");
        let body = "";
        for await (const chunk of req) { body += chunk; if (body.length > 1024 * 1024) throw new Error("Request too large"); }
        const response = await bridge(inspectStandalone(dir), JSON.parse(body), staffId);
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(response));
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify(result(400, { reason: error.message }, "bad_request")));
      }
      return;
    }
    res.writeHead(404).end("Not found");
  });
  await new Promise((resolve, reject) => server.once("error", reject).listen(port, "127.0.0.1", resolve));
  log(`Local preview for '${name}' (Node only; routing mode from env/local.yaml)
  Open: http://127.0.0.1:${port}/
  Stop: Ctrl+C`);
  await new Promise(() => {});
}
