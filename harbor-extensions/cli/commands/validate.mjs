import { resolveExt, log } from "../lib.mjs";
import { validateStandalone } from "../standalone.mjs";

export async function run(args) {
  const target = resolveExt(args.find((a) => !a.startsWith("-")) || ".");
  try {
    validateStandalone(target.dir);
    log("Extension valid (local, dev, prod)");
    return 0;
  } catch (error) {
    console.error(`Invalid extension: ${error.message}`);
    return 1;
  }
}
