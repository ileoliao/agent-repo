import * as vscode from 'vscode';
import { AgentDef, SkillDef } from './team';
import { Policy, skillScriptRule } from './policy';
import { PlainMsg, PlainPart, WorkItem, audit, getGate, loadCheckpoint, saveCheckpoint } from './queue';
import { redact } from './exec';
import { buildTools, runTool, ToolOutcome } from './tools';

export interface RunDeps {
  root: string;
  team: Map<string, AgentDef>;
  skills: Map<string, SkillDef>;
  policy: Policy;
  model: vscode.LanguageModelChat;
  secrets: Record<string, string>;
  maxSteps: number;
  maxHops: number;
  out: vscode.OutputChannel;
  token: vscode.CancellationToken;
}

export interface RunResult {
  /** done | blocked | nothing_to_do | waiting | max_steps | stalled | cancelled | error */
  status: string;
  summary?: string;
  steps: number;
  gateId?: string;
}

const RUNTIME_RULES = `# Runtime rules (Loop Runner)
You run unattended inside a policy. The human is not watching this conversation, but you can reach them.
- Your capabilities come from your skills. Follow their SKILL.md instructions; their scripts are pre-approved.
- A tool result starting with REFUSED is final. Do not retry it. Find another route, ask_human, or finish as blocked.
- When you cannot decide responsibly on your own, use ask_human rather than guessing. You will continue this same conversation once they answer.
- Actions that need human sign-off go through request_approval.
- Hand work outside your role to a teammate with handoff, including all context they need.
- Commands are non-interactive. Never start servers, watchers or anything that does not exit.
- Keep going until the work item is resolved, then call finish. If there is nothing to do, finish with nothing_to_do.`;

export function buildPrompt(agent: AgentDef, item: WorkItem, deps: Pick<RunDeps, 'team' | 'skills'>): string {
  const parts = [RUNTIME_RULES, `# Your role: ${agent.name}\n${agent.description}\n\n${agent.body}`];
  if (agent.skills.length) {
    parts.push('# Your skills');
    for (const s of agent.skills) {
      const sk = deps.skills.get(s);
      if (sk) { parts.push(`## Skill: ${sk.name}\nDirectory: ${sk.relDir}\n${sk.description}\n\n${sk.body}`); }
    }
  }
  if (agent.handoffs.length) {
    parts.push('# Teammates you can hand off to\n' + agent.handoffs.map(h => `- ${h}: ${deps.team.get(h)?.description ?? ''}`).join('\n'));
  }
  parts.push(`# Work item ${item.id}\nfrom: ${item.from} | chain: ${item.chainId} | hop: ${item.hop}\n\n${item.task}` +
    (item.context ? `\n\n## Context\n${item.context}` : ''));
  return parts.join('\n\n');
}

