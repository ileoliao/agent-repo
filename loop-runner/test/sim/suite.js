// Extension-host side of the headless simulation. Driven by test/sim/run.js.
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const WS = process.env.LOOP_SIM_WS;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function listJson(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => readJson(path.join(dir, f)));
}

function readTrace() {
  const f = path.join(WS, '.loop', 'sim-trace.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function wakeHits() {
  const f = path.join(WS, '.loop', 'wake-hits.txt');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean);
}

function notifyLines() {
  const f = path.join(WS, '.loop', 'notified.log');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean);
}

function audits() {
  const root = path.join(WS, '.loop', 'runs');
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const day of fs.readdirSync(root)) {
    const dir = path.join(root, day);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      for (const line of fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean)) {
        out.push(JSON.parse(line));
      }
    }
  }
  return out;
}

async function poll(label, pred, ms = 25000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    try { last = await pred(); } catch (e) { last = `error: ${e.message}`; }
    if (last) return last;
    await sleep(40);
  }
  throw new Error(`timeout: ${label}; last=${typeof last === 'string' ? last : JSON.stringify(last)}`);
}

function writeScript(data) {
  fs.writeFileSync(path.join(WS, '.loop', 'sim-script.json'), JSON.stringify(data, null, 2));
}

async function phasePark(check) {
  const ext = vscode.extensions.getExtension('local.loop-runner');
  if (ext && !ext.isActive) await ext.activate();
  check('activate', !!(ext && ext.isActive), ext ? `${ext.id} active=${ext.isActive}` : 'extension missing');
  const cmds = await vscode.commands.getCommands(true);
  check('Start Team command is registered', cmds.includes('loopRunner.startTeam') && cmds.includes('loopRunner.stopTeam'), 'loopRunner.startTeam');

  const activation = readJson(path.join(WS, '.loop', 'sim-activation.json'));
  check('first open does not auto-start', activation.willAutoStart === false, JSON.stringify(activation));
  check('status bar is painted at the end of activation', String(activation.bar).includes('Loop'), activation.bar);

  const before = await vscode.commands.executeCommand('loopRunner._sim.snapshot');
  check('team stays idle until Start Team', before && before.running === false, JSON.stringify(before));

  await vscode.commands.executeCommand('loopRunner.startTeam');

  const hits = wakeHits();
  check('missed cron catch-up runs wakeIf once', hits.length === 1, hits.join(' | ') || '(none)');
  const state = readJson(path.join(WS, '.loop', 'schedule-state.json'));
  check('catch-up stores the current minute', state.scout === process.env.LOOP_SIM_NOW_KEY, JSON.stringify(state));

  const draft = fs.readFileSync(path.join(WS, '.loop', 'outbox', 'scout', 'note.md'), 'utf8');
  check('multi-step tools wrote the draft', draft.includes('draft from note'), draft);
  const toolNames = audits().filter(e => e.type === 'tool' && e.agent === 'scout').map(e => e.name);
  check('tools ran read_file, then write_file, then handoff, then finish', toolNames.join(',') === 'read_file,write_file,handoff,finish', toolNames.join(','));
  const readEv = audits().find(e => e.type === 'tool' && e.name === 'read_file');
  check('read_file returned the note', !!(readEv && String(readEv.result).includes('SIM_NOTE_42')), readEv && String(readEv.result).slice(0, 300));

  const mode = readTrace().filter(e => String(e.event).startsWith('tool-mode'));
  check('tool mode Required fell back to Auto', mode.some(e => e.event === 'tool-mode-required-rejected') && mode.some(e => e.event === 'tool-mode-auto-accepted'), JSON.stringify(mode));

  const waiting = listJson(path.join(WS, '.loop', 'queue', '_waiting'));
  const gates = listJson(path.join(WS, '.loop', 'gates')).filter(g => g.status === 'pending');
  check('ask_human parks the clerk item', waiting.length === 1 && waiting[0].agent === 'clerk' && gates.length === 1 && gates[0].kind === 'question', JSON.stringify({ waiting: waiting.map(w => ({ id: w.id, agent: w.agent })), gate: gates[0] && gates[0].title }));
  const handed = waiting[0] && waiting[0].from === 'scout';
  check('handoff delivered the item to clerk', handed, waiting[0] && `from=${waiting[0].from} hop=${waiting[0].hop}`);

  const notes = notifyLines();
  check('the question was notified', notes.length === 1 && notes[0].startsWith('question|Which colour?'), notes.join('\n'));
  const snap = await vscode.commands.executeCommand('loopRunner._sim.snapshot');
  check('Start Team left the team running', !!(snap && snap.running), snap && snap.status);
}

