import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Gate, listGates } from './queue';

/** Sidebar inbox: what the team needs from you (questions, approvals), then recent history. */
export class InboxView implements vscode.TreeDataProvider<Gate> {
  private emitter = new vscode.EventEmitter<Gate | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private root: () => string | undefined) {}

  refresh(): void { this.emitter.fire(undefined); }

  pendingCount(): number {
    const r = this.root();
    return r ? listGates(r).filter(g => g.status === 'pending').length : 0;
  }

  getChildren(): Gate[] {
    const r = this.root();
    if (!r) { return []; }
    const all = listGates(r);
    return [...all.filter(g => g.status === 'pending'), ...all.filter(g => g.status !== 'pending').slice(0, 15)];
  }

  getTreeItem(g: Gate): vscode.TreeItem {
    const it = new vscode.TreeItem(g.title, vscode.TreeItemCollapsibleState.None);
    it.description = `${g.agent} · ${g.status === 'pending' ? age(g.createdAt) : g.status}`;
    it.tooltip = new vscode.MarkdownString(`**${g.kind}** from ${g.agent}\n\n${g.body}` + (g.command ? `\n\n\`\`\`\n${g.command}\n\`\`\`` : ''));
    it.contextValue = `${g.kind}-${g.status}`;
    it.iconPath = new vscode.ThemeIcon(
      g.status === 'pending' ? (g.kind === 'question' ? 'question' : 'bell-dot')
        : g.status === 'failed' ? 'error' : g.status === 'rejected' ? 'circle-slash' : 'pass');
    it.command = { command: 'loopRunner.openGate', title: 'Open', arguments: [g] };
    return it;
  }
}

function age(iso: string): string {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
}

/** Render the gate as markdown beside any draft files, so the human sees everything before deciding. */
export async function showGate(root: string, g: Gate): Promise<void> {
  const md = [
    `# ${g.kind === 'question' ? '❓' : '✅'} ${g.title}`,
    `**From:** ${g.agent}  **Status:** ${g.status}  **Chain:** \`${g.chainId}\``,
    '',
    g.body,
    g.options?.length ? '\n## Suggested answers\n' + g.options.map((o, i) => `${i + 1}. ${o}`).join('\n') : '',
    g.command ? '\n## Command run on approval\n```bash\n' + g.command + '\n```' : '',
    g.files.length ? '\n## Files (editable before you decide)\n' + g.files.map(f => `- ${f}`).join('\n') : '',
    g.outcome ? '\n## Outcome\n```\n' + g.outcome + '\n```' : ''
  ].join('\n');
  const view = path.join(root, '.loop', 'gates', `${g.id}.md`);
  fs.writeFileSync(view, md);
  await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(view));
  for (const f of g.files) {
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(root, f)), { preview: false, preserveFocus: true });
  }
}
