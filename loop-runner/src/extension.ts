import { TriggerServer, handleWebhook, newToken, scanFileTriggers, startTriggerServer } from './triggers';
import { TEMPLATES, installTemplate } from './templates';
import { setExtraPath } from './exec';
import { doctorMarkdown, runDoctor } from './doctor';
import { healthMarkdown, healthReport } from './health';
import { DEFAULT_RETENTION, Retention, autoCleanup, describeResult, pausedAgents, planCleanup, runCleanup } from './maintenance';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { AgentDef, GoalDef, SkillDef, loadAllAgents, loadSkills, pickModel, policyPathFor, validateTeam } from './team';
import { Gate, WorkItem, audit, complete, enqueue, getGate, listGates, newId, nextItem, pending, saveGate, waiting, keepQueued } from './queue';
import { loadPolicy } from './policy';
import { GoalIO, checkSilence, fireGoal, goalsDue } from './goals';
import { runItem } from './runner';
import { taskOnEnd } from './tasks';
import { notifyWebhook, LoopEvent, answerQuestion, approveAndRun, notify, rejectApproval } from './gates';
import { InboxView, showGate } from './inbox';
import { ConsolePanel } from './consoleView';
import { chatState, conversationContext, markDelivered, pendingMessages, postHumanMessage, routeFor } from './thread';
import { registerLoopChat } from './chat';
import { latestOutput } from './outbox';
import { recentRuns } from './runs';
import { agentRows, nextWake } from './status';

const hhmm = (d: Date) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
import { createSimModel, simEnabled, simNow, simPauseMs, simTrace } from './sim-model';
import { runSim } from './sim-drive';

const SECRET_INDEX = 'harborMate.secretNames';
const STARTED_KEY = 'harborMate.teamStarted';
/** Keys written before the product was renamed; still read so nothing is lost on upgrade. */
const LEGACY_SECRET_INDEX = 'loopRunner.secretNames';
const LEGACY_STARTED_KEY = 'loopRunner.teamStarted';
const NEEDS_YOU = new Set(['blocked', 'error', 'max_steps', 'stalled']);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export { keepQueued };

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

export class TeamService {
  team = new Map<string, AgentDef>();
  skills = new Map<string, SkillDef>();
  running = false;
  /** The runs in progress, in the order they started. */
  private live = new Map<string, { item: WorkItem; cts: vscode.CancellationTokenSource; startedAt: number; /** Set by Cancel this run: closed as cancelled instead of kept for a retry. */ drop: boolean; done: Promise<void> }>();
  /** A rate-limit pause is on: nothing new starts until it ends. */
  private paused = false;
  private pumping = false;
  private startedAt = new Date();
  /** Goals already announced as silent (goalKey). */
  private silent = new Set<string>();
  private lastAlert = new Map<string, string>();
  private timer?: NodeJS.Timeout;
  private scheduling = false;
  private lastFired = new Map<string, string>();
  /** Per agent: the model resolved at start. */
  private models = new Map<string, vscode.LanguageModelChat>();
  /** Per agent: last wakeIf error already alerted, so a broken probe alerts once, not every tick. */
  private wakeErrors = new Map<string, string>();
  /** True once a rate-limit pause has been announced; cleared when an item finishes normally. */
  private rateAlerted = false;
  private starting = false;

  /** Agents with a run in progress. */
  get activeAgents(): string[] { return [...new Set([...this.live.values()].map(l => l.item.agent))]; }
  /** The earliest-started running agent (status line fallbacks and the simulation). */
  get activeAgent(): string | undefined { return this.activeAgents[0]; }
  /** Worker slots. The simulation scripts time and runs one at a time. */
  private workers(): number { return simEnabled() ? 1 : Math.max(1, Math.floor(this.cfg().get<number>('workers', 2)) || 1); }

  constructor(
    private ctx: vscode.ExtensionContext,
    private out: vscode.OutputChannel,
    private changed: () => void,
    private openGate: (g: Gate) => void
  ) {}

  root(): string | undefined { return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath; }
  /** Settings live under `harborMate`; a value still set under the old `loopRunner` prefix keeps working. */
  private triggerServer?: TriggerServer;

  /** Folders added in front of PATH for every agent command (`harborMate.extraPath`). */
  applyExtraPath(): void { setExtraPath(this.cfg().get<string[]>('extraPath', []) ?? []); }

  /** The secret a webhook caller must present. Created once and kept in SecretStorage, never in the workspace. */
  async triggerToken(): Promise<string> {
    let t = await this.ctx.secrets.get('harborMate.triggerToken');
    if (!t) { t = newToken(); await this.ctx.secrets.store('harborMate.triggerToken', t); }
    return t;
  }

