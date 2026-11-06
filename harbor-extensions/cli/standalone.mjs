import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { validateExtension } from "./validate-core.mjs";

const NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const CONNECTOR_NAME = /^[a-z][a-z0-9-]{1,40}$/;
const CAP_KEY = /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)*$/;
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

function readYaml(file) {
  if (!fs.existsSync(file)) throw new Error(`${file}: missing`);
  const value = YAML.parse(fs.readFileSync(file, "utf8"), { uniqueKeys: true });
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${file}: expected a mapping`);
  return value;
}

function upstreams(repo, environment, names) {
  const data = readYaml(path.join(repo, "env", `${environment}.yaml`));
  const gateway = data.gateway;
  if (gateway != null && environment !== "local") throw new Error(`env/${environment}.yaml: gateway is only for local preview`);
  if (gateway != null && (gateway !== "dev" || data.upstreams != null)) throw new Error("env/local.yaml: use gateway: dev or upstreams");
  const map = data.upstreams || {};
  if (typeof map !== "object" || Array.isArray(map)) throw new Error(`env/${environment}.yaml: upstreams mapping required`);
  if (!gateway) for (const name of names) if (map[name] == null) throw new Error(`env/${environment}.yaml: missing upstream for ${name}`);
  for (const name of Object.keys(map)) if (!names.has(name)) throw new Error(`env/${environment}.yaml: unknown connector ${name}`);
  if (environment === "local" && !gateway && !names.size) throw new Error("env/local.yaml: add an upstream or Dev gateway");
  for (const [name, value] of Object.entries(map)) {
    if (typeof value !== "string") throw new Error(`env/${environment}.yaml: ${name} needs a URL`);
    let url;
    try { url = new URL(value); } catch { throw new Error(`env/${environment}.yaml: invalid URL for ${name}`); }
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
      throw new Error(`env/${environment}.yaml: ${name} must be an http(s) URL without credentials or query`);
    }
    if (environment === "local" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && url.protocol !== "https:") {
      throw new Error(`env/local.yaml: remote ${name} must use HTTPS`);
    }
  }
  return { map, gateway: gateway || null };
}

export function inspectStandalone(repo, environment = "local") {
  repo = path.resolve(repo);
  const manifest = readYaml(path.join(repo, "extension.yaml"));
  if (!NAME.test(manifest.name || "")) throw new Error("extension.yaml: invalid name");
  const web = path.join(repo, "web");
  if (!fs.existsSync(web) || fs.lstatSync(web).isSymbolicLink() || !fs.statSync(web).isDirectory()) throw new Error("web/: real static UI directory required");
  const check = validateExtension(repo, { name: manifest.name, contentDir: web });
  if (check.errors.length) throw new Error(check.errors.join("\n"));
  const dir = path.join(repo, "connectors");
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort() : [];
  const names = new Set(files.map((f) => path.basename(f, ".yaml")));
  const { map: addresses, gateway } = upstreams(repo, environment, names);
  const connectors = new Map();
  for (const file of files) {
    const raw = readYaml(path.join(dir, file));
    const name = path.basename(file, ".yaml");
    if (raw.name !== name || !CONNECTOR_NAME.test(name)) throw new Error(`${file}: connector name must match filename`);
    if (!name.startsWith(`${manifest.name}-`)) throw new Error(`${file}: connector name must start with ${manifest.name}-`);
    if (!raw.owner || !raw.capabilities || typeof raw.capabilities !== "object") throw new Error(`${file}: owner and capabilities are required`);
    const auth = raw.auth || {};
    if (!["identity-only", "service-account"].includes(auth.type || "service-account")) throw new Error(`${file}: invalid auth.type`);
    if ((auth.type || "service-account") === "service-account" && !auth.secret) throw new Error(`${file}: service-account auth needs a secret name`);
    const capabilities = new Map();
    for (const [key, cap] of Object.entries(raw.capabilities)) {
      if (!CAP_KEY.test(key) || !cap || !Array.isArray(cap.allow) || !cap.allow.length || !Array.isArray(cap.groups) || !cap.groups.length || !cap.groups.every((g) => typeof g === "string" && g)) {
        throw new Error(`${file}: ${key} needs allow routes and groups`);
      }
      if (!["internal", "confidential", "customer"].includes(cap.data_class || "internal")) throw new Error(`${file}: ${key} has invalid data_class`);
      const rules = cap.allow.map((rule) => {
        const match = typeof rule === "string" && rule.match(/^(GET|POST|PUT|PATCH|DELETE) (\/[^\s]*)$/);
        if (!match || !METHODS.has(match[1])) throw new Error(`${file}: invalid allow rule ${rule}`);
        if (match[2].split("/").includes("..")) throw new Error(`${file}: allow route contains ..`);
        if (match[1] !== "GET" && cap.write !== true) throw new Error(`${file}: ${key} has a write method but write is not true`);
        const escape = (part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const regex = new RegExp(`^${match[2].split("**").map((part) => part.split("*").map(escape).join("[^/]+")).join(".*")}$`);
        return { method: match[1], regex };
      });
      capabilities.set(key, { ...cap, rules });
    }
    connectors.set(name, { ...raw, via: gateway ? "gateway" : "direct", upstream: gateway ? null : addresses[name].replace(/\/$/, ""), capabilities });
  }
  for (const id of manifest.capabilities || []) {
    const [name, ...rest] = String(id).split(".");
    if (connectors.has(name) && !connectors.get(name).capabilities.has(rest.join("."))) throw new Error(`extension.yaml: capability ${id} is not defined by this repository`);
    if (!connectors.has(name) && name.startsWith(`${manifest.name}-`)) throw new Error(`extension.yaml: own connector ${name} is missing`);
    if (environment === "local" && !connectors.has(name) && !gateway) throw new Error(`env/local.yaml: use a Dev gateway to access existing connector ${name}`);
  }
  return { repo, manifest, connectors, gateway, notes: check.notes };
}

export function validateStandalone(repo) {
  for (const environment of ["local", "dev", "prod"]) inspectStandalone(repo, environment);
}

export function bundleStandalone(repo, environment, output) {
  if (!["dev", "prod"].includes(environment)) throw new Error("bundle environment must be dev or prod");
  validateStandalone(repo);
  const { manifest, connectors } = inspectStandalone(repo, environment);
  output = path.resolve(output);
  if (output === path.resolve(repo) || output.startsWith(path.resolve(repo) + path.sep)) throw new Error("bundle output must be outside the extension repo");
  if (fs.existsSync(output) && fs.readdirSync(output).length) throw new Error("bundle output must be empty");
  const dest = path.join(output, "extensions", manifest.name);
  fs.mkdirSync(dest, { recursive: true });
  let total = 0;
  function copy(from, relative = "") {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) throw new Error(`hidden file cannot be published: ${path.join(relative, entry.name)}`);
      const rel = path.join(relative, entry.name);
      const source = path.join(from, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`symlink cannot be published: ${rel}`);
      if (entry.isDirectory()) { copy(source, rel); continue; }
      if (/\.(pem|key|p12|pfx)$/i.test(entry.name)) throw new Error(`key file cannot be published: ${rel}`);
      total += fs.statSync(source).size;
      if (total > 25 * 1024 * 1024) throw new Error("extension package exceeds 25 MB");
      const target = path.join(dest, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    }
  }
  copy(path.join(repo, "web"));
  fs.copyFileSync(path.join(repo, "extension.yaml"), path.join(dest, "extension.yaml"));
  if (!fs.existsSync(path.join(dest, manifest.entry || "index.html"))) throw new Error("entry file was not included in bundle");
  for (const [name, connector] of connectors) {
    const raw = readYaml(path.join(repo, "connectors", `${name}.yaml`));
    raw.upstream = connector.upstream;
    const target = path.join(output, "connectors", `${name}.yaml`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, YAML.stringify(raw));
  }
  return manifest.name;
}

export function allowedCapability(project, connectorName, method, requestPath) {
  const connector = project.connectors.get(connectorName);
  if (!connector) return null;
  for (const [key, cap] of connector.capabilities) {
    if (cap.rules.some((rule) => rule.method === method && rule.regex.test(requestPath))) {
      const id = `${connectorName}.${key}`;
      return project.manifest.capabilities?.includes(id) ? { id, cap, connector } : null;
    }
  }
  return null;
}
