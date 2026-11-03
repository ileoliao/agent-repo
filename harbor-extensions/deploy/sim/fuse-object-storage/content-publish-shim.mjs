#!/usr/bin/env node
/**
 * Sim-only content channel for Harbor CLI publish.
 * Accepts the same POST body as cli/commands/publish.mjs and uploads
 * into the kind FUSE bucket (s3://harbor-content) via a short-lived rclone pod.
 *
 *   node deploy/sim/fuse-object-storage/content-publish-shim.mjs
 *   export HARBOR_PAT=pat_sim
 *   export HARBOR_CONTENT_ENDPOINT=http://127.0.0.1:18771/api/content/extensions
 *   node cli/harbor.mjs extension publish <name>
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "../../..");
const PORT = Number(process.env.CONTENT_PUBLISH_PORT || 18771);
const KCTX = process.env.KCTX || "kind-harbor-sim";
const NS = process.env.NS || "harbor";
const BUCKET = process.env.BUCKET || "harbor-content";

function log(...a) {
  console.log(new Date().toISOString(), ...a);
}
function kubectl(args, opts = {}) {
  const r = spawnSync("kubectl", ["--context", KCTX, "-n", NS, ...args], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    ...opts,
  });
  if (r.status !== 0) {
    const err = (r.stderr || r.stdout || "").trim();
    throw new Error(`kubectl ${args.join(" ")} failed: ${err.slice(0, 500)}`);
  }
  return r.stdout;
}

function uploadDir(localDir, name) {
  const pod = `content-pub-${process.pid}-${Date.now().toString(36)}`;
  const rel = `extensions/${name}`;
  const yaml = `apiVersion: v1
kind: Pod
metadata:
  name: ${pod}
  labels:
    app.kubernetes.io/part-of: harbor-fuse-prototype
spec:
  restartPolicy: Never
  containers:
    - name: rclone
      image: harbor-fuse-rclone:sim
      imagePullPolicy: IfNotPresent
      command: ["sleep", "180"]
      envFrom:
        - secretRef: { name: minio-fuse-creds }
      volumeMounts:
        - { name: tmp, mountPath: /tmp }
  volumes:
    - { name: tmp, emptyDir: {} }
`;
  const tmpYaml = path.join(os.tmpdir(), `${pod}.yaml`);
  fs.writeFileSync(tmpYaml, yaml);
  try {
    kubectl(["apply", "-f", tmpYaml]);
    kubectl(["wait", "--for=condition=Ready", `pod/${pod}`, "--timeout=90s"]);
    kubectl(["exec", pod, "--", "mkdir", "-p", "/tmp/up"]);
    // kubectl cp directory
    const cp = spawnSync(
      "kubectl",
      ["--context", KCTX, "-n", NS, "cp", `${localDir}/.`, `${pod}:/tmp/up/`],
      { encoding: "utf8" }
    );
    if (cp.status !== 0) throw new Error(`kubectl cp failed: ${(cp.stderr || "").slice(0, 400)}`);
    const script = `
set -e
export RCLONE_CONFIG_S3_TYPE=s3
export RCLONE_CONFIG_S3_PROVIDER=Minio
export RCLONE_CONFIG_S3_ENV_AUTH=false
export RCLONE_CONFIG_S3_ACCESS_KEY_ID="$MINIO_ROOT_USER"
export RCLONE_CONFIG_S3_SECRET_ACCESS_KEY="$MINIO_ROOT_PASSWORD"
export RCLONE_CONFIG_S3_ENDPOINT=http://minio-fuse.${NS}.svc.cluster.local:9000
export RCLONE_CONFIG_S3_FORCE_PATH_STYLE=true
rclone mkdir s3:${BUCKET} || true
rclone sync --checksum /tmp/up/ s3:${BUCKET}/${rel}/ --create-empty-src-dirs
echo "--- keys ---"
rclone ls s3:${BUCKET}/${rel} | head -50
`;
    kubectl(["exec", pod, "--", "sh", "-ec", script]);
  } finally {
    spawnSync("kubectl", ["--context", KCTX, "-n", NS, "delete", "pod", pod, "--wait=false"], {
      encoding: "utf8",
    });
    try {
      fs.unlinkSync(tmpYaml);
    } catch {}
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (req.method === "GET" && url.pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/content/extensions") {
    const auth = req.headers.authorization || "";
    if (!auth.startsWith("Bearer ") || auth.length < 15) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "missing Bearer token" }));
      return;
    }
    try {
      const raw = await readBody(req);
      const payload = JSON.parse(raw.toString("utf8"));
      const name = payload.name;
      if (!name || !/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid name" }));
        return;
      }
      const files = payload.files || {};
      const keys = Object.keys(files);
      if (!keys.length) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "no files" }));
        return;
      }
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `harbor-pub-${name}-`));
      for (const [rel, b64] of Object.entries(files)) {
        if (rel.includes("..")) throw new Error(`bad path ${rel}`);
        const abs = path.join(dir, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, Buffer.from(b64, "base64"));
      }
      log(`publish ${name}: ${keys.length} files -> s3://${BUCKET}/extensions/${name}/`);
      uploadDir(dir, name);
      fs.rmSync(dir, { recursive: true, force: true });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, name, files: keys.length, prefix: `extensions/${name}` }));
    } catch (e) {
      log("ERROR", e.message || e);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(e.message || e).slice(0, 400) }));
    }
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(PORT, "127.0.0.1", () => {
  log(`sim content channel on http://127.0.0.1:${PORT}/api/content/extensions`);
  log(`repo=${REPO} ctx=${KCTX} ns=${NS} bucket=${BUCKET}`);
});
