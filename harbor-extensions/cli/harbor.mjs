#!/usr/bin/env node
/**
 * Harbor CLI (Node). Community extension DX lives here:
 *   harbor extension new <name>
 *   harbor extension dev <name>
 *   harbor extension publish <name> [--dry-run]
 *   harbor extension validate
 *
 * Auth for publish: HARBOR_URL + HARBOR_PAT environment variables.
 */
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

function rootHelp() {
  console.log(`Harbor CLI

Usage:
  harbor extension new <name> [--owner X --contact Y --description Z]
                                              Scaffold extensions/<name>/
  harbor extension dev <name> [--port N]      Local preview (mock login, no account needed)
  harbor extension validate [<name>]          Check manifest + sandbox rules (exit 1 on problems)
  harbor extension publish <name> [--dry-run] Validate, then upload the static files

Publish needs:
  HARBOR_URL   your Harbor portal URL
  HARBOR_PAT   your personal access token

Docs: docs/extension-developer.md
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
