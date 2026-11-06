#!/usr/bin/env node
// Platform job: form a complete immutable content snapshot from the previous release and one extension bundle.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

const [baseArg, bundleArg, outputArg, releaseId, policyArg] = process.argv.slice(2);
if (!baseArg || !bundleArg || !outputArg || !/^[a-f0-9]{40}$/.test(releaseId || "")) {
  console.error("usage: node scripts/compose-release.mjs <previous-content> <bundle> <empty-output> <40-char-git-sha> [platform-config-dir]");
  process.exit(2);
}

function files(dir) { return fs.existsSync(dir) ? fs.readdirSync(dir) : []; }
function copy(from, to) {
  if (fs.existsSync(from)) fs.cpSync(from, to, { recursive: true, errorOnExist: true, force: false });
}

try {
  const base = path.resolve(baseArg);
  const policyOnly = bundleArg === "-";
  const bundle = policyOnly ? null : path.resolve(bundleArg);
  const output = path.resolve(outputArg);
  if ([base, bundle].filter(Boolean).some((dir) => output === dir || output.startsWith(dir + path.sep))) throw new Error("output must be outside the inputs");
  if (fs.existsSync(output) && files(output).length) throw new Error("output must be empty");
  const names = policyOnly ? [] : files(path.join(bundle, "extensions"));
  if (!policyOnly && (names.length !== 1 || !/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(names[0]))) throw new Error("bundle must contain exactly one extension");
  if (policyOnly && !policyArg) throw new Error("policy-only release needs platform config");
  const name = names[0] || null;
  const manifest = policyOnly ? null : YAML.parse(fs.readFileSync(path.join(bundle, "extensions", name, "extension.yaml"), "utf8"));
  if (!policyOnly && manifest?.name !== name) throw new Error("bundle manifest name mismatch");
  const connectorNames = policyOnly ? [] : files(path.join(bundle, "connectors"));
  if (!policyOnly && connectorNames.some((file) => !file.startsWith(`${name}-`) || !file.endsWith(".yaml"))) {
    throw new Error("bundle connectors must belong to this extension namespace");
  }
  fs.mkdirSync(output, { recursive: true });
  for (const dir of ["extensions", "connectors", "config"]) copy(path.join(base, dir), path.join(output, dir));
  fs.mkdirSync(path.join(output, "extensions"), { recursive: true });
  fs.mkdirSync(path.join(output, "connectors"), { recursive: true });
  fs.mkdirSync(path.join(output, "config"), { recursive: true });
  if (policyArg) {
    for (const file of ["grants.yaml", "nav.yaml"]) {
      const source = path.join(path.resolve(policyArg), file);
      if (!fs.existsSync(source)) throw new Error(`platform policy missing: ${source}`);
      fs.copyFileSync(source, path.join(output, "config", file));
    }
  }
  if (!policyOnly) {
    fs.rmSync(path.join(output, "extensions", name), { recursive: true, force: true });
    for (const file of files(path.join(output, "connectors"))) {
      if (file.startsWith(`${name}-`) && file.endsWith(".yaml")) fs.rmSync(path.join(output, "connectors", file));
    }
    copy(path.join(bundle, "extensions", name), path.join(output, "extensions", name));
    for (const file of connectorNames) copy(path.join(bundle, "connectors", file), path.join(output, "connectors", file));
  }
  for (const dir of ["extensions", "connectors"]) {
    const target = path.join(output, dir);
    if (!files(target).length) fs.writeFileSync(path.join(target, ".keep"), "");
  }
  fs.writeFileSync(path.join(output, "config", "release.json"), JSON.stringify({ id: releaseId, extension: name || "platform-policy" }) + "\n");
  console.log(`Composed release ${releaseId} with ${name || "platform policy"}`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
