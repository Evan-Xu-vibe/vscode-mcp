import * as vscode from 'vscode';
import type { ConnectionInfo } from './server';

export class McpSidebar implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  constructor(private readonly connection: () => ConnectionInfo | undefined, private readonly hasCustomKey: () => boolean, private readonly needsRestart: () => boolean) {}
  refresh(): void { this.changed.fire(); }
  dispose(): void { this.changed.dispose(); }
  getTreeItem(item: vscode.TreeItem): vscode.TreeItem { return item; }

  getChildren(): vscode.TreeItem[] {
    const connection = this.connection();
    const configuration = vscode.workspace.getConfiguration('vscodeMcp');
    const row = (id: string, label: string, icon: string, command?: string, description?: string) => {
      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
      item.id = id;
      item.iconPath = new vscode.ThemeIcon(icon);
      item.description = description;
      if (command) { item.command = { command, title: label }; }
      return item;
    };
    const state = row('state', connection ? '服务运行中' : '服务已停止', connection ? 'pass-filled' : 'circle-outline');
    state.tooltip = connection ? '外部 Agent 可通过本机地址连接此窗口。' : '启动服务后，复制连接信息并配置 MCP 客户端。';
    const configuredWrites = configuration.get<boolean>('allowWrites', true);
    const writes = vscode.workspace.isTrusted && configuredWrites;
    const items = [state];
    if (connection) {
      const endpoint = row('endpoint', '连接地址', 'link', undefined, connection.url);
      endpoint.tooltip = connection.url;
      items.push(endpoint, row('restart', this.needsRestart() ? '立即重启以应用设置' : '重启服务', 'refresh', 'vscode-mcp.restart'), row('stop', '停止服务', 'debug-stop', 'vscode-mcp.stop'), row('copy', '复制连接信息', 'copy', 'vscode-mcp.copyConnection'), row('client', '复制客户端配置', 'code', 'vscode-mcp.copyClient'));
    } else {
      items.push(row('start', '启动服务', 'play', 'vscode-mcp.start'));
    }
    const configuredAuth = configuration.get<boolean>('auth.enabled', true);
    const enabled = connection?.authEnabled ?? configuredAuth;
    const auth = row('auth', '连接验证', configuredAuth ? 'shield' : 'unlock', 'vscode-mcp.toggleAuth', configuredAuth ? '已开启' : '已关闭');
    auth.tooltip = '点击切换连接验证，重启服务后生效。';
    if (connection && enabled !== configuredAuth) { auth.description += ' · 待重启'; }
    items.push(auth);
    if (connection) { items.push(row('activeAuth', '当前生效验证', 'shield', undefined, enabled ? '开启' : '关闭')); }
    const configuredPort = configuration.get<number>('port', 0);
    items.push(row('port', '设置连接端口', 'plug', 'vscode-mcp.setPort', configuredPort === 0 ? '自动分配' : String(configuredPort)));
    if (connection?.authEnabled) { items.push(row('activeKey', '当前生效 Key', 'key', undefined, connection.keySource === 'custom' ? '自定义 Key' : '随机 Key')); }
    const key = row('key', '设置 / 更改 Key', 'key', 'vscode-mcp.setKey', this.hasCustomKey() ? '已保存自定义 Key' : '未设置，验证时生成随机 Key');
    key.tooltip = '自定义 Key 保存在 VS Code 密钥存储中，开启验证并重启服务后使用。';
    items.push(key);
    if (this.hasCustomKey()) { items.push(row('clearKey', '清除自定义 Key', 'discard', 'vscode-mcp.clearKey')); }
    const autoStart = row('autoStart', '启动窗口时自动运行', 'play-circle', 'vscode-mcp.toggleAutoStart', configuration.get<boolean>('autoStart', false) ? '已开启' : '已关闭');
    autoStart.tooltip = '点击切换，下次打开或重新加载窗口时生效。';
    const permissions = row('permissions', '允许文件修改', writes ? 'edit' : 'lock', 'vscode-mcp.toggleWrites', `${configuredWrites ? '已开启' : '已关闭'}${!vscode.workspace.isTrusted ? ' · 工作区未受信任' : ''}`);
    permissions.tooltip = vscode.workspace.isTrusted ? '点击切换，立即生效。' : '点击调整设置；工作区未受信任时仍禁止文件修改。';
    const approval = row('approval', '修改前需要确认', 'checklist', 'vscode-mcp.toggleApproval', configuration.get<boolean>('requireApproval', false) ? '已开启' : '已关闭');
    approval.tooltip = '点击切换，立即生效。开启后修改和保存请求进入下方待确认修改面板。';
    const tasksEnabled = configuration.get<boolean>('tasks.enabled', false);
    const tasks = row('tasks', '允许执行任务', 'run-all', 'vscode-mcp.toggleTasks', `${tasksEnabled ? '已开启' : '已关闭'}${!vscode.workspace.isTrusted ? ' · 工作区未受信任' : ''}`);
    tasks.tooltip = '点击切换，立即生效。任务还需加入允许列表，并且工作区必须受信任。';
    const names = configuration.get<string[]>('tasks.allowedNames', []);
    const allowedTasks = row('allowedTasks', '配置允许的任务', 'list-selection', 'vscode-mcp.configureTasks', names.length ? `已允许 ${names.length} 个` : '尚未允许任何任务');
    allowedTasks.tooltip = names.length ? `点击勾选允许的任务，或添加任务名称。\n${names.join('\n')}` : '点击选择允许的已有任务，或手动添加任务名称。';
    items.push(autoStart, permissions, approval, tasks, allowedTasks, row('log', '查看调用日志', 'output', 'vscode-mcp.showLog'));
    return items;
  }
}
