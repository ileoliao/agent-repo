import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT, assertExtName, titleCaseKebab, extDir, copyDir, log, die, cliLabel } from "../lib.mjs";

export async function run(args) {
  const name = assertExtName(args[0]);
  const dest = path.join(REPO_ROOT, "extensions", name);
  if (fs.existsSync(dest)) die(`extensions/${name} already exists; pick another name`);

  const template = path.join(REPO_ROOT, "templates", "extension-template");
  if (!fs.existsSync(template)) die(`template missing at templates/extension-template`);

  copyDir(template, dest);

  const title = titleCaseKebab(name);
  const yamlPath = path.join(dest, "extension.yaml");
  let yaml = fs.readFileSync(yamlPath, "utf8");
  yaml = yaml
    .replace(/^name:\s*.*$/m, `name: ${name}`)
    .replace(/^title:\s*.*$/m, `title: ${title}`);
  fs.writeFileSync(yamlPath, yaml);

  for (const f of ["index.html", "README.md", "package.json"]) {
    const p = path.join(dest, f);
    if (!fs.existsSync(p)) continue;
    let t = fs.readFileSync(p, "utf8");
    t = t.replaceAll("my-extension", name).replaceAll("My Extension", title);
    fs.writeFileSync(p, t);
  }

  // Keep a tiny package.json for local npm run dev convenience (calls harbor)
  const pkgPath = path.join(dest, "package.json");
  if (!fs.existsSync(pkgPath)) {
    fs.writeFileSync(
      pkgPath,
      JSON.stringify(
        {
          name: `harbor-extension-${name}`,
          private: true,
          scripts: {
            dev: `node ../../cli/harbor.mjs extension dev ${name}`,
            publish: `node ../../cli/harbor.mjs extension publish ${name}`,
          },
        },
        null,
        2
      ) + "\n"
    );
  }

  const H = cliLabel();
  log(`Created extensions/${name}
  Edit UI:   extensions/${name}/ (any frontend stack that builds to static files)
  Local:     ${H} extension dev ${name}
  Check:     ${H} extension validate ${name}
  Publish:   ${H} extension publish ${name} --dry-run
  Backend:   self-host your API, then register a connector (see docs/extension-developer.md)
  Tip:       if \`harbor\` is not on PATH yet, use: node cli/harbor.mjs …`);
  return 0;
}
