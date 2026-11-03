#!/usr/bin/env node
/**
 * Harbor CLI (Node). Community extension DX lives here:
 *   harbor extension new <name>
 *   harbor extension dev <name>
 *   harbor extension publish <name> [--dry-run]
 *   harbor extension validate
 *
 * Assumes: Harbor CLI installed, user already logged in / PAT ready
 * (HARBOR_PAT or harbor login). Storage/cluster details are never shown.
 */
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

function rootHelp() {
  console.log(`Harbor CLI

Usage:
  harbor extension new <name>                 Scaffold a new extension
  harbor extension dev <name>                 Local preview (no cluster)
  harbor extension publish <name> [--dry-run] Publish UI to Harbor content channel
  harbor extension validate                   Validate extensions in this repo

Global:
  harbor help
  harbor extension --help

Env (publish):
  HARBOR_PAT                 Auth (preferred; also from prior harbor login)
  HARBOR_URL                 Platform base URL
  HARBOR_CONTENT_ENDPOINT    Optional explicit content upload endpoint
`);
}

async function load(cmd) {
  const file = path.join(__dirname, "commands", `${cmd}.mjs`);
  return import(pathToFileURL(file).href);
}

const [group, ...rest] = args;

if (!group || group === "help" || group === "-h" || group === "--help") {
  rootHelp();
  process.exit(0);
}

if (group === "extension" || group === "ext" || group === "extensions") {
  const sub = rest[0];
  const subArgs = rest.slice(1);
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    rootHelp();
    process.exit(0);
  }
  const map = {
    new: "new",
    create: "new",
    init: "new",
    dev: "dev",
    serve: "dev",
    preview: "dev",
    publish: "publish",
    push: "publish",
    validate: "validate",
    lint: "validate",
  };
  const key = map[sub];
  if (!key) {
    console.error(`Unknown: harbor extension ${sub}`);
    rootHelp();
    process.exit(2);
  }
  try {
    const mod = await load(key);
    const code = await mod.run(subArgs);
    process.exit(code ?? 0);
  } catch (e) {
    console.error(e?.stack || e);
    process.exit(1);
  }
}

console.error(`Unknown command: harbor ${group}`);
console.error(`Try: harbor extension --help`);
process.exit(2);