  /** Start the loopback webhook listener when `harborMate.triggerPort` is set. A busy port is reported, not fatal. */
  private async startTriggers(): Promise<void> {
    const port = Math.floor(Number(this.cfg().get<number>('triggerPort', 0)));
    if (!(port > 0 && port < 65536) || this.triggerServer) { return; }
    try {
      this.triggerServer = await startTriggerServer({
        port, token: await this.triggerToken(), log: l => this.out.appendLine(l),
        onHook: (name, body) => { const r = handleWebhook(this.root()!, this.team.values(), name, body, this.now()); if (r.queued.length) { void this.tick(); } return r; }
      });
      this.out.appendLine(`Webhook triggers listening on http://127.0.0.1:${port}/hook/<name> (loopback only).`);
    } catch (e: any) { this.out.appendLine(`Webhook triggers could not start on port ${port}: ${e?.message ?? e}`); }
  }

  /** How long finished work is kept; see `maintenance.ts`. */
  retention(): Retention {
    const n = (k: string, d: number) => { const v = Number(this.cfg().get<number>(k, d)); return Number.isFinite(v) && v >= 1 ? v : d; };
    return { doneDays: n('retention.doneDays', DEFAULT_RETENTION.doneDays), runsDays: n('retention.runsDays', DEFAULT_RETENTION.runsDays), gateDays: n('retention.gateDays', DEFAULT_RETENTION.gateDays), taskDays: n('retention.taskDays', DEFAULT_RETENTION.taskDays) };
  }

  /** Daily housekeeping, run when the team starts and on ticks (it does nothing after the first pass of a day). */
  private housekeeping(root: string): void {
    try {
      const r = autoCleanup(root, this.retention(), this.now());
      if (r && Object.values(r.removed).some(n => n)) { this.out.appendLine(`Cleanup: ${describeResult(r)}`); }
    } catch (e: any) { this.out.appendLine(`Cleanup failed: ${e?.message ?? e}`); }
  }

