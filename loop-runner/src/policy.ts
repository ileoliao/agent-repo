import * as fs from 'fs';
import * as path from 'path';

/**
 * Approval policy. Decisions come from files, never from a blocking dialog.
 *   allow -> run now
 *   deny  -> refused; the refusal goes back to the model as a tool result
 * Anything that genuinely needs a human goes through the request_approval tool,
 * which parks the action asynchronously instead of stalling the loop.
 */
export type Decision = 'allow' | 'deny';

/**
 * How much the policy constrains the model. The line is drawn by consequence, not by an allowlist:
 *   strict   allowlist + deny + hard rejects (the behaviour of every hand-written policy file without `profile`)
 *   standard anything goes except hard rejects, deny rules, and `approveCommands` (irreversible or outward: needs a human)
 *   trusted  like standard with no approve list: only deny rules and hard rejects
 */
export type Profile = 'strict' | 'standard' | 'trusted';
export const PROFILES: Profile[] = ['strict', 'standard', 'trusted'];

export interface Policy {
  /** Absent = strict. */
  profile?: Profile;
  allowCommands: string[];
  denyCommands: string[];
  /** standard/trusted: a command matching one (whole or any segment) is refused until a human approves it via request_approval. */
  approveCommands: string[];
  writablePaths: string[];
  protectedPaths: string[];
  commandTimeoutSec: number;
  maxOutputBytes: number;
}

export const DEFAULT_POLICY: Policy = {
  profile: 'strict',
  approveCommands: [],
  allowCommands: [
    '^git (status|diff|log|show|branch|add|commit|checkout -b|switch -c|fetch)\\b',
    '^(ls|cat|head|tail|wc|grep|rg|find|jq)\\b',
    '^(npm|pnpm|yarn) (test|run (build|lint|test))\\b',
    '^(go (build|test|vet)|dotnet (build|test)|mvn -q (test|verify))\\b'
  ],
  denyCommands: [
    '\\brm\\s+-[a-z]*r',
    '\\bgit (push|reset --hard|clean)\\b',
    '\\b(curl|wget|ssh|scp|nc)\\b',
    '\\bsudo\\b',
    '>\\s*/'
  ],
  writablePaths: ['src/**', 'test/**', 'tests/**', 'docs/**'],
  protectedPaths: ['.loop/**', '.git/**', '.github/**', '.vscode/**', '**/*.env', '**/secrets/**'],
  commandTimeoutSec: 180,
  maxOutputBytes: 16000
};

/** Agents may always write drafts here, even though .loop/** is otherwise protected. */
export const OUTBOX = '.loop/outbox/**';
/** Throwaway scripts and spilled command output. Always writable, in every profile; housekeeping deletes old files. */
export const SCRATCH = '.loop/scratch/**';

/** Irreversible or outward actions: standard asks a human first. Matched against the whole command and each segment. */
export const STANDARD_APPROVE: string[] = [
  '\\bgit push\\b',
  '\\bgit\\b(?:\\s+-\\S+(?:\\s+[^\\s-]\\S*)?)*\\s+push\\b', // git -C dir push
  '\\b(npm|pnpm|yarn) publish\\b',
  '\\b(kubectl|helm|terraform)\\s+(apply|delete|destroy|upgrade|install)\\b',
  '\\bdocker push\\b',
  '\\b(curl|wget)\\b.*(\\s-X\\s*(POST|PUT|PATCH|DELETE)|\\s(-d|--data[\\w-]*|-F|--form|-T|--upload-file)\\b)',
  '\\b(ssh|scp|rsync|nc)\\b',
  '\\brm\\s+.*(\\s)(/|~)'
];
/** Deny in standard and trusted. curl/wget/ssh/scp/nc moved to STANDARD_APPROVE. */
export const OPEN_DENY: string[] = [
  '\\bsudo\\b',
  '\\bgit (reset --hard|clean)\\b',
  '>\\s*/',
  // Recursive rm of / or ~ themselves (flags before or after the target).
  '\\brm\\s+(?:-\\S+\\s+)*(?:-\\S*[rR]\\S*\\s+(?:-\\S+\\s+)*(?:--\\s+)?(?:/\\*?|~/?\\*?|\\$HOME/?)|(?:--\\s+)?(?:/\\*?|~/?\\*?|\\$HOME/?)(?:\\s+-\\S+)*\\s+-\\S*[rR]\\S*)(?=\\s|$|[;&|])'
];

