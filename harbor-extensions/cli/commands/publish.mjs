import fs from "node:fs";
import path from "node:path";
import { resolveExt, walkFiles, hasPat, contentEndpoint, portalBase, log, die } from "../lib.mjs";
import { checkExtension } from "./validate.mjs";

const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const SKIP = (rel) =>
  rel.split("/").some((seg) => seg.startsWith(".")) || // .env, .git, .DS_Store …
  /(^|\/)(node_modules)\//.test(rel) ||
  /\.(pem|key|p12|pfx)$/i.test(rel);

function explain(e, endpoint) {
  const c = e?.cause?.code || e?.code || "";
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(c)) return `TLS certificate not trusted by Node (${c}). Use a trusted URL, or set NODE_EXTRA_CA_CERTS=<ca.pem>.`;
  if (c === "ECONNREFUSED" || c === "ENOTFOUND" || c === "EAI_AGAIN") return `cannot reach ${endpoint} (${c}). Check HARBOR_URL and your network/VPN.`;
  return e?.message || String(e);
}

export async function run(args) {
  const dry = args.includes("--dry-run") || args.includes("-n");
  const nameArg = args.find((a) => !a.startsWith("-"));
  if (!nameArg) die("usage: harbor extension publish <name> [--dry-run]", 2);
  const { name, dir } = resolveExt(nameArg);

  // 1) Always validate first. Placeholders and sandbox-rule violations stop here.
  log(`1/3 Validating '${name}' …`);
  const { errors } = checkExtension(name, dir);
  if (errors.length) {
    log(`\nNot published: ${errors.length} problem(s) above. Fix them, then run publish again.`);
    return 1;
  }
  log("    ok");

  // 2) Collect files.
  const all = walkFiles(dir);
  const files = all.filter((f) => !SKIP(f));
  const skipped = all.filter(SKIP);
  if (!files.length) die(`extensions/${name} has no files to publish`);
  let total = 0;
  const bodies = {};
  for (const rel of files) {
    const buf = fs.readFileSync(path.join(dir, rel));
    total += buf.length;
    bodies[rel] = buf.toString("base64");
  }
  if (total > MAX_TOTAL_BYTES) die(`package is ${(total / 1048576).toFixed(1)} MB; limit is ${MAX_TOTAL_BYTES / 1048576} MB. Publish built static output only.`);
  log(`2/3 Package: ${files.length} file(s), ${(total / 1024).toFixed(1)} KB`);
  for (const f of files.slice(0, 20)) log(`      - ${f}`);
  if (files.length > 20) log(`      … ${files.length - 20} more`);
  if (skipped.length) log(`    (skipped: ${skipped.join(", ")} — hidden files, key files and node_modules are never uploaded)`);

  if (dry) {
    log("\nDry run: nothing uploaded. Remove --dry-run to publish.");
    return 0;
  }

  // 3) Upload — needs a PAT. No silent dry-run: a missing credential is an error.
  const endpoint = contentEndpoint();
  if (!hasPat() || !endpoint) {
    const need = [];
    if (!endpoint) need.push("HARBOR_URL  (your Harbor portal origin, e.g. https://harbor.example.com)");
    if (!hasPat()) need.push("HARBOR_PAT  (a personal access token from your Harbor account)");
    log("\nNot published: missing settings. Set:\n  " + need.join("\n  ") + "\nThen re-run. (Use --dry-run to only check the package.)");
    return 1;
  }
  const pat = process.env.HARBOR_PAT || process.env.HARBOR_TOKEN;
  log(`3/3 Uploading to ${endpoint} …`);
  let res;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${pat}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ name, prefix: `extensions/${name}`, files: bodies }),
    });
  } catch (e) {
    log(`\nNot published: ${explain(e, endpoint)}`);
    return 1;
  }
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 300);
    const hint =
      res.status === 401 ? "Your PAT was rejected — check HARBOR_PAT (expired or mistyped?)."
      : res.status === 403 ? "Your PAT is not allowed to publish this extension."
      : res.status === 404 ? "The content API was not found — check that HARBOR_URL is the portal origin."
      : res.status === 413 ? "Package too large for the server."
      : "";
    log(`\nNot published: HTTP ${res.status}. ${hint}${text ? `\n  server said: ${text}` : ""}`);
    return 1;
  }
  log("    uploaded.");

  // Confirm what the portal now serves (best effort; the catalog refreshes within a few seconds).
  const base = portalBase();
  const probe = base ? `${base}/extensions/api/extensions/${name}` : null;
  let seen = false;
  if (probe) {
    for (let i = 0; i < 12 && !seen; i++) {
      try {
        const r = await fetch(probe, { headers: { Authorization: `Bearer ${pat}` } });
        seen = r.ok;
      } catch { /* ignore */ }
      if (!seen) await new Promise((r) => setTimeout(r, 2500));
    }
  }
  log(`\nPublished '${name}'.`);
  if (base) {
    log(`  Catalog:  ${base}/extensions/   (sign in, find "${name}")`);
    log(`  Status:   ${seen ? "visible in the catalog for your account" : "uploaded; not yet visible to your account in the catalog (visibility groups? give it a minute, then refresh)"}`);
  }
  log("  Re-run publish after any change; the latest upload replaces the previous one.");
  return 0;
}
