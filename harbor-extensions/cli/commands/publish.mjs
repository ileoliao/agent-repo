import fs from "node:fs";
import path from "node:path";
import {
  resolveExt,
  walkFiles,
  hasPat,
  contentEndpoint,
  log,
  die,
} from "../lib.mjs";

export async function run(args) {
  const dry = args.includes("--dry-run") || args.includes("-n");
  const nameArg = args.find((a) => !a.startsWith("-"));
  if (!nameArg) die("usage: harbor extension publish <name> [--dry-run]", 2);
  const { name, dir } = resolveExt(nameArg);

  const files = walkFiles(dir);
  if (!files.length) die(`extensions/${name} has no files to publish`);

  const endpoint = contentEndpoint();
  const authed = hasPat();
  const forceDry = dry || !authed || !endpoint;

  log(`Publish extension '${name}'`);
  log(`  path:     extensions/${name}/`);
  log(`  files:    ${files.length}`);
  for (const f of files.slice(0, 30)) log(`    - ${f}`);
  if (files.length > 30) log(`    … ${files.length - 30} more`);

  if (forceDry) {
    const reasons = [];
    if (dry) reasons.push("`--dry-run` requested");
    if (!authed) reasons.push("no HARBOR_PAT (run harbor login, or export HARBOR_PAT)");
    if (!endpoint) reasons.push("no HARBOR_URL / HARBOR_CONTENT_ENDPOINT");
    log(`
Dry-run only (${reasons.join("; ")}).
Would upload the files above to Harbor's extension content channel.
When credentials are set:
  export HARBOR_PAT=…          # or: harbor login
  export HARBOR_URL=https://…  # platform base
  harbor extension publish ${name}

No cluster, object storage, or FUSE details are required from you.
`);
    return 0;
  }

  // Real upload: POST multipart-ish JSON manifest + file bodies to content API.
  // Shape is deliberately simple; platform implements the channel.
  const pat = process.env.HARBOR_PAT || process.env.HARBOR_TOKEN;
  const bodyFiles = {};
  for (const rel of files) {
    const abs = path.join(dir, rel);
    bodyFiles[rel] = fs.readFileSync(abs).toString("base64");
  }
  const payload = {
    name,
    prefix: `extensions/${name}`,
    files: bodyFiles,
  };

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pat}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    die(`publish failed: HTTP ${res.status} ${text.slice(0, 400)}`);
  }
  log(`Published OK → ${endpoint} (extension '${name}')`);
  return 0;
}
