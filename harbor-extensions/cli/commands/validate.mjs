import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { REPO_ROOT, resolveExt, log, die } from "../lib.mjs";
import { validateExtension } from "../validate-core.mjs";

/** Shared by `validate` and `publish`. Returns { errors, notes } and prints a readable report. */
export function checkExtension(name, dir, { quiet = false } = {}) {
  const { errors, notes } = validateExtension(dir, { repoRoot: REPO_ROOT });
  if (!quiet) {
    for (const e of errors) log(`  ✗ ${e}`);
    for (const n of notes) log(`  • note: ${n}`);
  }
  return { errors, notes };
}

export async function run(args) {
  const verbose = args.includes("--verbose") || args.includes("-v");
  const only = args.find((a) => !a.startsWith("-"));
  const extRoot = path.join(REPO_ROOT, "extensions");
  const names = only
    ? [resolveExt(only).name]
    : fs.existsSync(extRoot)
      ? fs.readdirSync(extRoot).filter((n) => fs.existsSync(path.join(extRoot, n, "extension.yaml")))
      : [];
  if (!names.length) die("no extensions found under extensions/. Create one with: harbor extension new <name>");

  let failed = 0;
  for (const name of names) {
    const { errors, notes } = checkExtension(name, path.join(extRoot, name), { quiet: false });
    if (errors.length) {
      failed++;
      log(`FAIL ${name}: ${errors.length} problem(s) — fix the lines marked ✗ above`);
    } else {
      log(`PASS ${name}${notes.length ? ` (${notes.length} note(s) for reviewers)` : ""}`);
    }
  }

  // Optional: the platform's own Python lint (same rules CI runs). Only with --python.
  if (args.includes("--python") && !failed) {
    const r = spawnSync(process.env.PYTHON || "python3", ["-m", "harbor_platform.validate"], {
      cwd: path.join(REPO_ROOT, "backend"),
      encoding: "utf8",
    });
    if (r.error) log(`(python lint skipped: ${r.error.message})`);
    else {
      if (verbose || r.status === 1) process.stdout.write(r.stdout || "");
      if (r.stderr && (verbose || r.status === 1)) process.stderr.write(r.stderr);
      if (r.status === 1) return 1;
      if (r.status === 2) log("python lint: valid, but needs platform-team review before merge");
    }
  }

  if (failed) {
    log(`\n${failed} of ${names.length} extension(s) failed.`);
    return 1;
  }
  log(`\nvalidate OK (${names.length} extension${names.length > 1 ? "s" : ""}).`);
  return 0;
}