// ---- plain <-> vscode message conversion (the plain form is what checkpoints store) ----
function toVscode(m: PlainMsg): vscode.LanguageModelChatMessage {
  const parts = m.parts.map(p =>
    p.t === 'text' ? new vscode.LanguageModelTextPart(p.v)
      : p.t === 'call' ? new vscode.LanguageModelToolCallPart(p.callId, p.name, p.input as object)
        : new vscode.LanguageModelToolResultPart(p.callId, [new vscode.LanguageModelTextPart(p.text)]));
  return m.role === 'user'
    ? vscode.LanguageModelChatMessage.User(parts as (vscode.LanguageModelTextPart | vscode.LanguageModelToolResultPart)[])
    : vscode.LanguageModelChatMessage.Assistant(parts as (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[]);
}

export async function runItem(item: WorkItem, deps: RunDeps): Promise<RunResult> {
  const agent = deps.team.get(item.agent)!;
  const extraAllow = agent.skills
    .map(s => deps.skills.get(s))
    .filter((s): s is SkillDef => !!s)
    .map(s => skillScriptRule(s.relDir));
  const tools = buildTools(agent);
  const maxSteps = agent.maxSteps ?? deps.maxSteps;
  const log = (ev: Record<string, unknown>) => audit(deps.root, item.chainId, { agent: agent.name, itemId: item.id, ...ev });

  let transcript: PlainMsg[];
  let step = 0;

  // `limit` is raised on a gate resume so the answer always reaches the model (one more request).
  let limit = maxSteps;
  const cp = loadCheckpoint(deps.root, item.id);
  if (cp && (item.resumeGate || !cp.parkedCallId)) {
    // Continue the same conversation: after a gate (outcome becomes the parked call's result), or after an
    // interrupted run (end-of-turn checkpoint, nothing to add). Re-running from scratch would repeat side effects.
    transcript = cp.messages;
    step = cp.step;
    if (cp.parkedCallId) {
      const gate = item.resumeGate ? getGate(deps.root, item.resumeGate) : undefined;
      if (!gate || gate.outcome === undefined) {
        return { status: 'error', summary: `cannot resume: checkpoint or gate outcome missing (${item.resumeGate})`, steps: 0 };
      }
      transcript.push({
        role: 'user',
        parts: cp.turnResults.map(r => ({ t: 'result', callId: r.callId, text: r.callId === cp.parkedCallId ? gate.outcome! : r.text }))
      });
      limit = Math.max(maxSteps, step + 1);
      deps.out.appendLine(`\n▶ ${agent.name} resumes ${item.id} after ${gate.kind} ${gate.id}`);
      log({ type: 'resume', gateId: gate.id, kind: gate.kind, outcome: gate.outcome.slice(0, 2000) });
    } else {
      deps.out.appendLine(`\n▶ ${agent.name} continues ${item.id} from its last completed step (${step})`);
      log({ type: 'resume', from: 'checkpoint', step });
    }
  } else if (item.resumeGate) {
    return { status: 'error', summary: `cannot resume: checkpoint or gate outcome missing (${item.resumeGate})`, steps: 0 };
  } else {
    transcript = [{ role: 'user', parts: [{ t: 'text', v: buildPrompt(agent, item, deps) }] }];
    deps.out.appendLine(`\n▶ ${agent.name} ← ${item.from} | ${item.id} | ${deps.model.family}`);
    log({ type: 'start', from: item.from, hop: item.hop, task: item.task, model: deps.model.id });
  }

  let finished: { status: string; summary: string } | undefined;
  let nudges = 0;

  try {
    while (!finished && step < limit && !deps.token.isCancellationRequested) {
      step++;
      const t0 = Date.now();
      // Auto, not Required: Copilot rejects Required with more than one tool, and it does so inside the
      // response stream, so a sendRequest-level fallback never sees it. A text-only reply is nudged below.
      const response = await deps.model.sendRequest(transcript.map(toVscode), {
        tools, toolMode: vscode.LanguageModelChatToolMode.Auto, justification: `Loop Runner: ${agent.name} work item ${item.id}`
      }, deps.token);
      const assistant: PlainPart[] = [];
      const calls: { callId: string; name: string; input: any }[] = [];
      let text = '';
      for await (const part of response.stream) {
        if (part instanceof vscode.LanguageModelTextPart) {
          text += part.value;
          assistant.push({ t: 'text', v: part.value });
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          calls.push({ callId: part.callId, name: part.name, input: part.input });
          assistant.push({ t: 'call', callId: part.callId, name: part.name, input: part.input });
        }
      }
      if (text.trim()) { deps.out.appendLine(`  [${step}] ${text.trim()}`); }
      log({ type: 'model', step, ms: Date.now() - t0, text, calls: calls.map(c => ({ name: c.name, input: c.input })) });
      transcript.push({ role: 'assistant', parts: assistant });

      if (calls.length === 0) {
        if (++nudges > 2) { break; }
        transcript.push({ role: 'user', parts: [{ t: 'text', v: 'Use a tool, or call finish.' }] });
        continue;
      }

      const results: { callId: string; text: string }[] = [];
      let parked: { gateId: string; callId: string } | undefined;
      for (const call of calls) {
        const t1 = Date.now();
        let o: ToolOutcome;
        if (parked && (call.name === 'ask_human' || call.name === 'request_approval')) {
          o = { text: 'Not sent: only one human gate per turn. Ask again after the first is resolved.' };
        } else {
          try {
            o = await runTool(call.name, call.input, {
              root: deps.root, agent, team: deps.team, item, policy: deps.policy, extraAllow,
              secrets: deps.secrets, maxHops: deps.maxHops, token: deps.token
            });
          } catch (e: any) {
            o = { text: redact(`ERROR: ${e?.message ?? String(e)}`, deps.secrets) };
          }
        }
        deps.out.appendLine(`    ${call.name} ${brief(call.input)} → ${o.decision ?? ''} ${(o.park ? `parked on ${o.park}` : o.text).split('\n')[0].slice(0, 100)}`);
        log({ type: 'tool', step, name: call.name, input: call.input, decision: o.decision, gateId: o.park, ms: Date.now() - t1, result: o.text.slice(0, 2000) });
        results.push({ callId: call.callId, text: o.text });
        if (o.park && !parked) { parked = { gateId: o.park, callId: call.callId }; }
        if (o.finished) { finished = o.finished; }
      }

      if (parked) {
        // Snapshot the conversation; the gate's outcome becomes this call's result on resume.
        saveCheckpoint(deps.root, { itemId: item.id, gateId: parked.gateId, messages: transcript, turnResults: results, parkedCallId: parked.callId, step });
        log({ type: 'park', step, gateId: parked.gateId });
        deps.out.appendLine(`⏸ ${agent.name} waiting on ${parked.gateId}`);
        return { status: 'waiting', steps: step, gateId: parked.gateId };
      }
      transcript.push({ role: 'user', parts: results.map(r => ({ t: 'result' as const, callId: r.callId, text: r.text })) });
      // End-of-turn snapshot so an interrupted or rate-limited item continues here instead of starting over.
      if (!finished) { saveCheckpoint(deps.root, { itemId: item.id, gateId: '', messages: transcript, turnResults: [], parkedCallId: '', step }); }
    }
  } catch (e: any) {
    // Copilot names its errors (ChatRateLimited, ChatQuotaExceeded); keep the name so they can be classified.
    const named = e?.name && e.name !== 'Error' && !String(e?.message ?? '').includes(e.name);
    const msg = e instanceof vscode.LanguageModelError ? `${e.code}: ${e.message}` : `${named ? `${e.name}: ` : ''}${e?.message ?? String(e)}`;
    if (deps.token.isCancellationRequested) {
      deps.out.appendLine(`  !! cancelled: ${msg}`);
      log({ type: 'error', step, message: msg, cancelled: true });
      return { status: 'cancelled', summary: msg, steps: step };
    }
    deps.out.appendLine(`  !! ${msg}`);
    log({ type: 'error', step, message: msg });
    return { status: 'error', summary: msg, steps: step };
  }

  const status = finished?.status ?? (deps.token.isCancellationRequested ? 'cancelled' : step >= limit ? 'max_steps' : 'stalled');
  log({ type: 'end', step, status, summary: finished?.summary });
  deps.out.appendLine(`■ ${agent.name}: ${status}${finished ? ` — ${finished.summary}` : ''}`);
  return { status, summary: finished?.summary, steps: step };
}

function brief(input: unknown): string {
  const s = JSON.stringify(input);
  return s.length > 100 ? s.slice(0, 97) + '...' : s;
}
