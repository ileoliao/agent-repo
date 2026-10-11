import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { AgentDef, SkillDef, loadAllAgents, loadSkills, pickModel, validateTeam } from './team';
import { cronMatches, minuteKey, missedSince } from './cron';
import { Gate, WorkItem, audit, complete, enqueue, hasOpenScheduled, listGates, newId, nextItem, pending, saveGate, waiting } from './queue';
import { loadPolicy, skillScriptRule } from './policy';
import { checkWake } from './wake';
import { runItem } from './runner';
import { LoopEvent, answerQuestion, approveAndRun, notify, rejectApproval } from './gates';
import { InboxView, showGate } from './inbox';
import { latestOutput } from './outbox';
import { createSimModel, simEnabled, simNow, simPauseMs, simTrace } from './sim-model';
import { runSim } from './sim-drive';

const SECRET_INDEX = 'loopRunner.secretNames';
const STARTED_KEY = 'loopRunner.teamStarted';
const NEEDS_YOU = new Set(['blocked', 'error', 'max_steps', 'stalled']);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const TRANSIENT = /rate.?limit|quota|exhausted|too many requests|temporarily blocked/i;

/**
 * Cancelled work and temporary quota/rate-limit errors stay in the agent queue so the next start retries them.
 * A context overflow ("Message exceeds token limit.") is permanent for that item: retrying it would loop forever.
 */
export function keepQueued(status: string, summary?: string): boolean {
  const s = summary ?? '';
  return status === 'cancelled' || (status === 'error' && TRANSIENT.test(s) && !/token limit/i.test(s));
}

/** Models for a start. An empty list means Copilot is not ready yet (no sign-in or network): wait for it once. */
export async function selectModelsWhenReady<T>(
  select: () => Thenable<T[]>,
  onChange: (cb: () => void) => { dispose(): void },
  timeoutMs: number
): Promise<T[]> {
  const first = await select();
  if (first.length > 0) return first;
  await new Promise<void>(resolve => {
    let sub: { dispose(): void } | undefined;
    const done = () => { clearTimeout(timer); sub?.dispose(); resolve(); };
    const timer = setTimeout(done, timeoutMs);
    sub = onChange(done);
  });
  return select();
}

/**
 * Copilot asks the user for consent on a model's first request, in a modal. Do that now, while a person is
 * at the keyboard, rather than at the first unattended wake. Returns one problem per model that failed.
 */
export async function ensureConsent<M extends { id: string; name: string }>(
  models: M[],
  canSend: (m: M) => boolean | undefined,
  ask: (m: M) => Promise<void>
): Promise<string[]> {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const m of models) {
    if (seen.has(m.id) || canSend(m) === true) continue;
    seen.add(m.id);
    try { await ask(m); } catch (e: any) { problems.push(`${m.name}: Copilot access was not granted (${e?.message ?? e})`); }
  }
  return problems;
}

class TeamService {
  team = new Map<string, AgentDef>();
  skills = new Map<string, SkillDef>();
  running = false;
  activeAgent?: string;
  private timer?: NodeJS.Timeout;
  private busy = false;
  private scheduling = false;
  private current?: vscode.CancellationTokenSource;
  private lastFired = new Map<string, string>();
  /** Per agent: the model resolved at start. */
  private models = new Map<string, vscode.LanguageModelChat>();
  /** Per agent: last wakeIf error already alerted, so a broken probe alerts once, not every tick. */
  private wakeErrors = new Map<string, string>();
  /** True once a rate-limit pause has been announced; cleared when an item finishes normally. */
  private rateAlerted = false;
  private starting = false;

  constructor(
    private ctx: vscode.ExtensionContext,
    private out: vscode.OutputChannel,
    private changed: () => void,
    private openGate: (g: Gate) => void
  ) {}

  root(): string | undefined { return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath; }
  cfg() { return vscode.workspace.getConfiguration('loopRunner'); }

  reload(): string[] {
    const root = this.root();
    if (!root) { return ['Open a folder first.']; }
    const all = loadAllAgents(root);
    this.team = new Map([...all].filter(([, a]) => a.inLoop));
    this.skills = loadSkills(root);
    const errors = validateTeam(this.team, this.skills, all);
    if (this.team.size === 0) { errors.push('No team members: add a loop: block to agents in .github/agents/*.agent.md'); }
    return errors;
  }

