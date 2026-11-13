#!/usr/bin/env python3
"""Plug or unplug harbor-team-kb into any Harbor Mate workspace and/or VS Code Copilot.

Zero external dependencies (Python 3 stdlib only).

Examples:
  # Plug into a Harbor Mate workspace (symlink skills + wire agents + optional weekly gardener)
  python3 plug.py install --workspace /path/to/mate-workspace --agents techlead,sentinel --with-gardener

  # Plug into VS Code Copilot personal skills (~/.copilot/skills/team-kb)
  python3 plug.py install --copilot

  # Check health & wiring
  python3 plug.py status --workspace /path/to/mate-workspace

  # Cleanly unplug without leaving residue
  python3 plug.py uninstall --workspace /path/to/mate-workspace
"""
import argparse
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys

KB_REPO_ROOT = os.path.dirname(os.path.abspath(__file__))
MARKER_START = '<!-- harbor-team-kb:start -->'
MARKER_END = '<!-- harbor-team-kb:end -->'
APPROVE_RULE = r'team-kb-publish/scripts/publish\.py'

AGENT_SNIPPET = f"""{MARKER_START}
## Shared Team Knowledge (`team-kb`)

Consult `team-kb` (`redlines` before unfamiliar service changes; `search` -> `get` when diagnosing signals) and propose verified reusable lessons via `.loop/outbox/kb/` + `request_approval` (`wait: false`).
{MARKER_END}"""


class PlugError(Exception):
    pass


def remove_existing_link_or_dir(target):
    if os.path.islink(target) or os.path.isfile(target):
        os.unlink(target)
    elif os.path.isdir(target):
        shutil.rmtree(target)


def install_skill_dir(src_dir, dst_dir, mode):
    os.makedirs(os.path.dirname(dst_dir), exist_ok=True)
    remove_existing_link_or_dir(dst_dir)
    if mode == 'symlink':
        os.symlink(src_dir, dst_dir)
    else:
        shutil.copytree(src_dir, dst_dir)


def split_frontmatter(raw):
    text = raw.replace('\r\n', '\n')
    if not text.startswith('---\n'):
        return None, text
    end = text.find('\n---\n', 4)
    if end == -1:
        return None, text
    return text[4:end], text[end + 5:]


def add_skill_to_agent_text(raw, skill_name='team-kb'):
    fm, body = split_frontmatter(raw)
    if fm is None:
        return raw, False
    lines = fm.split('\n')
    loop_idx = next((i for i, l in enumerate(lines) if re.match(r'^loop:\s*(#.*)?$', l)), None)
    if loop_idx is None:
        return raw, False

    changed = False
    i = loop_idx + 1
    skills_line_idx = None
    while i < len(lines):
        line = lines[i]
        if line.strip() and not line.startswith(' ') and not line.startswith('\t') and not line.lstrip().startswith('#'):
            break
        if re.match(r'^\s{2}skills\s*:', line):
            skills_line_idx = i
            break
        i += 1

    if skills_line_idx is not None:
        line = lines[skills_line_idx]
        m_inline = re.match(r'^(\s*skills\s*:\s*\[)(.*?)(\]\s*(?:#.*)?)$', line)
        if m_inline:
            prefix, inner, suffix = m_inline.groups()
            items = [x.strip() for x in inner.split(',') if x.strip()]
            if skill_name not in items:
                items.append(skill_name)
                lines[skills_line_idx] = f'{prefix}{", ".join(items)}{suffix}'
                changed = True
        else:
            j = skills_line_idx + 1
            existing = []
            while j < len(lines) and re.match(r'^\s{4,}-\s+\S+', lines[j]):
                existing.append(re.sub(r'^\s*-\s+', '', lines[j]).strip())
                j += 1
            if skill_name not in existing:
                lines.insert(j, f'    - {skill_name}')
                changed = True
    else:
        lines.insert(loop_idx + 1, f'  skills: [{skill_name}]')
        changed = True

    if MARKER_START not in body:
        body = body.rstrip() + '\n\n' + AGENT_SNIPPET + '\n'
        changed = True

    if not changed:
        return raw, False
    return '---\n' + '\n'.join(lines) + '\n---\n' + body, True


