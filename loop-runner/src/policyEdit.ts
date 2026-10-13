import * as fs from 'fs';
import * as path from 'path';
import { Change } from './manage';
import { setLoopField } from './manage';
import { DEFAULT_POLICY, decideCommand, hardReject, loadPolicy, skillScriptRule } from './policy';
import { loadAllAgents, loadSkills, policyPathFor, skillsFor } from './team';

/**
 * One click to let a mate run one command that its policy refused because no rule allowed it. The human clicks; the
 * assistant never edits policy. The new rule is the exact command and nothing broader, it lives in that mate's own
 * policy file, and a command that a deny rule blocks is never unblocked here: that rule is a line someone drew on purpose.
 */
export interface AllowPlan { changes: Change[]; rule: string; file: string; shared: string[]; summary: string }

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');

export function planAllowCommand(root: string, agentName: string, command: string, defaultPolicy = '.loop/policy.json'): AllowPlan | { error: string } {
  const cmd = command.trim();
  if (!cmd || cmd.length > 500 || /[\r\n\0]/.test(cmd)) { return { error: 'That command cannot be allowed here: it is empty, too long or has line breaks.' }; }
  const all = loadAllAgents(root);
  const agent = all.get(agentName);
  if (!agent || !agent.inLoop) { return { error: `${agentName} is not a mate that runs on its own.` }; }

  const effective = policyPathFor(agent, undefined, defaultPolicy);
  let policy;
  try { policy = loadPolicy(root, effective); } catch (e: any) { return { error: `Its policy file ${effective} cannot be read: ${e?.message ?? e}` }; }
  const skills = loadSkills(root);
  const extra = skillsFor(agent).map(n => skills.get(n)).filter((s): s is NonNullable<typeof s> => !!s).map(s => skillScriptRule(s.relDir));
  const deny = hardReject(policy, cmd);
  if (deny) { return { error: `This command matches a deny rule (${deny}). Deny rules are limits you set on purpose, so they are not lifted with one click. Edit the policy file yourself if you really mean to.` }; }
  if (decideCommand(policy, cmd, extra).decision === 'allow') { return { error: 'This command is already allowed by its policy.' }; }

  const rule = `^${escapeRegex(cmd)}$`;
  // The mate's own file, so the rule does not widen what other mates may run.
  const own = agent.policy && agent.policy !== defaultPolicy ? agent.policy : `.loop/policies/${agent.name}.json`;
  const shared = [...all.values()].filter(a => a.name !== agent.name && a.inLoop && policyPathFor(a, undefined, defaultPolicy) === own).map(a => a.name);
  const abs = path.join(root, own);
  const before = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
  let json: any;
  if (before !== null) {
    try { json = JSON.parse(before); } catch { return { error: `${own} is not valid JSON, so it was not changed.` }; }
  } else {
    // A new file replaces the arrays it names, so start from what the mate runs under now.
    const base = fs.existsSync(path.join(root, effective)) ? JSON.parse(fs.readFileSync(path.join(root, effective), 'utf8')) : DEFAULT_POLICY;
    json = { ...base };
  }
  json.allowCommands = [...new Set([...(Array.isArray(json.allowCommands) ? json.allowCommands : DEFAULT_POLICY.allowCommands), rule])];
  const changes: Change[] = [{ file: own, before, after: JSON.stringify(json, null, 2) + '\n', summary: `allow \`${cmd}\` for ${agent.name}` }];
  if (!agent.policy || agent.policy !== own) {
    const af = path.join(root, agent.file);
    const text = fs.readFileSync(af, 'utf8');
    const after = setLoopField(text, 'policy', own);
    if (!after) { return { error: `Could not point ${agent.name} at its own policy file safely. Edit its file by hand.` }; }
    changes.push({ file: agent.file, before: text, after, summary: `${agent.name} uses ${own}` });
  }
  return { changes, rule, file: own, shared, summary: `Allow \`${cmd}\` for ${agent.name}` };
}
