import * as vscode from 'vscode';
import { AgentDef, SkillDef } from './team';
import { Policy, skillScriptRule } from './policy';
import { PlainMsg, PlainPart, WorkItem, audit, getGate, loadCheckpoint, saveCheckpoint } from './queue';
import { redact } from './exec';
import { buildTools, runTool, ToolOutcome } from './tools';
import { outputsFrom, wroteFromAudit } from './runs';
import { changedFiles, snapshotOutbox } from './outbox';
import { memoryFor } from './manage';
import { HumanMessage, formatForModel, markDelivered, pendingMessages } from './thread';
import { Agent, AgentMessage, AgentTool } from './vendor/pi-agent';
import { AssistantMessage, Message, createAssistantMessageEventStream } from './vendor/pi-agent/ai';

export interface RunDeps {
  root: string;
  team: Map<string, AgentDef>;
  skills: Map<string, SkillDef>;
  policy: Policy;
  model: vscode.LanguageModelChat;
  secrets: Record<string, string>;
  maxSteps: number;
  maxHops: number;
  /** Wall-clock cap for one run, counted from this call (so a resume gets a fresh allowance). Unset = none. */
  maxMs?: number;
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
- The human may send you a message while you work. It is an instruction from the person who owns this work: follow it within your policy. If it changes your task, say so in your next step and carry on from there.
- Keep going until the work item is resolved, then call finish. If there is nothing to do, finish with nothing_to_do.`;

export function buildPrompt(agent: AgentDef, item: WorkItem, deps: Pick<RunDeps, 'team' | 'skills'>, memory = '', human: HumanMessage[] = []): string {
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
  // Standing notes the human gave in conversation. Sits after the static parts and before the per-run item, so the prefix stays stable.
  if (memory.trim()) { parts.push(`# Standing instructions from the human (follow them in every run)\n${memory.trim()}`); }
  parts.push(`# Work item ${item.id}\nfrom: ${item.from} | chain: ${item.chainId} | hop: ${item.hop}\n\n${item.task}` +
    (item.context ? `\n\n## Context\n${item.context}` : ''));
  // Anything the human said before this run began comes last, after the per-run item, so the static prefix is untouched.
  if (human.length) { parts.push(formatForModel(human, 'start')); }
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

// ---- plain <-> pi message conversion. The plain form is what checkpoints store (stable, byte-identical replay). ----
const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const API = { api: 'vscode-lm', provider: 'copilot' } as const;

function plainToPi(plain: PlainMsg[], modelId: string): AgentMessage[] {
  const out: any[] = [];
  const names = new Map<string, string>();
  const ts = Date.now();
  for (const m of plain) {
    if (m.role === 'assistant') {
      const content: any[] = m.parts.flatMap((p): any[] => p.t === 'text' ? [{ type: 'text', text: p.v }]
        : p.t === 'call' ? (names.set(p.callId, p.name), [{ type: 'toolCall', id: p.callId, name: p.name, arguments: p.input }]) : []);
      const calls = m.parts.some(p => p.t === 'call');
      out.push({ role: 'assistant', content, ...API, model: modelId, usage: ZERO_USAGE, stopReason: calls ? 'toolUse' : 'stop', timestamp: ts });
      continue;
    }
    for (const p of m.parts) {
      if (p.t === 'result') {
        out.push({ role: 'toolResult', toolCallId: p.callId, toolName: names.get(p.callId) ?? 'tool', content: [{ type: 'text', text: p.text }], isError: false, timestamp: ts });
      } else if (p.t === 'text') {
        out.push({ role: 'user', content: [{ type: 'text', text: p.v }], timestamp: ts });
      }
    }
  }
  return out;
}

/** Inverse of plainToPi. Consecutive tool results become one user message, as the model has always seen them. */
function piToPlain(msgs: readonly (AgentMessage | Message)[]): PlainMsg[] {
  const out: PlainMsg[] = [];
  for (const m of msgs as any[]) {
    if (m.role === 'toolResult') {
      const text = (m.content ?? []).map((c: any) => c.text ?? '').join('');
      const last = out[out.length - 1];
      const part: PlainPart = { t: 'result', callId: m.toolCallId, text };
      if (last && last.role === 'user' && last.parts.every(p => p.t === 'result')) { last.parts.push(part); } else { out.push({ role: 'user', parts: [part] }); }
    } else if (m.role === 'assistant') {
      out.push({ role: 'assistant', parts: (m.content ?? []).flatMap((c: any): PlainPart[] =>
        c.type === 'text' ? [{ t: 'text', v: c.text }] : c.type === 'toolCall' ? [{ t: 'call', callId: c.id, name: c.name, input: c.arguments }] : []) });
    } else if (m.role === 'user') {
      const text = typeof m.content === 'string' ? m.content : (m.content ?? []).map((c: any) => c.text ?? '').join('');
      out.push({ role: 'user', parts: [{ t: 'text', v: text }] });
    }
  }
  return out;
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

  // What the human said and the model has been given. It is marked delivered only once the turn that carried it is done and
  // checkpointed, so an interruption in between delivers it again instead of losing it.
  const inFlight: { id: string; via: NonNullable<HumanMessage['via']> }[] = [];
  const commitHuman = () => {
    for (const via of ['start', 'turn', 'resume'] as const) {
      const ids = inFlight.filter(i => i.via === via).map(i => i.id);
      if (ids.length) { markDelivered(deps.root, agent.name, ids, { itemId: item.id, via }); }
    }
    inFlight.length = 0;
  };
  const claim = (msgs: HumanMessage[], via: NonNullable<HumanMessage['via']>) => {
    if (!msgs.length) { return msgs; }
    inFlight.push(...msgs.map(m => ({ id: m.id, via })));
    log({ type: 'human', via, ids: msgs.map(m => m.id), text: msgs.map(m => m.text).join(' / ').slice(0, 500) });
    return msgs;
  };
  const unclaimed = () => pendingMessages(deps.root, agent.name).filter(m => !inFlight.some(i => i.id === m.id));

  let transcript: PlainMsg[];
  let step = 0;

  // `limit` is raised on a gate resume so the answer always reaches the model (one more request).
  let limit = maxSteps;
  let resuming = false;
  const cp = loadCheckpoint(deps.root, item.id);
  if (cp && (item.resumeGate || !cp.parkedCallId)) {
    // Continue the same conversation: after a gate (outcome becomes the parked call's result), or after an
    // interrupted run (end-of-turn checkpoint, nothing to add). Re-running from scratch would repeat side effects.
    transcript = cp.messages;
    step = cp.step;
    resuming = true;
    if (cp.parkedCallId) {
      const gate = item.resumeGate ? getGate(deps.root, item.resumeGate) : undefined;
      if (!gate || gate.outcome === undefined) {
        return { status: 'error', summary: `cannot resume: checkpoint or gate outcome missing (${item.resumeGate})`, steps: 0 };
      }
      const said = unclaimed();
      transcript.push({
        role: 'user',
        parts: [
          ...cp.turnResults.map((r): PlainPart => ({ t: 'result', callId: r.callId, text: r.callId === cp.parkedCallId ? gate.outcome! : r.text })),
          ...(said.length ? [{ t: 'text', v: formatForModel(said) } as PlainPart] : [])
        ]
      });
      limit = Math.max(maxSteps, step + 1);
      deps.out.appendLine(`\n▶ ${agent.name} resumes ${item.id} after ${gate.kind} ${gate.id}`);
      log({ type: 'resume', gateId: gate.id, kind: gate.kind, outcome: gate.outcome.slice(0, 2000) });
      claim(said, 'resume');
    } else {
      deps.out.appendLine(`\n▶ ${agent.name} continues ${item.id} from its last completed step (${step})`);
      log({ type: 'resume', from: 'checkpoint', step });
      const said = unclaimed();
      if (said.length) { transcript.push({ role: 'user', parts: [{ t: 'text', v: formatForModel(said) }] }); claim(said, 'resume'); }
    }
  } else if (item.resumeGate) {
    return { status: 'error', summary: `cannot resume: checkpoint or gate outcome missing (${item.resumeGate})`, steps: 0 };
  } else {
    const said = unclaimed();
    transcript = [{ role: 'user', parts: [{ t: 'text', v: buildPrompt(agent, item, deps, memoryFor(deps.root, agent.name), said) }] }];
    deps.out.appendLine(`\n▶ ${agent.name} ← ${item.from} | ${item.id} | ${deps.model.family}`);
    log({ type: 'start', from: item.from, hop: item.hop, task: item.task, model: deps.model.id });
    claim(said, 'start');
  }

  let finished: { status: string; summary: string } | undefined;
  let finishedByTool = false;
  let parked: { gateId: string; callId: string } | undefined;
  let modelError: any;
  let hitLimit = false;
  const startedAt = Date.now();
  // The same call with the same result three times in a row means the agent is going in circles.
  let lastSig = '';
  let repeats = 0;

  // The model: one request per pi turn, through the Language Model API. Auto, not Required: Copilot rejects
  // Required with more than one tool, and it does so inside the response stream. A text-only reply is nudged below.
  const streamFn = (model: any, context: any) => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      step++;
      const t0 = Date.now();
      const base = { role: 'assistant' as const, api: model.api, provider: model.provider, model: model.id, usage: ZERO_USAGE, timestamp: t0 };
      stream.push({ type: 'start', partial: { ...base, content: [], stopReason: 'stop' } as AssistantMessage });
      try {
        const msgs = piToPlain((context.messages as Message[]).filter(m => (m as any).role !== 'system')).map(toVscode);
        const response = await deps.model.sendRequest(msgs, {
          tools, toolMode: vscode.LanguageModelChatToolMode.Auto, justification: `Loop Runner: ${agent.name} work item ${item.id}`
        }, deps.token);
        const content: any[] = [];
        let text = '';
        const calls: { callId: string; name: string; input: any }[] = [];
        for await (const part of response.stream) {
          if (part instanceof vscode.LanguageModelTextPart) {
            text += part.value;
            content.push({ type: 'text', text: part.value });
          } else if (part instanceof vscode.LanguageModelToolCallPart) {
            calls.push({ callId: part.callId, name: part.name, input: part.input });
            content.push({ type: 'toolCall', id: part.callId, name: part.name, arguments: part.input });
          }
        }
        if (text.trim()) { deps.out.appendLine(`  [${step}] ${text.trim()}`); }
        log({ type: 'model', step, ms: Date.now() - t0, text, calls: calls.map(c => ({ name: c.name, input: c.input })) });
        const reason = calls.length ? 'toolUse' : 'stop';
        stream.push({ type: 'done', reason, message: { ...base, content, stopReason: reason } as AssistantMessage });
      } catch (e: any) {
        modelError = e;
        const reason = deps.token.isCancellationRequested ? 'aborted' : 'error';
        stream.push({ type: 'error', reason, error: { ...base, content: [], stopReason: reason, errorMessage: String(e?.message ?? e) } as AssistantMessage });
      }
    })();
    return stream;
  };

  let parkedThisTurn = false;
  const piTools: AgentTool[] = tools.map(t => ({
    name: t.name,
    label: t.name,
    description: t.description,
    parameters: t.inputSchema as any,
    executionMode: 'sequential',
    execute: async (callId: string, input: any) => {
      const t1 = Date.now();
      let o: ToolOutcome;
      // Scripts write files without telling us; compare the outbox around a command to learn what it produced.
      const before = t.name === 'run_command' ? snapshotOutbox(deps.root) : undefined;
      if (parkedThisTurn && (t.name === 'ask_human' || t.name === 'request_approval')) {
        o = { text: 'Not sent: only one human gate per turn. Ask again after the first is resolved.' };
      } else {
        try {
          o = await runTool(t.name, input, {
            root: deps.root, agent, team: deps.team, item, policy: deps.policy, extraAllow,
            secrets: deps.secrets, maxHops: deps.maxHops, token: deps.token
          });
        } catch (e: any) {
          o = { text: redact(`ERROR: ${e?.message ?? String(e)}`, deps.secrets) };
        }
      }
      deps.out.appendLine(`    ${t.name} ${brief(input)} → ${o.decision ?? ''} ${(o.park ? `parked on ${o.park}` : o.text).split('\n')[0].slice(0, 100)}`);
      const wrote = before ? changedFiles(before, snapshotOutbox(deps.root)) : [];
      log({ type: 'tool', step, name: t.name, input, decision: o.decision, gateId: o.park, ms: Date.now() - t1, result: o.text.slice(0, 2000), ...(wrote.length ? { wrote } : {}) });
      if (o.park && !parked) { parked = { gateId: o.park, callId }; parkedThisTurn = true; }
      if (o.finished) { finished = o.finished; finishedByTool = true; }
      const sig = `${t.name}\n${JSON.stringify(input)}\n${o.text}`;
      repeats = sig === lastSig ? repeats + 1 : 1;
      lastSig = sig;
      if (repeats >= 3 && !o.park && !o.finished && !finished) {
        finished = { status: 'stalled', summary: `stopped: ${t.name} gave the same result ${repeats} times in a row` };
      }
      return { content: [{ type: 'text' as const, text: o.text }], details: {} };
    }
  }));

  const pi = new Agent({
    initialState: { systemPrompt: '', model: { id: deps.model.id, name: deps.model.family, ...API, contextWindow: 128000, maxTokens: 4096, reasoning: false, input: ['text'], cost: ZERO_USAGE.cost } as any, tools: piTools, messages: resuming ? plainToPi(transcript, deps.model.id) : [] },
    streamFn: streamFn as any,
    toolExecution: 'sequential',
    // Runs after every completed turn, before the next request: where the old loop's bookkeeping lived.
    // Between two turns: anything the human said meanwhile reaches the model before its next request.
    prepareNextTurn: () => {
      if (parked) { return undefined; }
      const msgs = claim(unclaimed(), 'turn');
      return msgs.length ? { messages: [{ role: 'user', content: [{ type: 'text', text: formatForModel(msgs) }], timestamp: Date.now() } as any] } : undefined;
    },
    finishTurn: async turn => {
      parkedThisTurn = false;
      // A turn that failed or was cancelled never carried the human's words to a finished answer: keep them pending.
      if (turn.message.stopReason !== 'error' && turn.message.stopReason !== 'aborted') { commitHuman(); }
      if (parked) {
        // Snapshot the conversation up to the assistant message; the gate's outcome becomes the parked call's result on resume.
        const all = turn.context.messages as any[];
        const upTo = all.length - turn.toolResults.length;
        const results = turn.toolResults.map(r => ({ callId: r.toolCallId, text: (r.content as any[]).map(c => c.text ?? '').join('') }));
        saveCheckpoint(deps.root, { itemId: item.id, gateId: parked.gateId, messages: piToPlain(all.slice(0, upTo)), turnResults: results, parkedCallId: parked.callId, step });
        log({ type: 'park', step, gateId: parked.gateId });
        deps.out.appendLine(`⏸ ${agent.name} waiting on ${parked.gateId}`);
        return { action: 'end' };
      }
      // The agent said it was finished, but the human wrote while it was finishing: let it read that before it stops.
      if (finished && finishedByTool && unclaimed().length && step < limit && !deps.token.isCancellationRequested) { finished = undefined; finishedByTool = false; }
      if (finished) { return { action: 'end' }; }
      if (deps.maxMs && Date.now() - startedAt > deps.maxMs) {
        finished = { status: 'stalled', summary: `stopped after ${Math.round(deps.maxMs / 60000)} minutes (wall-clock cap)` };
        return { action: 'end' };
      }
      // End-of-turn snapshot so an interrupted or rate-limited item continues here instead of starting over.
      // A text-only turn has no results to snapshot; it is nudged instead.
      if (turn.toolResults.length) {
        saveCheckpoint(deps.root, { itemId: item.id, gateId: '', messages: piToPlain(turn.context.messages as any[]), turnResults: [], parkedCallId: '', step });
      }
      if (step >= limit) { hitLimit = true; return { action: 'end' }; }
      if (unclaimed().length) { return { action: 'continue' }; }
      return undefined;
    }
  });
  const onCancel = deps.token.onCancellationRequested(() => pi.abort());

  let nudges = 0;
  try {
    if (resuming) { await pi.continue(); } else { await pi.prompt(transcript[0].parts[0].t === 'text' ? (transcript[0].parts[0] as any).v : ''); }
    // A reply with no tool call ends pi's loop; nudge twice, then give up as stalled.
    while (!finished && !parked && !modelError && !hitLimit && !deps.token.isCancellationRequested && step < limit) {
      const last: any = pi.state.messages[pi.state.messages.length - 1];
      if (last?.role !== 'assistant' || last.content.some((c: any) => c.type === 'toolCall')) { break; }
      if (++nudges > 2) { break; }
      await pi.prompt('Use a tool, or call finish.');
    }
  } catch (e: any) {
    modelError = e;
  } finally {
    onCancel.dispose();
  }
  if (parked) { return { status: 'waiting', steps: step, gateId: (parked as { gateId: string }).gateId }; }
  if (modelError) {
    const e = modelError;
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

  const status = (finished as { status: string } | undefined)?.status ?? (deps.token.isCancellationRequested ? 'cancelled' : step >= limit ? 'max_steps' : 'stalled');
  // Every successful write in the transcript, including turns before a resume.
  const transcriptNow = piToPlain(pi.state.messages as any[]);
  const results = transcriptNow.flatMap(m => m.parts.flatMap(p => (p.t === 'result' ? [p.text] : [])));
  const done = finished as { status: string; summary: string } | undefined;
  log({ type: 'end', step, status, summary: done?.summary, outputs: [...new Set([...outputsFrom(results), ...wroteFromAudit(deps.root, item.chainId, item.id)])] });
  deps.out.appendLine(`■ ${agent.name}: ${status}${done ? ` — ${done.summary}` : ''}`);
  return { status, summary: done?.summary, steps: step };
}

function brief(input: unknown): string {
  const s = JSON.stringify(input);
  return s.length > 100 ? s.slice(0, 97) + '...' : s;
}
