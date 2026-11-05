#!/usr/bin/env node
/**
 * Harbor CLI (Node). Community extension DX lives here:
 *   harbor extension new <name>
 *   harbor extension dev <name>
 *   harbor extension validate
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
  harbor extension new <name> --standalone    Scaffold a dedicated extension repository directory
  harbor extension dev [<name|path>] [--port N] Local preview; standalone repos use a Node connector proxy
  harbor extension validate [<name|path>]   Check manifest, connector and environment configuration

Publishing is triggered only by GitHub pushes to dev or prod.

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
