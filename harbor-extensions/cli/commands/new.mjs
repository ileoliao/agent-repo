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
  const standalone = args.includes("--standalone");
  const valueFlags = ["--owner", "--contact", "--description", "--title"];
  const positional = args.filter((a, i) => !a.startsWith("-") && !valueFlags.includes(args[i - 1]));
  const name = assertExtName(positional[0]);
  const dest = standalone ? path.resolve(name) : path.join(REPO_ROOT, "extensions", name);
  if (fs.existsSync(dest)) die(`${dest} already exists; pick another name`);
  const template = path.join(REPO_ROOT, "templates", standalone ? "standalone-extension" : "extension-template");
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

  if (standalone) {
    const connectorName = `${name}-api`;
    const source = path.join(dest, "connectors", "my-extension-api.yaml");
    const target = path.join(dest, "connectors", `${connectorName}.yaml`);
    let connector = fs.readFileSync(source, "utf8").replaceAll("my-extension-api", connectorName);
    if (owner) connector = connector.replace("owner: team-xxx", `owner: ${yamlStr(owner)}`);
    fs.writeFileSync(target, connector);
    fs.unlinkSync(source);
    for (const rel of ["extension.yaml", "web/app.js", "env/local.yaml", "env/dev.yaml", "env/prod.yaml"]) {
      const file = path.join(dest, rel);
      fs.writeFileSync(file, fs.readFileSync(file, "utf8").replaceAll("my-extension-api", connectorName));
    }
  }

  for (const f of [standalone ? "web/index.html" : "index.html", "README.md", "package.json", standalone ? "web/app.js" : "app.js"]) {
    const p = path.join(dest, f);
    if (!fs.existsSync(p)) continue;
    let t = fs.readFileSync(p, "utf8");
    t = t.replaceAll("my-extension", name).replaceAll("My Extension", title);
    fs.writeFileSync(p, t);
  }

  const H = standalone && process.argv[1]?.endsWith("/cli/harbor.mjs")
    ? `node ${process.argv[1]}` : cliLabel();
  const todo = [];
  if (!owner) todo.push("owner");
  if (!contact) todo.push("contact");
  if (!description) todo.push("description");
  log(`Created ${standalone ? dest : `extensions/${name}`}

Next
  1. Preview:   ${H} extension dev ${standalone ? dest : name}
  2. Edit:      ${dest}/
${todo.length ? `  3. Fill in:   extension.yaml → ${todo.join(", ")}
` : ""}  ${todo.length ? "4" : "3"}. Check:     ${H} extension validate ${standalone ? dest : name}
  ${todo.length ? "5" : "4"}. Next:      ${standalone ? "Create a dedicated GitHub repo with dev/prod branches; ask platform to connect GitOps" : "Commit and push this sample through the GitHub content pipeline"}`);
  return 0;
}
