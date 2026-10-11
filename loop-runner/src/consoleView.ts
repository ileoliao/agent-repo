import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import { consoleModel, renderBody, renderPage } from './console';

/** What the console can ask the extension to do. Each action reuses an existing code path. */
export interface ConsoleActions {
  root: () => string | undefined;
  state: () => { running: boolean; active?: string };
  answer: (gateId: string, text: string) => void;
  approve: (gateId: string, seen: Record<string, string>) => Promise<void>;
  reject: (gateId: string, feedback: string) => void;
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

  constructor(private a: ConsoleActions) {}

  show(): void {
    if (this.panel) { this.panel.reveal(); this.refresh(); return; }
    const panel = vscode.window.createWebviewPanel('loopRunner.console', 'Loop Console', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    this.panel = panel;
    panel.onDidDispose(() => { this.panel = undefined; });
    panel.webview.html = renderPage(this.model(), crypto.randomBytes(16).toString('hex'), panel.webview.cspSource);
    panel.webview.onDidReceiveMessage(m => void this.handle(m));
  }

  /** Push fresh data into an open console. No-op when it is closed. */
  refresh(): void {
    if (this.panel) { void this.panel.webview.postMessage({ type: 'body', html: renderBody(this.model()) }); }
  }

  private model() {
    const r = this.a.root();
    return consoleModel(r ?? '', this.a.state());
  }

  private async handle(m: any): Promise<void> {
    const r = this.a.root();
    if (!r) { return; }
    try {
      switch (m?.type) {
        case 'ready': this.refresh(); break;
        case 'cmd': if (COMMANDS[m.name]) { await vscode.commands.executeCommand(COMMANDS[m.name]); } break;
        case 'answer': this.a.answer(String(m.id), String(m.text)); break;
        case 'approve': await this.a.approve(String(m.id), m.seen && typeof m.seen === 'object' ? m.seen : {}); break;
        case 'reject': this.a.reject(String(m.id), String(m.feedback ?? '')); break;
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
    this.refresh();
  }
}
