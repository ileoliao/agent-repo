#!/usr/bin/env node
// Platform job: build a VALIDATION-ONLY candidate = current bucket content with exactly one change applied.
//   extension push: replace extensions/<name>/ and connectors/<name>-*.yaml with the bundle's
//   policy push:    replace config/grants.yaml and config/nav.yaml with the platform policy files
// The candidate is never uploaded wholesale; publish-content.sh uploads only the files the change owns.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { MARKER, publishedConnectors } from "./publish-marker.mjs";

const [baseArg, bundleArg, outputArg, policyArg] = process.argv.slice(2);
if (!baseArg || !bundleArg || !outputArg) {
  console.error("usage: node scripts/compose-candidate.mjs <current-content> <bundle|-> <empty-output> [platform-policy-dir (required with '-')]");
  process.exit(2);
}

function files(dir) { return fs.existsSync(dir) ? fs.readdirSync(dir) : []; }
function copy(from, to) {
  if (fs.existsSync(from)) fs.cpSync(from, to, { recursive: true, errorOnExist: true, force: false });
}
// A connector file belongs to the extension with the LONGEST matching "<name>-" prefix, so "team" never
// claims "team-demo-api.yaml" while an extension called "team-demo" exists.
function ownsConnector(file, name, others) {
  return file.startsWith(`${name}-`) && file.endsWith(".yaml")
    && !others.some((other) => other.startsWith(`${name}-`) && file.startsWith(`${other}-`));
}
function tree(dir) {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => !e.isDirectory());
}

try {
  const base = path.resolve(baseArg);
  const policyOnly = bundleArg === "-";
  const bundle = policyOnly ? null : path.resolve(bundleArg);
  const output = path.resolve(outputArg);
  if ([base, bundle].filter(Boolean).some((dir) => output === dir || output.startsWith(dir + path.sep))) throw new Error("output must be outside the inputs");
  if (fs.existsSync(output) && files(output).length) throw new Error("output must be empty");
  if (policyOnly && !policyArg) throw new Error("policy-only candidate needs the platform policy directory");
  if (!policyOnly && policyArg) throw new Error("an extension candidate never takes platform policy");
  const names = policyOnly ? [] : files(path.join(bundle, "extensions"));
  if (!policyOnly && (names.length !== 1 || !/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(names[0]))) throw new Error("bundle must contain exactly one extension");
  const name = names[0] || null;
  if (!policyOnly) {
    const manifest = YAML.parse(fs.readFileSync(path.join(bundle, "extensions", name, "extension.yaml"), "utf8"));
    if (manifest?.name !== name) throw new Error("bundle manifest name mismatch");
    for (const entry of tree(path.join(bundle, "extensions", name))) {
      if (entry.name === MARKER) throw new Error(`${MARKER} is reserved for the platform`);
      if (!entry.isFile()) throw new Error(`bundle may contain only regular files: ${entry.name}`);
    }
    const connectorNames = files(path.join(bundle, "connectors"));
    if (connectorNames.some((file) => !file.startsWith(`${name}-`) || !file.endsWith(".yaml"))) {
      throw new Error("bundle connectors must belong to this extension namespace");
    }
    if (files(bundle).some((entry) => !["extensions", "connectors"].includes(entry))) throw new Error("bundle may contain only extensions/ and connectors/");
  }
  for (const dir of ["extensions", "connectors", "config"]) {
    copy(path.join(base, dir), path.join(output, dir));
    fs.mkdirSync(path.join(output, dir), { recursive: true });
  }
  if (policyOnly) {
    for (const file of ["grants.yaml", "nav.yaml"]) {
      const source = path.join(path.resolve(policyArg), file);
      if (!fs.existsSync(source)) throw new Error(`platform policy missing: ${source}`);
      fs.copyFileSync(source, path.join(output, "config", file));
    }
  } else {
    const others = files(path.join(base, "extensions")).filter((other) => other !== name && !other.startsWith("."));
    const claimed = new Set(others.flatMap((other) => publishedConnectors(path.join(base, "extensions", other), other)));
    for (const file of files(path.join(bundle, "connectors"))) {
      if (!ownsConnector(file, name, others) || claimed.has(file)) throw new Error(`connector ${file} belongs to another extension's namespace`);
    }
    // Mirror publish-content.sh exactly: only connectors this extension's previous publish recorded are retired.
    for (const file of publishedConnectors(path.join(base, "extensions", name), name)) {
      fs.rmSync(path.join(output, "connectors", file), { force: true });
    }
    fs.rmSync(path.join(output, "extensions", name), { recursive: true, force: true });
    copy(path.join(bundle, "extensions", name), path.join(output, "extensions", name));
    for (const file of files(path.join(bundle, "connectors"))) copy(path.join(bundle, "connectors", file), path.join(output, "connectors", file));
  }
  console.log(`Composed validation candidate with ${name || "platform policy"}`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
