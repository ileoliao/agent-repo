import { AgentDef } from './team';
import { Policy, decideCommand } from './policy';
import { exec } from './exec';

export interface WakeResult {
  wake: boolean;
  /** Passed to the agent as work-item context, so it does not have to re-run detection. */
  context?: string;
  /** Set when the check itself is broken; the human is alerted and the model is not woken. */
  error?: string;
}

/**
 * Zero-token gate for scheduled runs. The check is a skill script; the runtime only reads its exit code:
 *   0     -> something to handle: wake the agent, stdout becomes context
 *   1     -> nothing to do: no model call at all
 *   other -> the check is broken: alert, do not wake (an LLM can't fix a broken probe)
 * The command must pass the agent's policy like any other command.
 */
export async function checkWake(
  root: string,
  agent: AgentDef,
  policy: Policy,
  extraAllow: string[],
  secrets: Record<string, string>
): Promise<WakeResult> {
  if (!agent.wakeIf) {
    return { wake: true };
  }
  const gate = decideCommand(policy, agent.wakeIf, extraAllow);
  if (gate.decision !== 'allow') {
    return { wake: false, error: `loop.wakeIf refused by policy (${gate.rule}): ${agent.wakeIf}` };
  }
  const r = await exec(agent.wakeIf, {
    cwd: root, timeoutSec: policy.commandTimeoutSec, maxOutputBytes: policy.maxOutputBytes, secrets
  });
  if (r.code === 0) {
    return { wake: true, context: `Pre-check \`${agent.wakeIf}\` found something to handle. Its output:\n${r.text}` };
  }
  if (r.code === 1) {
    return { wake: false };
  }
  return { wake: false, error: `loop.wakeIf failed (${r.code === null ? 'timeout' : `exit ${r.code}`}): ${r.text.slice(0, 800)}` };
}
