import { planAllowCommand } from './policyEdit';
import { applyChange } from './manage';
import { TEMPLATES } from './templates';
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import { ConsoleModel, consoleModel, renderBody, renderPage } from './console';
import { closeTaskByHuman } from './tasks';
import { Active } from './textutil';
import { dismissBlock, setUiFlag } from './maintenance';

/** What the console can ask the extension to do. Each action reuses an existing code path. */
export interface ConsoleActions {
  root: () => string | undefined;
  state: () => { running: boolean; active?: Active };
  answer: (gateId: string, text: string) => void;
  approve: (gateId: string, seen: Record<string, string>) => Promise<void>;
  reject: (gateId: string, feedback: string) => void;
  /** The human writes to an agent. Returns where the message went, for the status line. */
  chatSend: (agent: string, text: string) => void;
  /** Cancel the agent's current run (it is not retried). */
  chatCancel: (agent: string) => boolean;
  /** Copilot models VS Code offers right now (undefined while unknown). */
  copilotModels?: () => number | undefined;
  /** The policy file used by mates that name none (the harborMate.policyFile setting). */
  defaultPolicy?: () => string;
}

const COMMANDS: Record<string, string> = {
  startTeam: 'harborMate.startTeam',
  stopTeam: 'harborMate.stopTeam',
  runAgent: 'harborMate.runAgent',
  getStarted: 'harborMate.getStarted',
  describeAgent: 'harborMate.describeAgent',
  runDoctor: 'harborMate.runDoctor',
  showHealth: 'harborMate.showHealth',
  cleanUp: 'harborMate.cleanUp',
  setSecret: 'harborMate.setSecret',
  pauseAgent: 'harborMate.pauseAgent',
  resumeAgent: 'harborMate.resumeAgent'
};

/** Webview console: one page, the roster of mates beside the conversation with the selected one. */
export class ConsolePanel {
  private panel?: vscode.WebviewPanel;
  /** Gates whose approved command is running now: a second click must not run it again. */
  private inFlight = new Set<string>();
  /** Which mate's conversation is showing; set by the page, kept here so a refresh does not reset it. */
  private view: { agent?: string } = {};
  private lastHtml = '';

  constructor(private a: ConsoleActions) {}

  /** The one argument a page button may pass: a starter id, or an agent name. Anything else is dropped. */
  private cmdArg(name: string, arg: unknown): string | undefined {
    if (typeof arg !== 'string') { return undefined; }
    if (name === 'getStarted') { return TEMPLATES.some(t => t.id === arg) ? arg : undefined; }
    if (name === 'runAgent' || name === 'pauseAgent' || name === 'resumeAgent') { return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(arg) ? arg : undefined; }
    return undefined;
  }

