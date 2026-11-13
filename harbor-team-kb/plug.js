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
const { spawnSync } = require('child_process');

const KB_REPO_ROOT = __dirname;
const MARKER_START = '<!-- harbor-team-kb:start -->';
const MARKER_END = '<!-- harbor-team-kb:end -->';
const APPROVE_RULE = 'team-kb-publish/scripts/publish\\.js';
const LEGACY_APPROVE_RULE = 'team-kb-publish/scripts/publish\\.py';

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

function removeExistingLinkOrDir(target) {
  if (!lstatExists(target)) return;
  const lst = fs.lstatSync(target);
  if (lst.isSymbolicLink() || lst.isFile()) {
    fs.unlinkSync(target);
  } else if (lst.isDirectory()) {
    fs.rmSync(target, { recursive: true, force: true });
  }
}

function installSkillDir(srcDir, dstDir, mode) {
  fs.mkdirSync(path.dirname(dstDir), { recursive: true });
  removeExistingLinkOrDir(dstDir);
  if (mode === 'symlink') {
    fs.symlinkSync(srcDir, dstDir, 'dir');
  } else {
    fs.cpSync(srcDir, dstDir, { recursive: true });
  }
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function splitFrontmatter(raw) {
  const text = String(raw).replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) return [null, text];
  const end = text.indexOf('\n---\n', 4);
  if (end === -1) return [null, text];
  return [text.slice(4, end), text.slice(end + 5)];
}

