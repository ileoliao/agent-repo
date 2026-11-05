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

async function bridge(project, msg) {
  const me = { user: "local", display_name: "Local Developer", groups: ["LOCAL-PREVIEW"], credential: "local-preview" };
  if (msg.op === "me") return result(200, me);
  if (msg.op === "context") return result(200, { workspace: null, embedded: false });
  if (msg.op === "can") {
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
  if (!matched) return result(403, { reason: "Route is not in a capability declared by this extension" }, "no_capability");
  if (matched.cap.cli_only) return result(403, { reason: "This capability is CLI-only" }, "cli_only");
  const target = matched.connector.upstream + requestPath;
  try {
    const body = msg.body == null ? undefined : typeof msg.body === "string" ? msg.body : JSON.stringify(msg.body);
    const response = await fetch(target, { method, body, redirect: "manual", headers: { "X-Harbor-Local-User": "local", ...(body ? { "Content-Type": typeof msg.contentType === "string" ? msg.contentType : "application/json" } : {}) }, signal: AbortSignal.timeout(15000) });
    const text = await response.text();
    const type = response.headers.get("content-type") || "text/plain";
    let data = null;
    let raw = text;
    if (type.includes("json")) { try { data = JSON.parse(text); raw = undefined; } catch { /* plain response */ } }
    return { ...result(response.status, data, null, { "content-type": type }), ...(raw === undefined ? {} : { text: raw }) };
  } catch (error) {
    return result(502, { reason: `Local backend unavailable: ${error.message}` }, "upstream_unavailable");
  }
}

function portal(name) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Harbor local · ${name}</title><style>body{font:15px system-ui;margin:0;color:#17243a}header{padding:12px 20px;background:#eef3fa;border-bottom:1px solid #cad5e3}iframe{width:100%;height:calc(100vh - 51px);border:0}</style></head><body><header>Harbor local preview · ${name} · Local Developer</header><iframe id="extension" title="${name}" src="/ext/${name}/index.html" sandbox="allow-scripts allow-forms"></iframe><script>
const frame=document.getElementById('extension');
window.addEventListener('message',async event=>{
  if(event.source!==frame.contentWindow)return;
  const msg=event.data;
  if(!msg||msg.harbor!==1||typeof msg.id!=='string')return;
  let result;
  try { const response=await fetch('/api/bridge',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(msg)}); result=await response.json(); }
  catch(error){ result={ok:false,status:502,gatewayError:'bridge_error',data:{reason:String(error)}}; }
  frame.contentWindow.postMessage({harbor:1,id:msg.id,result},'*');
});</script></body></html>`;
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
    if (req.method === "GET" && url.pathname.startsWith(`/ext/${name}/`)) return staticFile(path.join(dir, "web"), url.pathname.slice(`/ext/${name}/`.length), res, true);
    if (req.method === "GET" && url.pathname.startsWith("/sdk/")) return staticFile(path.join(REPO_ROOT, "sdk"), url.pathname.slice(5), res);
    if (req.method === "POST" && url.pathname === "/api/bridge") {
      try {
        let body = "";
        for await (const chunk of req) { body += chunk; if (body.length > 1024 * 1024) throw new Error("Request too large"); }
        const response = await bridge(inspectStandalone(dir), JSON.parse(body));
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(response));
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify(result(400, { reason: error.message }, "bad_request")));
      }
      return;
    }
    res.writeHead(404).end("Not found");
  });
  await new Promise((resolve, reject) => server.once("error", reject).listen(port, "127.0.0.1", resolve));
  log(`Local preview for '${name}' (Node only; connector upstream from env/local.yaml)
  Open: http://127.0.0.1:${port}/
  Stop: Ctrl+C`);
  await new Promise(() => {});
}