  /**
   * The first Start Team is user-initiated, which is what shows Copilot's consent dialog.
   * Later activations only reach this after that start succeeded.
   */
  async resolveModels(): Promise<string[]> {
    const problems: string[] = [];
    // Built aside and swapped in only when complete, so a failed Reload keeps the models of a running team.
    const next = new Map<string, vscode.LanguageModelChat>();
    if (simEnabled()) {
      const root = this.root();
      if (!root) return ['Open a folder first.'];
      for (const a of this.team.values()) next.set(a.name, createSimModel(root, a.name));
      this.models = next;
      return [];
    }
    const available = await selectModelsWhenReady(
      () => vscode.lm.selectChatModels({ vendor: 'copilot' }), cb => vscode.lm.onDidChangeChatModels(cb), 2 * 60_000);
    const fallback = this.cfg().get<string>('modelFamily', '');
    for (const a of this.team.values()) {
      const m = pickModel(available, a, fallback);
      if (m) { next.set(a.name, m); }
      else {
        problems.push(available.length === 0
          ? `${a.name}: Copilot returned no models (not signed in, still starting, or blocked by policy). Fix that, then run Start Team again.`
          : `${a.name}: no Copilot model matches ${a.modelFamily ? `loop.model "${a.modelFamily}"` : 'its model setting'}`);
      }
    }
    if (problems.length === 0) this.models = next;
    return problems;
  }

  /** Reload command: re-read agents and, on a running team, re-resolve models too. */
  async reloadAll(): Promise<string[]> {
    const errors = this.reload();
    if (this.running && errors.length === 0) errors.push(...await this.resolveModels());
    return errors;
  }

  private async grantAccess(): Promise<string[]> {
    if (simEnabled()) return [];
    return ensureConsent([...this.models.values()], m => this.ctx.languageModelAccessInformation.canSendRequest(m), async m => {
      const r = await m.sendRequest([vscode.LanguageModelChatMessage.User('Reply with OK.')],
        { justification: 'Loop Runner runs your custom agents unattended with this model.' });
      for await (const _ of r.stream) { /* drain */ }
    });
  }

  /** `user` is true for the Start Team command; only then may Copilot's consent dialog be raised. */
  async start(user = false): Promise<void> {
    if (this.running || this.starting) return;
    this.starting = true;
    try {
      await this.startInner(user);
    } finally {
      this.starting = false;
    }
  }

  private async startInner(user: boolean): Promise<void> {
    const errors = this.reload();
    errors.push(...await this.resolveModels());
    if (user && errors.length === 0) errors.push(...await this.grantAccess());
    this.out.show(true);
    if (errors.length) {
      this.out.appendLine('Team config problems:\n  ' + errors.join('\n  '));
      vscode.window.showErrorMessage(`Loop Runner: ${errors.length} config problem(s). See output.`);
      this.changed();
      return;
    }
    this.running = true;
    await this.ctx.workspaceState.update(STARTED_KEY, true);
    if (!this.running) {
      // Stop Team won the race while the flag was being written.
      await this.ctx.workspaceState.update(STARTED_KEY, false);
      return;
    }
    this.out.appendLine(`Team started: ${[...this.team.values()].map(a => `${a.name} [${this.models.get(a.name)?.name}]` + (a.schedule ? ` (${a.schedule}${a.wakeIf ? ', wakeIf' : ''})` : '')).join(', ')}`);
    if (this.timer) clearInterval(this.timer);
    // The simulation drives ticks itself; a 20s interval would race with scripted time.
    this.timer = setInterval(() => void this.tick(), simEnabled() ? 3_600_000 : 20_000);
    // A restart re-alerts every gate that is still pending, even if it was already shown.
    await this.notifyPendingGates(true);
    await this.drainThenSchedule();
  }

  /** `user` is Stop Team. Deactivate also stops the loop but must keep the flag so the next window continues. */
  stop(user = false): void {
    this.running = false;
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    this.current?.cancel();
    if (user) void this.ctx.workspaceState.update(STARTED_KEY, false);
    this.out.appendLine('Team stopped.');
    this.changed();
  }

  submit(agent: string, task: string, from = 'user', context?: string): void {
    enqueue(this.root()!, { id: newId(), agent, task, context, from, chainId: newId(), hop: 0, createdAt: new Date().toISOString() });
    this.tick();
  }