  cfg() {
    const now = vscode.workspace.getConfiguration('harborMate');
    const old = vscode.workspace.getConfiguration('loopRunner');
    return { get: <T>(key: string, dflt?: T): T => (now.inspect<T>(key)?.globalValue ?? now.inspect<T>(key)?.workspaceValue ?? now.inspect<T>(key)?.workspaceFolderValue) !== undefined ? now.get<T>(key, dflt as T) : old.get<T>(key) ?? now.get<T>(key, dflt as T) };
  }

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
        { justification: 'Harbor Mate runs your custom agents unattended with this model.' });
      for await (const _ of r.stream) { /* drain */ }
    });
  }

  /** `user` is true for the Start Team command; only then may Copilot's consent dialog be raised. */
  async start(user = false): Promise<void> {
    if (this.running || this.starting) return;
    this.applyExtraPath();
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
      vscode.window.showErrorMessage(`Harbor Mate: ${errors.length} config problem(s). See output.`);
      this.changed();
      return;
    }
    this.running = true;
    this.startedAt = this.now();
    this.silent.clear();
    await this.ctx.workspaceState.update(STARTED_KEY, true);
    if (!this.running) {
      // Stop Team won the race while the flag was being written.
      await this.ctx.workspaceState.update(STARTED_KEY, false);
      return;
    }
    this.out.appendLine(`Team started: ${[...this.team.values()].map(a => `${a.name} [${this.models.get(a.name)?.name}]` + (a.goals.length ? ` (${a.goals.map(g => g.schedule ? `${g.id}: ${g.schedule}${g.wakeIf ? ', wakeIf' : ''}` : g.id).join('; ')})` : '')).join(', ')}`);
    if (this.timer) clearInterval(this.timer);
    // The simulation drives ticks itself; a 20s interval would race with scripted time.
    this.timer = setInterval(() => void this.tick(), simEnabled() ? 3_600_000 : 20_000);
    await this.startTriggers();
    // A restart re-alerts every gate that is still pending, even if it was already shown.
    await this.notifyPendingGates(true);
    await this.drainThenSchedule();
  }

  /** `user` is Stop Team. Deactivate also stops the loop but must keep the flag so the next window continues. */
  stop(user = false): void {
    this.running = false;
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    for (const l of this.live.values()) { l.cts.cancel(); }
    void this.triggerServer?.close(); this.triggerServer = undefined;
    if (user) void this.ctx.workspaceState.update(STARTED_KEY, false);
    this.out.appendLine('Team stopped.');
    this.changed();
  }

  /** The human writes to an agent in the chat. Where it goes depends on what the agent is doing (see routeFor). */
  chatSend(agent: string, text: string): void {
    const root = this.root();
    if (!root) { throw new Error('Open a folder first.'); }
    if (!this.team.has(agent)) { throw new Error(`${agent} is not on the team. Reload the team if you just added it.`); }
    const route = routeFor(chatState(root, agent, this.activeAgents).state);
    const context = route === 'new-task' ? conversationContext(root, agent) : '';
    const m = postHumanMessage(root, agent, text);
    if (route === 'new-task') {
      markDelivered(root, agent, [m.id], { via: 'task' });
      this.submit(agent, m.text, 'chat', context || undefined);
    }
    this.changed();
  }

  /** Stop the agent's current run for good: it is closed as cancelled and not retried, unlike Stop Team. */
  cancelRun(agent: string): boolean {
    // With several runs of one agent, the earliest-started one (the one that reads the human's messages).
    const l = [...this.live.values()].find(x => x.item.agent === agent);
    if (!l) { return false; }
    l.drop = true;
    l.cts.cancel();
    return true;
  }

  /** Words that arrived after the agent's last turn: if nothing else is going to read them, they start a run. */
  private followUpMessages(root: string, agent: string): void {
    const late = pendingMessages(root, agent);
    if (!late.length || chatState(root, agent, this.activeAgents).state !== 'idle') { return; }
    const context = conversationContext(root, agent);
    markDelivered(root, agent, late.map(m => m.id), { via: 'task' });
    this.submit(agent, late.map(m => m.text).join('\n\n'), 'chat', context || undefined);
  }

  submit(agent: string, task: string, from = 'user', context?: string): void {
    enqueue(this.root()!, { id: newId(), agent, task, context, from, chainId: newId(), hop: 0, createdAt: new Date().toISOString() });
    this.tick();
  }

  tick(): Promise<void> {
    const root = this.root();
    if (!this.running || !root) { this.changed(); return Promise.resolve(); }
    this.housekeeping(root);
    try { scanFileTriggers(root, this.team.values(), this.now()); } catch (e: any) { this.out.appendLine(`File trigger scan failed: ${e?.message ?? e}`); }
    return this.schedule(root).then(() => checkSilence(root, this.team.values(), this.startedAt, this.now(), this.silent, ev => this.alert(ev)))
      .then(() => { void this.pump(root); }).then(() => { this.changed(); });
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
    await this.drain(root);
    if (!this.running) { this.changed(); return; }
    await this.catchUp(root);
    if (!this.running) { this.changed(); return; }
    await this.schedule(root);
    // After the catch-up checks, so a goal that was silent while VS Code was closed is reported only if it still is.
    await checkSilence(root, this.team.values(), this.startedAt, this.now(), this.silent, ev => this.alert(ev));
    if (this.running) await this.drain(root);
    this.changed();
  }

  private goalIO(root: string): GoalIO {
    return {
      lastFired: this.lastFired, save: () => this.saveFired(root), skills: this.skills, wakeErrors: this.wakeErrors, lastAlert: this.lastAlert,
      policy: (a, g) => loadPolicy(root, policyPathFor(a, g.id, this.cfg().get<string>('policyFile', '.loop/policy.json'))),
      secrets: () => this.secrets(), alert: ev => this.alert(ev), log: l => this.out.appendLine(l)
    };
  }

  /** One wakeIf per goal if any cron minute was missed while the team was not running. */
  private async catchUp(root: string): Promise<void> { await this.fireDue(root, true); }

  /** Due goals: run the zero-token wakeIf check first; only enqueue model work if it says so. */
  private async schedule(root: string): Promise<void> { await this.fireDue(root, false); }

  private async fireDue(root: string, catchUp: boolean): Promise<void> {
    if (this.scheduling) { return; }
    this.scheduling = true;
    try {
      this.loadFired(root);
      const now = this.now();
      const io = this.goalIO(root);
      // Decided up front: firing one goal changes lastFired, not what is due for the others.
      const paused = pausedAgents(root);
      for (const d of goalsDue([...this.team.values()].filter(a => !paused.has(a.name)), this.lastFired, now, catchUp)) {
        if (!this.running && catchUp) { return; }
        // Also covers slots missed while the machine slept with VS Code open (one catch-up wake, not one per slot).
        if (d.missed) { this.out.appendLine(`${d.agent.name}/${d.goal.id}: missed a scheduled wake; catching up once.`); }
        await fireGoal(root, d.agent, d.goal, now, io);
      }
    } finally {
      this.scheduling = false;
    }
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

  /** Start as many queued items as the pool allows (see `pickItem`). Does not wait for them. */
  private async pump(root: string): Promise<void> {
    if (this.pumping) { return; }
    this.pumping = true;
    try {
      let item: WorkItem | undefined;
      while (this.running && !this.paused && (item = nextItem(root, [...this.team.keys()], [...this.live.values()].map(l => l.item), this.workers()))) {
        const agent = this.team.get(item.agent);
        if (!agent) { complete(root, item, 'error', 'unknown agent'); continue; }
        const model = this.models.get(agent.name);
        if (!model) { complete(root, item, 'error', `no model resolved for ${agent.name}`); continue; }
        const started = item;
        const cts = new vscode.CancellationTokenSource();
        const entry = { item: started, cts, startedAt: Date.now(), drop: false, done: Promise.resolve() };
        this.live.set(started.id, entry);
        entry.done = this.runOne(root, started, agent, model, entry).then(again => {
          cts.dispose();
          this.live.delete(started.id);
          this.changed();
          if (again && this.running) { void this.pump(root); }
        });
        this.changed();
      }
    } finally {
      this.pumping = false;
    }
  }

  /** Wait until nothing is running and nothing more can start (used on start, to finish what was already queued). */
  private async drain(root: string): Promise<void> {
    do {
      await this.pump(root);
      if (!this.live.size) { break; }
      await Promise.race([...this.live.values()].map(l => l.done));
    } while (this.running);
  }

  /** Runs one item to its end. Returns whether the pool should look for more work right away. */
  private async runOne(root: string, item: WorkItem, agent: AgentDef, model: vscode.LanguageModelChat, live: { cts: vscode.CancellationTokenSource; drop: boolean }): Promise<boolean> {
    const earliest = () => [...this.live.values()].find(l => l.item.agent === agent.name)?.item.id === item.id;
    const r = await runItem(item, {
      root, team: this.team, skills: this.skills,
      policy: loadPolicy(root, policyPathFor(agent, item.goal, this.cfg().get<string>('policyFile', '.loop/policy.json'))),
      model, secrets: await this.secrets(),
      maxSteps: this.cfg().get<number>('maxSteps', 40),
      maxHops: this.cfg().get<number>('maxHops', 5),
      maxMs: this.cfg().get<number>('maxMinutes', 30) * 60_000,
      takesMessages: earliest,
      out: this.out, token: live.cts.token
    });
    this.live.delete(item.id);
    if (live.drop && r.status === 'cancelled') {
      audit(root, item.chainId, { type: 'end', agent: agent.name, itemId: item.id, step: r.steps, status: 'cancelled', summary: 'cancelled by the human', outputs: [] });
      taskOnEnd(root, item, 'cancelled_by_human', undefined, undefined, this.cfg().get<number>('maxHops', 5));
      complete(root, item, 'cancelled', 'cancelled by the human');
      this.followUpMessages(root, agent.name);
      return true;
    }
    if (keepQueued(r.status, r.summary)) {
      const reason = r.status === 'cancelled' ? 'cancelled' : 'rate-limit';
      const queued = fs.existsSync(path.join(root, '.loop', 'queue', item.agent, `${item.id}.json`));
      audit(root, item.chainId, { type: 'retry', agent: agent.name, itemId: item.id, reason, summary: r.summary });
      simTrace(root, { event: 'kept-queued', reason, id: item.id, agent: item.agent, queued });
      this.out.appendLine(`${agent.name} ${item.id} stays queued (${reason}).`);
      if (reason === 'rate-limit' && this.running) {
        // The whole pool pauses (the quota is shared), and before any await so the queued item is not picked up again meanwhile.
        this.paused = true;
        if (!this.rateAlerted) {
          this.rateAlerted = true;
          await this.alert({ kind: 'error', agent: agent.name, title: `${agent.name}: model rate limit or quota hit, worker paused`, detail: r.summary, itemId: item.id, chainId: item.chainId });
        }
        const ms = this.ratePauseMs();
        this.out.appendLine(`Model quota/rate limit hit: pausing the workers for ${ms === 10 * 60_000 ? '10 minutes' : `${ms} ms`}. The item stays queued and will be retried.`);
        await sleep(ms);
        this.paused = false;
        return true;
      }
      return false;
    }
    this.rateAlerted = false;
    complete(root, item, r.status, r.summary, r.gateId);
    if (r.status !== 'waiting') { this.followUpMessages(root, agent.name); }
    await this.notifyPendingGates();
    if (NEEDS_YOU.has(r.status)) {
      await this.alert({ kind: r.status as LoopEvent['kind'], agent: agent.name, title: `${agent.name}: ${r.status}`, detail: r.summary, itemId: item.id, chainId: item.chainId });
    }
    return true;
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
    void vscode.window.showInformationMessage(`Harbor Mate · ${label}`, ...(gate ? ['Open'] : [])).then(pick => {
      if (pick === 'Open' && gate) { this.openGate(gate); }
    });
    try {
      const r = await notify(this.root()!, this.cfg().get<string>('notifyCommand') || undefined, ev, await this.secrets());
      if (r && r.code !== 0) { this.out.appendLine(`notify failed: ${r.text}`); }
    } catch (e: any) {
      this.out.appendLine(`notify failed: ${e?.message ?? e}`);
    }
    const w = await notifyWebhook(this.cfg().get<string>('notifyWebhook') || undefined, ev, await this.secrets());
    if (w && !w.ok) { this.out.appendLine(`webhook notify failed: ${w.error}`); }
  }

  async secrets(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const n of [...this.ctx.globalState.get<string[]>(SECRET_INDEX, []), ...this.ctx.globalState.get<string[]>(LEGACY_SECRET_INDEX, [])]) {
      const v = (await this.ctx.secrets.get(`harborMate.secret.${n}`)) ?? (await this.ctx.secrets.get(`loopRunner.secret.${n}`));
      if (v) { out[n] = v; }
    }
    return out;
  }

  async setSecret(name: string, value: string): Promise<void> {
    await this.ctx.secrets.store(`harborMate.secret.${name}`, value);
    const names = new Set([...this.ctx.globalState.get<string[]>(SECRET_INDEX, []), ...this.ctx.globalState.get<string[]>(LEGACY_SECRET_INDEX, [])]);
    names.add(name);
    await this.ctx.globalState.update(SECRET_INDEX, [...names]);
  }

  status(): string {
    const root = this.root();
    if (!root) { return 'no folder'; }
    const lines = [`running: ${this.running}${this.activeAgents.length ? ` | active: ${this.activeAgents.join(', ')}` : ''} | waiting on you: ${waiting(root).length} item(s)`];
    for (const a of this.team.values()) {
      lines.push(`- ${a.name}: queue ${pending(root, a.name).length} | skills [${a.skills.join(', ')}] | handoffs [${a.handoffs.join(', ')}]${a.goals.length ? ` | ${a.goals.map(g => `${g.id}${g.schedule ? ` ${g.schedule}` : ''}`).join('; ')}` : ''}`);
    }
    return lines.join('\n');
  }
}

