/** Small text helpers shared by the console and the chat thread. No vscode. */
export const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s);
export const firstLine = (s: string): string => s.split('\n').find(l => l.trim()) ?? '';

/** One short phrase about what a tool call touched: its path, command, pattern or first string argument. */
export function brief(input: unknown): string {
  if (!input || typeof input !== 'object') { return ''; }
  const o = input as Record<string, unknown>;
  const v = o.path ?? o.command ?? o.pattern ?? o.title ?? Object.values(o).find(x => typeof x === 'string');
  return typeof v === 'string' ? clip(firstLine(v), 90) : '';
}