  /** Open the console, on one mate's conversation when `agent` is given (a notification's Open button). */
  show(agent?: string): void {
    if (agent) { this.view = { agent }; }
    if (this.panel) { this.panel.reveal(); this.refresh(true); return; }
    // A freshly opened console starts where the longest wait is (see `consoleModel`), unless a mate was asked for.
    if (!agent) { this.view = {}; }
    const panel = vscode.window.createWebviewPanel('harborMate.console', 'Harbor Mate', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    this.panel = panel;
    this.lastHtml = '';
    panel.onDidDispose(() => { this.panel = undefined; this.lastHtml = ''; });
    panel.onDidChangeViewState(() => { if (panel.visible) { this.refresh(true); } });
    const model = this.model();
    panel.webview.html = renderPage(model, crypto.randomBytes(16).toString('hex'), panel.webview.cspSource);
    this.title(this.todos(model));
    panel.webview.onDidReceiveMessage(m => void this.handle(m));
  }

  /** Push fresh data into an open console. Skipped while hidden and when nothing changed. */
  refresh(force = false): void {
    if (!this.panel || (!this.panel.visible && !force)) { return; }
    const model = this.model();
    const html = renderBody(model);
    this.title(this.todos(model));
    // updatedAt changes every time; compare without it so an idle console does not redraw (and lose focus) every 5 s.
    const key = html.replace(/<time[^>]*data-updated[^>]*>[^<]*<\/time>/, '');
    if (key === this.lastHtml && !force) { return; }
    this.lastHtml = key;
    void this.panel.webview.postMessage({ type: 'body', html });
  }

  /** Everything waiting on the person: questions, approvals and blocked commands. */
  private todos(m: ConsoleModel): number { return m.pending.length + (m.blocked ?? []).length; }

  private title(pending: number): void {
    if (this.panel) { this.panel.title = pending ? `Harbor Mate (${pending})` : 'Harbor Mate'; }
  }

  private model(): ConsoleModel {
    const r = this.a.root();
    if (!r) {
      return { running: false, next: undefined, pending: [], agents: [], runs: [], updatedAt: new Date().toISOString(),
        note: { tone: 'info', text: 'Open a folder in VS Code to use Harbor Mate.' } };
    }
    try {
      const model = consoleModel(r, { ...this.a.state(), agent: this.view.agent, defaultPolicy: this.a.defaultPolicy?.() });
      // The choice made by the opening rule sticks: a mate that starts needing you later does not pull the page away (the header pill does that, on a click).
      if (!this.view.agent && model.chat?.selected) { this.view = { agent: model.chat.selected }; }
      return { ...model, copilot: this.a.copilotModels?.() };
    } catch (e: any) {
      return { running: this.a.state().running, active: this.a.state().active, pending: [], agents: [], runs: [], updatedAt: new Date().toISOString(),
        note: { tone: 'bad', text: `Could not read .loop data: ${e?.message ?? e}. Showing nothing rather than something stale.` } };
    }
  }

  /** Ask, then add the exact command to that mate's own policy. True when it was allowed. */
  private async allow(r: string, agent: string, command: string): Promise<boolean> {
    const plan = planAllowCommand(r, agent, command, this.a.defaultPolicy?.() ?? '.loop/policy.json');
    if ('error' in plan) { void vscode.window.showWarningMessage(`Harbor Mate: ${plan.error}`); return false; }
    const shared = plan.shared.length ? `\n\nThis policy file is also used by ${plan.shared.join(', ')}, so they get the same permission.` : '';
    const ok = await vscode.window.showWarningMessage(`Let ${agent} run this command from now on?`, { modal: true, detail: `${command}\n\nOnly this exact command, only for ${agent}. It is saved in ${plan.file}. Anything else it tries is still checked against the policy.${shared}` }, 'Allow');
    if (ok !== 'Allow') { return false; }
    for (const c of plan.changes) { applyChange(r, c); }
    await vscode.commands.executeCommand('harborMate.reloadTeam');
    void vscode.window.showInformationMessage(`Harbor Mate: ${agent} may now run that command. Policy: ${plan.file}.`);
    return true;
  }

  private async handle(m: any): Promise<void> {
    const r = this.a.root();
    if (!r) { void vscode.window.showWarningMessage('Harbor Mate: open a folder first.'); return; }
    try {
      switch (m?.type) {
        case 'ready': this.refresh(true); return;
        case 'cmd': if (COMMANDS[m.name]) { await vscode.commands.executeCommand(COMMANDS[m.name], this.cmdArg(String(m.name), m.arg)); } break;
        case 'answer': this.a.answer(String(m.id), String(m.text)); break;
        case 'approve': {
          const id = String(m.id);
          if (this.inFlight.has(id)) { return; }
          this.inFlight.add(id);
          try { await this.a.approve(id, m.seen && typeof m.seen === 'object' ? m.seen : {}); setUiFlag(r, 'approvalNoteSeen'); } finally { this.inFlight.delete(id); void this.panel?.webview.postMessage({ type: 'idle', id }); }
          break;
        }
        case 'reject': this.a.reject(String(m.id), String(m.feedback ?? '')); setUiFlag(r, 'approvalNoteSeen'); break;
        case 'view':
          this.view = { agent: typeof m.agent === 'string' && m.agent ? m.agent : this.view.agent };
          break;
        case 'allowCommand': {
          const agent = String(m.agent ?? ''), command = String(m.command ?? '');
          if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(agent)) { return; }
          const allowed = await this.allow(r, agent, command);
          // "Allow and rerun" reuses Run now, so the person still says what to run.
          if (allowed && m.rerun === true) { await vscode.commands.executeCommand(COMMANDS.runAgent, agent); }
          break;
        }
        case 'dismissBlock': {
          const agent = String(m.agent ?? '');
          if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(agent)) { dismissBlock(r, agent, String(m.command ?? '')); }
          break;
        }
        case 'closeTask': closeTaskByHuman(r, String(m.id)); break;
        case 'chatSend': this.a.chatSend(String(m.agent), String(m.text ?? '')); break;
        case 'chatCancel':
          if (!this.a.chatCancel(String(m.agent))) { void vscode.window.showInformationMessage(`Harbor Mate: ${m.agent} is not running right now.`); }
          break;
        case 'open': case 'openAbs': {
          // Only files inside the workspace; the page cannot ask for anything else.
          const abs = path.resolve(r, String(m.path));
          if (abs !== r && !abs.startsWith(r + path.sep)) { return; }
          await vscode.window.showTextDocument(vscode.Uri.file(abs), { preview: false });
          break;
        }
      }
    } catch (e: any) {
      vscode.window.showWarningMessage(`Harbor Mate: ${e?.message ?? e}`);
    }
    this.refresh(true);
  }
}
