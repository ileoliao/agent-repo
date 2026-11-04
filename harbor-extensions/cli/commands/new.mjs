import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT, assertExtName, titleCaseKebab, copyDir, log, die, cliLabel } from "../lib.mjs";

function opt(args, flag) {
  const i = args.findIndex((a) => a === flag || a.startsWith(flag + "="));
  if (i < 0) return null;
  return args[i].includes("=") ? args[i].slice(flag.length + 1) : args[i + 1] ?? null;
}

const yamlStr = (s) => JSON.stringify(String(s)); // quoted scalar, safe for ':' '#'

export async function run(args) {
  const valueFlags = ["--owner", "--contact", "--description", "--title"];
  const positional = args.filter((a, i) => !a.startsWith("-") && !valueFlags.includes(args[i - 1]));
  const name = assertExtName(positional[0]);
  const dest = path.join(REPO_ROOT, "extensions", name);
  if (fs.existsSync(dest)) die(`extensions/${name} already exists; pick another name`);
  const template = path.join(REPO_ROOT, "templates", "extension-template");
  if (!fs.existsSync(template)) die("template missing at templates/extension-template");

  const title = opt(args, "--title") || titleCaseKebab(name);
  const owner = opt(args, "--owner");
  const contact = opt(args, "--contact");
  const description = opt(args, "--description");

  copyDir(template, dest);

  const yamlPath = path.join(dest, "extension.yaml");
  let yaml = fs.readFileSync(yamlPath, "utf8");
  const set = (key, val) => {
    yaml = yaml.replace(new RegExp(`^${key}:.*$`, "m"), `${key}: ${val}`);
  };
  set("name", name);
  set("title", yamlStr(title));
  if (description) set("description", yamlStr(description));
  if (owner) set("owner", yamlStr(owner));
  if (contact) set("contact", yamlStr(contact));
  fs.writeFileSync(yamlPath, yaml);

  for (const f of ["index.html", "README.md", "package.json", "app.js"]) {
    const p = path.join(dest, f);
    if (!fs.existsSync(p)) continue;
    let t = fs.readFileSync(p, "utf8");
    t = t.replaceAll("my-extension", name).replaceAll("My Extension", title);
    fs.writeFileSync(p, t);
  }

  const H = cliLabel();
  const todo = [];
  if (!owner) todo.push("owner");
  if (!contact) todo.push("contact");
  if (!description) todo.push("description");
  log(`Created extensions/${name}

Next
  1. Preview:   ${H} extension dev ${name}      (mock login, no cluster, no account needed)
  2. Edit:      extensions/${name}/  — any framework that builds to static files
${todo.length ? `  3. Fill in:   extensions/${name}/extension.yaml → ${todo.join(", ")}  (validate/publish refuse the template values)
` : ""}  ${todo.length ? "4" : "3"}. Check:     ${H} extension validate ${name}
  ${todo.length ? "5" : "4"}. Publish:   export HARBOR_URL=<portal URL> HARBOR_PAT=<token>; ${H} extension publish ${name}
Backend: host your own API and register it as a connector — see docs/extension-developer.md`);
  return 0;
}
