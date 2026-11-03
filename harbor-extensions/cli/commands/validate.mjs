import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { REPO_ROOT, log, die } from "../lib.mjs";

export async function run(args) {
  const only = args.find((a) => !a.startsWith("-"));
  const extRoot = path.join(REPO_ROOT, "extensions");
  const names = only
    ? [only]
    : fs.readdirSync(extRoot).filter((n) => fs.existsSync(path.join(extRoot, n, "extension.yaml")));

  let errors = 0;
  for (const name of names) {
    const dir = path.join(extRoot, name);
    const yaml = path.join(dir, "extension.yaml");
    if (!fs.existsSync(yaml)) {
      log(`FAIL ${name}: missing extension.yaml`);
      errors++;
      continue;
    }
    const text = fs.readFileSync(yaml, "utf8");
    if (!/^name:\s*\S+/m.test(text)) {
      log(`FAIL ${name}: extension.yaml missing name:`);
      errors++;
    } else {
      const m = text.match(/^name:\s*(\S+)/m);
      if (m && m[1] !== name) {
        log(`FAIL ${name}: name '${m[1]}' must match directory`);
        errors++;
      }
    }
    if (!fs.existsSync(path.join(dir, "index.html"))) {
      log(`FAIL ${name}: missing index.html (entry UI)`);
      errors++;
    } else {
      log(`OK   ${name}: structure`);
    }
  }

  // Prefer platform Python validator when available (full lint rules).
  const py = process.env.PYTHON || "python3";
  const validatePy = path.join(REPO_ROOT, "backend", "harbor_platform", "validate.py");
  if (fs.existsSync(validatePy)) {
    const r = spawnSync(py, ["-m", "harbor_platform.validate"], {
      cwd: path.join(REPO_ROOT, "backend"),
      encoding: "utf8",
      env: process.env,
    });
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    // exit 2 = needs review — still success for local DX
    if (r.status === 1) {
      log("Python validate reported errors.");
      return 1;
    }
    if (r.error) {
      log(`(optional python validate skipped: ${r.error.message})`);
    } else {
      log(`python validate exit ${r.status}`);
    }
  }

  if (errors) die(`${errors} extension(s) failed structural checks`);
  log("validate PASS");
  return 0;
}