async function phaseResume(check) {
  const ext = vscode.extensions.getExtension('local.loop-runner');
  if (ext && !ext.isActive) await ext.activate();

  const activation = readJson(path.join(WS, '.loop', 'sim-activation.json'));
  check('restart remembers that the team was started', activation.willAutoStart === true, JSON.stringify(activation));
  check('status bar refresh shows the pending gate', String(activation.bar).includes('bell') && activation.pending >= 1, JSON.stringify(activation));

  const notes = await poll('re-notify', () => {
    const lines = notifyLines();
    return lines.filter(l => l.startsWith('question|')).length >= 2 ? lines : null;
  });
  check('pending gate is notified again even though notifiedAt was set', notes.filter(l => l.startsWith('question|')).length >= 2, notes.join('\n'));

  const snap = await poll('auto-start', async () => {
    const s = await vscode.commands.executeCommand('loopRunner._sim.snapshot');
    return s && s.running ? s : null;
  });
  check('auto-start runs without another Start Team', String(snap.status).includes('running: true'), snap.status);

  const gate = listJson(path.join(WS, '.loop', 'gates')).find(g => g.status === 'pending' && g.kind === 'question');
  check('the parked question is still pending', !!gate, gate && gate.id);
  await vscode.commands.executeCommand('loopRunner._sim.answer', gate.id, 'green');
  const finished = await poll('resume', () => listJson(path.join(WS, '.loop', 'queue', '_done')).find(d => d.summary && d.summary.includes('colour was green')) || null);
  check('answer resumes the same item through to done', finished.status === 'done' && finished.agent === 'clerk', JSON.stringify({ id: finished.id, status: finished.status, summary: finished.summary }));
  check('resume was audited', audits().some(e => e.type === 'resume' && e.itemId === finished.id), finished.id);

  const hitsBefore = wakeHits().length;
  fs.writeFileSync(path.join(WS, '.loop', 'sim-now.txt'), process.env.LOOP_SIM_LATER);
  writeScript({ scout: [{ calls: [{ name: 'finish', input: { status: 'done', summary: 'live cron' } }] }], clerk: [] });
  await vscode.commands.executeCommand('loopRunner._sim.tick');
  const hitsAfter = await poll('live wake', () => wakeHits().length === hitsBefore + 1 ? wakeHits() : null);
  check('the current cron minute runs wakeIf', hitsAfter.length === hitsBefore + 1, `${hitsBefore} -> ${hitsAfter.length}: ${hitsAfter.join(' | ')}`);
  const live = await poll('live item', () => listJson(path.join(WS, '.loop', 'queue', '_done')).find(d => d.summary === 'live cron') || null);
  check('cron + wakeIf enqueued model work', live.from === 'schedule' && live.agent === 'scout' && live.status === 'done', JSON.stringify(live));

  writeScript({
    scout: [],
    clerk: [
      { error: 'rate limit exceeded' },
      { calls: [{ name: 'finish', input: { status: 'done', summary: 'retried after rate limit' } }] }
    ]
  });
  await vscode.commands.executeCommand('loopRunner._sim.submit', 'clerk', 'hit the limit');
  const keptRate = await poll('rate-limit keep', () => readTrace().find(e => e.event === 'kept-queued' && e.reason === 'rate-limit') || null);
  check('rate limit keeps the item in the agent queue', keptRate.queued === true && keptRate.agent === 'clerk', JSON.stringify(keptRate));
  const retried = await poll('rate-limit retry', () => listJson(path.join(WS, '.loop', 'queue', '_done')).find(d => d.id === keptRate.id) || null, 15000);
  check('after the pause the same item retries to done', retried.status === 'done' && retried.summary === 'retried after rate limit', JSON.stringify(retried));
  check('the retried item is not left in the queue', !fs.existsSync(path.join(WS, '.loop', 'queue', 'clerk', `${keptRate.id}.json`)), keptRate.id);

  writeScript({
    scout: [],
    clerk: [{ hold: true, calls: [{ name: 'finish', input: { status: 'done', summary: 'should not finish while held' } }] }]
  });
  await vscode.commands.executeCommand('loopRunner._sim.submit', 'clerk', 'cancel me');
  await poll('hold', () => readTrace().some(e => e.event === 'hold-started') ? true : null);
  writeScript({
    scout: [],
    clerk: [{ calls: [{ name: 'finish', input: { status: 'done', summary: 'finished after cancel' } }] }]
  });
  await vscode.commands.executeCommand('loopRunner.stopTeam');
  const keptCancel = await poll('cancel keep', () => readTrace().find(e => e.event === 'kept-queued' && e.reason === 'cancelled') || null);
  check('cancel keeps the item in the agent queue', keptCancel.queued === true, JSON.stringify(keptCancel));
  const queuedFile = path.join(WS, '.loop', 'queue', 'clerk', `${keptCancel.id}.json`);
  const doneEarly = listJson(path.join(WS, '.loop', 'queue', '_done')).some(d => d.id === keptCancel.id);
  check('cancelled item was not completed into _done', fs.existsSync(queuedFile) && !doneEarly, queuedFile);
  await vscode.commands.executeCommand('loopRunner.startTeam');
  const afterCancel = await poll('cancel retry', () => listJson(path.join(WS, '.loop', 'queue', '_done')).find(d => d.id === keptCancel.id) || null);
  check('the next Start Team retries the cancelled item', afterCancel.status === 'done' && afterCancel.summary === 'finished after cancel', JSON.stringify(afterCancel));
}