  tick(): Promise<void> {
    const root = this.root();
    if (!this.running || !root) { this.changed(); return Promise.resolve(); }
    return this.schedule(root).then(() => {
      if (!this.busy) return this.work(root);
    }).then(() => { this.changed(); });
  }

  private now(): Date {
    return simNow(this.root()) ?? new Date();
  }

  private ratePauseMs(): number {
    return simPauseMs() ?? 10 * 60_000;
  }

  /**
   * On start: finish anything already queued (cancel, rate limit, crash), then catch up one
   * missed wakeIf, then the current minute. Pending work is not stuck behind a new schedule.
   */
  private async drainThenSchedule(): Promise<void> {
    const root = this.root();
    if (!this.running || !root) { this.changed(); return; }
    if (!this.busy) await this.work(root);
    if (!this.running) { this.changed(); return; }
    await this.catchUp(root);
    if (!this.running) { this.changed(); return; }
    await this.schedule(root);
    if (this.running && !this.busy) await this.work(root);
    this.changed();
  }

  /** One wakeIf per role if any cron minute was missed while the team was not running. */
  private async catchUp(root: string): Promise<void> {
    if (this.scheduling) return;
    this.scheduling = true;
    try {
      this.loadFired(root);
      const now = this.now();
      for (const a of this.team.values()) {
        if (!this.running) return;
        if (!a.schedule || !a.task) continue;
        if (!missedSince(a.schedule, this.lastFired.get(a.name), now)) continue;
        this.out.appendLine(`${a.name}: missed a scheduled wake; catching up once.`);
        await this.fireSchedule(root, a, now);
      }
    } finally {
      this.scheduling = false;
    }
  }

  /** Due schedules: run the zero-token wakeIf check first; only enqueue model work if it says so. */
  private async schedule(root: string): Promise<void> {
    if (this.scheduling) { return; }
    this.scheduling = true;
    try {
      this.loadFired(root);
      const now = this.now();
      const minute = minuteKey(now);
      for (const a of this.team.values()) {
        if (!a.schedule || !a.task || this.lastFired.get(a.name) === minute) { continue; }
        // Also covers slots missed while the machine slept with VS Code open (one catch-up wake, not one per slot).
        if (!cronMatches(a.schedule, now)) {
          if (!missedSince(a.schedule, this.lastFired.get(a.name), now)) { continue; }
          this.out.appendLine(`${a.name}: missed a scheduled wake; catching up once.`);
        }
        await this.fireSchedule(root, a, now);
      }
    } finally {
      this.scheduling = false;
    }
  }

  private async fireSchedule(root: string, a: AgentDef, now: Date): Promise<void> {
    const task = a.task;
    if (!task) return;
    this.lastFired.set(a.name, minuteKey(now));
    this.saveFired(root);
    if (hasOpenScheduled(root, a.name)) return;
    const policy = loadPolicy(root, a.policy ?? this.cfg().get<string>('policyFile', '.loop/policy.json'));
    const extraAllow = a.skills.map(s => this.skills.get(s)).filter((s): s is SkillDef => !!s).map(s => skillScriptRule(s.relDir));
    const w = await checkWake(root, a, policy, extraAllow, await this.secrets());
    audit(root, `wake-${now.toISOString().slice(0, 10)}`, { type: 'wake', agent: a.name, wake: w.wake, error: w.error });
    if (w.error) {
      if (this.wakeErrors.get(a.name) !== w.error) {
        this.wakeErrors.set(a.name, w.error);
        await this.alert({ kind: 'error', agent: a.name, title: `${a.name}: wakeIf check is failing`, detail: w.error });
      }
      return;
    }
    if (this.wakeErrors.delete(a.name)) { this.out.appendLine(`${a.name}: wakeIf recovered.`); }
    if (!w.wake) return;
    enqueue(root, { id: newId(), agent: a.name, task, context: w.context, from: 'schedule', chainId: newId(), hop: 0, createdAt: now.toISOString() });
  }

  private loadFired(root: string): void {
    const f = path.join(root, '.loop', 'schedule-state.json');
    if (!fs.existsSync(f)) return;
    try {
      const data = JSON.parse(fs.readFileSync(f, 'utf8')) as Record<string, unknown>;
      for (const [k, v] of Object.entries(data)) {
        if (typeof v === 'string') this.lastFired.set(k, v);
      }
    } catch { /* a corrupt file must not stop the team */ }
  }

