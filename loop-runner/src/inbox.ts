import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Gate, listGates } from './queue';
import { RunSummary, recentRuns } from './runs';
import { AgentRow, agentRows } from './status';

/** Collapsible root groups: the agents on the team, and the audit chains of recent runs. */
interface Group { group: 'agents' | 'runs' }
/** One agent on the team. */
interface AgentNode { agentRow: AgentRow }
/** One file a run wrote; `abs` is the absolute path to open. */
interface OutputNode { output: string; abs: string }
type Node = Gate | Group | AgentNode | RunSummary | OutputNode;

const isGroup = (n: Node): n is Group => (n as Group).group !== undefined;
const isAgent = (n: Node): n is AgentNode => (n as AgentNode).agentRow !== undefined;
const isRun = (n: Node): n is RunSummary => (n as RunSummary).started !== undefined;
const isOutput = (n: Node): n is OutputNode => (n as OutputNode).output !== undefined;

/**
 * Sidebar inbox, top to bottom: what needs you (questions, approvals), recent gates, the agents on the team,
 * then recent runs with the files each one wrote.
 */
export class InboxView implements vscode.TreeDataProvider<Node> {
  private emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private root: () => string | undefined, private activeAgent: () => string | undefined = () => undefined) {}

  refresh(): void { this.emitter.fire(undefined); }

  pendingCount(): number {
    const r = this.root();
    return r ? listGates(r).filter(g => g.status === 'pending').length : 0;
  }

  getChildren(element?: Node): Node[] {
    const r = this.root();
    if (!r) { return []; }
    if (element && isGroup(element)) {
      return element.group === 'agents'
        ? agentRows(r, this.activeAgent()).map(agentRow => ({ agentRow }))
        : recentRuns(r);
    }
    if (element && isRun(element)) {
      return element.outputs.map(output => ({ output, abs: path.join(r, output) }));
    }
    if (element) { return []; }
    const all = listGates(r);
    return [
      ...all.filter(g => g.status === 'pending'),
      ...all.filter(g => g.status !== 'pending').slice(0, 15),
      { group: 'agents' },
      { group: 'runs' }
    ];
  }

  getTreeItem(n: Node): vscode.TreeItem {
    if (isGroup(n)) {
      const agents = n.group === 'agents';
      const it = new vscode.TreeItem(agents ? 'Agents' : 'Recent runs',
        agents ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
      it.iconPath = new vscode.ThemeIcon(agents ? 'organization' : 'history');
      return it;
    }
    if (isAgent(n)) {
      const a = n.agentRow;
      const it = new vscode.TreeItem(a.name, vscode.TreeItemCollapsibleState.None);
      it.description = `${a.state} · ${a.next ? `next ${clock(a.next.toISOString())}` : 'manual'}`;
      it.tooltip = new vscode.MarkdownString([
        `**${a.name}** — ${a.state}`,
        a.model ? `Model: ${a.model}` : '',
        a.schedule ? `Schedule: \`${a.schedule}\`` : 'No schedule (runs when given a task)',
        a.lastWake ? `Last wake check: ${a.lastWake.wake ? 'found work' : 'nothing to do'} at ${clock(a.lastWake.at)}` : 'No wake check yet'
      ].filter(Boolean).join('\n\n'));
      it.iconPath = new vscode.ThemeIcon(a.state === 'running' ? 'sync' : a.state === 'waiting' ? 'bell-dot' : 'circle-outline');
      const r = this.root() ?? '';
      it.command = { command: 'vscode.open', title: 'Open agent file', arguments: [vscode.Uri.file(path.join(r, a.file))] };
      return it;
    }
    if (isOutput(n)) {
      const it = new vscode.TreeItem(path.basename(n.output), vscode.TreeItemCollapsibleState.None);
      it.description = path.dirname(n.output);
      it.iconPath = new vscode.ThemeIcon('file');
      it.command = { command: 'vscode.open', title: 'Open file', arguments: [vscode.Uri.file(n.abs)] };
      return it;
    }
    if (isRun(n)) {
      const it = new vscode.TreeItem(n.agent, n.outputs.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
      it.description = `${n.status} · step ${n.step} · ${clock(n.started)}${n.summary ? ` · ${n.summary.slice(0, 60)}` : ''}`;
      it.tooltip = new vscode.MarkdownString(`**${n.agent}** — ${n.status}\n\n${n.summary}\n\n\`${n.chainId}\``);
      it.iconPath = new vscode.ThemeIcon(
        n.status === 'done' ? 'pass' : n.status === 'waiting' ? 'bell-dot' : n.status === 'running' ? 'sync' : 'warning');
      it.command = { command: 'vscode.open', title: 'Open run log', arguments: [vscode.Uri.file(n.file)] };
      return it;
    }
    const g = n;
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

function clock(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