/** The built-in defaults of a profile. A policy file that names a profile starts from these. */
export function profileDefaults(profile: Profile): Policy {
  if (profile === 'strict') return DEFAULT_POLICY;
  return { ...DEFAULT_POLICY, profile, denyCommands: OPEN_DENY, approveCommands: profile === 'standard' ? STANDARD_APPROVE : [] };
}

/** `defaultProfile` applies only when there is no policy file. A file without `profile` is strict. */
export function loadPolicy(root: string, relPath: string, defaultProfile: Profile = 'standard'): Policy {
  const p = path.join(root, relPath);
  if (!fs.existsSync(p)) {
    return profileDefaults(PROFILES.includes(defaultProfile) ? defaultProfile : 'standard');
  }
  const custom = JSON.parse(fs.readFileSync(p, 'utf8'));
  const profile: Profile = PROFILES.includes(custom.profile) ? custom.profile : 'strict';
  const base = profileDefaults(profile);
  // The protected paths are a floor: a policy can add to them but never remove one, so no policy lets an agent rewrite its own definition.
  return { ...base, ...custom, profile, protectedPaths: [...new Set([...DEFAULT_POLICY.protectedPaths, ...(Array.isArray(custom.protectedPaths) ? custom.protectedPaths : [])])] };
}

const isStrict = (policy: Policy) => (policy.profile ?? 'strict') === 'strict';

/** Every `harbor` command is allowed in every profile (still subject to deny rules and hard rejects). */
export const HARBOR_RULE = '^harbor(?=\\s|$)';

/** Allow rule for running scripts that ship inside an assigned skill. */
export function skillScriptRule(relDir: string): string {
  const dir = relDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Interpreters: python/python3, py (Windows launcher), node, bash/sh, pwsh/powershell.
  // No `..` segment anywhere in the command: `scripts/../../x` must not reach a script outside the skill.
  return `^(?!.*(?:^|[\\s/\\\\])\\.\\.(?:[/\\\\]|\\s|$))((python3?|py|node|bash|sh|pwsh|powershell)\\s+)?(\\./)?${dir}/scripts/`;
}

export function deniedBy(policy: Policy, command: string): string | undefined {
  return policy.denyCommands.find(rule => new RegExp(rule).test(command));
}

/**
 * Split a shell command into the pieces that actually run.
 * Separators: `&&`, `||`, `;`, `|`, a single `&` (bash background and cmd/PowerShell statement
 * separator), and newlines. Quoted text is not split. `>|` and `>&` stay attached to a redirect.
 */
export function commandSegments(command: string): string[] {
  const parts: string[] = [];
  let buf = '';
  let quote: '"' | "'" | null = null;
  const push = () => {
    const s = buf.trim();
    if (s) parts.push(s);
    buf = '';
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      buf += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; buf += c; continue; }
    if (c === '\\' && command[i + 1]) { buf += c + command[i + 1]; i++; continue; }
    if (c === '\n' || c === '\r') { push(); continue; }
    if (c === '&' && command[i + 1] === '&') { push(); i++; continue; }
    if (c === '|' && command[i + 1] === '|') { push(); i++; continue; }
    if ((c === '|' || c === '&') && command[i - 1] === '>') { buf += c; continue; }
    if (c === '&' || c === '|' || c === ';') { push(); continue; }
    buf += c;
  }
  push();
  return parts;
}

/** Paths a command would write via `>`, `>>`, `>|`, `&>`, or `>&file`. Fd dups (`>&1`) are skipped. */
export function redirectionTargets(command: string): string[] {
  const targets: string[] = [];
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '\\') { i++; continue; }
    const startsRedirect = c === '>' || (c === '&' && command[i + 1] === '>');
    if (!startsRedirect) continue;
    let j = i;
    if (command[j] === '&') j++;
    if (command[j] !== '>') continue;
    j++;
    if (command[j] === '>') j++;
    if (command[j] === '|') j++;
    if (command[j] === '&') {
      if (/\d/.test(command[j + 1] ?? '')) { i = j + 1; continue; }
      j++;
    }
    while (command[j] === ' ' || command[j] === '\t') j++;
    let target = '';
    if (command[j] === '"' || command[j] === "'") {
      const q = command[j++];
      while (j < command.length && command[j] !== q) target += command[j++];
    } else {
      while (j < command.length && !/[\s<>|&;]/.test(command[j])) target += command[j++];
    }
    if (target && !/^&\d+$/.test(target)) targets.push(target);
    i = Math.max(i, j - 1);
  }
  return targets;
}

