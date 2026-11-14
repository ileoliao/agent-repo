#!/usr/bin/env node
'use strict';

/**
 * Plug or unplug harbor-team-kb into any Harbor Mate workspace and/or VS Code Copilot.
 *
 * Zero external dependencies (Node.js standard library only).
 *
 * Examples:
 *   # Copilot Chat only (zero flags: installs into ~/.copilot/skills/)
 *   node plug.js install
 *
 *   # Harbor Mate workspace (wires all loop Mates + weekly kb-gardener automatically)
 *   node plug.js install -w /path/to/mate-workspace
 *
 *   # Check health & wiring across Copilot + Harbor Mate
 *   node plug.js status
 *
 *   # Cleanly unplug without leaving residue
 *   node plug.js uninstall -w /path/to/mate-workspace --copilot
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const KB_REPO_ROOT = __dirname;
const MARKER_START = '<!-- harbor-team-kb:start -->';
const MARKER_END = '<!-- harbor-team-kb:end -->';
const APPROVE_RULE = 'team-kb-publish/scripts/publish\\.js';
const LEGACY_APPROVE_RULE = 'team-kb-publish/scripts/publish\\.py';

/**
 * Built-in `STANDARD_APPROVE` baseline from `loop-runner/src/policy.ts`.
 * Needed whenever `.loop/policy.json` is absent (default workspace runs `standard` profile)
 * or when a `standard` policy file omits `approveCommands` (because `loadPolicy` replaces
 * `base.approveCommands` if `custom.approveCommands` is defined).
 */
const HTTP_WRITE_METHODS_RE =
  '(' +
  ['POST', 'PUT', 'PATCH', 'DELETE']
    .map(w => [...w].map(c => `[${c}${c.toLowerCase()}]`).join(''))
    .join('|') +
  ')';

const STANDARD_APPROVE_DEFAULTS = [
  '\\bgit push\\b',
  '\\bgit\\b(?:\\s+-\\S+(?:\\s+[^\\s-]\\S*)?)*\\s+push\\b',
  '\\b(npm|pnpm|yarn) publish\\b',
  '\\b(kubectl|helm|terraform)\\s+(apply|delete|destroy|upgrade|install)\\b',
  '\\bdocker push\\b',
  `\\b(curl|wget)\\b.*(\\s-X\\s*${HTTP_WRITE_METHODS_RE}|\\s--request[\\s=]+${HTTP_WRITE_METHODS_RE}|\\s(-d|--data[\\w-]*|-F|--form|-T|--upload-file|--json)\\b)`,
  '\\b(ssh|scp|rsync|nc)\\b',
  '\\brm\\s+.*(\\s)(/|~)',
];

const AGENT_SNIPPET = `${MARKER_START}
## Shared Team Knowledge (\`team-kb\`)

Consult \`team-kb\` (\`redlines\` before unfamiliar service changes; \`search\` -> \`get\` when diagnosing signals) and propose verified reusable lessons via \`.loop/outbox/kb/\` + \`request_approval\` (\`wait: false\`).
${MARKER_END}`;

class PlugError extends Error {}

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

