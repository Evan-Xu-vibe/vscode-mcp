import * as vscode from 'vscode';
import type { ConnectionInfo } from './server';

export class McpSidebar implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  constructor(private readonly connection: () => ConnectionInfo | undefined, private readonly hasCustomKey: () => boolean) {}
  refresh(): void { this.changed.fire(); }
  dispose(): void { this.changed.dispose(); }
  getTreeItem(item: vscode.TreeItem): vscode.TreeItem { return item; }

  getChildren(): vscode.TreeItem[] {
    const connection = this.connection();
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
    const writes = vscode.workspace.isTrusted && vscode.workspace.getConfiguration('vscodeMcp').get<boolean>('allowWrites', true);
    const items = [state];
    if (connection) {
      const endpoint = row('endpoint', '连接地址', 'link', undefined, connection.url);
      endpoint.tooltip = connection.url;
      items.push(endpoint, row('stop', '停止服务', 'debug-stop', 'vscode-mcp.stop'), row('copy', '复制连接信息', 'copy', 'vscode-mcp.copyConnection'));
    } else {
      items.push(row('start', '启动服务', 'play', 'vscode-mcp.start'));
    }
    const configuredAuth = vscode.workspace.getConfiguration('vscodeMcp').get<boolean>('auth.enabled', true);
    const enabled = connection?.authEnabled ?? configuredAuth;
    const auth = row('auth', enabled ? '连接验证已开启' : '连接验证已关闭', enabled ? 'shield' : 'unlock', 'vscode-mcp.toggleAuth');
    auth.tooltip = '点击切换连接验证，重启服务后生效。';
    if (connection && enabled !== configuredAuth) { auth.description = '设置已更改，待重启'; }
    items.push(auth);
    const key = row('key', '设置 / 更改 Key', 'key', 'vscode-mcp.setKey', this.hasCustomKey() ? '已保存自定义 Key' : '未设置，验证时生成随机 Key');
    key.tooltip = '自定义 Key 保存在 VS Code 密钥存储中，开启验证并重启服务后使用。';
    items.push(key);
    if (this.hasCustomKey()) { items.push(row('clearKey', '清除自定义 Key', 'discard', 'vscode-mcp.clearKey')); }
    const permissions = row('permissions', writes ? '允许文件修改' : '仅允许读取文件', writes ? 'edit' : 'lock', 'vscode-mcp.openSettings');
    permissions.tooltip = vscode.workspace.isTrusted ? '点击打开插件设置，调整文件修改权限。' : '工作区未受信任，文件修改已禁用。';
    items.push(permissions, row('log', '查看调用日志', 'output', 'vscode-mcp.showLog'), row('settings', '插件设置', 'settings-gear', 'vscode-mcp.openSettings'));
    return items;
  }
}