function writeResult(phase, failures, evidence) {
  fs.mkdirSync(path.dirname(process.env.LOOP_SIM_RESULT), { recursive: true });
  const parkFile = path.join(WS, '.loop', 'sim-park.json');
  const park = fs.existsSync(parkFile) ? JSON.parse(fs.readFileSync(parkFile, 'utf8')) : null;
  fs.writeFileSync(process.env.LOOP_SIM_RESULT, JSON.stringify({
    phase, failures, evidence,
    parkFailures: park ? park.failures : phase === 'park' ? failures : [],
    parkEvidence: park ? park.evidence : phase === 'park' ? evidence : []
  }, null, 2));
}

async function quit() {
  await sleep(1000);
  await vscode.commands.executeCommand('workbench.action.quit');
}

module.exports.main = async function main() {
  const evidence = [];
  const failures = [];
  const check = (name, cond, detail) => {
    const pass = !!cond;
    const text = detail == null ? '' : String(detail).slice(0, 2000);
    evidence.push({ name, pass, detail: text });
    console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${text ? `\n    ${text}` : ''}`);
    if (!pass) failures.push(name);
  };
  const phaseFile = path.join(WS, '.loop', 'sim-phase');
  const phase = fs.existsSync(phaseFile) ? fs.readFileSync(phaseFile, 'utf8').trim() : 'park';
  try {
    if (phase === 'park') {
      await phasePark(check);
      fs.writeFileSync(path.join(WS, '.loop', 'sim-park.json'), JSON.stringify({ failures: [...failures], evidence }, null, 2));
      if (!failures.length) fs.writeFileSync(phaseFile, 'resume');
    } else {
      await phaseResume(check);
    }
  } catch (e) {
    failures.push(e.stack || e.message);
    console.error(e);
  }
  writeResult(phase, failures, evidence);
  await quit();
};
