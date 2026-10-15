import type { PlainMsg, PlainPart } from './queue';
import { clip, firstLine } from './textutil';

/**
 * Request-time context folding. Pure and deterministic; no vscode. Only what is SENT to the model changes: the
 * transcript and checkpoints keep the full text (invariant 7). When the conversation is large, old big tool results
 * become one line each; the model can re-read a spilled file or re-run the command if it needs one back.
 *
 * The boundary moves only every FOLD_STEP turns, so the folded prefix is identical across requests and Copilot's
 * prompt cache keeps hitting until the boundary moves.
 */
export const FOLD_AT = 0.6;
export const FOLD_MIN_CHARS = 2000;
export const KEEP_TURNS = 6;
export const FOLD_STEP = 10;

const sizeOf = (p: PlainPart): number => (p.t === 'text' ? p.v.length : p.t === 'call' ? p.name.length + JSON.stringify(p.input ?? null).length : p.text.length);
export const charsOf = (msgs: PlainMsg[]): number => msgs.reduce((n, m) => n + m.parts.reduce((k, p) => k + sizeOf(p), 0), 0);

/** The one line that stands for a folded result. */
export function foldedLine(text: string): string {
  const path = /Full output: (\S+)/.exec(text)?.[1];
  return `[folded: ${clip(firstLine(text), 120)}, ${text.split('\n').length} lines${path ? `, full output: ${path}` : ''}]`;
}

export function foldForRequest(msgs: PlainMsg[], budgetChars: number): PlainMsg[] {
  if (charsOf(msgs) <= FOLD_AT * budgetChars) { return msgs; }
  const turns = msgs.filter(m => m.role === 'assistant').length;
  const boundary = Math.floor(Math.max(0, turns - KEEP_TURNS) / FOLD_STEP) * FOLD_STEP;
  if (boundary === 0) { return msgs; }
  let turn = -1; // index of the assistant turn the current message follows
  return msgs.map((m, i) => {
    if (m.role === 'assistant') { turn++; return m; }
    // Results answer the assistant turn before them; the opening prompt (no turn yet) is never touched.
    if (i === 0 || turn < 0 || turn >= boundary || !m.parts.some(p => p.t === 'result' && p.text.length > FOLD_MIN_CHARS)) { return m; }
    return { ...m, parts: m.parts.map((p): PlainPart => (p.t === 'result' && p.text.length > FOLD_MIN_CHARS ? { ...p, text: foldedLine(p.text) } : p)) };
  });
}
