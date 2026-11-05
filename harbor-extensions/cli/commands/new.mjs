import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT, assertExtName, titleCaseKebab, copyDir, log, die } from "../lib.mjs";

function opt(args, flag) {
  const i = args.findIndex((a) => a === flag || a.startsWith(flag + "="));
  if (i < 0) return null;
  return args[i].includes("=") ? args[i].slice(flag.length + 1) : args[i + 1] ?? null;
}

const yamlStr = (s) => JSON.stringify(String(s));

export async function run(args) {
  const valueFlags = ["--owner", "--contact", "--description", "--title"];
  const positional = args.filter((a, i) => !a.startsWith("-") && !valueFlags.includes(args[i - 1]));
  const name = assertExtName(positional[0]);
  const dest = path.resolve(name);
  if (dest === REPO_ROOT || dest.startsWith(REPO_ROOT + path.sep)) die("create extension repositories outside the platform checkout", 2);
  if (fs.existsSync(dest)) die(`${dest} already exists; pick another name`);
  const template = path.join(REPO_ROOT, "templates", "extension");
  if (!fs.existsSync(template)) die("template missing at templates/extension");

  const title = opt(args, "--title") || titleCaseKebab(name);
  const owner = opt(args, "--owner");
  const contact = opt(args, "--contact");
  const description = opt(args, "--description");
  copyDir(template, dest);

  const yamlPath = path.join(dest, "extension.yaml");
  let yaml = fs.readFileSync(yamlPath, "utf8");
  for (const [key, value] of Object.entries({ name, title, ...(owner && { owner }), ...(contact && { contact }), ...(description && { description }) })) {
    yaml = yaml.replace(new RegExp(`^${key}:.*$`, "m"), `${key}: ${yamlStr(value)}`);
  }
  fs.writeFileSync(yamlPath, yaml);

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
  for (const rel of ["web/index.html", "README.md", "web/app.js"]) {
    const file = path.join(dest, rel);
    if (!fs.existsSync(file)) continue;
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replaceAll("my-extension", name).replaceAll("My Extension", title));
  }

  const cli = process.argv[1]?.endsWith("/cli/harbor.mjs") ? `node ${process.argv[1]}` : "harbor";
  const missing = [!owner && "owner", !contact && "contact", !description && "description"].filter(Boolean);
  log(`Created ${dest}

Next
  1. Edit:      ${dest}/
  2. Check:     ${cli} extension validate ${dest}
  3. Preview:   ${cli} extension dev ${dest}
  4. Release:   Create a dedicated GitHub repo with dev/prod branches; ask platform to connect Jenkins${missing.length ? `\n  Fill in:      extension.yaml → ${missing.join(", ")}` : ""}`);
  return 0;
}
