import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT, resolveExt, log, die } from "../lib.mjs";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".map": "application/json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".yaml": "text/yaml; charset=utf-8",
  ".yml": "text/yaml; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent((urlPath || "/").split("?")[0]);
  const rel = decoded.replace(/^\/+/, "");
  const full = path.normalize(path.join(root, rel));
  if (!full.startsWith(root)) return null;
  return full;
}

const PREVIEW_SHIM = `/* Harbor dev-server preview shim (not published). */
(function () {
  if (window.parent !== window) return;
  var empty = { items: [], note: "preview: no connector data" };
  function ok(v) { return Promise.resolve(v); }
  function connector(name) {
    function req() {
      if (name === "example") return ok({ status: "ok", message: "Preview stub — replace with your connector", connector: name });
      return ok(Object.assign({ connector: name }, empty));
    }
    return { request: req, get: req, post: req, put: req, patch: req, delete: req };
  }
  window.harbor = Object.freeze({
    version: "preview",
    HarborError: Error,
    me: function () { return ok({ display_name: "Preview User", name: "Preview User", username: "preview", email: "preview@example.invalid", groups: [] }); },
    can: function () { return ok(true); },
    connector: connector,
    context: function () { return ok({ workspace: null, embedded: false }); },
  });
  console.info("[harbor preview] mock harbor identity active");
})();
`;

export async function run(args) {
  const nameArg = args.find((a) => !a.startsWith("-"));
  if (!nameArg) die("usage: harbor extension dev <name>", 2);
  const portFlag = args.find((a) => a.startsWith("--port="));
  const port = Number(portFlag?.split("=")[1] || process.env.PORT || 5173);
  const { name } = resolveExt(nameArg);

  const indexUrl = `http://127.0.0.1:${port}/extensions/${name}/index.html`;

  const server = http.createServer((req, res) => {
    if ((req.url || "").split("?")[0] === "/sdk/harbor-preview.js") {
      res.writeHead(200, { "Content-Type": MIME[".js"], "Cache-Control": "no-cache" });
      res.end(PREVIEW_SHIM);
      return;
    }
    if ((req.url || "").split("?")[0] === "/") {
      res.writeHead(200, { "Content-Type": MIME[".html"], "Cache-Control": "no-cache" });
      res.end(`<!doctype html><meta charset="utf-8"><title>Harbor preview</title><body><h1>Harbor preview mode</h1><p>Open your extension: <a href="/extensions/${name}/index.html">/extensions/${name}/index.html</a></p><p>Preview mode: harbor identity and connectors are mocked.</p></body>`);
      return;
    }
    let file = safeJoin(REPO_ROOT, req.url);
    if (!file) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    if (stat.isDirectory()) {
      file = path.join(file, "index.html");
      try {
        stat = fs.statSync(file);
      } catch {
        res.writeHead(404);
        res.end("not found");
        return;
      }
    }
    const ext = path.extname(file).toLowerCase();
    if (ext === ".html") {
      let html = fs.readFileSync(file, "utf8");
      const tag = '<script src="/sdk/harbor-preview.js"></script>';
      const re = /(<script[^>]*src=["'][^"']*sdk\/harbor\.js["'][^>]*><\/script>)/i;
      html = re.test(html) ? html.replace(re, "$1\n    " + tag) : html.replace(/<\/body>/i, tag + "</body>");
      res.writeHead(200, { "Content-Type": MIME[".html"], "Cache-Control": "no-cache" });
      res.end(html);
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    fs.createReadStream(file).pipe(res);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  log(`Local preview for '${name}' (no cluster, no sim)
  Preview mode: mock harbor identity active
  Open:  ${indexUrl}
  Stop:  Ctrl+C

Notes:
  - Edit files under extensions/${name}/ and refresh the browser.
  - Any framework is fine; point the build output at this folder (or keep plain HTML/JS).
  - harbor.me()/can()/connector() return mock data here (dev server only; published files are untouched).
  - Your business API is self-hosted + registered as a connector — not part of this preview.
`);

  // keep alive
  await new Promise(() => {});
}
