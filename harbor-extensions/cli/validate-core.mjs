/**
 * Node-only extension validation (no Python, no cluster, no network).
 * Mirrors the platform's rules in backend/harbor_platform/{extensions,lint}.py so that
 * `harbor extension validate` / `publish` give the same answer a reviewer would.
 */
import fs from "node:fs";
import path from "node:path";

const NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const TIERS = ["experimental", "community", "official"];
const ALLOWED_FIELDS = ["name", "title", "description", "owner", "contact", "tier", "visibility", "capabilities", "entry", "nav"];
const CODE_SUFFIXES = [".js", ".mjs", ".html", ".htm"];
const HTML = [".html", ".htm"];
const JS = [".js", ".mjs"];

/** Minimal parser for the flat extension.yaml shape (scalars, [inline, lists], "- block lists", nested blocks ignored). */
export function parseManifest(text) {
  const out = {};
  const lines = text.split(/\r?\n/);
  const clean = (s) => {
    let q = null;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) { if (c === q) q = null; } else if (c === '"' || c === "'") q = c;
      else if (c === "#" && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
    }
    return s;
  };
  const scalar = (v) => v.trim().replace(/^(["'])(.*)\1$/, "$2");
  for (let i = 0; i < lines.length; i++) {
    const line = clean(lines[i]);
    const m = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!m) continue;
    const [, key, rest] = m;
    const v = rest.trim();
    if (v.startsWith("[")) {
      out[key] = v.replace(/^\[|\]$/g, "").split(",").map(scalar).filter(Boolean);
    } else if (v === "") {
      const items = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const l = clean(lines[j]);
        if (!l.trim()) continue;
        const li = l.match(/^\s+-\s+(.*)$/);
        if (li) items.push(scalar(li[1]));
        else if (/^\s/.test(l)) continue; // nested mapping (nav:) — not needed here
        else break;
      }
      out[key] = items.length ? items : null;
    } else out[key] = scalar(v);
  }
  return out;
}

const PLACEHOLDER = {
  owner: (v) => !v || /^team-xxx$/i.test(v),
  contact: (v) => !v || /^you@example\.com$/i.test(v) || /^team-xxx(@|$)/i.test(v) || /@example\.invalid$/i.test(v),
  description: (v) => !v || /^one sentence on/i.test(v),
  title: (v) => !v || /^my extension$/i.test(v),
};