function unsafeRedirect(policy: Policy, target: string): string | undefined {
  if (path.posix.isAbsolute(target) || path.win32.isAbsolute(target) || target.startsWith('~') || target.split(/[\\/]/).includes('..')) {
    return `redirect escapes workspace (${target})`;
  }
  const rel = target.replace(/\\/g, '/').replace(/^\.\//, '');
  const gate = decideWrite(policy, rel);
  if (gate.decision === 'deny' && gate.rule !== 'not in writablePaths') {
    return `redirect to protected path (${gate.rule})`;
  }
  return undefined;
}

/**
 * Rejects a human cannot approve away: deny rules, command substitution, and writes
 * (via redirection) into a protected path or outside the workspace.
 */
export function hardReject(policy: Policy, command: string): string | undefined {
  const deny = deniedBy(policy, command);
  if (deny) return deny;
  if (isStrict(policy) && /\$\(|`/.test(command)) return 'command substitution';
  for (const target of redirectionTargets(command)) {
    const reason = unsafeRedirect(policy, target);
    if (reason) return reason;
  }
  for (const part of commandSegments(command)) {
    const partDeny = deniedBy(policy, part);
    if (partDeny) return partDeny;
  }
  return undefined;
}

/** standard/trusted: the approve rule a command (whole, or any segment) matches. Strict has none. */
export function needsApproval(policy: Policy, command: string): string | undefined {
  if (isStrict(policy)) return undefined;
  const pieces = [command, ...commandSegments(command)];
  return (policy.approveCommands ?? []).find(rule => { const re = new RegExp(rule); return pieces.some(p => re.test(p)); });
}

export function decideCommand(policy: Policy, command: string, extraAllow: string[] = []): { decision: Decision; rule?: string; approval?: boolean } {
  const hard = hardReject(policy, command);
  if (hard) return { decision: 'deny', rule: hard };
  if (!isStrict(policy)) {
    const ask = needsApproval(policy, command);
    return ask ? { decision: 'deny', rule: ask, approval: true } : { decision: 'allow' };
  }
  const rules = [...policy.allowCommands, ...extraAllow, HARBOR_RULE];
  const parts = commandSegments(command);
  const ok = parts.every(part => rules.some(rule => new RegExp(rule).test(part)));
  return ok ? { decision: 'allow' } : { decision: 'deny', rule: 'no allow rule matched' };
}

/**
 * Whether the stored secrets may be injected into this command. strict: always (as before). standard/trusted: only when
 * every segment is a skill script or a harbor call and nothing is substituted, so a free-form script cannot print them.
 */
export function secretsAllowed(policy: Policy, command: string, extraAllow: string[]): boolean {
  if (isStrict(policy)) return true;
  if (/\$\(|`/.test(command)) return false;
  const rules = [...extraAllow, HARBOR_RULE].map(r => new RegExp(r));
  const parts = commandSegments(command);
  return parts.length > 0 && parts.every(part => rules.some(re => re.test(part)));
}

export function decideWrite(policy: Policy, relPath: string): { decision: Decision; rule?: string } {
  const p = relPath.replace(/\\/g, '/');
  if (globMatch(OUTBOX, p)) {
    return { decision: 'allow', rule: OUTBOX };
  }
  if (globMatch(SCRATCH, p)) {
    return { decision: 'allow', rule: SCRATCH };
  }
  for (const g of policy.protectedPaths) {
    if (globMatch(g, p)) { return { decision: 'deny', rule: g }; }
  }
  // standard/trusted: anywhere in the workspace except protected paths (writablePaths does not apply).
  if (!isStrict(policy)) { return { decision: 'allow', rule: 'workspace' }; }
  for (const g of policy.writablePaths) {
    if (globMatch(g, p)) { return { decision: 'allow', rule: g }; }
  }
  return { decision: 'deny', rule: 'not in writablePaths' };
}

export function globMatch(glob: string, p: string): boolean {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0001')
    .replace(/\*\*/g, '\u0002')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0001/g, '(?:.*/)?')
    .replace(/\u0002/g, '.*');
  return new RegExp('^' + re + '$').test(p);
}
