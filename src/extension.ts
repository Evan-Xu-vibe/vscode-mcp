import * as vscode from 'vscode';
import { ConnectionInfo, HealthReport, McpHttpService, validateKey } from './server';
import { hash, SerialQueue } from './core';
import { WorkspaceTools } from './tools';
import { McpSidebar } from './sidebar';
import { CallHistory } from './history';
import { clientConfiguration } from './connection';
import { ReviewNode } from './review';

let service: McpHttpService | undefined;
export interface ExtensionApi {
  start(): Promise<ConnectionInfo>;
  stop(): Promise<void>;
  restart(): Promise<ConnectionInfo>;
  getConnectionInfo(): ConnectionInfo | undefined;
}

export async function activate(context: vscode.ExtensionContext): Promise<ExtensionApi> {
  const output = vscode.window.createOutputChannel('VSCode MCP');
  const log = (message: string) => output.appendLine(`${new Date().toISOString()} ${message}`);
  const history = new CallHistory();
  const tools = new WorkspaceTools(log, record => history.add(record));
  const current = new McpHttpService(server => tools.register(server), log, context.extension.packageJSON.version as string, () => sidebar.refresh());
  service = current;
  const lifecycle = new SerialQueue();
  const configurationChanges = new SerialQueue();
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  const keyStorage = 'vscodeMcp.customKey';
  const initialKey = await context.secrets.get(keyStorage);
  let hasCustomKey = !!initialKey;
  let configuredKeyHash = initialKey ? hash(initialKey) : undefined;
  let activePort: number | undefined;
  let healthReport: HealthReport | undefined;
  const needsRestart = () => {
    const info = current.connection;
    if (!info) { return false; }
    const config = vscode.workspace.getConfiguration('vscodeMcp');
    return activePort !== config.get<number>('port', 0) || info.authEnabled !== config.get<boolean>('auth.enabled', true)
      || (info.authEnabled && (configuredKeyHash ? hash(info.token ?? '') !== configuredKeyHash : info.keySource === 'custom'));
  };
  const sidebar = new McpSidebar(() => current.connection, () => hasCustomKey, needsRestart, () => current.requests, () => healthReport);
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
  const start = async () => {
      const configuration = vscode.workspace.getConfiguration('vscodeMcp');
      const port = configuration.get<number>('port', 0);
      const enabled = configuration.get<boolean>('auth.enabled', true);
      const info = await current.start(port, { enabled, key: await context.secrets.get(keyStorage) });
      if (activePort === undefined) { activePort = port; healthReport = undefined; }
      updateStatus(); return info;
  };
  const stop = async () => { await current.stop(); activePort = undefined; updateStatus(); };
  const api: ExtensionApi = {
    start: () => lifecycle.run(start),
    stop: () => lifecycle.run(stop),
    restart: () => lifecycle.run(async () => { await stop(); return start(); }),
    getConnectionInfo: () => current.connection
  };
  const command = (name: string, callback: (...args: unknown[]) => Promise<unknown> | unknown) => vscode.commands.registerCommand(name, async (...args: unknown[]) => {
    try { return await callback(...args); }
    catch (error) {
      log(`${name} failed: ${error instanceof Error ? error.message : String(error)}`);
      void vscode.window.showErrorMessage(`VSCode MCP：${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  });
  const offerRestart = (message: string) => {
    if (!needsRestart()) { return; }
    void vscode.window.showInformationMessage(message, '立即重启').then(selection => {
      if (selection === '立即重启') { void vscode.commands.executeCommand('vscode-mcp.restart'); }
    });
  };
  const copyClient = async (client: 'codex' | 'opencode') => {
    const info = current.connection;
    if (!info) { throw new Error('请先启动 MCP 服务。'); }
    await vscode.env.clipboard.writeText(clientConfiguration(info, client));
    void vscode.window.showInformationMessage(`${client === 'codex' ? 'Codex' : 'OpenCode'} 配置已复制${info.authEnabled ? '，包含 Key，请只粘贴到可信客户端配置' : ''}。`);
  };
  const proposalId = async (value: unknown) => {
    if (typeof value === 'string') { return value; }
    if (value instanceof ReviewNode) { return value.proposalId; }
    const selected = await vscode.window.showQuickPick(tools.reviews.getChildren().map(item => ({ label: String(item.label), id: item.proposalId })), { placeHolder: '选择待确认修改' });
    return selected?.id;
  };
  const updateConfiguration = (key: string, value: unknown) => configurationChanges.run(async () => {
    const configuration = vscode.workspace.getConfiguration('vscodeMcp');
    if (configuration.inspect(key)?.defaultValue === undefined) { throw new Error('插件配置尚未加载，请重新加载窗口；若使用 F5 调试，请关闭开发宿主后重新启动。'); }
    await configuration.update(key, value, vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
    sidebar.refresh();
  });
  const toggleConfiguration = (key: string, defaultValue: boolean) => configurationChanges.run(async () => {
    const configuration = vscode.workspace.getConfiguration('vscodeMcp');
    if (configuration.inspect(key)?.defaultValue === undefined) { throw new Error('插件配置尚未加载，请重新加载窗口；若使用 F5 调试，请关闭开发宿主后重新启动。'); }
    await configuration.update(key, !configuration.get<boolean>(key, defaultValue), vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
    sidebar.refresh();
  });
  context.subscriptions.push(output, status, sidebar, sidebarView, tools, history,
    vscode.window.createTreeView('vscode-mcp.calls', { treeDataProvider: history }),
    vscode.window.createTreeView('vscode-mcp.reviews', { treeDataProvider: tools.reviews }),
    vscode.workspace.registerTextDocumentContentProvider('vscode-mcp-review', tools.reviews),
    command('vscode-mcp.start', async () => {
      const info = await api.start(); void vscode.window.showInformationMessage(`MCP 服务已启动：${info.url}`);
    }),
    command('vscode-mcp.stop', () => api.stop()),
    command('vscode-mcp.checkConnection', () => lifecycle.run(async () => {
      healthReport = await current.checkConnection(); sidebar.refresh();
      void vscode.window.showInformationMessage(`连接自检${healthReport.passed ? '通过' : '未通过'}：${healthReport.checks.map(check => check.message).join(' ')}`);
      return healthReport;
    })),
    command('vscode-mcp.restart', async () => { const info = await api.restart(); void vscode.window.showInformationMessage(`MCP 服务已重启：${info.url}`); return info; }),
    command('vscode-mcp.copyCodex', () => copyClient('codex')),
    command('vscode-mcp.copyOpenCode', () => copyClient('opencode')),
    command('vscode-mcp.copyClient', async () => {
      const selected = await vscode.window.showQuickPick(['Codex', 'OpenCode'], { placeHolder: '选择客户端配置格式' });
      if (selected) { await copyClient(selected === 'Codex' ? 'codex' : 'opencode'); }
    }),
    command('vscode-mcp.setPort', async value => {
      const configured = vscode.workspace.getConfiguration('vscodeMcp').get<number>('port', 0);
      const input = typeof value === 'number' ? String(value) : await vscode.window.showInputBox({ title: '设置 MCP 端口', value: String(configured), prompt: '0 表示自动分配；固定端口范围为 1–65535。', validateInput: text => /^\d+$/.test(text) && Number(text) <= 65535 ? undefined : '请输入 0–65535 的整数。' });
      if (input === undefined) { return; }
      if (!/^\d+$/.test(input) || Number(input) > 65535) { throw new Error('请输入 0–65535 的整数。'); }
      await updateConfiguration('port', Number(input));
      if (!current.connection) { void vscode.window.showInformationMessage('端口设置已保存，下次启动生效。'); }
    }),
    command('vscode-mcp.clearHistory', () => history.clear()),
    command('vscode-mcp.reviewOpen', async value => { const id = await proposalId(value); if (id) { await tools.reviews.open(id, value instanceof ReviewNode ? value.fileIndex ?? 0 : 0); } }),
    command('vscode-mcp.reviewAccept', async value => { const id = await proposalId(value); if (id) { return tools.reviews.accept(id); } }),
    command('vscode-mcp.reviewReject', async value => { const id = await proposalId(value); if (id) { tools.reviews.reject(id); } }),
    command('vscode-mcp.copyConnection', async () => {
      const info = current.connection;
      if (!info) { throw new Error('请先启动 MCP 服务。'); }
      await vscode.env.clipboard.writeText(JSON.stringify({ url: info.url, ...(info.authEnabled ? { headers: { Authorization: `Bearer ${info.token}` } } : {}) }, null, 2));
      void vscode.window.showInformationMessage(info.authEnabled ? 'MCP 连接信息已复制，包含连接凭据，请只粘贴到可信客户端配置。' : 'MCP 连接地址已复制，当前无需 Key。');
    }),
    command('vscode-mcp.showLog', () => output.show()),
    command('vscode-mcp.openSettings', () => vscode.commands.executeCommand('vscode-mcp.controls.focus')),
    command('vscode-mcp.toggleAutoStart', () => toggleConfiguration('autoStart', false)),
    command('vscode-mcp.toggleWrites', () => toggleConfiguration('allowWrites', true)),
    command('vscode-mcp.toggleApproval', () => toggleConfiguration('requireApproval', false)),
    command('vscode-mcp.toggleTasks', () => toggleConfiguration('tasks.enabled', false)),
    command('vscode-mcp.toggleTerminals', () => toggleConfiguration('terminals.enabled', false)),
    command('vscode-mcp.toggleDebug', () => toggleConfiguration('debug.enabled', false)),
    command('vscode-mcp.toggleDebugEvaluation', () => toggleConfiguration('debug.allowEvaluation', false)),
    command('vscode-mcp.setSearchMaxFiles', async value => {
      const input = typeof value === 'number' ? String(value) : await vscode.window.showInputBox({ title: '搜索候选文件上限', value: String(vscode.workspace.getConfiguration('vscodeMcp').get<number>('search.maxFiles', 10000)), prompt: '100–50000；搜索按页扫描，可继续翻页。', validateInput: text => /^\d+$/.test(text) && Number(text) >= 100 && Number(text) <= 50000 ? undefined : '请输入 100–50000 的整数。' });
      if (input === undefined) { return; }
      if (!/^\d+$/.test(input) || Number(input) < 100 || Number(input) > 50000) { throw new Error('请输入 100–50000 的整数。'); }
      await updateConfiguration('search.maxFiles', Number(input));
    }),
    command('vscode-mcp.configureSearchExclude', async value => {
      let patterns: unknown = value;
      if (patterns === undefined) {
        const saved = vscode.workspace.getConfiguration('vscodeMcp').get<string[]>('search.exclude', ['**/{node_modules,out,dist,.vscode-test}/**']);
        const choices = saved.map(pattern => ({ label: pattern, pattern, picked: true }));
        const selected = await vscode.window.showQuickPick([...choices, { label: '$(add) 添加排除规则…', pattern: '', picked: false }], { canPickMany: true, title: '搜索排除规则', placeHolder: '取消勾选可移除；例如 **/vendor/**，.git 始终排除' });
        if (selected === undefined) { return; }
        const selectedPatterns = selected.filter(item => item.pattern !== '').map(item => item.pattern);
        if (selected.some(item => !item.pattern)) {
          const pattern = await vscode.window.showInputBox({ title: '添加搜索排除规则', prompt: '输入 glob，例如 **/vendor/** 或 **/*.min.js。', validateInput: text => text.trim() ? undefined : '规则不能为空。' });
          if (pattern === undefined) { return; } selectedPatterns.push(pattern.trim());
        }
        patterns = selectedPatterns;
      }
      if (!Array.isArray(patterns) || patterns.length > 50 || patterns.some(pattern => typeof pattern !== 'string' || !pattern.trim() || pattern.length > 1024)) { throw new Error('请提供最多 50 条非空 glob 规则，每条最多 1024 字符。'); }
      await updateConfiguration('search.exclude', [...new Set(patterns)]);
    }),
    command('vscode-mcp.configureTasks', async value => {
      let names: unknown = value;
      if (names === undefined) {
        const saved = vscode.workspace.getConfiguration('vscodeMcp').get<string[]>('tasks.allowedNames', []);
        const tasks = await tools.tasks.list();
        const available = [...new Set([...saved, ...tasks.map(task => task.name)])].sort((a, b) => a.localeCompare(b));
        const choices = available.map(name => ({ label: name, name, picked: saved.includes(name), description: tasks.some(task => task.name === name) ? '已有任务' : '已保存，当前未发现此任务' }));
        const selected = await vscode.window.showQuickPick([...choices, { label: '$(add) 添加任务名称…', name: '', picked: false, description: '手动输入一个任务名称' }], { canPickMany: true, title: '允许 Agent 执行的任务', placeHolder: '勾选允许的任务；取消勾选可移除，全部取消可清空' });
        if (selected === undefined) { return; }
        const selectedNames = selected.filter(item => item.name !== '').map(item => item.name);
        if (selected.some(item => item.name === '')) {
          const name = await vscode.window.showInputBox({ title: '添加允许的任务名称', prompt: '请输入任务名称，按名称精确匹配。', validateInput: text => text.trim().length ? undefined : '任务名称不能为空。' });
          if (name === undefined) { return; }
          selectedNames.push(name.trim());
        }
        names = selectedNames;
      }
      if (!Array.isArray(names) || names.some(name => typeof name !== 'string' || !name.trim())) { throw new Error('允许的任务必须是非空名称列表。'); }
      await updateConfiguration('tasks.allowedNames', [...new Set(names)]);
    }),
    command('vscode-mcp.toggleAuth', async () => {
      await toggleConfiguration('auth.enabled', true);
      if (!current.connection) { void vscode.window.showInformationMessage('连接验证设置已保存，下次启动生效。'); }
    }),
    command('vscode-mcp.setKey', async () => {
      const key = await vscode.window.showInputBox({ title: '设置 MCP Key', prompt: '保存自定义 Key，重启 MCP 服务后生效。', password: true, ignoreFocusOut: true,
        validateInput: value => validateKey(value) ? undefined : '请输入 1–1024 个可打印英文字符，不包含空格。' });
      if (key === undefined) { return; }
      await context.secrets.store(keyStorage, key);
      hasCustomKey = true;
      configuredKeyHash = hash(key);
      sidebar.refresh();
      if (!current.connection?.authEnabled) { void vscode.window.showInformationMessage('自定义 Key 已保存，开启连接验证并重启 MCP 服务后生效。'); }
    }),
    command('vscode-mcp.clearKey', async () => {
      await context.secrets.delete(keyStorage);
      hasCustomKey = false;
      configuredKeyHash = undefined;
      sidebar.refresh();
      if (!current.connection?.authEnabled) { void vscode.window.showInformationMessage('自定义 Key 已清除，开启连接验证并重启 MCP 服务后使用随机 Key。'); }
    }),
    context.secrets.onDidChange(async event => {
      if (event.key === keyStorage) {
        const key = await context.secrets.get(keyStorage); hasCustomKey = !!key; configuredKeyHash = key ? hash(key) : undefined;
        sidebar.refresh(); offerRestart('Key 设置已更改，重启 MCP 服务后生效。');
      }
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('vscodeMcp')) { sidebar.refresh(); }
      if (event.affectsConfiguration('vscodeMcp.port') || event.affectsConfiguration('vscodeMcp.auth.enabled')) { offerRestart('连接设置已更改，重启 MCP 服务后生效。'); }
    }),
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