function addSkillToAgentText(raw, skillName = 'team-kb') {
  const [fm, origBody] = splitFrontmatter(raw);
  if (fm === null) return [raw, false];
  let body = origBody;
  const lines = fm.split('\n');
  const loopIdx = lines.findIndex(l => /^loop:\s*(#.*)?$/.test(l));
  if (loopIdx === -1) return [raw, false];

  let changed = false;
  let i = loopIdx + 1;
  let skillsLineIdx = null;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() && !line.startsWith(' ') && !line.startsWith('\t') && !line.trimStart().startsWith('#')) {
      break;
    }
    if (/^\s{2}skills\s*:/.test(line)) {
      skillsLineIdx = i;
      break;
    }
    i++;
  }

  if (skillsLineIdx !== null) {
    const line = lines[skillsLineIdx];
    const mInline = /^(\s*skills\s*:\s*\[)(.*?)(\]\s*(?:#.*)?)$/.exec(line);
    if (mInline) {
      const [, prefix, inner, suffix] = mInline;
      const items = inner.split(',').map(x => x.trim()).filter(Boolean);
      if (!items.includes(skillName)) {
        items.push(skillName);
        lines[skillsLineIdx] = `${prefix}${items.join(', ')}${suffix}`;
        changed = true;
      }
    } else {
      let j = skillsLineIdx + 1;
      const existing = [];
      while (j < lines.length && /^\s{4,}-\s+\S+/.test(lines[j])) {
        existing.push(lines[j].replace(/^\s*-\s+/, '').trim());
        j++;
      }
      if (!existing.includes(skillName)) {
        lines.splice(j, 0, `    - ${skillName}`);
        changed = true;
      }
    }
  } else {
    lines.splice(loopIdx + 1, 0, `  skills: [${skillName}]`);
    changed = true;
  }

  if (!body.includes(MARKER_START)) {
    body = `${body.trimEnd()}\n\n${AGENT_SNIPPET}\n`;
    changed = true;
  }

  if (!changed) return [raw, false];
  return [`---\n${lines.join('\n')}\n---\n${body}`, true];
}

function removeSkillFromAgentText(raw, skillName = 'team-kb') {
  const [fm, origBody] = splitFrontmatter(raw);
  if (fm === null) return [raw, false];
  let body = origBody;
  const lines = fm.split('\n');
  let changed = false;

  const newLines = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const mInline = /^(\s*skills\s*:\s*\[)(.*?)(\]\s*(?:#.*)?)$/.exec(line);
    if (mInline) {
      const [, prefix, inner, suffix] = mInline;
      const items = inner.split(',').map(x => x.trim()).filter(Boolean);
      if (items.includes(skillName)) {
        const filtered = items.filter(x => x !== skillName);
        changed = true;
        if (filtered.length) {
          newLines.push(`${prefix}${filtered.join(', ')}${suffix}`);
        }
        i++;
        continue;
      }
    }
    if (/^\s{2}skills\s*:\s*$/.test(line)) {
      let j = i + 1;
      const kept = [];
      let hadTarget = false;
      while (j < lines.length && /^\s{4,}-\s+\S+/.test(lines[j])) {
        const val = lines[j].replace(/^\s*-\s+/, '').trim();
        if (val === skillName) hadTarget = true;
        else kept.push(lines[j]);
        j++;
      }
      if (hadTarget) {
        changed = true;
        if (kept.length) {
          newLines.push(line, ...kept);
        }
        i = j;
        continue;
      }
    }
    newLines.push(line);
    i++;
  }

  if (body.includes(MARKER_START) && body.includes(MARKER_END)) {
    const pattern = new RegExp(`\\n*${escapeRegExp(MARKER_START)}[\\s\\S]*?${escapeRegExp(MARKER_END)}\\n*`, 'g');
    body = `${body.replace(pattern, '\n').trimEnd()}\n`;
    changed = true;
  }

  if (!changed) return [raw, false];
  return [`---\n${newLines.join('\n')}\n---\n${body}`, true];
}

function patchStandardPolicy(workspace, install = true) {
  const policyPath = path.join(workspace, '.loop', 'policy.json');
  if (!isFile(policyPath)) return false;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  } catch {
    return false;
  }
  if (data.profile !== 'standard') return false;
  let approve = Array.isArray(data.approveCommands) ? [...data.approveCommands] : [];
  if (install) {
    approve = approve.filter(r => r !== LEGACY_APPROVE_RULE);
    if (approve.includes(APPROVE_RULE)) return false;
    approve.push(APPROVE_RULE);
    data.approveCommands = approve;
  } else {
    const before = approve.length;
    approve = approve.filter(r => r !== APPROVE_RULE && r !== LEGACY_APPROVE_RULE);
    if (approve.length === before) return false;
    data.approveCommands = approve;
  }
  fs.writeFileSync(policyPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return true;
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

function cmdInstall(a) {
  let mode = a.mode;
  if (mode === 'auto') {
    mode = process.platform === 'win32' ? 'copy' : 'symlink';
  }
  const actions = [];

  let wsArg = a.workspace;
  let useCopilot = Boolean(a.copilot);
  if (!wsArg && !useCopilot) {
    if (looksLikeMateWorkspace(process.cwd())) wsArg = process.cwd();
    useCopilot = true;
  }

  if (wsArg) {
    const ws = path.resolve(expandHome(wsArg));
    if (!isDir(ws)) throw new PlugError(`Workspace directory does not exist: ${ws}`);
    const skillsBase = path.join(ws, '.github', 'skills');
    for (const sk of ['team-kb', 'team-kb-publish']) {
      const src = path.join(KB_REPO_ROOT, 'skills', sk);
      const dst = path.join(skillsBase, sk);
      installSkillDir(src, dst, mode);
      actions.push(`installed skill ${sk} (${mode}) -> ${dst}`);
    }

    const ptrFile = path.join(ws, '.loop', 'outbox', 'kb', '.kb_root');
    if (mode === 'copy') {
      fs.mkdirSync(path.dirname(ptrFile), { recursive: true });
      fs.writeFileSync(ptrFile, `${KB_REPO_ROOT}\n`, 'utf8');
      actions.push(`wrote KB root pointer -> ${ptrFile}`);
    } else if (isFile(ptrFile)) {
      fs.unlinkSync(ptrFile);
    }

    if (patchStandardPolicy(ws, true)) {
      actions.push('added publish.js approval gate to .loop/policy.json (standard profile)');
    }

    const agentsSpec = a.agents !== null ? a.agents : 'all';
    const installGardener = a.noGardener ? false : Boolean(a.withGardener) || a.agents === null;

    const agentsDir = path.join(ws, '.github', 'agents');
    for (const af of selectAgentFiles(agentsDir, agentsSpec)) {
      const raw = fs.readFileSync(af, 'utf8');
      const [updated, changed] = addSkillToAgentText(raw, 'team-kb');
      if (changed) {
        fs.writeFileSync(af, updated, 'utf8');
        actions.push(`wired team-kb into ${path.basename(af)}`);
      }
    }

    if (installGardener) {
      fs.mkdirSync(agentsDir, { recursive: true });
      const dstG = path.join(agentsDir, 'kb-gardener.agent.md');
      fs.copyFileSync(path.join(KB_REPO_ROOT, 'agents', 'kb-gardener.agent.md'), dstG);
      actions.push(`installed weekly maintenance mate -> ${dstG}`);
    }

    if (a.withHooks) {
      const hooksDir = path.join(ws, '.github', 'hooks');
      fs.mkdirSync(hooksDir, { recursive: true });
      const dstH = path.join(hooksDir, 'harbor-kb.json');
      fs.copyFileSync(path.join(KB_REPO_ROOT, 'hooks', 'harbor-kb.hooks.json'), dstH);
      actions.push(`installed Copilot sessionStart redline hook -> ${dstH}`);
    }
  }

  if (useCopilot) {
    const copilotSkills = path.join(os.homedir(), '.copilot', 'skills');
    for (const sk of ['team-kb', 'team-kb-publish']) {
      installSkillDir(path.join(KB_REPO_ROOT, 'skills', sk), path.join(copilotSkills, sk), mode);
      actions.push(`installed Copilot user skill ${sk} (${mode})`);
    }
    const defaultPtr = path.join(os.homedir(), '.cache', 'harbor-kb', 'default_root');
    fs.mkdirSync(path.dirname(defaultPtr), { recursive: true });
    fs.writeFileSync(defaultPtr, `${KB_REPO_ROOT}\n`, 'utf8');
  }

  const kbJs = path.join(KB_REPO_ROOT, 'skills', 'team-kb', 'scripts', 'kb.js');
  const warmRes = spawnSync(process.execPath, [kbJs, '--kb-root', KB_REPO_ROOT, 'stats'], {
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
  const actions = [];
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
    for (const sk of ['team-kb', 'team-kb-publish']) {
      const dst = path.join(ws, '.github', 'skills', sk);
      if (lstatExists(dst)) {
        removeExistingLinkOrDir(dst);
        actions.push(`removed skill ${sk} from ${ws}`);
      }
    }
    const ptrFile = path.join(ws, '.loop', 'outbox', 'kb', '.kb_root');
    if (isFile(ptrFile)) {
      fs.unlinkSync(ptrFile);
      actions.push('removed .kb_root pointer');
    }

    const gardener = path.join(ws, '.github', 'agents', 'kb-gardener.agent.md');
    if (isFile(gardener)) {
      fs.unlinkSync(gardener);
      actions.push('removed kb-gardener.agent.md');
    }

    const hookF = path.join(ws, '.github', 'hooks', 'harbor-kb.json');
    if (isFile(hookF)) {
      fs.unlinkSync(hookF);
      actions.push('removed .github/hooks/harbor-kb.json');
    }

    const agentsDir = path.join(ws, '.github', 'agents');
    if (isDir(agentsDir)) {
      for (const fn of fs.readdirSync(agentsDir).sort()) {
        if (!fn.endsWith('.agent.md')) continue;
        const af = path.join(agentsDir, fn);
        const raw = fs.readFileSync(af, 'utf8');
        const [cleaned, changed] = removeSkillFromAgentText(raw, 'team-kb');
        if (changed) {
          fs.writeFileSync(af, cleaned, 'utf8');
          actions.push(`unwired team-kb from ${fn}`);
        }
      }
    }

    if (patchStandardPolicy(ws, false)) {
      actions.push('removed publish.js rule from .loop/policy.json');
    }
  }

  if (useCopilot) {
    const copilotSkills = path.join(os.homedir(), '.copilot', 'skills');
    for (const sk of ['team-kb', 'team-kb-publish']) {
      const dst = path.join(copilotSkills, sk);
      if (lstatExists(dst)) {
        removeExistingLinkOrDir(dst);
        actions.push(`removed Copilot user skill ${sk}`);
      }
    }
    const defaultPtr = path.join(os.homedir(), '.cache', 'harbor-kb', 'default_root');
    if (isFile(defaultPtr)) fs.unlinkSync(defaultPtr);
  }

  if (a.json) {
    console.log(JSON.stringify({ status: 'uninstalled', actions }, null, 2));
  } else if (!actions.length) {
    console.log('Nothing to uninstall.');
  } else {
    for (const act of actions) console.log(`✓ ${act}`);
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
    wsChecks = {
      workspace: ws,
      team_kb_installed: isDir(skDir) && isFile(path.join(skDir, 'SKILL.md')),
      team_kb_mode: isSymlink(skDir) ? 'symlink' : isDir(skDir) ? 'copy' : 'absent',
      publish_installed: isDir(pubDir) && isFile(path.join(pubDir, 'SKILL.md')),
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
      [kbJsDefault, '--kb-root', KB_REPO_ROOT, '--json', 'stats'],
      { encoding: 'utf8', timeout: 15000 }
    );
    if (runRes.status === 0) {
      checks.stats = JSON.parse(runRes.stdout);
    }
  }

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
    console.log(`KB root:        ${KB_REPO_ROOT} (${totalEntries} entries)`);
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
    withGardener: false,
    noGardener: false,
    withHooks: false,
    copilot: false,
    json: false,
    help: false,
  };
  const VALUE_FLAGS = {
    '--workspace': 'workspace',
    '-w': 'workspace',
    '--mode': 'mode',
    '--agents': 'agents',
  };
  const BOOL_FLAGS = {
    '--with-gardener': 'withGardener',
    '--no-gardener': 'noGardener',
    '--with-hooks': 'withHooks',
    '--copilot': 'copilot',
    '--json': 'json',
    '--help': 'help',
    '-h': 'help',
  };
  const COMMANDS = new Set(['install', 'uninstall', 'status']);

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
      throw new PlugError(`Unexpected argument: ${raw}`);
    }
  }
  if (!['auto', 'symlink', 'copy'].includes(opts.mode)) {
    throw new PlugError(`Invalid --mode "${opts.mode}". Allowed: auto, symlink, copy`);
  }
  return opts;
}

function printHelp() {
  console.log(
    [
      'Usage: node plug.js <install|uninstall|status> [options]',
      '',
      'Commands:',
      '  install [-w <workspace>] [--copilot] [--agents all|none|a,b] [--no-gardener] [--with-hooks] [--mode auto|symlink|copy]',
      '  uninstall [-w <workspace>] [--copilot]',
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