def remove_skill_from_agent_text(raw, skill_name='team-kb'):
    fm, body = split_frontmatter(raw)
    if fm is None:
        return raw, False
    lines = fm.split('\n')
    changed = False

    new_lines = []
    i = 0
    while i < len(lines):
        line = lines[i]
        m_inline = re.match(r'^(\s*skills\s*:\s*\[)(.*?)(\]\s*(?:#.*)?)$', line)
        if m_inline:
            prefix, inner, suffix = m_inline.groups()
            items = [x.strip() for x in inner.split(',') if x.strip()]
            if skill_name in items:
                items = [x for x in items if x != skill_name]
                changed = True
                if items:
                    new_lines.append(f'{prefix}{", ".join(items)}{suffix}')
                i += 1
                continue
        if re.match(r'^\s{2}skills\s*:\s*$', line):
            j = i + 1
            kept = []
            had_target = False
            while j < len(lines) and re.match(r'^\s{4,}-\s+\S+', lines[j]):
                val = re.sub(r'^\s*-\s+', '', lines[j]).strip()
                if val == skill_name:
                    had_target = True
                else:
                    kept.append(lines[j])
                j += 1
            if had_target:
                changed = True
                if kept:
                    new_lines.append(line)
                    new_lines.extend(kept)
                i = j
                continue
        new_lines.append(line)
        i += 1

    if MARKER_START in body and MARKER_END in body:
        pattern = re.compile(r'\n*' + re.escape(MARKER_START) + r'[\s\S]*?' + re.escape(MARKER_END) + r'\n*')
        body = pattern.sub('\n', body).rstrip() + '\n'
        changed = True

    if not changed:
        return raw, False
    return '---\n' + '\n'.join(new_lines) + '\n---\n' + body, True


