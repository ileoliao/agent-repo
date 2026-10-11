#!/usr/bin/env node
// Picks whichever Python is actually installed. The smoke agent calls this instead of `python`.
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
for (const bin of ['python3', 'python', 'py']) {
  const r = spawnSync(bin, args, { stdio: 'inherit' });
  if (r.error && r.error.code === 'ENOENT') continue;
  if (r.error) {
    process.stderr.write(r.error.message + '\n');
    process.exit(1);
  }
  process.exit(r.status === null ? 1 : r.status);
}
process.stderr.write('no python interpreter found (tried python3, python, py)\n');
process.exit(127);
