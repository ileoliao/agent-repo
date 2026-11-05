#!/usr/bin/env node
// CI adapter: Jenkins supplies the verified GitHub push ref and commit.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { bundleStandalone } from "../cli/standalone.mjs";

const [repoArg, environment, outputArg] = process.argv.slice(2);
if (!repoArg || !outputArg || !["dev", "prod"].includes(environment)) {
  console.error("usage: node scripts/gitops-bundle.mjs <extension-repo> <dev|prod> <empty-output-dir>");
  process.exit(2);
}
const repo = path.resolve(repoArg);
try {
  const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const branch = execFileSync("git", ["-C", repo, "branch", "--show-current"], { encoding: "utf8" }).trim();
  if (process.env.HARBOR_CI === "jenkins") {
    if (process.env.HARBOR_SOURCE_EVENT !== "push" || process.env.HARBOR_SOURCE_REF !== `refs/heads/${environment}` || process.env.HARBOR_SOURCE_SHA !== head) {
      throw new Error(`Jenkins push ref and checkout commit must match ${environment}`);
    }
  } else if (branch !== environment) {
    throw new Error(`checked-out branch ${branch || "(detached)"} cannot render ${environment}`);
  }
  const name = bundleStandalone(repo, environment, outputArg);
  console.log(`Bundled ${name} from ${environment}@${head.slice(0, 12)}: ${path.resolve(outputArg)}`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