  private saveFired(root: string): void {
    const data: Record<string, string> = {};
    for (const [k, v] of this.lastFired) data[k] = v;
    fs.mkdirSync(path.join(root, '.loop'), { recursive: true });
    fs.writeFileSync(path.join(root, '.loop', 'schedule-state.json'), JSON.stringify(data, null, 2));
  }

  private async work(root: string): Promise<void> {
    this.busy = true;
    try {
      let item: WorkItem | undefined;
      while (this.running && (item = nextItem(root, [...this.team.keys()]))) {
        const agent = this.team.get(item.agent);
        if (!agent) { complete(root, item, 'error', 'unknown agent'); continue; }
        const model = this.models.get(agent.name);
        if (!model) { complete(root, item, 'error', `no model resolved for ${agent.name}`); continue; }
        this.current = new vscode.CancellationTokenSource();
        this.activeAgent = agent.name;
        this.changed();
        const r = await runItem(item, {
          root, team: this.team, skills: this.skills,
          policy: loadPolicy(root, agent.policy ?? this.cfg().get<string>('policyFile', '.loop/policy.json')),
          model, secrets: await this.secrets(),
          maxSteps: this.cfg().get<number>('maxSteps', 40),
          maxHops: this.cfg().get<number>('maxHops', 5),
          out: this.out, token: this.current.token
        });
        this.current.dispose();
        this.current = undefined;
        this.activeAgent = undefined;
        if (keepQueued(r.status, r.summary)) {
          const reason = r.status === 'cancelled' ? 'cancelled' : 'rate-limit';
          const queued = fs.existsSync(path.join(root, '.loop', 'queue', item.agent, `${item.id}.json`));
          audit(root, item.chainId, { type: 'retry', agent: agent.name, itemId: item.id, reason, summary: r.summary });
          simTrace(root, { event: 'kept-queued', reason, id: item.id, agent: item.agent, queued });
          this.out.appendLine(`${agent.name} ${item.id} stays queued (${reason}).`);
          this.changed();
          if (reason === 'rate-limit' && this.running) {
            if (!this.rateAlerted) {
              this.rateAlerted = true;
              await this.alert({ kind: 'error', agent: agent.name, title: `${agent.name}: model rate limit or quota hit, worker paused`, detail: r.summary, itemId: item.id, chainId: item.chainId });
            }
            const ms = this.ratePauseMs();
            this.out.appendLine(`Model quota/rate limit hit: pausing the worker for ${ms === 10 * 60_000 ? '10 minutes' : `${ms} ms`}. The item stays queued and will be retried.`);
            await sleep(ms);
            if (this.running) continue;
          }
          break;
        }
        this.rateAlerted = false;
        complete(root, item, r.status, r.summary, r.gateId);
        await this.notifyPendingGates();
        if (NEEDS_YOU.has(r.status)) {
          await this.alert({ kind: r.status as LoopEvent['kind'], agent: agent.name, title: `${agent.name}: ${r.status}`, detail: r.summary, itemId: item.id, chainId: item.chainId });
        }
        this.changed();
      }
    } finally {
      this.busy = false;
      this.changed();
    }
  }

  /**
   * New pending gates are announced once. `force` (team start) announces every gate that is
   * still pending, including ones already shown before VS Code last closed.
   */
  async notifyPendingGates(force = false): Promise<void> {
    const root = this.root();
    if (!root) { return; }
    for (const g of listGates(root).filter(x => x.status === 'pending' && (force || !x.notifiedAt))) {
      g.notifiedAt = new Date().toISOString();
      saveGate(root, g);
      await this.alert({ kind: g.kind, agent: g.agent, title: g.title, detail: g.body, gateId: g.id, itemId: g.itemId, chainId: g.chainId }, g);
    }
  }

