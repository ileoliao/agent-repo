import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function die(msg, code = 1) {
  console.error(`Error: ${msg}`);
  process.exit(code);
}

export function log(msg) {
  console.log(msg);
}

export function assertExtName(name) {
  if (!name) die("missing extension name. Example: harbor extension new hello-world", 2);
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name)) {
    die(`'${name}' is not lowercase-kebab (start with a letter; digits and single dashes ok)`, 2);
  }
  return name;
}

export function titleCaseKebab(name) {
  return name.split("-").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

export function resolveExt(nameOrPath) {
  const dir = path.resolve(nameOrPath);
  const manifest = path.join(dir, "extension.yaml");
  if (!fs.existsSync(manifest)) die(`${manifest} not found; run this command from an extension repo`, 2);
  const name = assertExtName(YAML.parse(fs.readFileSync(manifest, "utf8"))?.name);
  return { name, dir };
}

export function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}
