// Request-time folding: pure, deterministic, cache-friendly. Needs `tsc` first.
const path = require('path');
const assert = require('assert');
const OUT = path.join(__dirname, '..', 'out');
const { foldForRequest, foldedLine, charsOf } = require(`${OUT}/fold.js`);
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ✓', m); };

const big = i => `[exit 0]\nline one of result ${i}\n` + 'x'.repeat(3000) + '\nlast';
/** A prompt, then `turns` assistant turns, each followed by its tool result (every third one small). */
const convo = (turns, text = big) => {
  const msgs = [{ role: 'user', parts: [{ t: 'text', v: 'PROMPT ' + 'p'.repeat(3000) }] }];
  for (let i = 0; i < turns; i++) {
    msgs.push({ role: 'assistant', parts: [{ t: 'call', callId: `c${i}`, name: 'run_command', input: { command: `cmd ${i}` } }] });
    msgs.push({ role: 'user', parts: [{ t: 'result', callId: `c${i}`, text: i % 3 === 0 ? 'small ' + i : text(i) }] });
  }
  return msgs;
};
const folded = out => out.flatMap((m, i) => m.parts.filter(p => p.t === 'result' && p.text.startsWith('[folded:')).map(() => i));
const turnOf = i => (i - 1) / 2; // result message index -> turn number
const foldedTurns = out => folded(out).map(turnOf);

console.log('folding');
{
  const msgs = convo(30);
  const total = charsOf(msgs);
  ok(foldForRequest(msgs, Math.ceil(total / 0.6)) === msgs && foldForRequest(msgs, total * 2) === msgs, 'at or under 60% of the budget the messages are returned unchanged');
  const out = foldForRequest(msgs, Math.floor(total / 0.6) - 1000);
  ok(out !== msgs && charsOf(out) < total, 'over it, the request gets smaller');
  const turns = foldedTurns(out);
  ok(turns.length > 0 && turns.every(t => t < 20 && t % 3 !== 0), 'only big results from before the boundary (turn 20 of 30) are folded; small ones stay');
  ok(JSON.stringify(out[0]) === JSON.stringify(msgs[0]), 'the first user message is never folded');
  ok(msgs.slice(-12).every((m, i) => JSON.stringify(m) === JSON.stringify(out[out.length - 12 + i])), 'the last 6 turns are untouched');
  ok(out.every((m, i) => m.role === msgs[i].role && m.parts.length === msgs[i].parts.length && m.parts.every((p, k) => p.t === msgs[i].parts[k].t && (p.callId ?? '') === (msgs[i].parts[k].callId ?? ''))), 'structure is kept: every call still has its result');
  ok(msgs.every(m => m.parts.every(p => p.t !== 'result' || !p.text.startsWith('[folded:'))), 'the input (the transcript) is not modified');
  ok(out[4].parts[0].text === '[folded: [exit 0], 4 lines]', 'a folded result is one line: its first line and its line count');
}

console.log('determinism and the boundary');
{
  const msgs = convo(30), budget = 60_000;
  ok(JSON.stringify(foldForRequest(msgs, budget)) === JSON.stringify(foldForRequest(msgs, budget)), 'the same input gives the same output');
  const bound = t => { const f = foldedTurns(foldForRequest(convo(t), 30_000)); return f.length ? Math.max(...f) : -1; };
  ok(bound(6) === -1 && bound(15) === -1, 'a short conversation has nothing to fold');
  ok(bound(25) < 10 && bound(25) >= 7 && bound(26) >= 17 && bound(26) < 20, 'the boundary is 10 at 25 turns and 20 at 26');
  ok(bound(26) === bound(35) && bound(36) > 26, 'and it stays put until 36 turns');
  const a = foldForRequest(convo(26), 30_000), b = foldForRequest(convo(30), 30_000);
  ok(JSON.stringify(a.slice(0, 40)) === JSON.stringify(b.slice(0, 40)), 'requests between boundaries share an identical prefix (prompt-cache friendly)');
}

console.log('the line');
{
  const withFile = 'cut\n' + 'y'.repeat(2500) + '\nFull output: .loop/scratch/out/i-3-abc.txt (5001 lines). Use grep or read_file with startLine.';
  ok(foldedLine(withFile).endsWith(', full output: .loop/scratch/out/i-3-abc.txt]') && foldedLine(withFile).startsWith('[folded: cut, 3 lines'), 'it keeps the spilled file path');
  ok(foldedLine('a'.repeat(300) + '\nb').startsWith(`[folded: ${'a'.repeat(119)}…, 2 lines]`), 'the first line is clipped to 120');
}
console.log(`${n} fold checks passed`);