  private async alert(ev: LoopEvent, gate?: Gate): Promise<void> {
    const label = ev.kind === 'question' ? `${ev.agent} asks: ${ev.title}`
      : ev.kind === 'approval' ? `${ev.agent} needs approval: ${ev.title}`
        : `${ev.title}${ev.detail ? ` — ${ev.detail}` : ''}`;
    void vscode.window.showInformationMessage(`Loop Runner · ${label}`, ...(gate ? ['Open'] : [])).then(pick => {
      if (pick === 'Open' && gate) { this.openGate(gate); }
    });
    try {
      const r = await notify(this.root()!, this.cfg().get<string>('notifyCommand') || undefined, ev, await this.secrets());
      if (r && r.code !== 0) { this.out.appendLine(`notify failed: ${r.text}`); }
    } catch (e: any) {
      this.out.appendLine(`notify failed: ${e?.message ?? e}`);
    }
  }

  async secrets(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const n of this.ctx.globalState.get<string[]>(SECRET_INDEX, [])) {
      const v = await this.ctx.secrets.get(`loopRunner.secret.${n}`);
      if (v) { out[n] = v; }
    }
    return out;
  }

  async setSecret(name: string, value: string): Promise<void> {
    await this.ctx.secrets.store(`loopRunner.secret.${name}`, value);
    const names = new Set(this.ctx.globalState.get<string[]>(SECRET_INDEX, []));
    names.add(name);
    await this.ctx.globalState.update(SECRET_INDEX, [...names]);
  }

  status(): string {
    const root = this.root();
    if (!root) { return 'no folder'; }
    const lines = [`running: ${this.running}${this.activeAgent ? ` | active: ${this.activeAgent}` : ''} | waiting on you: ${waiting(root).length} item(s)`];
    for (const a of this.team.values()) {
      lines.push(`- ${a.name}: queue ${pending(root, a.name).length} | skills [${a.skills.join(', ')}] | handoffs [${a.handoffs.join(', ')}]${a.schedule ? ` | ${a.schedule}` : ''}`);
    }
    return lines.join('\n');
  }
}

