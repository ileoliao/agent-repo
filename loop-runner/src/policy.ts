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

export interface Policy {
  allowCommands: string[];
  denyCommands: string[];
  writablePaths: string[];
  protectedPaths: string[];
  commandTimeoutSec: number;
  maxOutputBytes: number;
}

export const DEFAULT_POLICY: Policy = {
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

export function loadPolicy(root: string, relPath: string): Policy {
  const p = path.join(root, relPath);
  if (!fs.existsSync(p)) {
    return DEFAULT_POLICY;
  }
  return { ...DEFAULT_POLICY, ...JSON.parse(fs.readFileSync(p, 'utf8')) };
}

/** Allow rule for running scripts that ship inside an assigned skill. */
export function skillScriptRule(relDir: string): string {
  const dir = relDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Interpreters: python/python3, py (Windows launcher), node, bash/sh, pwsh/powershell.
  return `^((python3?|py|node|bash|sh|pwsh|powershell)\\s+)?(\\./)?${dir}/scripts/`;
}

export function deniedBy(policy: Policy, command: string): string | undefined {
  return policy.denyCommands.find(rule => new RegExp(rule).test(command));
}

export function decideCommand(policy: Policy, command: string, extraAllow: string[] = []): { decision: Decision; rule?: string } {
  const deny = deniedBy(policy, command);
  if (deny) {
    return { decision: 'deny', rule: deny };
  }
  if (/\$\(|`/.test(command)) {
    return { decision: 'deny', rule: 'command substitution' };
  }
  const rules = [...policy.allowCommands, ...extraAllow];
  // Compound commands are split; every segment must be allowed.
  const parts = command.split(/&&|\|\||;|\|/).map(s => s.trim()).filter(Boolean);
  const ok = parts.every(part => rules.some(rule => new RegExp(rule).test(part)));
  return ok ? { decision: 'allow' } : { decision: 'deny', rule: 'no allow rule matched' };
}

export function decideWrite(policy: Policy, relPath: string): { decision: Decision; rule?: string } {
  const p = relPath.replace(/\\/g, '/');
  if (globMatch(OUTBOX, p)) {
    return { decision: 'allow', rule: OUTBOX };
  }
  for (const g of policy.protectedPaths) {
    if (globMatch(g, p)) { return { decision: 'deny', rule: g }; }
  }
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