def patch_standard_policy(workspace, install=True):
    policy_path = os.path.join(workspace, '.loop', 'policy.json')
    if not os.path.isfile(policy_path):
        return False
    try:
        with open(policy_path, encoding='utf-8') as f:
            data = json.load(f)
    except ValueError:
        return False
    if data.get('profile') != 'standard':
        return False
    approve = list(data.get('approveCommands') or [])
    if install and APPROVE_RULE not in approve:
        approve.append(APPROVE_RULE)
        data['approveCommands'] = approve
    elif not install and APPROVE_RULE in approve:
        approve = [r for r in approve if r != APPROVE_RULE]
        data['approveCommands'] = approve
    else:
        return False
    with open(policy_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write('\n')
    return True


def select_agent_files(agents_dir, spec):
    if not spec or not os.path.isdir(agents_dir):
        return []
    wanted = [x.strip() for x in spec.split(',') if x.strip()]
    all_files = sorted(f for f in os.listdir(agents_dir) if f.endswith('.agent.md'))
    if wanted == ['all']:
        return [os.path.join(agents_dir, f) for f in all_files if f != 'kb-gardener.agent.md']
    selected = []
    for name in wanted:
        fname = name if name.endswith('.agent.md') else f'{name}.agent.md'
        p = os.path.join(agents_dir, fname)
        if not os.path.isfile(p):
            raise PlugError(f'Agent file not found: {p}')
        selected.append(p)
    return selected


def cmd_install(a):
    mode = a.mode
    if mode == 'auto':
        mode = 'copy' if os.name == 'nt' else 'symlink'
    actions = []

    if a.workspace:
        ws = os.path.abspath(os.path.expanduser(a.workspace))
        if not os.path.isdir(ws):
            raise PlugError(f'Workspace directory does not exist: {ws}')
        skills_base = os.path.join(ws, '.github', 'skills')
        for sk in ('team-kb', 'team-kb-publish'):
            src = os.path.join(KB_REPO_ROOT, 'skills', sk)
            dst = os.path.join(skills_base, sk)
            install_skill_dir(src, dst, mode)
            actions.append(f'installed skill {sk} ({mode}) -> {dst}')

        ptr_file = os.path.join(ws, '.loop', 'outbox', 'kb', '.kb_root')
        if mode == 'copy':
            os.makedirs(os.path.dirname(ptr_file), exist_ok=True)
            with open(ptr_file, 'w', encoding='utf-8') as f:
                f.write(KB_REPO_ROOT + '\n')
            actions.append(f'wrote KB root pointer -> {ptr_file}')
        elif os.path.isfile(ptr_file):
            os.remove(ptr_file)

        if patch_standard_policy(ws, install=True):
            actions.append('added publish.py approval gate to .loop/policy.json (standard profile)')

        agents_dir = os.path.join(ws, '.github', 'agents')
        for af in select_agent_files(agents_dir, a.agents):
            with open(af, encoding='utf-8') as f:
                raw = f.read()
            updated, changed = add_skill_to_agent_text(raw, 'team-kb')
            if changed:
                with open(af, 'w', encoding='utf-8') as f:
                    f.write(updated)
                actions.append(f'wired team-kb into {os.path.basename(af)}')

        if a.with_gardener:
            os.makedirs(agents_dir, exist_ok=True)
            dst_g = os.path.join(agents_dir, 'kb-gardener.agent.md')
            shutil.copyfile(os.path.join(KB_REPO_ROOT, 'agents', 'kb-gardener.agent.md'), dst_g)
            actions.append(f'installed weekly maintenance mate -> {dst_g}')

        if a.with_hooks:
            hooks_dir = os.path.join(ws, '.github', 'hooks')
            os.makedirs(hooks_dir, exist_ok=True)
            dst_h = os.path.join(hooks_dir, 'harbor-kb.json')
            shutil.copyfile(os.path.join(KB_REPO_ROOT, 'hooks', 'harbor-kb.hooks.json'), dst_h)
            actions.append(f'installed Copilot sessionStart redline hook -> {dst_h}')

    if a.copilot:
        copilot_skills = os.path.join(os.path.expanduser('~'), '.copilot', 'skills')
        for sk in ('team-kb', 'team-kb-publish'):
            install_skill_dir(os.path.join(KB_REPO_ROOT, 'skills', sk), os.path.join(copilot_skills, sk), mode)
            actions.append(f'installed Copilot user skill {sk} ({mode})')
        default_ptr = os.path.join(os.path.expanduser('~'), '.cache', 'harbor-kb', 'default_root')
        os.makedirs(os.path.dirname(default_ptr), exist_ok=True)
        with open(default_ptr, 'w', encoding='utf-8') as f:
            f.write(KB_REPO_ROOT + '\n')

    if not a.workspace and not a.copilot:
        raise PlugError('Specify --workspace <path> and/or --copilot.')

    kb_py = os.path.join(KB_REPO_ROOT, 'skills', 'team-kb', 'scripts', 'kb.py')
    subprocess.run([sys.executable, kb_py, '--kb-root', KB_REPO_ROOT, 'stats'], check=True, stdout=subprocess.PIPE)

    if a.json:
        print(json.dumps({'status': 'installed', 'mode': mode, 'kb_root': KB_REPO_ROOT, 'actions': actions}, indent=2))
    else:
        for act in actions:
            print(f'✓ {act}')


def cmd_uninstall(a):
    actions = []
    if a.workspace:
        ws = os.path.abspath(os.path.expanduser(a.workspace))
        for sk in ('team-kb', 'team-kb-publish'):
            dst = os.path.join(ws, '.github', 'skills', sk)
            if os.path.lexists(dst):
                remove_existing_link_or_dir(dst)
                actions.append(f'removed skill {sk} from {ws}')
        ptr_file = os.path.join(ws, '.loop', 'outbox', 'kb', '.kb_root')
        if os.path.isfile(ptr_file):
            os.remove(ptr_file)
            actions.append('removed .kb_root pointer')

        gardener = os.path.join(ws, '.github', 'agents', 'kb-gardener.agent.md')
        if os.path.isfile(gardener):
            os.remove(gardener)
            actions.append('removed kb-gardener.agent.md')

        hook_f = os.path.join(ws, '.github', 'hooks', 'harbor-kb.json')
        if os.path.isfile(hook_f):
            os.remove(hook_f)
            actions.append('removed .github/hooks/harbor-kb.json')

        agents_dir = os.path.join(ws, '.github', 'agents')
        if os.path.isdir(agents_dir):
            for fn in sorted(os.listdir(agents_dir)):
                if not fn.endswith('.agent.md'):
                    continue
                af = os.path.join(agents_dir, fn)
                with open(af, encoding='utf-8') as f:
                    raw = f.read()
                cleaned, changed = remove_skill_from_agent_text(raw, 'team-kb')
                if changed:
                    with open(af, 'w', encoding='utf-8') as f:
                        f.write(cleaned)
                    actions.append(f'unwired team-kb from {fn}')

        if patch_standard_policy(ws, install=False):
            actions.append('removed publish.py rule from .loop/policy.json')

    if a.copilot:
        copilot_skills = os.path.join(os.path.expanduser('~'), '.copilot', 'skills')
        for sk in ('team-kb', 'team-kb-publish'):
            dst = os.path.join(copilot_skills, sk)
            if os.path.lexists(dst):
                remove_existing_link_or_dir(dst)
                actions.append(f'removed Copilot user skill {sk}')

    if not a.workspace and not a.copilot:
        raise PlugError('Specify --workspace <path> and/or --copilot.')

    if a.json:
        print(json.dumps({'status': 'uninstalled', 'actions': actions}, indent=2))
    else:
        for act in actions:
            print(f'✓ {act}')


def check_fts5():
    conn = sqlite3.connect(':memory:')
    try:
        conn.execute('CREATE VIRTUAL TABLE t USING fts5(x)')
        return True
    except sqlite3.Error:
        return False
    finally:
        conn.close()


def cmd_status(a):
    checks = {'fts5_supported': check_fts5(), 'kb_root': KB_REPO_ROOT}
    kb_py_default = os.path.join(KB_REPO_ROOT, 'skills', 'team-kb', 'scripts', 'kb.py')
    ws_checks = None

    if a.workspace:
        ws = os.path.abspath(os.path.expanduser(a.workspace))
        sk_dir = os.path.join(ws, '.github', 'skills', 'team-kb')
        pub_dir = os.path.join(ws, '.github', 'skills', 'team-kb-publish')
        wired_agents = []
        agents_dir = os.path.join(ws, '.github', 'agents')
        if os.path.isdir(agents_dir):
            for fn in sorted(os.listdir(agents_dir)):
                if fn.endswith('.agent.md'):
                    with open(os.path.join(agents_dir, fn), encoding='utf-8') as f:
                        txt = f.read()
                    if 'team-kb' in txt:
                        wired_agents.append(fn)
        ws_checks = {
            'workspace': ws,
            'team_kb_installed': os.path.isdir(sk_dir) and os.path.isfile(os.path.join(sk_dir, 'SKILL.md')),
            'team_kb_mode': 'symlink' if os.path.islink(sk_dir) else ('copy' if os.path.isdir(sk_dir) else 'absent'),
            'publish_installed': os.path.isdir(pub_dir) and os.path.isfile(os.path.join(pub_dir, 'SKILL.md')),
            'wired_agents': wired_agents,
            'gardener_installed': os.path.isfile(os.path.join(ws, '.github', 'agents', 'kb-gardener.agent.md')),
            'hook_installed': os.path.isfile(os.path.join(ws, '.github', 'hooks', 'harbor-kb.json')),
        }
        if ws_checks['team_kb_installed']:
            run_res = subprocess.run(
                [sys.executable, os.path.join('.github', 'skills', 'team-kb', 'scripts', 'kb.py'), '--json', 'stats'],
                cwd=ws, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=15
            )
            ws_checks['runtime_probe_ok'] = (run_res.returncode == 0)
            if run_res.returncode == 0:
                ws_checks['stats'] = json.loads(run_res.stdout)
            else:
                ws_checks['runtime_error'] = run_res.stderr.strip()
    else:
        run_res = subprocess.run(
            [sys.executable, kb_py_default, '--kb-root', KB_REPO_ROOT, '--json', 'stats'],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=15
        )
        if run_res.returncode == 0:
            checks['stats'] = json.loads(run_res.stdout)

    checks['workspace_status'] = ws_checks
    ok = checks['fts5_supported'] and (ws_checks is None or (ws_checks['team_kb_installed'] and ws_checks.get('runtime_probe_ok', False)))
    checks['healthy'] = ok

    if a.json:
        print(json.dumps(checks, ensure_ascii=False, indent=2))
    else:
        print(f'FTS5 supported: {checks["fts5_supported"]}')
        print(f'KB root:        {KB_REPO_ROOT}')
        if ws_checks:
            print(f'Workspace:      {ws_checks["workspace"]}')
            print(f'Skill status:   team-kb={ws_checks["team_kb_mode"]}, publish={ws_checks["publish_installed"]}')
            print(f'Wired mates:    {", ".join(ws_checks["wired_agents"]) or "(none)"}')
            print(f'Runtime probe:  {"OK" if ws_checks.get("runtime_probe_ok") else "FAILED"}')
    if not ok:
        sys.exit(2)


def main():
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument('--json', action='store_true', default=argparse.SUPPRESS, help='Output JSON')

    ap = argparse.ArgumentParser(description='Plug or unplug harbor-team-kb for Harbor Mate & Copilot')
    ap.add_argument('--json', action='store_true', default=False, help='Output JSON')
    sub = ap.add_subparsers(dest='cmd', required=True)

    p = sub.add_parser('install', parents=[common], help='Install team-kb into a Harbor Mate workspace and/or Copilot')
    p.add_argument('--workspace', '-w', help='Path to Harbor Mate workspace')
    p.add_argument('--mode', choices=('auto', 'symlink', 'copy'), default='auto', help='Install mode (default: symlink on POSIX, copy on Windows)')
    p.add_argument('--agents', help='Comma-separated mate names to wire (e.g. sentinel,techlead or all)')
    p.add_argument('--with-gardener', action='store_true', help='Install weekly kb-gardener.agent.md mate')
    p.add_argument('--with-hooks', action='store_true', help='Install .github/hooks/harbor-kb.json sessionStart hook')
    p.add_argument('--copilot', action='store_true', help='Also install into ~/.copilot/skills/')

    p = sub.add_parser('uninstall', parents=[common], help='Cleanly unplug team-kb from a workspace and/or Copilot')
    p.add_argument('--workspace', '-w', help='Path to Harbor Mate workspace')
    p.add_argument('--copilot', action='store_true', help='Remove from ~/.copilot/skills/')

    p = sub.add_parser('status', parents=[common], help='Check pluggability, FTS5 support, and runtime resolution')
    p.add_argument('--workspace', '-w', help='Optional Harbor Mate workspace to verify')
    a = ap.parse_args()
    try:
        {'install': cmd_install, 'uninstall': cmd_uninstall, 'status': cmd_status}[a.cmd](a)
    except PlugError as e:
        print(f'plug: {e}', file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
