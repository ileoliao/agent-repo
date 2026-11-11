// Platform-owned publish marker written last into extensions/<name>/ by publish-content.sh.
import fs from "node:fs";
import path from "node:path";

export const MARKER = ".harbor-publish.json";

// Connectors an extension's last publish wrote, from its platform marker. Prefix matching alone cannot tell whether
// "team-demo-extra-api.yaml" belongs to team-demo or to a team-demo-extra that is being published concurrently.
export function publishedConnectors(extensionDir, name) {
  const marker = path.join(extensionDir, MARKER);
  if (!fs.existsSync(marker)) return [];
  const listed = JSON.parse(fs.readFileSync(marker, "utf8")).connectors ?? [];
  if (!Array.isArray(listed) || listed.some((file) => typeof file !== "string" || file.includes("/") || !file.startsWith(`${name}-`) || !file.endsWith(".yaml"))) {
    throw new Error(`${marker} lists connectors outside the ${name} namespace`);
  }
  return listed;
}