export function activate(ctx: vscode.ExtensionContext) {
  const out = vscode.window.createOutputChannel('Loop Runner');
  // Status bar: one click per common action. A status bar item cannot host a dropdown, and a QuickPick always opens at the top of the window.
  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  bar.command = 'loopRunner.focusInbox';
  const toggle = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
  const result = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 48);
  result.text = '$(file-text) Result';
  result.tooltip = 'Open the latest agent output';
  result.command = 'loopRunner.openLatestResult';
  result.show();
  const menu = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 47);
  menu.text = '$(menu)';
  menu.tooltip = 'Loop Runner: all commands';
  menu.command = 'loopRunner.menu';
  menu.show();
  const inbox = new InboxView(() => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
  const refresh = () => {
    inbox.refresh();
    const n = inbox.pendingCount();
    bar.text = `$(${svc.running ? 'sync' : 'debug-pause'}) Loop${svc.activeAgent ? `: ${svc.activeAgent}` : ''}${n ? ` · $(bell-dot) ${n}` : ''}`;
    bar.tooltip = n ? `${n} item(s) need you: click to open the inbox` : 'Loop Runner: click to open the inbox';
    bar.show();
    toggle.text = svc.running ? '$(debug-stop) Stop' : '$(play) Start';
    toggle.tooltip = svc.running ? 'Stop the Loop Runner team' : 'Start the Loop Runner team';
    toggle.command = svc.running ? 'loopRunner.stopTeam' : 'loopRunner.startTeam';
    toggle.show();
    if (simEnabled()) {
      const folder = svc.root();
      if (folder) {
        fs.mkdirSync(path.join(folder, '.loop'), { recursive: true });
        fs.writeFileSync(path.join(folder, '.loop', 'sim-status.json'), JSON.stringify({
          running: svc.running, active: svc.activeAgent ?? null, pending: n, bar: bar.text
        }));
      }
    }
  };
  const svc: TeamService = new TeamService(ctx, out, refresh, g => void showGate(root(), g));
  svc.reload();

  const root = () => {
    const r = svc.root();
    if (!r) { throw new Error('Open a folder first.'); }
    return r;
  };
  // A resolved gate may have woken a parked item; tick so the worker picks it up right away.
  const after = (_woke: boolean) => { svc.tick(); inbox.refresh(); };
  const policyFor = (g: Gate) => loadPolicy(root(), svc.team.get(g.agent)?.policy ?? svc.cfg().get<string>('policyFile', '.loop/policy.json'));

  ctx.subscriptions.push(
    out, bar, toggle, result, menu,
    vscode.window.registerTreeDataProvider('loopRunner.inbox', inbox),
    vscode.commands.registerCommand('loopRunner.startTeam', () => svc.start(true)),
    vscode.commands.registerCommand('loopRunner.stopTeam', () => svc.stop(true)),
    vscode.commands.registerCommand('loopRunner.reloadTeam', async () => {
      const errs = await svc.reloadAll();
      out.show(true);
      out.appendLine(errs.length ? 'Team config problems:\n  ' + errs.join('\n  ') : 'Team reloaded OK.\n' + svc.status());
    }),
    vscode.commands.registerCommand('loopRunner.status', () => { out.show(true); out.appendLine(svc.status()); }),
    vscode.commands.registerCommand('loopRunner.focusInbox', () => vscode.commands.executeCommand('loopRunner.inbox.focus')),
    vscode.commands.registerCommand('loopRunner.openLatestResult', async () => {
      const file = latestOutput(root());
      if (!file) { vscode.window.showInformationMessage('Loop Runner: no agent output yet.'); return; }
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file), { preview: false });
    }),
    // One entry point for the status bar: the commands people reach for, without hunting in the palette.
    vscode.commands.registerCommand('loopRunner.menu', async () => {
      const run = (command: string) => () => vscode.commands.executeCommand(command);
      const items: (vscode.QuickPickItem & { run: () => unknown })[] = [
        svc.running
          ? { label: '$(debug-stop) Stop Team', run: run('loopRunner.stopTeam') }
          : { label: '$(play) Start Team', run: run('loopRunner.startTeam') },
        { label: '$(inbox) Open Inbox', description: inbox.pendingCount() ? `${inbox.pendingCount()} need you` : undefined, run: run('loopRunner.focusInbox') },
        { label: '$(file-text) Open Latest Result', run: run('loopRunner.openLatestResult') },
        { label: '$(sync) Reload & Validate Team', run: run('loopRunner.reloadTeam') },
        { label: '$(send) Give an Agent a Task', run: run('loopRunner.runAgent') },
        { label: '$(info) Show Team Status', run: run('loopRunner.status') },
        { label: '$(key) Set Secret', run: run('loopRunner.setSecret') },
        { label: '$(list-unordered) List Available Models', run: run('loopRunner.listModels') },
        { label: '$(bell) Send a Test Notification', run: run('loopRunner.testNotify') }
      ];
      const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Loop Runner' });
      await pick?.run();
    }),
    vscode.commands.registerCommand('loopRunner.runAgent', async () => {
      if (!svc.running) { vscode.window.showWarningMessage('Start the team first (Loop Runner: Start Team).'); return; }
      const pick = await vscode.window.showQuickPick(
        [...svc.team.values()].map(a => ({ label: a.name, description: a.description })), { placeHolder: 'Which agent?' });
      if (!pick) { return; }
      const task = await vscode.window.showInputBox({ prompt: `Task for ${pick.label}`, ignoreFocusOut: true });
      if (task) { svc.submit(pick.label, task); }
    }),
    vscode.commands.registerCommand('loopRunner.setSecret', async () => {
      const name = await vscode.window.showInputBox({ prompt: 'Env var name (e.g. HARBOR_PAT, JIRA_TOKEN)', ignoreFocusOut: true });
      if (!name || !/^[A-Z_][A-Z0-9_]*$/.test(name)) { return; }
      const value = await vscode.window.showInputBox({ prompt: `Value for ${name}`, password: true, ignoreFocusOut: true });
      if (value) { await svc.setSecret(name, value); vscode.window.showInformationMessage(`Stored ${name}.`); }
    }),
    vscode.commands.registerCommand('loopRunner.testNotify', async () => {
      const cmd = svc.cfg().get<string>('notifyCommand');
      if (!cmd) { vscode.window.showWarningMessage('Set loopRunner.notifyCommand in your user settings first.'); return; }
      const r = await notify(root(), cmd, { kind: 'question', agent: 'loop-runner', title: 'Test notification' }, await svc.secrets());
      out.show(true);
      out.appendLine(`notify test: ${r?.text}`);
    }),
    vscode.commands.registerCommand('loopRunner.listModels', async () => {
      const ms = await vscode.lm.selectChatModels({ vendor: 'copilot' });
      out.show(true);
      out.appendLine('Copilot models:\n' + ms.map(m => `  family=${m.family}  id=${m.id}  maxInputTokens=${m.maxInputTokens}`).join('\n'));
    }),
    vscode.commands.registerCommand('loopRunner.openGate', (g: Gate) => showGate(root(), g)),
    vscode.commands.registerCommand('loopRunner.answer', async (g: Gate) => {
      await showGate(root(), g);
      const TYPE = '$(edit) Type an answer…';
      let answer: string | undefined;
      if (g.options?.length) {
        const pick = await vscode.window.showQuickPick([...g.options, TYPE], { placeHolder: g.title, ignoreFocusOut: true });
        if (!pick) { return; }
        answer = pick === TYPE ? undefined : pick;
      }
      answer ??= await vscode.window.showInputBox({ prompt: g.title, ignoreFocusOut: true });
      if (!answer) { return; }
      try { after(answerQuestion(root(), g.id, answer).woke); } catch (e: any) { vscode.window.showWarningMessage(e.message); }
    }),
    vscode.commands.registerCommand('loopRunner.approve', async (g: Gate) => {
      const ok = await vscode.window.showWarningMessage(`Run for "${g.title}"?`, { modal: true, detail: g.command }, 'Run');
      if (ok !== 'Run') { return; }
      try {
        const r = await approveAndRun(root(), g.id, policyFor(g), await svc.secrets());
        out.appendLine(`✔ ${g.title}: ${r.ok ? 'executed' : 'FAILED'}\n${r.text}`);
        vscode.window.showInformationMessage(`Loop Runner: "${g.title}" ${r.ok ? 'executed' : 'failed'}.`);
        after(r.woke);
      } catch (e: any) { vscode.window.showErrorMessage(e.message); }
    }),
    vscode.commands.registerCommand('loopRunner.reject', async (g: Gate) => {
      const fb = await vscode.window.showInputBox({ prompt: 'Feedback for the agent (optional)', ignoreFocusOut: true });
      if (fb === undefined) { return; }
      try { after(rejectApproval(root(), g.id, fb).woke); } catch (e: any) { vscode.window.showWarningMessage(e.message); }
    }),
    vscode.commands.registerCommand('loopRunner.refreshInbox', () => inbox.refresh()),
    { dispose: () => svc.stop() }
  );
  if (simEnabled()) {
    ctx.subscriptions.push(
      vscode.commands.registerCommand('loopRunner._sim.submit', (agent: string, task: string) => { svc.submit(agent, task); }),
      vscode.commands.registerCommand('loopRunner._sim.answer', (gateId: string, answer: string) => {
        after(answerQuestion(root(), gateId, answer).woke);
      }),
      vscode.commands.registerCommand('loopRunner._sim.tick', () => svc.tick()),
      vscode.commands.registerCommand('loopRunner._sim.snapshot', () => ({
        running: svc.running, active: svc.activeAgent ?? null, status: svc.status(), bar: bar.text
      }))
    );
  }

  const r = svc.root();
  if (r) {
    const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(r, '.loop/gates/*.json'));
    w.onDidChange(() => inbox.refresh());
    w.onDidCreate(() => inbox.refresh());
    ctx.subscriptions.push(w);
  }
  const willAutoStart = ctx.workspaceState.get<boolean>(STARTED_KEY) === true;
  if (willAutoStart) {
    void svc.start().catch((e: any) => out.appendLine(`Auto-start failed: ${e?.message ?? e}`));
  }
  // Paint the bell count even when nothing has ticked yet (and before auto-start finishes).
  refresh();
  if (simEnabled()) {
    const folder = svc.root();
    if (folder) {
      fs.mkdirSync(path.join(folder, '.loop'), { recursive: true });
      fs.writeFileSync(path.join(folder, '.loop', 'sim-activation.json'), JSON.stringify({
        bar: bar.text, pending: inbox.pendingCount(), running: svc.running, willAutoStart
      }, null, 2));
    }
    void runSim().catch(async (e: any) => {
      const folder = svc.root();
      if (folder) {
        fs.mkdirSync(path.join(folder, '.loop'), { recursive: true });
        fs.appendFileSync(path.join(folder, '.loop', 'sim-trace.jsonl'), JSON.stringify({ event: 'sim-crash', error: String(e?.stack ?? e) }) + '\n');
      }
      try { await vscode.commands.executeCommand('workbench.action.quit'); } catch { /* already closing */ }
    });
  }
}

export function deactivate() {}
