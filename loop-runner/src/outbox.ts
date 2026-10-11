import * as fs from 'fs';
import * as path from 'path';

/**
 * Newest file under .loop/outbox (the drafts and reports agents write there), or undefined when there is none.
 * The runtime does not track outputs, so "newest by mtime" is the only signal available.
 */
export function latestOutput(root: string): string | undefined {
  let best: { file: string; mtime: number } | undefined;
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) { return; }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(file); continue; }
      const mtime = fs.statSync(file).mtimeMs;
      if (!best || mtime > best.mtime) { best = { file, mtime }; }
    }
  };
  walk(path.join(root, '.loop', 'outbox'));
  return best?.file;
}