/** Show generated markdown in a read-only editor tab. */
async function showMarkdown(title: string, md: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: `# ${title}\n\n${md}\n` });
  await vscode.window.showTextDocument(doc, { preview: true });
  await vscode.commands.executeCommand('markdown.showPreview', doc.uri).then(undefined, () => undefined);
}

export function activate(ctx: vscode.ExtensionContext) {
  const out = vscode.window.createOutputChannel('Harbor Mate');
  // Status bar: one click per common action. A status bar item cannot host a dropdown, and a QuickPick always opens at the top of the window.
  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  bar.command = 'harborMate.openConsole';
  const toggle = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
  const result = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 48);
  result.text = '$(file-text) Result';
  result.tooltip = 'Open the latest agent output';
  result.command = 'harborMate.openLatestResult';
  result.show();
  const menu = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 47);
  menu.text = '$(menu)';
  menu.tooltip = 'Harbor Mate: all commands';
  menu.command = 'harborMate.menu';
  menu.show();
  const inbox = new InboxView(() => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, () => svc.activeAgents);
  let consolePanel: ConsolePanel | undefined;
  const refresh = () => {
    inbox.refresh();
    consolePanel?.refresh();
    const n = inbox.pendingCount();
    // Live state in one line: what is running (and which step), or when the next wake is due.
    const r = svc.root();
    const nw = r ? nextWake(agentRows(r, svc.activeAgents)) : undefined;
    const current = r && svc.activeAgent ? recentRuns(r, 5).find(x => x.status === 'running' && x.agent === svc.activeAgent) : undefined;
    const many = svc.activeAgents.length > 1 ? svc.activeAgents.join(', ') : undefined;
    const state = !svc.running ? '$(debug-stop) Harbor Mate · stopped'
      : svc.activeAgent ? `$(sync~spin) Mate: ${many ?? svc.activeAgent}${current && !many ? ` · step ${current.step}` : ''}`
      : `$(debug-pause) Mate · idle${nw ? ` · next ${hhmm(nw.at)}` : ''}`;
    bar.text = `${state}${n ? ` · $(bell-dot) ${n}` : ''}`;
    bar.tooltip = n ? `${n} item(s) need you: click to open the inbox` : 'Harbor Mate: click to open the inbox';
    bar.show();
    toggle.text = svc.running ? '$(debug-stop) Stop' : '$(play) Start';
    toggle.tooltip = svc.running ? 'Stop the Harbor Mate team' : 'Start the Harbor Mate team';
    toggle.command = svc.running ? 'harborMate.stopTeam' : 'harborMate.startTeam';
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
  svc.applyExtraPath();
  ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('harborMate.extraPath')) { svc.applyExtraPath(); } }));
  svc.reload();

  const root = () => {
    const r = svc.root();
    if (!r) { throw new Error('Open a folder first.'); }
    return r;
  };
  // A resolved gate may have woken a parked item; tick so the worker picks it up right away.
  const after = (_woke: boolean) => { svc.tick(); inbox.refresh(); consolePanel?.refresh(); };
  const policyFor = (g: Gate) => loadPolicy(root(), (svc.team.get(g.agent) ? policyPathFor(svc.team.get(g.agent)!, g.goal, '') : '') || svc.cfg().get<string>('policyFile', '.loop/policy.json'));
  const approveGate = async (id: string, seen?: Record<string, string>) => {
    const g = getGate(root(), id);
    if (!g) { throw new Error(`No approval ${id}`); }
    const r = await approveAndRun(root(), id, policyFor(g), await svc.secrets(), seen);
    out.appendLine(`✔ ${g.title}: ${r.ok ? 'executed' : 'FAILED'}\n${r.text}`);
    after(r.woke);
  };
  // Whether Copilot is signed in decides whether any agent can run; the console shows it, so it is checked now and every minute.
  let copilotCount: number | undefined;
  const probeCopilot = async () => {
    let n = 0;
    try { n = (await vscode.lm.selectChatModels({})).length; } catch { n = 0; }
    if (n !== copilotCount) { copilotCount = n; consolePanel?.refresh(); }
  };
  void probeCopilot();
  const copilotTimer = setInterval(() => void probeCopilot(), 60_000);
  ctx.subscriptions.push({ dispose: () => clearInterval(copilotTimer) }, vscode.lm.onDidChangeChatModels(() => void probeCopilot()));
  consolePanel = new ConsolePanel({
    root: () => svc.root(),
    state: () => ({ running: svc.running, active: svc.activeAgents }),
    answer: (id, text) => after(answerQuestion(root(), id, text).woke),
    approve: approveGate,
    reject: (id, fb) => after(rejectApproval(root(), id, fb).woke),
    chatSend: (agent, text) => { svc.chatSend(agent, text); },
    chatCancel: agent => svc.cancelRun(agent),
    copilotModels: () => copilotCount
  });
  registerLoopChat(ctx, () => {
    const r = svc.root();
    return r ? {
      root: r,
      state: () => ({ running: svc.running, active: svc.activeAgents }),
      submit: (agent, task) => svc.submit(agent, task),
      answer: (id, text) => after(answerQuestion(r, id, text).woke),
      power: async on => { if (on) { await svc.start(true); } else { svc.stop(true); } refresh(); },
      reload: async () => { const errs = await svc.reloadAll(); refresh(); return errs; },
      secrets: () => svc.secrets(),
      cancel: agent => { const ok = svc.cancelRun(agent); refresh(); return ok; },
      retention: svc.retention()
    } : undefined;
  });
  const panelTimer = setInterval(() => consolePanel?.refresh(), 3000);

  ctx.subscriptions.push(
    out, bar, toggle, result, menu, { dispose: () => clearInterval(panelTimer) },
    vscode.commands.registerCommand('harborMate.openConsole', () => consolePanel?.show()),
    vscode.window.registerTreeDataProvider('harborMate.inbox', inbox),
    vscode.commands.registerCommand('harborMate.startTeam', () => svc.start(true)),
    vscode.commands.registerCommand('harborMate.stopTeam', () => svc.stop(true)),
    vscode.commands.registerCommand('harborMate.reloadTeam', async () => {
      const errs = await svc.reloadAll();
      out.show(true);
      out.appendLine(errs.length ? 'Team config problems:\n  ' + errs.join('\n  ') : 'Team reloaded OK.\n' + svc.status());
    }),
    vscode.commands.registerCommand('harborMate.status', () => { out.show(true); out.appendLine(svc.status()); }),
    vscode.commands.registerCommand('harborMate.focusInbox', () => vscode.commands.executeCommand('harborMate.inbox.focus')),
    vscode.commands.registerCommand('harborMate.openLatestResult', async () => {
      // The newest run that recorded its outputs is authoritative; file modification time is only the fallback.
      const r = root();
      const run = recentRuns(r).find(x => x.outputs.length > 0);
      const file = run ? path.join(r, run.outputs[run.outputs.length - 1]) : latestOutput(r);
      if (!file) { vscode.window.showInformationMessage('Harbor Mate: no agent output yet.'); return; }
      if (run) { vscode.window.setStatusBarMessage(`Harbor Mate: ${run.agent} wrote this (run ${run.chainId})`, 6000); }
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file), { preview: false });
    }),
    // One entry point for the status bar: the commands people reach for, without hunting in the palette.
    vscode.commands.registerCommand('harborMate.menu', async () => {
      const run = (command: string) => () => vscode.commands.executeCommand(command);
      const items: (vscode.QuickPickItem & { run: () => unknown })[] = [
        svc.running
          ? { label: '$(debug-stop) Stop Team', run: run('harborMate.stopTeam') }
          : { label: '$(play) Start Team', run: run('harborMate.startTeam') },
        { label: '$(dashboard) Open Console', run: run('harborMate.openConsole') },
        { label: '$(inbox) Open Inbox', description: inbox.pendingCount() ? `${inbox.pendingCount()} need you` : undefined, run: run('harborMate.focusInbox') },
        { label: '$(file-text) Open Latest Result', run: run('harborMate.openLatestResult') },
        { label: '$(sync) Reload & Validate Team', run: run('harborMate.reloadTeam') },
        { label: '$(send) Give an Agent a Task', run: run('harborMate.runAgent') },
        { label: '$(info) Show Team Status', run: run('harborMate.status') },
        { label: '$(rocket) Get Started', run: run('harborMate.getStarted') },
        { label: '$(pulse) Check Agents (Doctor)', run: run('harborMate.runDoctor') },
        { label: '$(graph) Agent Health Report', run: run('harborMate.showHealth') },
        { label: '$(trash) Clean Up Finished Work', run: run('harborMate.cleanUp') },
        { label: '$(key) Set Secret', run: run('harborMate.setSecret') },
        { label: '$(list-unordered) List Available Models', run: run('harborMate.listModels') },
        { label: '$(bell) Send a Test Notification', run: run('harborMate.testNotify') }
      ];
      const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Harbor Mate' });
      await pick?.run();
    }),
    vscode.commands.registerCommand('harborMate.runAgent', async () => {
      if (!svc.running) { vscode.window.showWarningMessage('Start the team first (Harbor Mate: Start Team).'); return; }
      const pick = await vscode.window.showQuickPick(
        [...svc.team.values()].map(a => ({ label: a.name, description: a.description })), { placeHolder: 'Which agent?' });
      if (!pick) { return; }
      const task = await vscode.window.showInputBox({ prompt: `Task for ${pick.label}`, ignoreFocusOut: true });
      if (task) { svc.submit(pick.label, task); }
    }),
    vscode.commands.registerCommand('harborMate.describeAgent', () => vscode.commands.executeCommand('workbench.action.chat.open', { query: '@mate I want an agent that ', isPartialQuery: true })),
    vscode.commands.registerCommand('harborMate.getStarted', async (preset?: string) => {
      const r = root();
      const items = [
        ...TEMPLATES.map(t => ({ label: t.label, description: t.id, detail: t.detail, id: t.id })),
        { label: 'Describe what you want', description: 'ask @mate', detail: 'Open Chat and tell @mate in your own words; it builds the agent and checks it can run.', id: '' }
      ];
      const pick = preset && TEMPLATES.some(t => t.id === preset) ? items.find(i => (i as { id?: string }).id === preset) : await vscode.window.showQuickPick(items, { title: 'Harbor Mate: Get Started', placeHolder: 'Pick a starting point. Nothing runs on a schedule until you start the team.' });
      if (!pick) { return; }
      if (!pick.id) { await vscode.commands.executeCommand('harborMate.describeAgent'); return; }
      const res = installTemplate(r, pick.id);
      if (!res.ok) { vscode.window.showWarningMessage(`Harbor Mate: ${res.error}`); return; }
      const errs = await svc.reloadAll();
      refresh();
      const report = await runDoctor(r, { agent: res.agent, runProbes: true, secrets: await svc.secrets() });
      const ready = report.ready.includes(res.agent);
      const next = await vscode.window.showInformationMessage(
        ready && !errs.length ? `Harbor Mate: ${pick.label} is ready. Start the team to let it run on its schedule, or give it a task now.` : `Harbor Mate: ${pick.label} was created but is not ready: ${[...errs, ...report.checks.filter(c => c.level === 'fail').map(c => c.what)].join(' ')}`,
        ...(ready && !svc.running ? ['Start Team'] : []), 'Open File');
      if (next === 'Start Team') { await svc.start(true); }
      if (next === 'Open File') { await vscode.window.showTextDocument(vscode.Uri.file(path.join(r, res.files[0]))); }
    }),
    vscode.commands.registerCommand('harborMate.copyTriggerInfo', async () => {
      const port = Math.floor(Number(svc.cfg().get<number>('triggerPort', 0)));
      if (!(port > 0)) { vscode.window.showWarningMessage('Harbor Mate: set harborMate.triggerPort (for example 8765) in your user settings, then Start Team.'); return; }
      const cmd = `curl -X POST http://127.0.0.1:${port}/hook/<name> -H "Authorization: Bearer ${await svc.triggerToken()}" -d 'what happened'`;
      await vscode.env.clipboard.writeText(cmd);
      vscode.window.showInformationMessage('Harbor Mate: a curl example with your token is on the clipboard. Replace <name> with the webhook name from the agent\'s on: webhook:<name>.');
    }),
    vscode.commands.registerCommand('harborMate.runDoctor', async () => {
      svc.applyExtraPath();
      const md = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Harbor Mate: checking agents…' }, async () => doctorMarkdown(await runDoctor(root(), { runProbes: true, secrets: await svc.secrets(), policyFile: svc.cfg().get<string>('policyFile', '.loop/policy.json'), triggerPort: Number(svc.cfg().get<number>('triggerPort', 0)) })));
      let models = 0;
      try { models = (await vscode.lm.selectChatModels({})).length; } catch { /* not signed in */ }
      const copilot = models ? `✅ **Copilot** is ready: ${models} model${models > 1 ? 's' : ''} available.` : '❌ **Copilot** has no models available. Sign in to GitHub Copilot in VS Code: agents cannot run without it.';
      await showMarkdown('Harbor Mate · Doctor', `${copilot}\n\n${md}`);
    }),
    vscode.commands.registerCommand('harborMate.showHealth', async () => { await showMarkdown('Harbor Mate · Agent Health', healthMarkdown(healthReport(root()))); }),
    vscode.commands.registerCommand('harborMate.cleanUp', async () => {
      const victims = planCleanup(root(), svc.retention());
      if (!victims.length) { vscode.window.showInformationMessage('Harbor Mate: nothing to clean up.'); return; }
      const kb = Math.round(victims.reduce((n, v) => n + v.bytes, 0) / 1024);
      const ok = await vscode.window.showWarningMessage(`Harbor Mate: delete ${victims.length} finished file(s), about ${kb} KB? Pending questions, queued work, open tasks and failed runs are kept.`, { modal: true }, 'Delete');
      if (ok === 'Delete') { const msg = describeResult(runCleanup(root(), victims, 'human')); out.appendLine(`Cleanup: ${msg}`); vscode.window.showInformationMessage(`Harbor Mate: ${msg}`); inbox.refresh(); consolePanel?.refresh(); }
    }),
    vscode.commands.registerCommand('harborMate.setSecret', async () => {
      const name = await vscode.window.showInputBox({ prompt: 'Env var name (e.g. HARBOR_PAT, JIRA_TOKEN)', ignoreFocusOut: true });
      if (!name || !/^[A-Z_][A-Z0-9_]*$/.test(name)) { return; }
      const value = await vscode.window.showInputBox({ prompt: `Value for ${name}`, password: true, ignoreFocusOut: true });
      if (value) { await svc.setSecret(name, value); vscode.window.showInformationMessage(`Stored ${name}.`); }
    }),
    vscode.commands.registerCommand('harborMate.testNotify', async () => {
      const cmd = svc.cfg().get<string>('notifyCommand');
      const hook = svc.cfg().get<string>('notifyWebhook');
      if (!cmd && !hook) { vscode.window.showWarningMessage('Set harborMate.notifyWebhook (Slack, Teams or Discord) or harborMate.notifyCommand in your user settings first.'); return; }
      if (hook) { const w = await notifyWebhook(hook, { kind: 'question', agent: 'harbor-mate', title: 'Test notification' }, await svc.secrets()); vscode.window.showInformationMessage(w?.ok ? 'Harbor Mate: webhook test sent.' : `Harbor Mate: webhook failed: ${w?.error}`); if (!cmd) { return; } }
      const r = await notify(root(), cmd, { kind: 'question', agent: 'harbor-mate', title: 'Test notification' }, await svc.secrets());
      out.show(true);
      out.appendLine(`notify test: ${r?.text}`);
    }),
    vscode.commands.registerCommand('harborMate.listModels', async () => {
      const ms = await vscode.lm.selectChatModels({ vendor: 'copilot' });
      out.show(true);
      out.appendLine('Copilot models:\n' + ms.map(m => `  family=${m.family}  id=${m.id}  maxInputTokens=${m.maxInputTokens}`).join('\n'));
    }),
    vscode.commands.registerCommand('harborMate.openGate', (g: Gate) => showGate(root(), g)),
    vscode.commands.registerCommand('harborMate.answer', async (g: Gate) => {
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
    vscode.commands.registerCommand('harborMate.approve', async (g: Gate) => {
      const ok = await vscode.window.showWarningMessage(`Run for "${g.title}"?`, { modal: true, detail: g.command }, 'Run');
      if (ok !== 'Run') { return; }
      try {
        const r = await approveAndRun(root(), g.id, policyFor(g), await svc.secrets());
        out.appendLine(`✔ ${g.title}: ${r.ok ? 'executed' : 'FAILED'}\n${r.text}`);
        vscode.window.showInformationMessage(`Harbor Mate: "${g.title}" ${r.ok ? 'executed' : 'failed'}.`);
        after(r.woke);
      } catch (e: any) { vscode.window.showErrorMessage(e.message); }
    }),
    vscode.commands.registerCommand('harborMate.reject', async (g: Gate) => {
      const fb = await vscode.window.showInputBox({ prompt: 'Feedback for the agent (optional)', ignoreFocusOut: true });
      if (fb === undefined) { return; }
      try { after(rejectApproval(root(), g.id, fb).woke); } catch (e: any) { vscode.window.showWarningMessage(e.message); }
    }),
    vscode.commands.registerCommand('harborMate.refreshInbox', () => inbox.refresh()),
    { dispose: () => svc.stop() }
  );
  if (simEnabled()) {
    ctx.subscriptions.push(
      vscode.commands.registerCommand('harborMate._sim.submit', (agent: string, task: string) => { svc.submit(agent, task); }),
      vscode.commands.registerCommand('harborMate._sim.answer', (gateId: string, answer: string) => {
        after(answerQuestion(root(), gateId, answer).woke);
      }),
      vscode.commands.registerCommand('harborMate._sim.chatSend', (agent: string, text: string) => { svc.chatSend(agent, text); }),
      vscode.commands.registerCommand('harborMate._sim.cancelRun', (agent: string) => svc.cancelRun(agent)),
      vscode.commands.registerCommand('harborMate._sim.tick', () => svc.tick()),
      vscode.commands.registerCommand('harborMate._sim.snapshot', () => ({
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
  const willAutoStart = (ctx.workspaceState.get<boolean>(STARTED_KEY) ?? ctx.workspaceState.get<boolean>(LEGACY_STARTED_KEY)) === true;
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