const ERROR_RULES = [
  [/type\s*=\s*["']?password/i, "Do not collect passwords: extensions inherit the portal login and must not implement their own", CODE_SUFFIXES],
  [/\bfetch\s*\(/, "Do not use fetch(): extensions have no network access; call your backend with harbor.connector(...)", CODE_SUFFIXES],
  [/\bXMLHttpRequest\b/, "Do not use XMLHttpRequest: use harbor.connector(...)", CODE_SUFFIXES],
  [/\b(WebSocket|EventSource)\s*\(/, "Do not open connections directly: extensions have no network access", CODE_SUFFIXES],
  [/\bsendBeacon\s*\(/, "Do not use sendBeacon: extensions have no network access", CODE_SUFFIXES],
  [/\b(localStorage|sessionStorage|indexedDB)\b/, "No browser storage in the sandbox: keep state in your own service and use connectors", CODE_SUFFIXES],
  [/\bdocument\.cookie\b/, "Extensions cannot read cookies; identity comes from harbor.me()", CODE_SUFFIXES],
  [/<script\b(?![^>]*\bsrc\s*=)[^>]*>/i, "No inline scripts: CSP only allows same-origin .js files", HTML],
  [/<[a-z][^>]*\son[a-z]+\s*=/i, "No inline event handlers (onclick=...): use addEventListener in a .js file", HTML],
  [/<(script|link|img|iframe)\b[^>]*\b(src|href)\s*=\s*["']?(https?:)?\/\//i, "No external resources: only files in this folder and ../../sdk/ may be referenced", HTML],
  [/<(script|link|img)\b[^>]*\b(src|href)\s*=\s*["']?\/(?!\/)/i, "Use relative paths (./app.js, ../../sdk/harbor.js). Absolute paths break under the portal's /extensions prefix (Vite: set base: './')", HTML],
  [/\bimport\b[^;]*?["'](https?:)?\/\//, "Do not import modules from an external address", JS],
];
const REVIEW_RULES = [
  [/\.(innerHTML|outerHTML)\s*\+?=|\binsertAdjacentHTML\s*\(|\bdocument\.write\s*\(/, "Uses an HTML injection API (innerHTML…): platform reviewers will check untrusted data is not rendered as HTML", CODE_SUFFIXES],
];

function stripJsComments(t) {
  t = t.replace(/\/\*[\s\S]*?\*\//g, (m) => "\n".repeat((m.match(/\n/g) || []).length));
  return t.replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");
}

function* codeFiles(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name === ".git") continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) yield* codeFiles(full);
    else if (CODE_SUFFIXES.includes(path.extname(ent.name).toLowerCase())) yield full;
  }
}

/** @returns {{errors:string[], notes:string[]}} */
export function validateExtension(dir, { repoRoot } = {}) {
  const errors = [];
  const notes = [];
  const name = path.basename(dir);
  const yamlPath = path.join(dir, "extension.yaml");
  const at = `extensions/${name}/extension.yaml`;
  if (!fs.existsSync(yamlPath)) return { errors: [`${at}: file missing`], notes };
  const m = parseManifest(fs.readFileSync(yamlPath, "utf8"));

  for (const k of Object.keys(m)) if (!ALLOWED_FIELDS.includes(k)) errors.push(`${at}: unknown field '${k}' (allowed: ${ALLOWED_FIELDS.join(", ")})`);
  if (!m.name) errors.push(`${at}: missing name`);
  else if (!NAME_RE.test(m.name)) errors.push(`${at}: name '${m.name}' must be lowercase letters, digits and single dashes`);
  else if (m.name !== name) errors.push(`${at}: name '${m.name}' must match the folder name '${name}'`);

  for (const k of ["title", "owner", "contact", "description"]) {
    if (PLACEHOLDER[k](m[k])) errors.push(`${at}: '${k}' is empty or still the template placeholder${m[k] ? ` ("${m[k]}")` : ""} — set a real value`);
  }
  if (m.tier && !TIERS.includes(m.tier)) errors.push(`${at}: tier must be one of ${TIERS.join(", ")}`);
  if (!Array.isArray(m.visibility) || !m.visibility.length) errors.push(`${at}: visibility must list at least one group, e.g. [APP-DEV-ALL]`);
  const caps = Array.isArray(m.capabilities) ? m.capabilities : [];
  for (const c of caps) {
    if (!/^[a-z][a-z0-9-]*\.[A-Za-z0-9_.-]+$/.test(c)) errors.push(`${at}: capability '${c}' must look like <connector>.<capability>`);
    else if (repoRoot && !fs.existsSync(path.join(repoRoot, "connectors", `${c.split(".")[0]}.yaml`))) {
      notes.push(`capability '${c}': connector '${c.split(".")[0]}' is not registered in this checkout yet (ask the platform team to register it)`);
    }
  }
  if (caps.length) notes.push("requests capabilities: write capabilities and non-internal data classes need platform-team approval");

  const entry = m.entry || "index.html";
  const entryPath = path.resolve(dir, entry);
  if (!entryPath.startsWith(path.resolve(dir) + path.sep) || !fs.existsSync(entryPath)) {
    errors.push(`extensions/${name}/${entry}: entry file missing (build output must contain it)`);
  } else if (/<h1>\s*my extension\s*<\/h1>/i.test(fs.readFileSync(entryPath, "utf8"))) {
    errors.push(`extensions/${name}/${entry}: still has the template heading "My Extension" — edit the page`);
  }

  for (const file of codeFiles(dir)) {
    const ext = path.extname(file).toLowerCase();
    let text = fs.readFileSync(file, "utf8");
    text = JS.includes(ext) ? stripJsComments(text) : text.replace(/<!--[\s\S]*?-->/g, (x) => "\n".repeat((x.match(/\n/g) || []).length));
    const rel = `extensions/${name}/${path.relative(dir, file).split(path.sep).join("/")}`;
    for (const [rules, bucket] of [[ERROR_RULES, errors], [REVIEW_RULES, notes]]) {
      for (const [re, msg, suffixes] of rules) {
        if (!suffixes.includes(ext)) continue;
        const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
        let hit;
        while ((hit = g.exec(text))) {
          const line = text.slice(0, hit.index).split("\n").length;
          bucket.push(`${rel}:${line}: ${msg}`);
        }
      }
    }
  }
  return { errors, notes };
}
