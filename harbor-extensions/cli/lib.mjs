import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** harbor-extensions repo root (parent of cli/) */
export const REPO_ROOT = path.resolve(__dirname, "..");

export function die(msg, code = 1) {
  console.error(`Error: ${msg}`);
  process.exit(code);
}

export function log(msg) {
  console.log(msg);
}

/** lowercase-kebab: hello-world */
export function assertExtName(name) {
  if (!name) die("missing extension name. Example: harbor extension new hello-world", 2);
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name)) {
    die(`'${name}' is not lowercase-kebab (start with a letter; digits and single dashes ok)`, 2);
  }
  return name;
}

export function titleCaseKebab(name) {
  return name
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function extDir(name) {
  return path.join(REPO_ROOT, "extensions", name);
}

export function resolveExt(nameOrPath) {
  const direct = nameOrPath === "." ? process.cwd() : path.resolve(nameOrPath);
  const standalone = fs.existsSync(path.join(direct, "extension.yaml"));
  const manifestName = standalone ? YAML.parse(fs.readFileSync(path.join(direct, "extension.yaml"), "utf8"))?.name : null;
  const name = assertExtName(standalone ? manifestName :
    nameOrPath.includes("/") || nameOrPath.includes("\\")
      ? path.basename(direct)
      : nameOrPath);
  const dir = standalone ? direct : extDir(name);
  if (!fs.existsSync(dir)) die(`extensions/${name} not found. Create it with: harbor extension new ${name}`);
  if (!fs.existsSync(path.join(dir, "extension.yaml"))) {
    die(`extensions/${name}/extension.yaml missing`);
  }
  return { name, dir, standalone: standalone && !dir.startsWith(path.join(REPO_ROOT, "extensions") + path.sep) };
}

export function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    if (ent.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

export function walkFiles(dir, base = dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name === ".git") continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(full, base, out);
    else out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out;
}

/** How to re-invoke this CLI in printed hints (checkout vs global `harbor`). */
export function cliLabel() {
  const argv1 = process.argv[1] || "";
  if (argv1.includes(`${path.sep}cli${path.sep}`) || argv1.endsWith("harbor.mjs")) {
    return "node cli/harbor.mjs";
  }
  return "harbor";
}
