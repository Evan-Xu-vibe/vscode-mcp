import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { ToolError } from './core';

export interface FileChange { uri: vscode.Uri; original: string; text: string; expectedHash?: string; create?: boolean; save: boolean; }
interface Proposal { id: string; changes: FileChange[]; files: string[]; status: 'pending' | 'applying' | 'accepted' | 'rejected' | 'failed'; result?: Record<string, unknown>; }
export class ReviewNode extends vscode.TreeItem {
  constructor(label: string, public readonly proposalId: string, public readonly fileIndex?: number, expanded = false) {
    super(label, expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
  }
}

export class ChangeReviews implements vscode.TreeDataProvider<ReviewNode>, vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly proposals = new Map<string, Proposal>();
  constructor(private readonly apply: (changes: FileChange[]) => Promise<Record<string, unknown>>) {}
  submit(changes: FileChange[]): Record<string, unknown> {
    const pending = [...this.proposals.values()].filter(item => item.status === 'pending' || item.status === 'applying');
    const bytes = (items: FileChange[]) => items.reduce((sum, item) => sum + Buffer.byteLength(item.original) + Buffer.byteLength(item.text), 0);
    if (pending.length >= 20 || pending.reduce((sum, item) => sum + bytes(item.changes), bytes(changes)) > 10 * 1024 * 1024) {
      throw new ToolError('REVIEW_LIMIT', 'Review queue is full. Accept or reject pending changes first (20 proposals / 10 MiB).');
    }
    const id = randomUUID();
    this.proposals.set(id, { id, changes, files: changes.map(item => item.uri.toString()), status: 'pending' });
    this.changed.fire();
    return this.status(id);
  }
  status(id: string): Record<string, unknown> {
    const proposal = this.proposals.get(id);
    if (!proposal) { throw new ToolError('REVIEW_NOT_FOUND', 'Proposal is unavailable in this window.'); }
    return { proposalId: id, status: proposal.status, files: proposal.files, ...(proposal.result ? { result: proposal.result } : {}) };
  }
  async accept(id: string): Promise<Record<string, unknown>> {
    const proposal = this.pending(id);
    proposal.status = 'applying'; this.changed.fire();
    try { proposal.result = await this.apply(proposal.changes); proposal.status = 'accepted'; }
    catch (error) {
      proposal.status = 'failed';
      proposal.result = { error: { code: error instanceof ToolError ? error.code : 'OPERATION_FAILED', message: error instanceof Error ? error.message : String(error) } };
      throw error;
    } finally { this.finish(proposal); }
    return this.status(id);
  }
  reject(id: string): void { const proposal = this.pending(id); proposal.status = 'rejected'; this.finish(proposal); }
  private pending(id: string): Proposal {
    const proposal = this.proposals.get(id);
    if (!proposal || proposal.status !== 'pending') { throw new ToolError('REVIEW_NOT_PENDING', 'Proposal is not pending.'); }
    return proposal;
  }
  private finish(proposal: Proposal): void {
    proposal.changes = [];
    const completed = [...this.proposals.values()].filter(item => item.status !== 'pending' && item.status !== 'applying');
    for (const item of completed.slice(0, Math.max(0, completed.length - 100))) { this.proposals.delete(item.id); }
    this.changed.fire();
  }
  async open(id: string, index: number): Promise<void> {
    const proposal = this.pending(id);
    const change = proposal.changes[index];
    if (!change) { throw new ToolError('REVIEW_NOT_FOUND', 'No such file in this proposal.'); }
    const uri = (side: string) => vscode.Uri.from({ scheme: 'vscode-mcp-review', path: `/${id}/${index}/${side}/${change.uri.path.split('/').pop()}` });
    await vscode.commands.executeCommand('vscode.diff', uri('before'), uri('after'), `MCP 修改预览：${vscode.workspace.asRelativePath(change.uri)}`);
  }
  provideTextDocumentContent(uri: vscode.Uri): string {
    const [, id, index, side] = uri.path.split('/');
    const change = this.proposals.get(id)?.changes[Number(index)];
    return change ? side === 'before' ? change.original : change.text : '该修改预览已结束。';
  }
  getTreeItem(item: ReviewNode): ReviewNode { return item; }
  getChildren(parent?: ReviewNode): ReviewNode[] {
    if (parent) {
      const proposal = this.proposals.get(parent.proposalId);
      if (!proposal || proposal.status !== 'pending') { return []; }
      const files = proposal.changes.map((change, index) => {
        const item = new ReviewNode(`${vscode.workspace.asRelativePath(change.uri)}${change.create ? '（新建）' : ''}${change.save ? '（保存）' : ''}`, proposal.id, index);
        item.iconPath = new vscode.ThemeIcon('diff');
        item.command = { command: 'vscode-mcp.reviewOpen', title: '查看差异', arguments: [item] };
        return item;
      });
      for (const [label, command, icon] of [['接受全部修改', 'vscode-mcp.reviewAccept', 'check'], ['拒绝全部修改', 'vscode-mcp.reviewReject', 'close']]) {
        const item = new ReviewNode(label, proposal.id);
        item.iconPath = new vscode.ThemeIcon(icon);
        item.command = { command, title: label, arguments: [item] }; files.push(item);
      }
      return files;
    }
    const proposals = [...this.proposals.values()].filter(item => item.status === 'pending' || item.status === 'applying');
    return proposals.map(item => new ReviewNode(`${item.files.length} 个文件 · ${item.status === 'applying' ? '正在应用' : '待确认'} · ${item.id.slice(0, 8)}`, item.id, undefined, true));
  }
  dispose(): void { this.changed.dispose(); this.proposals.clear(); }
}
