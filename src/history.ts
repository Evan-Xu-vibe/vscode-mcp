import * as vscode from 'vscode';

export interface CallRecord { tool: string; target?: string; code: string; durationMs: number; time: string; }

export class CallHistory implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly records: CallRecord[] = [];
  add(record: CallRecord): void { this.records.unshift(record); this.records.splice(200); this.changed.fire(); }
  clear(): void { this.records.length = 0; this.changed.fire(); }
  getTreeItem(item: vscode.TreeItem): vscode.TreeItem { return item; }
  getChildren(): vscode.TreeItem[] {
    if (!this.records.length) { return [new vscode.TreeItem('暂无调用记录')]; }
    return this.records.map(record => {
      const item = new vscode.TreeItem(`${record.tool} · ${record.code}`);
      item.description = `${record.durationMs}ms · ${new Date(record.time).toLocaleTimeString()}`;
      item.iconPath = new vscode.ThemeIcon(record.code === 'OK' ? 'pass' : 'error');
      item.tooltip = `${record.time}\n${record.target ?? '无目标文件'}\n耗时 ${record.durationMs}ms`;
      return item;
    });
  }
  dispose(): void { this.changed.dispose(); this.records.length = 0; }
}
