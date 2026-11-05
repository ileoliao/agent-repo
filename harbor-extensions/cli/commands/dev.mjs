import { resolveExt, die } from "../lib.mjs";
import { runStandaloneDev } from "../local-dev.mjs";

export async function run(args) {
  const nameArg = args.find((a, i) => !a.startsWith("-") && args[i - 1] !== "--port" && args[i - 1] !== "-p") || ".";
  let port = Number(process.env.PORT || 5173);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--port=")) port = Number(a.slice("--port=".length));
    else if (a === "--port" || a === "-p") port = Number(args[++i]);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) die("invalid --port", 2);
  return runStandaloneDev(resolveExt(nameArg), port);
}