function lstatExists(target) {
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

function isSymlink(target) {
  try {
    return fs.lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

function isDir(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isFile(target) {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function sha256Bytes(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256File(filePath) {
  return sha256Bytes(fs.readFileSync(filePath));
}

function sha256Tree(dirPath) {
  const h = crypto.createHash('sha256');
  function walk(cur, relPrefix) {
    const entries = fs.readdirSync(cur, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    );
    for (const ent of entries) {
      const rel = relPrefix ? `${relPrefix}/${ent.name}` : ent.name;
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        h.update(`D:${rel}\0`);
        walk(full, rel);
      } else if (ent.isSymbolicLink()) {
        h.update(`L:${rel}:${fs.readlinkSync(full)}\0`);
      } else if (ent.isFile()) {
        h.update(`F:${rel}:`);
        h.update(fs.readFileSync(full));
        h.update('\0');
      }
    }
  }
  walk(dirPath, '');
  return h.digest('hex');
}

function manifestsDir() {
  return path.join(os.homedir(), '.cache', 'harbor-kb', 'manifests');
}

function wsManifestPath(ws) {
  let canonical = path.resolve(ws);
  try {
    canonical = fs.realpathSync(ws);
  } catch {}
  const key = sha256Bytes(Buffer.from(canonical, 'utf8')).slice(0, 24);
  return path.join(manifestsDir(), `ws-${key}.json`);
}

function copilotManifestPath() {
  return path.join(manifestsDir(), 'copilot.json');
}

function loadManifest(manifestFile) {
  if (!isFile(manifestFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  } catch {
    return null;
  }
}

function saveManifest(manifestFile, data) {
  fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
  fs.writeFileSync(manifestFile, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function ensureDirTracked(dirPath, wsRoot, createdDirsSet) {
  const absTarget = path.resolve(dirPath);
  const absWs = path.resolve(wsRoot);
  const rel = path.relative(absWs, absTarget);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    fs.mkdirSync(absTarget, { recursive: true });
    return;
  }
  const parts = rel.split(path.sep).filter(Boolean);
  let cur = absWs;
  for (const part of parts) {
    cur = path.join(cur, part);
    if (!lstatExists(cur)) {
      fs.mkdirSync(cur);
      createdDirsSet.add(path.relative(absWs, cur).replace(/\\/g, '/'));
    }
  }
}

function inspectSkillTarget(srcDir, dstDir, manifestEntry) {
  if (!lstatExists(dstDir)) {
    return { exists: false, owned: false, unmodified: true };
  }
  const realSrc = fs.realpathSync(srcDir);
  if (isSymlink(dstDir)) {
    const rawLink = fs.readlinkSync(dstDir);
    const resolvedLink = path.resolve(path.dirname(dstDir), rawLink);
    let realDst = resolvedLink;
    try {
      realDst = fs.realpathSync(dstDir);
    } catch {}
    if (realDst === realSrc || resolvedLink === realSrc) {
      return { exists: true, owned: true, unmodified: true, kind: 'symlink' };
    }
    const ownedByManifest = Boolean(manifestEntry && manifestEntry.owned);
    return {
      exists: true,
      owned: ownedByManifest,
      unmodified: false,
      kind: 'symlink',
      reason: `symlink points to ${rawLink}`,
    };
  }
  if (isDir(dstDir)) {
    const srcHash = sha256Tree(srcDir);
    const dstHash = sha256Tree(dstDir);
    if (manifestEntry && manifestEntry.owned === false) {
      return {
        exists: true,
        owned: false,
        unmodified: false,
        kind: 'dir',
        reason: 'pre-existing unmanaged skill directory',
      };
    }
    if (dstHash === srcHash) {
      return { exists: true, owned: true, unmodified: true, kind: 'dir', treeHash: dstHash };
    }
    if (manifestEntry && manifestEntry.owned) {
      const unmodified = Boolean(manifestEntry.treeHash && dstHash === manifestEntry.treeHash);
      return {
        exists: true,
        owned: true,
        unmodified,
        kind: 'dir',
        treeHash: dstHash,
        reason: unmodified ? undefined : 'installed skill directory has local modifications',
      };
    }
    return {
      exists: true,
      owned: false,
      unmodified: false,
      kind: 'dir',
      reason: 'pre-existing unmanaged skill directory',
    };
  }
  return {
    exists: true,
    owned: false,
    unmodified: false,
    kind: 'file',
    reason: 'pre-existing non-directory file at skill path',
  };
}

function inspectFileTarget(tplPath, dstPath, manifestEntry) {
  if (!lstatExists(dstPath)) {
    return { exists: false, owned: false, unmodified: true };
  }
  if (!isFile(dstPath) || isSymlink(dstPath)) {
    return {
      exists: true,
      owned: Boolean(manifestEntry && manifestEntry.owned),
      unmodified: false,
      reason: 'pre-existing symlink or non-regular file',
    };
  }
  const tplSha = sha256File(tplPath);
  const dstSha = sha256File(dstPath);
  if (manifestEntry && manifestEntry.owned === false) {
    return {
      exists: true,
      owned: false,
      unmodified: false,
      sha256: dstSha,
      reason: 'pre-existing user file',
    };
  }
  if (manifestEntry && manifestEntry.owned) {
    const expected = manifestEntry.installedSha256 || tplSha;
    const unmodified = dstSha === expected || dstSha === tplSha;
    return {
      exists: true,
      owned: true,
      unmodified,
      sha256: dstSha,
      reason: unmodified ? undefined : 'file was modified after install',
    };
  }
  if (dstSha === tplSha) {
    return { exists: true, owned: true, unmodified: true, sha256: dstSha };
  }
  return {
    exists: true,
    owned: false,
    unmodified: false,
    sha256: dstSha,
    reason: 'pre-existing file with custom content',
  };
}

function removeExistingLinkOrDir(target) {
  if (!lstatExists(target)) return;
  const lst = fs.lstatSync(target);
  if (lst.isSymbolicLink() || lst.isFile()) {
    fs.unlinkSync(target);
  } else if (lst.isDirectory()) {
    fs.rmSync(target, { recursive: true, force: true });
  }
}

function installSkillDir(srcDir, dstDir, mode, wsRoot = null, createdDirsSet = null) {
  if (wsRoot && createdDirsSet) {
    ensureDirTracked(path.dirname(dstDir), wsRoot, createdDirsSet);
  } else {
    fs.mkdirSync(path.dirname(dstDir), { recursive: true });
  }
  removeExistingLinkOrDir(dstDir);
  if (mode === 'symlink') {
    fs.symlinkSync(srcDir, dstDir, 'dir');
    return { owned: true, mode: 'symlink' };
  }
  fs.cpSync(srcDir, dstDir, { recursive: true });
  return { owned: true, mode: 'copy', treeHash: sha256Tree(dstDir) };
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function splitFrontmatter(raw) {
  const nl = String(raw).includes('\r\n') ? '\r\n' : '\n';
  const text = String(raw).replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) return [null, text, nl];
  const end = text.indexOf('\n---\n', 4);
  if (end === -1) return [null, text, nl];
  return [text.slice(4, end), text.slice(end + 5), nl];
}

function lineIndent(line) {
  return line.length - line.trimStart().length;
}

function isBlankOrComment(line) {
  const t = line.trim();
  return t === '' || t.startsWith('#');
}

function unquoteYamlScalar(s) {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Locate the `loop:` map block and detect its exact child key indentation (`childIndent`),
 * matching `loop-runner/src/frontmatter.ts` (`parseMap`).
 */
function findLoopBlock(lines) {
  const loopIdx = lines.findIndex(l => /^\s*loop\s*:\s*(?:#.*)?$/.test(l));
  if (loopIdx === -1) return null;
  const loopIndent = lineIndent(lines[loopIdx]);
  let childIndent = null;
  let loopEnd = lines.length;
  for (let i = loopIdx + 1; i < lines.length; i++) {
    if (isBlankOrComment(lines[i])) continue;
    const ind = lineIndent(lines[i]);
    if (ind <= loopIndent) {
      loopEnd = i;
      break;
    }
    if (childIndent === null) {
      childIndent = ind;
    }
  }
  if (childIndent === null) {
    childIndent = loopIndent + 2;
  }
  return { loopIdx, loopEnd, loopIndent, childIndent };
}

function addSkillToAgentText(raw, skillName = 'team-kb') {
  const [fm, origBody, nl] = splitFrontmatter(raw);
  if (fm === null) return [raw, false];
  let body = origBody;
  const lines = fm.split('\n');
  const blk = findLoopBlock(lines);
  if (!blk) return [raw, false];

  let changed = false;
  let skillsLineIdx = null;
  for (let i = blk.loopIdx + 1; i < blk.loopEnd; i++) {
    if (isBlankOrComment(lines[i])) continue;
    if (lineIndent(lines[i]) === blk.childIndent && /^skills\s*:(?:\s|$)/.test(lines[i].trim())) {
      skillsLineIdx = i;
      break;
    }
  }

  if (skillsLineIdx !== null) {
    const line = lines[skillsLineIdx];
    const mInline = /^(\s*skills\s*:\s*\[)(.*?)(\]\s*(?:#.*)?)$/.exec(line);
    if (mInline) {
      const [, prefix, inner, suffix] = mInline;
      const items = inner.split(',').map(x => x.trim()).filter(Boolean);
      const unquoted = items.map(unquoteYamlScalar);
      if (!unquoted.includes(skillName)) {
        items.push(skillName);
        lines[skillsLineIdx] = `${prefix}${items.join(', ')}${suffix}`;
        changed = true;
      }
    } else if (/^skills\s*:\s*(?:#.*)?$/.test(line.trim())) {
      let k = skillsLineIdx + 1;
      while (k < blk.loopEnd && isBlankOrComment(lines[k])) k++;
      let itemIndent = blk.childIndent + 2;
      let lastItemIdx = skillsLineIdx;
      const existing = [];
      if (k < blk.loopEnd && lineIndent(lines[k]) >= blk.childIndent && lines[k].trimStart().startsWith('- ')) {
        itemIndent = lineIndent(lines[k]);
        let j = k;
        while (j < blk.loopEnd) {
          if (isBlankOrComment(lines[j])) {
            j++;
            continue;
          }
          if (lineIndent(lines[j]) === itemIndent && lines[j].trimStart().startsWith('- ')) {
            const rawVal = lines[j].trimStart().slice(2).replace(/\s+#.*$/, '').trim();
            existing.push(unquoteYamlScalar(rawVal));
            lastItemIdx = j;
            j++;
          } else {
            break;
          }
        }
      }
      if (!existing.includes(skillName)) {
        lines.splice(lastItemIdx + 1, 0, `${' '.repeat(itemIndent)}- ${skillName}`);
        changed = true;
      }
    }
  } else {
    lines.splice(blk.loopIdx + 1, 0, `${' '.repeat(blk.childIndent)}skills: [${skillName}]`);
    changed = true;
  }

  if (!body.includes(MARKER_START)) {
    body = `${body.trimEnd()}\n\n${AGENT_SNIPPET}\n`;
    changed = true;
  }

  if (!changed) return [raw, false];
  const out = `---\n${lines.join('\n')}\n---\n${body}`;
  return [nl === '\r\n' ? out.replace(/\n/g, '\r\n') : out, true];
}

function removeSkillFromAgentText(raw, skillName = 'team-kb') {
  const [fm, origBody, nl] = splitFrontmatter(raw);
  if (fm === null) return [raw, false];
  let body = origBody;
  const lines = fm.split('\n');
  const blk = findLoopBlock(lines);
  let changed = false;

  if (blk) {
    for (let i = blk.loopIdx + 1; i < blk.loopEnd; i++) {
      if (isBlankOrComment(lines[i])) continue;
      if (lineIndent(lines[i]) !== blk.childIndent || !/^skills\s*:(?:\s|$)/.test(lines[i].trim())) {
        continue;
      }
      const line = lines[i];
      const mInline = /^(\s*skills\s*:\s*\[)(.*?)(\]\s*(?:#.*)?)$/.exec(line);
      if (mInline) {
        const [, prefix, inner, suffix] = mInline;
        const items = inner.split(',').map(x => x.trim()).filter(Boolean);
        if (items.some(x => unquoteYamlScalar(x) === skillName)) {
          const filtered = items.filter(x => unquoteYamlScalar(x) !== skillName);
          changed = true;
          if (filtered.length) {
            lines[i] = `${prefix}${filtered.join(', ')}${suffix}`;
          } else {
            lines.splice(i, 1);
          }
        }
        break;
      }
      if (/^skills\s*:\s*(?:#.*)?$/.test(line.trim())) {
        let k = i + 1;
        while (k < blk.loopEnd && isBlankOrComment(lines[k])) k++;
        if (k < blk.loopEnd && lineIndent(lines[k]) >= blk.childIndent && lines[k].trimStart().startsWith('- ')) {
          const itemIndent = lineIndent(lines[k]);
          let endList = k;
          let lastItemIdx = k - 1;
          const itemIdxs = [];
          while (endList < blk.loopEnd) {
            if (isBlankOrComment(lines[endList])) {
              endList++;
              continue;
            }
            if (lineIndent(lines[endList]) === itemIndent && lines[endList].trimStart().startsWith('- ')) {
              itemIdxs.push(endList);
              lastItemIdx = endList;
              endList++;
            } else {
              break;
            }
          }
          const matching = itemIdxs.filter(idx => {
            const rawVal = lines[idx].trimStart().slice(2).replace(/\s+#.*$/, '').trim();
            return unquoteYamlScalar(rawVal) === skillName;
          });
          if (matching.length) {
            changed = true;
            if (matching.length === itemIdxs.length) {
              lines.splice(i, lastItemIdx - i + 1);
            } else {
              for (let m = matching.length - 1; m >= 0; m--) {
                lines.splice(matching[m], 1);
              }
            }
          }
        }
        break;
      }
    }
  }

  if (body.includes(MARKER_START) && body.includes(MARKER_END)) {
    const pattern = new RegExp(`\\n*${escapeRegExp(MARKER_START)}[\\s\\S]*?${escapeRegExp(MARKER_END)}\\n*`, 'g');
    body = `${body.replace(pattern, '\n').trimEnd()}\n`;
    changed = true;
  }

  if (!changed) return [raw, false];
  const out = `---\n${lines.join('\n')}\n---\n${body}`;
  return [nl === '\r\n' ? out.replace(/\n/g, '\r\n') : out, true];
}

const VALID_PROFILES = ['strict', 'standard', 'trusted'];

function parseJsonc(raw) {
  const src = String(raw || '').replace(/^\uFEFF/, '');
  // Pass 1: strip // line comments and /* */ block comments outside string literals
  let noComments = '';
  let inStr = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      noComments += ch;
      if (ch === '\\' && i + 1 < src.length) {
        noComments += src[++i];
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
      noComments += ch;
    } else if (ch === '/' && src[i + 1] === '/') {
      i += 2;
      while (i < src.length && src[i] !== '\n') i++;
      if (i < src.length) noComments += '\n';
    } else if (ch === '/' && src[i + 1] === '*') {
      i += 2;
      while (i + 1 < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i++;
    } else {
      noComments += ch;
    }
  }

  // Pass 2: strip trailing commas before `}` or `]` outside string literals
  let cleaned = '';
  inStr = false;
  for (let i = 0; i < noComments.length; i++) {
    const ch = noComments[i];
    if (inStr) {
      cleaned += ch;
      if (ch === '\\' && i + 1 < noComments.length) {
        cleaned += noComments[++i];
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
      cleaned += ch;
    } else if (ch === ',') {
      let j = i + 1;
      while (j < noComments.length && /\s/.test(noComments[j])) j++;
      if (j < noComments.length && (noComments[j] === '}' || noComments[j] === ']')) {
        continue;
      }
      cleaned += ch;
    } else {
      cleaned += ch;
    }
  }

  if (!cleaned.trim()) return {};
  return JSON.parse(cleaned);
}

function readJsoncFile(filePath) {
  if (!filePath || !isFile(filePath)) return null;
  try {
    const parsed = parseJsonc(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readSectionKey(settingsObj, section, key) {
  if (!settingsObj || typeof settingsObj !== 'object') return undefined;
  const flatKey = `${section}.${key}`;
  if (
    Object.prototype.hasOwnProperty.call(settingsObj, flatKey) &&
    settingsObj[flatKey] !== undefined &&
    settingsObj[flatKey] !== null
  ) {
    return settingsObj[flatKey];
  }
  const nested = settingsObj[section];
  if (
    nested &&
    typeof nested === 'object' &&
    !Array.isArray(nested) &&
    Object.prototype.hasOwnProperty.call(nested, key) &&
    nested[key] !== undefined &&
    nested[key] !== null
  ) {
    return nested[key];
  }
  return undefined;
}

function collectCodeWorkspaceSettingsObjects(ws) {
  if (!ws) return [];
  const wsAbs = path.resolve(ws);
  const searchDirs = [...new Set([wsAbs, path.dirname(wsAbs)])];
  const out = [];
  for (const dir of searchDirs) {
    let entries;
    try {
      entries = fs.readdirSync(dir).filter(f => f.endsWith('.code-workspace')).sort();
    } catch {
      continue;
    }
    for (const fn of entries) {
      const cwPath = path.join(dir, fn);
      const doc = readJsoncFile(cwPath);
      if (!doc || !doc.settings || typeof doc.settings !== 'object' || Array.isArray(doc.settings)) {
        continue;
      }
      if (Array.isArray(doc.folders)) {
        const matchesWs = doc.folders.some(
          f =>
            f &&
            typeof f === 'object' &&
            typeof f.path === 'string' &&
            path.resolve(path.dirname(cwPath), f.path) === wsAbs
        );
        if (!matchesWs) continue;
      } else if (dir !== wsAbs) {
        continue;
      }
      out.push(doc.settings);
    }
  }
  return out;
}

function matchWorkspaceUriKey(uriOrPath, wsAbs) {
  if (typeof uriOrPath !== 'string' || !uriOrPath) return false;
  try {
    if (uriOrPath.startsWith('file://')) {
      const u = new URL(uriOrPath);
      let p = decodeURIComponent(u.pathname);
      if (process.platform === 'win32' && /^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
      return path.resolve(p) === wsAbs;
    }
    return path.resolve(uriOrPath) === wsAbs;
  } catch {
    return false;
  }
}

function collectVsCodeUserSettingsObjects(ws) {
  const out = [];
  const wsAbs = ws ? path.resolve(ws) : null;
  if (process.env.HARBOR_VSCODE_USER_SETTINGS) {
    const custom = readJsoncFile(path.resolve(expandHome(process.env.HARBOR_VSCODE_USER_SETTINGS)));
    if (custom) out.push(custom);
  }

  const home = os.homedir();
  const remoteCandidates = [
    path.join(home, '.vscode-server', 'data', 'Machine', 'settings.json'),
    path.join(home, '.vscode-server-insiders', 'data', 'Machine', 'settings.json'),
    path.join(home, '.vscode-remote', 'data', 'Machine', 'settings.json'),
  ];
  for (const rc of remoteCandidates) {
    const obj = readJsoncFile(rc);
    if (obj) out.push(obj);
  }

  const appBase =
    process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support')
      : process.platform === 'win32'
        ? process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
        : process.env.XDG_CONFIG_HOME || path.join(home, '.config');

  for (const appName of ['Code', 'Code - Insiders', 'Cursor', 'VSCodium']) {
    const userDir = path.join(appBase, appName, 'User');
    if (wsAbs) {
      const storage = readJsoncFile(path.join(userDir, 'globalStorage', 'storage.json'));
      const assoc =
        storage &&
        storage.profileAssociations &&
        typeof storage.profileAssociations === 'object' &&
        storage.profileAssociations.workspaces;
      if (assoc && typeof assoc === 'object') {
        for (const [k, profId] of Object.entries(assoc)) {
          if (
            typeof profId === 'string' &&
            profId &&
            !profId.includes('/') &&
            !profId.includes('\\') &&
            !profId.includes('..') &&
            matchWorkspaceUriKey(k, wsAbs)
          ) {
            const profObj = readJsoncFile(path.join(userDir, 'profiles', profId, 'settings.json'));
            if (profObj) out.push(profObj);
          }
        }
      }
    }
    const userObj = readJsoncFile(path.join(userDir, 'settings.json'));
    if (userObj) out.push(userObj);
  }

  return out;
}

/**
 * Resolve effective `defaultProfile` and `policyFile` matching `loop-runner/src/extension.ts`:
 *   1. Explicit CLI `--default-profile` or `HARBOR_DEFAULT_PROFILE` env override
 *   2. `harborMate.<key>` across folder `.vscode/settings.json` -> `.code-workspace` -> Machine/User `settings.json`
 *   3. Legacy `loopRunner.<key>` across the same scopes
 *   4. Built-in Harbor Mate defaults (`defaultProfile = 'standard'`, `policyFile = '.loop/policy.json'`)
 */
function resolveEffectiveHarborSettings(ws, cliDefaultProfile = null) {
  let explicitProfile = cliDefaultProfile;
  if (!explicitProfile && process.env.HARBOR_DEFAULT_PROFILE) {
    const envVal = process.env.HARBOR_DEFAULT_PROFILE.trim();
    if (!VALID_PROFILES.includes(envVal)) {
      throw new PlugError(
        `Invalid HARBOR_DEFAULT_PROFILE "${envVal}". Allowed: ${VALID_PROFILES.join(', ')}`
      );
    }
    explicitProfile = envVal;
  }

  const scopes = [];
  if (ws) {
    const folderObj = readJsoncFile(path.join(ws, '.vscode', 'settings.json'));
    if (folderObj) scopes.push(folderObj);
    scopes.push(...collectCodeWorkspaceSettingsObjects(ws));
  }
  scopes.push(...collectVsCodeUserSettingsObjects(ws));

  const getCfg = (key, fallback) => {
    for (const s of scopes) {
      const v = readSectionKey(s, 'harborMate', key);
      if (v !== undefined) return v;
    }
    for (const s of scopes) {
      const v = readSectionKey(s, 'loopRunner', key);
      if (v !== undefined) return v;
    }
    return fallback;
  };

  let defaultProfile = explicitProfile;
  if (!defaultProfile) {
    const rawProfile = getCfg('defaultProfile', 'standard');
    defaultProfile =
      typeof rawProfile === 'string' && VALID_PROFILES.includes(rawProfile)
        ? rawProfile
        : 'standard';
  }

  const rawPolicyFile = getCfg('policyFile', '.loop/policy.json');
  let policyFile = '.loop/policy.json';
  if (typeof rawPolicyFile === 'string') {
    const trimmed = rawPolicyFile.trim();
    if (trimmed && !path.isAbsolute(trimmed) && !trimmed.split(/[\\/]/).includes('..')) {
      policyFile = trimmed.replace(/\\/g, '/');
    }
  }

  return { defaultProfile, policyFile };
}

function extractReferencedPoliciesFromAgent(raw) {
  const [fm] = splitFrontmatter(raw);
  if (!fm) return [];
  const lines = fm.split('\n');
  const blk = findLoopBlock(lines);
  if (!blk) return [];
  const refs = [];
  for (let i = blk.loopIdx + 1; i < blk.loopEnd; i++) {
    if (isBlankOrComment(lines[i])) continue;
    const m = /^\s*(?:-\s+)?policy\s*:\s*(.+?)\s*(?:#.*)?$/.exec(lines[i]);
    if (m) {
      const val = unquoteYamlScalar(m[1]);
      if (val && !path.isAbsolute(val) && !val.split(/[\\/]/).includes('..')) {
        refs.push(val.replace(/\\/g, '/'));
      }
    }
  }
  return refs;
}

function collectWorkspacePolicyRelPaths(ws, targetAgentFiles = [], defaultPolicyRel = '.loop/policy.json') {
  const relSet = new Set([defaultPolicyRel]);
  if (isFile(path.join(ws, '.loop', 'policy.json'))) {
    relSet.add('.loop/policy.json');
  }
  const policiesDir = path.join(ws, '.loop', 'policies');
  if (isDir(policiesDir)) {
    for (const fn of fs.readdirSync(policiesDir).sort()) {
      if (fn.endsWith('.json')) {
        relSet.add(`.loop/policies/${fn}`);
      }
    }
  }
  const agentSet = new Set(targetAgentFiles);
  const agentsDir = path.join(ws, '.github', 'agents');
  if (isDir(agentsDir)) {
    for (const fn of fs.readdirSync(agentsDir).sort()) {
      if (fn.endsWith('.agent.md')) agentSet.add(path.join(agentsDir, fn));
    }
  }
  for (const af of agentSet) {
    if (!isFile(af)) continue;
    for (const ref of extractReferencedPoliciesFromAgent(fs.readFileSync(af, 'utf8'))) {
      relSet.add(ref);
    }
  }
  return [...relSet];
}

function synthesizedPolicyObject(profile) {
  if (profile === 'standard') {
    return {
      profile: 'standard',
      approveCommands: [...STANDARD_APPROVE_DEFAULTS, APPROVE_RULE],
    };
  }
  if (profile === 'trusted') {
    return {
      profile: 'trusted',
      approveCommands: [APPROVE_RULE],
    };
  }
  // `strict` profile uses DEFAULT_POLICY allowlist, which already denies `publish.js`
  // without needing a policy file on disk.
  return null;
}

function isSynthesizedDefaultPolicy(data) {
  if (!data || typeof data !== 'object') return false;
  const keys = Object.keys(data);
  if (keys.length !== 2 || !Array.isArray(data.approveCommands)) {
    return false;
  }
  if (data.profile === 'standard') {
    const expected = [...STANDARD_APPROVE_DEFAULTS, APPROVE_RULE];
    return (
      data.approveCommands.length === expected.length &&
      data.approveCommands.every((v, idx) => v === expected[idx])
    );
  }
  if (data.profile === 'trusted') {
    return data.approveCommands.length === 1 && data.approveCommands[0] === APPROVE_RULE;
  }
  return false;
}

function pruneEmptyTrackedDirs(startDir, ws, createdDirsSet) {
  if (!createdDirsSet) return;
  const wsPrefix = path.resolve(ws) + path.sep;
  let dir = path.resolve(startDir);
  while (dir.startsWith(wsPrefix)) {
    const relDir = path.relative(ws, dir).replace(/\\/g, '/');
    if (!createdDirsSet.has(relDir)) break;
    try {
      if (isDir(dir) && fs.readdirSync(dir).length === 0) {
        fs.rmdirSync(dir);
        createdDirsSet.delete(relDir);
        dir = path.dirname(dir);
      } else {
        break;
      }
    } catch {
      break;
    }
  }
}

function ensureApprovalGateInPolicy(
  ws,
  relPath,
  manifestPolicies,
  createdDirsSet,
  effectiveDefaultProfile = 'standard'
) {
  const absPath = path.join(ws, relPath);
  const prevEntry = manifestPolicies[relPath] || null;

  if (!lstatExists(absPath)) {
    const createdObj = synthesizedPolicyObject(effectiveDefaultProfile);
    if (!createdObj) {
      delete manifestPolicies[relPath];
      return null;
    }
    ensureDirTracked(path.dirname(absPath), ws, createdDirsSet);
    const content = `${JSON.stringify(createdObj, null, 2)}\n`;
    fs.writeFileSync(absPath, content, 'utf8');
    manifestPolicies[relPath] = {
      created: true,
      installedSha256: sha256Bytes(Buffer.from(content, 'utf8')),
    };
    return `created ${relPath} (${effectiveDefaultProfile} profile + publish.js approval gate)`;
  }

  if (!isFile(absPath)) return null;
  let rawBytes;
  let data;
  try {
    rawBytes = fs.readFileSync(absPath);
    data = JSON.parse(rawBytes.toString('utf8'));
  } catch {
    return null;
  }

  const curSha = sha256Bytes(rawBytes);
  const isUntouchedSynthesized =
    (prevEntry && prevEntry.created === true && curSha === prevEntry.installedSha256) ||
    (!prevEntry && isSynthesizedDefaultPolicy(data));

  if (isUntouchedSynthesized) {
    const desiredObj = synthesizedPolicyObject(effectiveDefaultProfile);
    if (!desiredObj) {
      fs.unlinkSync(absPath);
      delete manifestPolicies[relPath];
      pruneEmptyTrackedDirs(path.dirname(absPath), ws, createdDirsSet);
      return `removed synthesized ${relPath} (defaultProfile is strict)`;
    }
    const desiredContent = `${JSON.stringify(desiredObj, null, 2)}\n`;
    const desiredSha = sha256Bytes(Buffer.from(desiredContent, 'utf8'));
    manifestPolicies[relPath] = {
      created: true,
      installedSha256: desiredSha,
    };
    if (curSha === desiredSha) return null;
    fs.writeFileSync(absPath, desiredContent, 'utf8');
    return `updated synthesized ${relPath} (${effectiveDefaultProfile} profile + publish.js approval gate)`;
  }

  const profile = data.profile;
  if (profile !== 'standard' && profile !== 'trusted') {
    // Missing `profile` or `"profile": "strict"` runs in strict allowlist mode,
    // which already denies `publish.js` because `team-kb-publish` is never in `loop.skills`.
    return null;
  }

  const hadExplicitApprove =
    prevEntry && typeof prevEntry.hadExplicitApprove === 'boolean'
      ? prevEntry.hadExplicitApprove
      : Array.isArray(data.approveCommands);

  let approve = Array.isArray(data.approveCommands)
    ? [...data.approveCommands]
    : profile === 'standard'
      ? [...STANDARD_APPROVE_DEFAULTS]
      : [];

  approve = approve.filter(r => r !== LEGACY_APPROVE_RULE);
  const alreadyPresent = Array.isArray(data.approveCommands) && approve.includes(APPROVE_RULE);
  if (!approve.includes(APPROVE_RULE)) {
    approve.push(APPROVE_RULE);
  }

  if (!prevEntry) {
    manifestPolicies[relPath] = {
      created: false,
      hadExplicitApprove,
      profile,
    };
  }

  if (alreadyPresent && data.approveCommands.length === approve.length) {
    return null;
  }
  data.approveCommands = approve;
  fs.writeFileSync(absPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return `added publish.js approval gate to ${relPath} (${profile} profile)`;
}

function restorePolicyOnUninstall(ws, relPath, manifestEntry) {
  const absPath = path.join(ws, relPath);
  if (!isFile(absPath)) return null;

  let rawBytes;
  let data;
  try {
    rawBytes = fs.readFileSync(absPath);
    data = JSON.parse(rawBytes.toString('utf8'));
  } catch {
    return null;
  }

  const curSha = sha256Bytes(rawBytes);
  if (
    (manifestEntry && manifestEntry.created && curSha === manifestEntry.installedSha256) ||
    (!manifestEntry && isSynthesizedDefaultPolicy(data))
  ) {
    fs.unlinkSync(absPath);
    return `removed synthesized ${relPath}`;
  }

  if (data.profile !== 'standard' && data.profile !== 'trusted') return null;
  if (!Array.isArray(data.approveCommands)) return null;

  const filtered = data.approveCommands.filter(r => r !== APPROVE_RULE && r !== LEGACY_APPROVE_RULE);
  if (filtered.length === data.approveCommands.length) return null;

  if (manifestEntry && manifestEntry.created === false && manifestEntry.hadExplicitApprove === false) {
    const matchesImplicitBaseline =
      data.profile === 'standard'
        ? filtered.length === STANDARD_APPROVE_DEFAULTS.length &&
          filtered.every((v, i) => v === STANDARD_APPROVE_DEFAULTS[i])
        : filtered.length === 0;
    if (matchesImplicitBaseline) {
      delete data.approveCommands;
    } else {
      data.approveCommands = filtered;
    }
  } else {
    data.approveCommands = filtered;
  }

  fs.writeFileSync(absPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return `removed publish.js rule from ${relPath}`;
}

function selectAgentFiles(agentsDir, spec) {
  if (!spec || !isDir(agentsDir)) return [];
  const wanted = spec.split(',').map(x => x.trim()).filter(Boolean);
  if (wanted.length === 1 && wanted[0] === 'none') return [];
  const allFiles = fs.readdirSync(agentsDir).filter(f => f.endsWith('.agent.md')).sort();
  if (wanted.length === 1 && wanted[0] === 'all') {
    return allFiles
      .filter(f => f !== 'kb-gardener.agent.md')
      .map(f => path.join(agentsDir, f));
  }
  return wanted.map(name => {
    const fname = name.endsWith('.agent.md') ? name : `${name}.agent.md`;
    const p = path.join(agentsDir, fname);
    if (!isFile(p)) throw new PlugError(`Agent file not found: ${p}`);
    return p;
  });
}

function looksLikeMateWorkspace(dirPath) {
  return (
    path.resolve(dirPath) !== path.resolve(KB_REPO_ROOT) &&
    (isDir(path.join(dirPath, '.loop')) || isDir(path.join(dirPath, '.github', 'agents')))
  );
}

function cmdInitDataRepo(a) {
  if(!a.target) throw new PlugError('init-data-repo requires a directory');
  const dest=path.resolve(expandHome(a.target));
  const exists=fs.existsSync(dest);
  if(a.upgradeScripts&&(!exists||!isDir(path.join(dest,'kb'))||!isDir(path.join(dest,'standards'))))throw new PlugError('Upgrade requires an existing data repository');
  if(exists && !a.upgradeScripts && fs.readdirSync(dest).length) throw new PlugError('Target is not empty; use --upgrade-scripts');
  for(const rel of ['CODEOWNERS','.github/workflows/kb-guard.yml','scripts/validate-data.js']) {
    if(a.upgradeScripts && rel==='CODEOWNERS')continue;
    const file=path.join(dest,rel);fs.mkdirSync(path.dirname(file),{recursive:true});fs.copyFileSync(path.join(KB_REPO_ROOT,'templates','data-repo',rel),file);
  }
  if(!a.upgradeScripts){
    fs.mkdirSync(path.join(dest,'kb'),{recursive:true});
    fs.writeFileSync(path.join(dest,'kb','.gitkeep'),'');
    fs.mkdirSync(path.join(dest,'standards'),{recursive:true});
    fs.copyFileSync(path.join(KB_REPO_ROOT,'standards','user-story.md'),path.join(dest,'standards','user-story.md'));
    const init=spawnSync('git',['init',dest],{encoding:'utf8',timeout:8000,env:{...process.env,GIT_TERMINAL_PROMPT:'0'}});
    if(init.status!==0)throw new PlugError('Failed to initialize Git data repository');
  }
  console.log('Private data repository prepared: '+dest);
}

function cmdInstall(a) {
  if(a.dataRepo){
    if(!isDir(path.resolve(expandHome(a.dataRepo))))throw new PlugError('Data repository directory not found');
    a.dataRepo=fs.realpathSync(path.resolve(expandHome(a.dataRepo)));
    if(a.dataRepo===fs.realpathSync(KB_REPO_ROOT)||!isDir(path.join(a.dataRepo,'kb')))throw new PlugError('Bind a separate data repository with kb/');
  }
  let mode = a.mode;
  if (mode === 'auto') {
    mode = process.platform === 'win32' ? 'copy' : 'symlink';
  }
  const force = Boolean(a.force);
  const actions = [];

  let wsArg = a.workspace;
  let useCopilot = Boolean(a.copilot);
  if (!wsArg && !useCopilot) {
    if (looksLikeMateWorkspace(process.cwd())) wsArg = process.cwd();
    useCopilot = true;
  }

  const ws = wsArg ? path.resolve(expandHome(wsArg)) : null;
  if (ws && !isDir(ws)) {
    throw new PlugError(`Workspace directory does not exist: ${ws}`);
  }

  const wsManifestFile = ws ? wsManifestPath(ws) : null;
  const wsManifest = ws
    ? loadManifest(wsManifestFile) || {
        version: 1,
        workspace: ws,
        createdDirs: [],
        skills: {},
        files: {},
        policies: {},
      }
    : null;

  const copManifestFile = useCopilot ? copilotManifestPath() : null;
  const copManifest = useCopilot
    ? loadManifest(copManifestFile) || { version: 1, skills: {}, wroteDefaultRoot: false }
    : null;

  const agentsSpec = a.agents !== null ? a.agents : 'all';
  const installGardener = a.noGardener ? false : Boolean(a.withGardener) || a.agents === null;
  const effSettings = ws ? resolveEffectiveHarborSettings(ws, a.defaultProfile) : null;

  // Pre-flight collision checks BEFORE mutating any file on disk
  if (ws) {
    const skillsBase = path.join(ws, '.github', 'skills');
    for (const sk of ['team-kb', 'team-kb-publish', 'story-guard']) {
      const src = path.join(KB_REPO_ROOT, 'skills', sk);
      const dst = path.join(skillsBase, sk);
      const st = inspectSkillTarget(src, dst, wsManifest.skills[sk]);
      if (st.exists && (!st.owned || !st.unmodified) && !force) {
        throw new PlugError(
          `Refusing to overwrite existing skill target ${dst} (${st.reason}). Re-run with --force to replace.`
        );
      }
    }
    if (installGardener) {
      const tplG = path.join(KB_REPO_ROOT, 'agents', 'kb-gardener.agent.md');
      const dstG = path.join(ws, '.github', 'agents', 'kb-gardener.agent.md');
      const stG = inspectFileTarget(tplG, dstG, wsManifest.files['.github/agents/kb-gardener.agent.md']);
      if (stG.exists && (!stG.owned || !stG.unmodified) && !force) {
        throw new PlugError(
          `Refusing to overwrite ${dstG} (${stG.reason}). Pass --force to overwrite or --no-gardener to keep custom gardener.`
        );
      }
    }
    if (a.withHooks) {
      const tplH = path.join(KB_REPO_ROOT, 'hooks', 'harbor-kb.hooks.json');
      const dstH = path.join(ws, '.github', 'hooks', 'harbor-kb.json');
      const stH = inspectFileTarget(tplH, dstH, wsManifest.files['.github/hooks/harbor-kb.json']);
      if (stH.exists && (!stH.owned || !stH.unmodified) && !force) {
        throw new PlugError(
          `Refusing to overwrite ${dstH} (${stH.reason}). Re-run with --force to overwrite.`
        );
      }
    }
  }

  if (useCopilot) {
    const copilotSkills = path.join(os.homedir(), '.copilot', 'skills');
    for (const sk of ['team-kb', 'team-kb-publish', 'story-guard']) {
      const src = path.join(KB_REPO_ROOT, 'skills', sk);
      const dst = path.join(copilotSkills, sk);
      const st = inspectSkillTarget(src, dst, copManifest.skills[sk]);
      if (st.exists && (!st.owned || !st.unmodified) && !force) {
        throw new PlugError(
          `Refusing to overwrite existing Copilot skill ${dst} (${st.reason}). Re-run with --force to replace.`
        );
      }
    }
  }

  if (ws) {
    const createdDirsSet = new Set(Array.isArray(wsManifest.createdDirs) ? wsManifest.createdDirs : []);
    const skillsBase = path.join(ws, '.github', 'skills');
    for (const sk of ['team-kb', 'team-kb-publish', 'story-guard']) {
      const src = path.join(KB_REPO_ROOT, 'skills', sk);
      const dst = path.join(skillsBase, sk);
      wsManifest.skills[sk] = installSkillDir(src, dst, mode, ws, createdDirsSet);
      actions.push(`installed skill ${sk} (${mode}) -> ${dst}`);
    }

    const ptrRel = '.loop/outbox/kb/.kb_root';
    const ptrFile = path.join(ws, ptrRel);
    if (mode === 'copy' || a.dataRepo) {
      ensureDirTracked(path.dirname(ptrFile), ws, createdDirsSet);
      const content = `${a.dataRepo || KB_REPO_ROOT}\n`;
      fs.writeFileSync(ptrFile, content, 'utf8');
      wsManifest.files[ptrRel] = {
        owned: true,
        installedSha256: sha256Bytes(Buffer.from(content, 'utf8')),
      };
      actions.push(`wrote KB root pointer -> ${ptrFile}`);
    } else if (isFile(ptrFile) && (!wsManifest.files[ptrRel] || wsManifest.files[ptrRel].owned !== false)) {
      fs.unlinkSync(ptrFile);
      delete wsManifest.files[ptrRel];
    }

    const agentsDir = path.join(ws, '.github', 'agents');
    const selectedAgents = selectAgentFiles(agentsDir, agentsSpec);
    for (const af of selectedAgents) {
      const raw = fs.readFileSync(af, 'utf8');
      let [updated, changed] = addSkillToAgentText(raw, 'team-kb');
      const [withStory, storyChanged] = addSkillToAgentText(updated,'story-guard');
      if(storyChanged){wsManifest.wiredStoryAgents=[...new Set([...(wsManifest.wiredStoryAgents||[]),path.relative(ws,af)])];updated=withStory;changed=true;}
      if (changed) {
        fs.writeFileSync(af, updated, 'utf8');
        actions.push(`wired team-kb into ${path.basename(af)}`);
      }
    }

    for (const polRel of collectWorkspacePolicyRelPaths(ws, selectedAgents, effSettings.policyFile)) {
      const act = ensureApprovalGateInPolicy(
        ws,
        polRel,
        wsManifest.policies,
        createdDirsSet,
        effSettings.defaultProfile
      );
      if (act) actions.push(act);
    }

    const gardenerRel = '.github/agents/kb-gardener.agent.md';
    const dstG = path.join(ws, gardenerRel);
    if (installGardener) {
      const tplG = path.join(KB_REPO_ROOT, 'agents', 'kb-gardener.agent.md');
      ensureDirTracked(agentsDir, ws, createdDirsSet);
      fs.copyFileSync(tplG, dstG);
      wsManifest.files[gardenerRel] = {
        owned: true,
        installedSha256: sha256File(dstG),
      };
      actions.push(`installed weekly maintenance mate -> ${dstG}`);
    } else if (!wsManifest.files[gardenerRel] && lstatExists(dstG)) {
      wsManifest.files[gardenerRel] = { owned: false };
    }

    const hookRel = '.github/hooks/harbor-kb.json';
    const dstH = path.join(ws, hookRel);
    if (a.withHooks) {
      const tplH = path.join(KB_REPO_ROOT, 'hooks', 'harbor-kb.hooks.json');
      ensureDirTracked(path.dirname(dstH), ws, createdDirsSet);
      fs.copyFileSync(tplH, dstH);
      wsManifest.files[hookRel] = {
        owned: true,
        installedSha256: sha256File(dstH),
      };
      actions.push(`installed Copilot sessionStart redline hook -> ${dstH}`);
    } else if (!wsManifest.files[hookRel] && lstatExists(dstH)) {
      wsManifest.files[hookRel] = { owned: false };
    }

    wsManifest.createdDirs = [...createdDirsSet];
    saveManifest(wsManifestFile, wsManifest);
  }

  if (useCopilot) {
    const copilotSkills = path.join(os.homedir(), '.copilot', 'skills');
    for (const sk of ['team-kb', 'team-kb-publish', 'story-guard']) {
      const src = path.join(KB_REPO_ROOT, 'skills', sk);
      const dst = path.join(copilotSkills, sk);
      copManifest.skills[sk] = installSkillDir(src, dst, mode);
      actions.push(`installed Copilot user skill ${sk} (${mode})`);
    }
    const defaultPtr = path.join(os.homedir(), '.cache', 'harbor-kb', 'default_root');
    fs.mkdirSync(path.dirname(defaultPtr), { recursive: true });
    fs.writeFileSync(defaultPtr, `${KB_REPO_ROOT}\n`, 'utf8');
    copManifest.wroteDefaultRoot = true;
    saveManifest(copManifestFile, copManifest);
  }

  if(a.dataRepo){
    const ptr=path.join(os.homedir(),'.harbor','kb_data_root');fs.mkdirSync(path.dirname(ptr),{recursive:true});fs.writeFileSync(ptr,a.dataRepo+'\n');
  }
  const kbJs = path.join(KB_REPO_ROOT, 'skills', 'team-kb', 'scripts', 'kb.js');
  const warmRes = spawnSync(process.execPath, [kbJs, '--kb-root', a.dataRepo || KB_REPO_ROOT, 'stats'], {
    encoding: 'utf8',
    timeout: 15000,
  });
  if (warmRes.status !== 0) {
    throw new PlugError(`Warm-up index check failed: ${(warmRes.stderr || warmRes.stdout || '').trim()}`);
  }

  if (a.json) {
    console.log(JSON.stringify({ status: 'installed', mode, kb_root: KB_REPO_ROOT, actions }, null, 2));
  } else {
    for (const act of actions) console.log(`✓ ${act}`);
    if (useCopilot) {
      console.log('  Tip (VS Code Copilot): ensure "chat.useAgentSkills": true is enabled in VS Code Settings.');
    }
  }
}

function cmdUninstall(a) {
  const force = Boolean(a.force);
  const actions = [];
  const skipped = [];

  let wsArg = a.workspace;
  let useCopilot = Boolean(a.copilot);
  if (!wsArg && !useCopilot) {
    if (lstatExists(path.join(process.cwd(), '.github', 'skills', 'team-kb'))) {
      wsArg = process.cwd();
    }
    useCopilot = true;
  }

  if (wsArg) {
    const ws = path.resolve(expandHome(wsArg));
    const wsManifestFile = wsManifestPath(ws);
    const wsManifest = loadManifest(wsManifestFile);
    let keptOwnedEntries = false;

    for (const sk of ['team-kb', 'team-kb-publish', 'story-guard']) {
      const src = path.join(KB_REPO_ROOT, 'skills', sk);
      const dst = path.join(ws, '.github', 'skills', sk);
      if (!lstatExists(dst)) {
        if (wsManifest && wsManifest.skills) delete wsManifest.skills[sk];
        continue;
      }
      const mEntry = wsManifest && wsManifest.skills ? wsManifest.skills[sk] : null;
      const st = inspectSkillTarget(src, dst, mEntry);
      if (!st.owned) {
        skipped.push(`preserved unmanaged skill ${dst}`);
        continue;
      }
      if (!st.unmodified && !force) {
        skipped.push(`preserved modified skill ${dst} (pass --force to remove)`);
        keptOwnedEntries = true;
        continue;
      }
      removeExistingLinkOrDir(dst);
      if (wsManifest && wsManifest.skills) delete wsManifest.skills[sk];
      actions.push(`removed skill ${sk} from ${ws}`);
    }

    const ptrRel = '.loop/outbox/kb/.kb_root';
    const ptrFile = path.join(ws, ptrRel);
    if (isFile(ptrFile)) {
      const ptrEntry = wsManifest && wsManifest.files ? wsManifest.files[ptrRel] : null;
      if (!ptrEntry || ptrEntry.owned !== false) {
        fs.unlinkSync(ptrFile);
        if (wsManifest && wsManifest.files) delete wsManifest.files[ptrRel];
        actions.push('removed .kb_root pointer');
      }
    }

    const managedFiles = [
      ['.github/agents/kb-gardener.agent.md', path.join(KB_REPO_ROOT, 'agents', 'kb-gardener.agent.md')],
      ['.github/hooks/harbor-kb.json', path.join(KB_REPO_ROOT, 'hooks', 'harbor-kb.hooks.json')],
    ];
    for (const [rel, tplPath] of managedFiles) {
      const dst = path.join(ws, rel);
      if (!lstatExists(dst)) {
        if (wsManifest && wsManifest.files) delete wsManifest.files[rel];
        continue;
      }
      const mEntry = wsManifest && wsManifest.files ? wsManifest.files[rel] : null;
      const st = inspectFileTarget(tplPath, dst, mEntry);
      if (!st.owned) {
        skipped.push(`preserved pre-existing ${rel}`);
        continue;
      }
      if (!st.unmodified && !force) {
        skipped.push(`preserved user-modified ${rel} (pass --force to remove)`);
        keptOwnedEntries = true;
        continue;
      }
      fs.unlinkSync(dst);
      if (wsManifest && wsManifest.files) delete wsManifest.files[rel];
      actions.push(`removed ${rel}`);
    }

    const agentsDir = path.join(ws, '.github', 'agents');
    const agentFiles = [];
    if (isDir(agentsDir)) {
      for (const fn of fs.readdirSync(agentsDir).sort()) {
        if (!fn.endsWith('.agent.md')) continue;
        const af = path.join(agentsDir, fn);
        agentFiles.push(af);
        const raw = fs.readFileSync(af, 'utf8');
        let [cleaned, changed] = removeSkillFromAgentText(raw, 'team-kb');
        if((wsManifest?.wiredStoryAgents||[]).includes(path.relative(ws,af))){const [next,removed]=removeSkillFromAgentText(cleaned,'story-guard');cleaned=next;changed=changed||removed;}
        if (changed) {
          fs.writeFileSync(af, cleaned, 'utf8');
          actions.push(`unwired team-kb from ${fn}`);
        }
      }
    }

    const effSettings = resolveEffectiveHarborSettings(ws, a.defaultProfile);
    const policyPaths = new Set(
      collectWorkspacePolicyRelPaths(ws, agentFiles, effSettings.policyFile)
    );
    if (wsManifest && wsManifest.policies) {
      for (const k of Object.keys(wsManifest.policies)) policyPaths.add(k);
    }
    for (const polRel of policyPaths) {
      const mEntry = wsManifest && wsManifest.policies ? wsManifest.policies[polRel] : null;
      const act = restorePolicyOnUninstall(ws, polRel, mEntry);
      if (act) actions.push(act);
      if (wsManifest && wsManifest.policies) delete wsManifest.policies[polRel];
    }

    if (wsManifest && Array.isArray(wsManifest.createdDirs)) {
      const dirsDesc = [...wsManifest.createdDirs].sort(
        (x, y) => y.split('/').length - x.split('/').length
      );
      for (const relDir of dirsDesc) {
        const absDir = path.join(ws, relDir);
        try {
          if (isDir(absDir) && fs.readdirSync(absDir).length === 0) {
            fs.rmdirSync(absDir);
          }
        } catch {}
      }
    }

    if (wsManifestFile && isFile(wsManifestFile)) {
      if (keptOwnedEntries && wsManifest) {
        saveManifest(wsManifestFile, wsManifest);
      } else {
        try {
          fs.unlinkSync(wsManifestFile);
        } catch {}
      }
    }
  }

  if (useCopilot) {
    const copManifestFile = copilotManifestPath();
    const copManifest = loadManifest(copManifestFile);
    let keptCopilotEntries = false;
    const copilotSkills = path.join(os.homedir(), '.copilot', 'skills');

    for (const sk of ['team-kb', 'team-kb-publish', 'story-guard']) {
      const src = path.join(KB_REPO_ROOT, 'skills', sk);
      const dst = path.join(copilotSkills, sk);
      if (!lstatExists(dst)) {
        if (copManifest && copManifest.skills) delete copManifest.skills[sk];
        continue;
      }
      const mEntry = copManifest && copManifest.skills ? copManifest.skills[sk] : null;
      const st = inspectSkillTarget(src, dst, mEntry);
      if (!st.owned) {
        skipped.push(`preserved unmanaged Copilot skill ${dst}`);
        continue;
      }
      if (!st.unmodified && !force) {
        skipped.push(`preserved modified Copilot skill ${dst} (pass --force to remove)`);
        keptCopilotEntries = true;
        continue;
      }
      removeExistingLinkOrDir(dst);
      if (copManifest && copManifest.skills) delete copManifest.skills[sk];
      actions.push(`removed Copilot user skill ${sk}`);
    }

    const defaultPtr = path.join(os.homedir(), '.cache', 'harbor-kb', 'default_root');
    if (isFile(defaultPtr) && (!copManifest || copManifest.wroteDefaultRoot !== false)) {
      try {
        const curPtr = fs.readFileSync(defaultPtr, 'utf8').trim();
        if (!curPtr || path.resolve(curPtr) === path.resolve(KB_REPO_ROOT)) {
          fs.unlinkSync(defaultPtr);
        }
      } catch {}
    }

    if (copManifestFile && isFile(copManifestFile)) {
      if (keptCopilotEntries && copManifest) {
        saveManifest(copManifestFile, copManifest);
      } else {
        try {
          fs.unlinkSync(copManifestFile);
        } catch {}
      }
    }
  }

  if (a.json) {
    console.log(JSON.stringify({ status: 'uninstalled', actions, skipped }, null, 2));
  } else if (!actions.length && !skipped.length) {
    console.log('Nothing to uninstall.');
  } else {
    for (const act of actions) console.log(`✓ ${act}`);
    for (const skp of skipped) console.warn(`! ${skp}`);
  }
}

function cmdStatus(a) {
  const copilotSk = path.join(os.homedir(), '.copilot', 'skills', 'team-kb');
  const copilotPub = path.join(os.homedir(), '.copilot', 'skills', 'team-kb-publish');
  const copilotInstalled = isDir(copilotSk) && isFile(path.join(copilotSk, 'SKILL.md'));
  const copilotMode = isSymlink(copilotSk) ? 'symlink' : isDir(copilotSk) ? 'copy' : 'absent';

  const checks = {
    engine: 'node-bm25',
    node_version: process.versions.node,
    kb_root: KB_REPO_ROOT,
    copilot_status: {
      team_kb_installed: copilotInstalled,
      team_kb_mode: copilotMode,
      publish_installed: isDir(copilotPub) && isFile(path.join(copilotPub, 'SKILL.md')),
      story_guard_installed: isFile(path.join(os.homedir(),'.copilot','skills','story-guard','SKILL.md')),
    },
  };
  const kbJsDefault = path.join(KB_REPO_ROOT, 'skills', 'team-kb', 'scripts', 'kb.js');
  let wsChecks = null;

  let wsArg = a.workspace;
  if (!wsArg && looksLikeMateWorkspace(process.cwd())) {
    wsArg = process.cwd();
  }

  if (wsArg) {
    const ws = path.resolve(expandHome(wsArg));
    const skDir = path.join(ws, '.github', 'skills', 'team-kb');
    const pubDir = path.join(ws, '.github', 'skills', 'team-kb-publish');
    const wiredAgents = [];
    const agentsDir = path.join(ws, '.github', 'agents');
    if (isDir(agentsDir)) {
      for (const fn of fs.readdirSync(agentsDir).sort()) {
        if (fn.endsWith('.agent.md')) {
          const txt = fs.readFileSync(path.join(agentsDir, fn), 'utf8');
          if (txt.includes('team-kb')) wiredAgents.push(fn);
        }
      }
    }
    const effSettings = resolveEffectiveHarborSettings(ws, a.defaultProfile);
    wsChecks = {
      workspace: ws,
      effective_default_profile: effSettings.defaultProfile,
      team_kb_installed: isDir(skDir) && isFile(path.join(skDir, 'SKILL.md')),
      team_kb_mode: isSymlink(skDir) ? 'symlink' : isDir(skDir) ? 'copy' : 'absent',
      publish_installed: isDir(pubDir) && isFile(path.join(pubDir, 'SKILL.md')),
      story_guard_installed: isFile(path.join(ws,'.github','skills','story-guard','SKILL.md')),
      wired_agents: wiredAgents,
      gardener_installed: isFile(path.join(ws, '.github', 'agents', 'kb-gardener.agent.md')),
      hook_installed: isFile(path.join(ws, '.github', 'hooks', 'harbor-kb.json')),
    };
    if (wsChecks.team_kb_installed) {
      const runRes = spawnSync(
        process.execPath,
        [path.join('.github', 'skills', 'team-kb', 'scripts', 'kb.js'), '--json', 'stats'],
        { cwd: ws, encoding: 'utf8', timeout: 15000 }
      );
      wsChecks.runtime_probe_ok = runRes.status === 0;
      if (runRes.status === 0) {
        wsChecks.stats = JSON.parse(runRes.stdout);
      } else {
        wsChecks.runtime_error = (runRes.stderr || '').trim();
      }
    }
  } else {
    const runRes = spawnSync(
      process.execPath,
      [kbJsDefault, '--json', 'stats'],
      { encoding: 'utf8', timeout: 15000 }
    );
    if (runRes.status === 0) {
      checks.stats = JSON.parse(runRes.stdout);
    }
  }

  checks.kb_root=((wsChecks && wsChecks.stats)||checks.stats||{}).kb_root||KB_REPO_ROOT;
  checks.workspace_status = wsChecks;
  const ok =
    wsChecks === null
      ? Boolean(checks.stats)
      : Boolean(wsChecks.team_kb_installed && wsChecks.runtime_probe_ok);
  checks.healthy = ok;

  if (a.json) {
    console.log(JSON.stringify(checks, null, 2));
  } else {
    const totalEntries =
      ((wsChecks && wsChecks.stats) || checks.stats || {}).total_entries ?? '?';
    console.log(`Runtime:        Node.js v${checks.node_version} (${checks.engine})`);
    console.log(`KB root:        ${((wsChecks && wsChecks.stats) || checks.stats || {}).kb_root || KB_REPO_ROOT} (${totalEntries} entries)`);
    console.log(`Copilot skills: ${copilotMode} (publish=${checks.copilot_status.publish_installed})`);
    if (wsChecks) {
      console.log(`Workspace:      ${wsChecks.workspace}`);
      console.log(`Skill status:   team-kb=${wsChecks.team_kb_mode}, publish=${wsChecks.publish_installed}`);
      console.log(`Wired mates:    ${wsChecks.wired_agents.join(', ') || '(none)'}`);
      console.log(`Runtime probe:  ${wsChecks.runtime_probe_ok ? 'OK' : 'FAILED'}`);
    }
  }
  if (!ok) process.exit(2);
}

function parseCliArgs(argv) {
  const opts = {
    cmd: null,
    workspace: null,
    mode: 'auto',
    agents: null,
    defaultProfile: null,
    withGardener: false,
    noGardener: false,
    withHooks: false,
    copilot: false,
    force: false,
    json: false,
    help: false,
  };
  const VALUE_FLAGS = {
    '--workspace': 'workspace',
    '-w': 'workspace',
    '--mode': 'mode',
    '--agents': 'agents',
    '--default-profile': 'defaultProfile',
    '--data-repo': 'dataRepo',
  };
  const BOOL_FLAGS = {
    '--with-gardener': 'withGardener',
    '--no-gardener': 'noGardener',
    '--with-hooks': 'withHooks',
    '--copilot': 'copilot',
    '--force': 'force',
    '--upgrade-scripts': 'upgradeScripts',
    '-f': 'force',
    '--json': 'json',
    '--help': 'help',
    '-h': 'help',
  };
  const COMMANDS = new Set(['install', 'uninstall', 'status', 'init-data-repo']);

  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (raw.startsWith('-')) {
      const eq = raw.indexOf('=');
      const flag = eq === -1 ? raw : raw.slice(0, eq);
      if (Object.prototype.hasOwnProperty.call(BOOL_FLAGS, flag)) {
        opts[BOOL_FLAGS[flag]] = true;
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(VALUE_FLAGS, flag)) {
        const val = eq === -1 ? argv[++i] : raw.slice(eq + 1);
        if (val === undefined) throw new PlugError(`Missing value for ${flag}`);
        opts[VALUE_FLAGS[flag]] = val;
        continue;
      }
      throw new PlugError(`Unknown option: ${raw}`);
    }
    if (!opts.cmd && COMMANDS.has(raw)) {
      opts.cmd = raw;
    } else {
      if(opts.cmd==='init-data-repo'&&!opts.target)opts.target=raw;else throw new PlugError(`Unexpected argument: ${raw}`);
    }
  }
  if (!['auto', 'symlink', 'copy'].includes(opts.mode)) {
    throw new PlugError(`Invalid --mode "${opts.mode}". Allowed: auto, symlink, copy`);
  }
  if (opts.defaultProfile !== null && !VALID_PROFILES.includes(opts.defaultProfile)) {
    throw new PlugError(
      `Invalid --default-profile "${opts.defaultProfile}". Allowed: ${VALID_PROFILES.join(', ')}`
    );
  }
  return opts;
}

function printHelp() {
  console.log(
    [
      'Usage: node plug.js <install|uninstall|status|init-data-repo> [options]',
      '',
      'Commands:',
      '  init-data-repo <dir> [--upgrade-scripts]',
      '  install --data-repo <private-data-dir>',
      '  install [-w <workspace>] [--copilot] [--agents all|none|a,b] [--default-profile strict|standard|trusted] [--no-gardener] [--with-hooks] [--mode auto|symlink|copy] [--force]',
      '  uninstall [-w <workspace>] [--copilot] [--force]',
      '  status [-w <workspace>]',
    ].join('\n')
  );
}

function main(argv = process.argv.slice(2)) {
  const a = parseCliArgs(argv);
  if (a.help || !a.cmd) {
    printHelp();
    return a.help ? 0 : 2;
  }
  const dispatch = {
    'init-data-repo': cmdInitDataRepo,
    install: cmdInstall,
    uninstall: cmdUninstall,
    status: cmdStatus,
  };
  dispatch[a.cmd](a);
  return 0;
}

if (require.main === module) {
  try {
    process.exit(main());
  } catch (err) {
    if (err instanceof PlugError) {
      console.error(`plug: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }
}

module.exports = {
  PlugError,
  APPROVE_RULE,
  STANDARD_APPROVE_DEFAULTS,
  parseJsonc,
  resolveEffectiveHarborSettings,
  addSkillToAgentText,
  removeSkillFromAgentText,
  main,
};
