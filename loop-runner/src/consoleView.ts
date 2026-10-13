import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import { ConsoleModel, consoleModel, renderBody, renderPage } from './console';
import { closeTaskByHuman } from './tasks';
import { Active } from './textutil';

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
}

const COMMANDS: Record<string, string> = {
  startTeam: 'loopRunner.startTeam',
  stopTeam: 'loopRunner.stopTeam',
  runAgent: 'loopRunner.runAgent',
  openLatestResult: 'loopRunner.openLatestResult'
};

/** Webview console: one page with what needs you, the agents, and what each run did. */
export class ConsolePanel {
  private panel?: vscode.WebviewPanel;
  /** Gates whose approved command is running now: a second click must not run it again. */
  private inFlight = new Set<string>();
  /** Which page is showing and which agent's conversation; set by the page, kept here so a refresh does not reset it. */
  private view: { tab: 'chat' | 'overview'; agent?: string } = { tab: 'chat' };
  private lastHtml = '';

  constructor(private a: ConsoleActions) {}

  show(): void {
    if (this.panel) { this.panel.reveal(); this.refresh(true); return; }
    const panel = vscode.window.createWebviewPanel('loopRunner.console', 'Loop Console', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    this.panel = panel;
    this.lastHtml = '';
    panel.onDidDispose(() => { this.panel = undefined; this.lastHtml = ''; });
    panel.onDidChangeViewState(() => { if (panel.visible) { this.refresh(true); } });
    const model = this.model();
    panel.webview.html = renderPage(model, crypto.randomBytes(16).toString('hex'), panel.webview.cspSource);
    this.title(model.pending.length);
    panel.webview.onDidReceiveMessage(m => void this.handle(m));
  }

  /** Push fresh data into an open console. Skipped while hidden and when nothing changed. */
  refresh(force = false): void {
    if (!this.panel || (!this.panel.visible && !force)) { return; }
    const model = this.model();
    const html = renderBody(model);
    this.title(model.pending.length);
    // updatedAt changes every time; compare without it so an idle console does not redraw (and lose focus) every 5 s.
    const key = html.replace(/<time[^>]*data-updated[^>]*>[^<]*<\/time>/, '');
    if (key === this.lastHtml && !force) { return; }
    this.lastHtml = key;
    void this.panel.webview.postMessage({ type: 'body', html });
  }

  private title(pending: number): void {
    if (this.panel) { this.panel.title = pending ? `Loop Console (${pending})` : 'Loop Console'; }
  }

  private model(): ConsoleModel {
    const r = this.a.root();
    if (!r) {
      return { tab: this.view.tab, running: false, next: undefined, pending: [], agents: [], runs: [], updatedAt: new Date().toISOString(),
        note: { tone: 'info', text: 'Open a folder in VS Code to use Loop Runner.' } };
    }
    try {
      return consoleModel(r, { ...this.a.state(), tab: this.view.tab, agent: this.view.agent });
    } catch (e: any) {
      return { tab: this.view.tab, running: this.a.state().running, active: this.a.state().active, pending: [], agents: [], runs: [], updatedAt: new Date().toISOString(),
        note: { tone: 'bad', text: `Could not read .loop data: ${e?.message ?? e}. Showing nothing rather than something stale.` } };
    }
  }

  private async handle(m: any): Promise<void> {
    const r = this.a.root();
    if (!r) { void vscode.window.showWarningMessage('Loop Runner: open a folder first.'); return; }
    try {
      switch (m?.type) {
        case 'ready': this.refresh(true); return;
        case 'cmd': if (COMMANDS[m.name]) { await vscode.commands.executeCommand(COMMANDS[m.name]); } break;
        case 'answer': this.a.answer(String(m.id), String(m.text)); break;
        case 'approve': {
          const id = String(m.id);
          if (this.inFlight.has(id)) { return; }
          this.inFlight.add(id);
          try { await this.a.approve(id, m.seen && typeof m.seen === 'object' ? m.seen : {}); } finally { this.inFlight.delete(id); void this.panel?.webview.postMessage({ type: 'idle', id }); }
          break;
        }
        case 'reject': this.a.reject(String(m.id), String(m.feedback ?? '')); break;
        case 'view':
          this.view = { tab: m.tab === 'overview' ? 'overview' : 'chat', agent: typeof m.agent === 'string' && m.agent ? m.agent : this.view.agent };
          break;
        case 'closeTask': closeTaskByHuman(r, String(m.id)); break;
        case 'chatSend': this.a.chatSend(String(m.agent), String(m.text ?? '')); break;
        case 'chatCancel':
          if (!this.a.chatCancel(String(m.agent))) { void vscode.window.showInformationMessage(`Loop Runner: ${m.agent} is not running right now.`); }
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
      vscode.window.showWarningMessage(`Loop Runner: ${e?.message ?? e}`);
    }
    this.refresh(true);
  }
}
