import * as vscode from 'vscode';
import { ConnectionInfo, McpHttpService, validateKey } from './server';
import { SerialQueue } from './core';
import { WorkspaceTools } from './tools';
import { McpSidebar } from './sidebar';

let service: McpHttpService | undefined;
export interface ExtensionApi {
  start(): Promise<ConnectionInfo>;
  stop(): Promise<void>;
  getConnectionInfo(): ConnectionInfo | undefined;
}

export async function activate(context: vscode.ExtensionContext): Promise<ExtensionApi> {
  const output = vscode.window.createOutputChannel('VSCode MCP');
  const log = (message: string) => output.appendLine(`${new Date().toISOString()} ${message}`);
  const tools = new WorkspaceTools(log);
  const current = new McpHttpService(server => tools.register(server), log, context.extension.packageJSON.version as string);
  service = current;
  const lifecycle = new SerialQueue();
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  const keyStorage = 'vscodeMcp.customKey';
  let hasCustomKey = !!await context.secrets.get(keyStorage);
  const sidebar = new McpSidebar(() => current.connection, () => hasCustomKey);
  const sidebarView = vscode.window.createTreeView('vscode-mcp.controls', { treeDataProvider: sidebar, showCollapseAll: false });
  const updateStatus = () => {
    const connection = current.connection;
    status.text = connection ? `$(plug) MCP :${new URL(connection.url).port}` : '$(debug-disconnect) MCP 已停止';
    status.tooltip = connection ? 'VSCode MCP：点击复制连接信息' : 'VSCode MCP：点击启动服务';
    status.command = connection ? 'vscode-mcp.copyConnection' : 'vscode-mcp.start';
    status.show();
    sidebar.refresh();
    void vscode.commands.executeCommand('setContext', 'vscodeMcp.running', !!connection);
  };
  const api: ExtensionApi = {
    start: () => lifecycle.run(async () => {
      const configuration = vscode.workspace.getConfiguration('vscodeMcp');
      const info = await current.start(configuration.get<number>('port', 0), {
        enabled: configuration.get<boolean>('auth.enabled', true), key: await context.secrets.get(keyStorage)
      });
      updateStatus(); return info;
    }),
    stop: () => lifecycle.run(async () => { await current.stop(); updateStatus(); }),
    getConnectionInfo: () => current.connection
  };
  const command = (name: string, callback: () => Promise<unknown> | unknown) => vscode.commands.registerCommand(name, async () => {
    try { return await callback(); }
    catch (error) {
      log(`${name} failed: ${error instanceof Error ? error.message : String(error)}`);
      void vscode.window.showErrorMessage(`VSCode MCP：${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  });
  context.subscriptions.push(output, status, sidebar, sidebarView,
    command('vscode-mcp.start', async () => {
      const info = await api.start(); void vscode.window.showInformationMessage(`MCP 服务已启动：${info.url}`);
    }),
    command('vscode-mcp.stop', () => api.stop()),
    command('vscode-mcp.copyConnection', async () => {
      const info = current.connection;
      if (!info) { throw new Error('请先启动 MCP 服务。'); }
      await vscode.env.clipboard.writeText(JSON.stringify({ url: info.url, ...(info.authEnabled ? { headers: { Authorization: `Bearer ${info.token}` } } : {}) }, null, 2));
      void vscode.window.showInformationMessage(info.authEnabled ? 'MCP 连接信息已复制，包含连接凭据，请只粘贴到可信客户端配置。' : 'MCP 连接地址已复制，当前无需 Key。');
    }),
    command('vscode-mcp.showLog', () => output.show()),
    command('vscode-mcp.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:' + context.extension.id)),
    command('vscode-mcp.toggleAuth', async () => {
      const configuration = vscode.workspace.getConfiguration('vscodeMcp');
      if (configuration.inspect<boolean>('auth.enabled')?.defaultValue === undefined) {
        throw new Error('连接验证配置尚未加载。请执行 Developer: Reload Window（开发人员: 重新加载窗口）；若使用 F5 调试，请关闭开发宿主后重新按 F5 启动。');
      }
      const target = vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
      await configuration.update('auth.enabled', !configuration.get<boolean>('auth.enabled', true), target);
      void vscode.window.showInformationMessage('连接验证设置已更新，重启 MCP 服务后生效。');
    }),
    command('vscode-mcp.setKey', async () => {
      const key = await vscode.window.showInputBox({ title: '设置 MCP Key', prompt: '保存自定义 Key，重启 MCP 服务后生效。', password: true, ignoreFocusOut: true,
        validateInput: value => validateKey(value) ? undefined : '请输入 1–1024 个可打印英文字符，不包含空格。' });
      if (key === undefined) { return; }
      await context.secrets.store(keyStorage, key);
      hasCustomKey = true;
      sidebar.refresh();
      void vscode.window.showInformationMessage('自定义 Key 已保存，开启连接验证并重启 MCP 服务后生效。');
    }),
    command('vscode-mcp.clearKey', async () => {
      await context.secrets.delete(keyStorage);
      hasCustomKey = false;
      sidebar.refresh();
      void vscode.window.showInformationMessage('自定义 Key 已清除，开启连接验证并重启 MCP 服务后使用随机 Key。');
    }),
    context.secrets.onDidChange(async event => {
      if (event.key === keyStorage) { hasCustomKey = !!await context.secrets.get(keyStorage); sidebar.refresh(); }
    }),
    vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('vscodeMcp')) { sidebar.refresh(); } }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => sidebar.refresh()),
    { dispose: () => { void current.stop(); } }
  );
  updateStatus();
  if (vscode.workspace.getConfiguration('vscodeMcp').get<boolean>('autoStart', false)) {
    try { await api.start(); }
    catch (error) { log(`Auto-start failed: ${error instanceof Error ? error.message : String(error)}`); void vscode.window.showErrorMessage('VSCode MCP 自动启动失败，请查看日志。'); }
  }
  return api;
}

export async function deactivate(): Promise<void> { await service?.stop(); service = undefined; }
