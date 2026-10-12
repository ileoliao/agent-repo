import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Headless-simulation seam. Inert unless LOOP_RUNNER_SIM=1.
 * The fake model reads `.loop/sim-script.json`, a per-agent queue of turns, so a
 * restarted VS Code continues the same script from disk.
 */

export interface SimCall { name: string; input?: Record<string, unknown> }
export interface SimTurn {
  calls?: SimCall[];
  error?: string;
  /** Block until the cancellation token fires. The turn is left in the script for the retry. */
  hold?: boolean;
  /** Take this many milliseconds to answer, so a test can write to the agent while it is working. */
  delay?: number;
  /** Like Copilot: fail inside the response stream (not in sendRequest) when toolMode is Required. */
  rejectRequired?: boolean;
}

export function simEnabled(): boolean {
  return process.env.LOOP_RUNNER_SIM === '1';
}

export function simPauseMs(): number | undefined {
  if (!simEnabled()) return undefined;
  const n = Number(process.env.LOOP_RUNNER_SIM_PAUSE_MS ?? '400');
  return Number.isFinite(n) && n >= 0 ? n : 400;
}

export function simNow(root: string | undefined): Date | undefined {
  if (!simEnabled() || !root) return undefined;
  const f = path.join(root, '.loop', 'sim-now.txt');
  if (!fs.existsSync(f)) return undefined;
  const d = new Date(fs.readFileSync(f, 'utf8').trim());
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function simTrace(root: string, ev: Record<string, unknown>): void {
  if (!simEnabled()) return;
  const f = path.join(root, '.loop', 'sim-trace.jsonl');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, JSON.stringify({ ts: new Date().toISOString(), ...ev }) + '\n');
}

function scriptPath(root: string): string {
  return path.join(root, '.loop', 'sim-script.json');
}

function readScript(root: string): Record<string, SimTurn[]> {
  const f = scriptPath(root);
  if (!fs.existsSync(f)) return {};
  const data = JSON.parse(fs.readFileSync(f, 'utf8')) as Record<string, SimTurn[]>;
  return data && typeof data === 'object' ? data : {};
}

function peek(root: string, agent: string): SimTurn | undefined {
  const turns = readScript(root)[agent];
  return Array.isArray(turns) ? turns[0] : undefined;
}

function consume(root: string, agent: string): void {
  const data = readScript(root);
  if (Array.isArray(data[agent])) data[agent].shift();
  fs.writeFileSync(scriptPath(root), JSON.stringify(data, null, 2));
}

export function createSimModel(root: string, agent: string): vscode.LanguageModelChat {
  const model = {
    id: `sim-${agent}`,
    name: `sim-${agent}`,
    vendor: 'sim',
    family: 'sim',
    version: '1',
    maxInputTokens: 100_000,
    countTokens: async () => 0,
    sendRequest: async (_messages: vscode.LanguageModelChatMessage[], options?: vscode.LanguageModelChatRequestOptions, token?: vscode.CancellationToken) => {
      const turn = peek(root, agent);
      if (!turn) throw new Error(`sim model: no scripted turn left for ${agent}`);
      const rejectRequired = !!turn.rejectRequired && options?.toolMode === vscode.LanguageModelChatToolMode.Required;
      if (rejectRequired) { simTrace(root, { event: 'tool-mode-required-rejected', agent }); }
      if (options?.toolMode === vscode.LanguageModelChatToolMode.Auto) {
        simTrace(root, { event: 'tool-mode-auto-accepted', agent });
      }
      if (turn.delay) {
        simTrace(root, { event: 'delay-started', agent });
        await new Promise(r => setTimeout(r, turn.delay));
      }
      if (turn.hold) {
        const holdFile = path.join(root, '.loop', 'sim-holding');
        fs.mkdirSync(path.dirname(holdFile), { recursive: true });
        fs.writeFileSync(holdFile, agent);
        simTrace(root, { event: 'hold-started', agent });
        try {
          await new Promise<void>((_resolve, reject) => {
            let settled = false;
            const fail = () => {
              if (settled) return;
              settled = true;
              clearInterval(timer);
              reject(new Error('cancelled'));
            };
            const timer = setInterval(() => { if (token?.isCancellationRequested) fail(); }, 20);
            token?.onCancellationRequested(fail);
          });
        } finally {
          fs.rmSync(holdFile, { force: true });
        }
      }
      consume(root, agent);
      if (turn.error) {
        simTrace(root, { event: 'model-error', agent, error: turn.error });
        throw new Error(turn.error);
      }
      const calls = (turn.calls ?? []).map((c, i) =>
        new vscode.LanguageModelToolCallPart(`sim-${agent}-${Date.now()}-${i}`, c.name, (c.input ?? {}) as object));
      return {
        stream: (async function* () {
          if (rejectRequired) throw new Error('LanguageModelChatToolMode.Required is not supported with more than one tool');
          yield* calls;
        })(),
        text: (async function* () { /* tool-only turn */ })()
      };
    }
  };
  return model as vscode.LanguageModelChat;
}
