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

export async function run(args) {
  const nameArg = args.find((a) => !a.startsWith("-"));
  if (!nameArg) die("usage: harbor extension dev <name>", 2);
  const portFlag = args.find((a) => a.startsWith("--port="));
  const port = Number(portFlag?.split("=")[1] || process.env.PORT || 5173);
  const { name } = resolveExt(nameArg);

  const indexUrl = `http://127.0.0.1:${port}/extensions/${name}/index.html`;

  const server = http.createServer((req, res) => {
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
  Open:  ${indexUrl}
  Stop:  Ctrl+C

Notes:
  - Edit files under extensions/${name}/ and refresh the browser.
  - Any framework is fine; point the build output at this folder (or keep plain HTML/JS).
  - harbor.* calls need the Harbor portal; standalone preview still serves your UI (API calls show a host error until embedded).
  - Your business API is self-hosted + registered as a connector — not part of this preview.
`);

  // keep alive
  await new Promise(() => {});
}
