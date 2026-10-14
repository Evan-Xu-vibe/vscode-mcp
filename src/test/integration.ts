import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import * as path from 'node:path';
import { readFile, writeFile, mkdir, symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ExtensionApi } from '../extension';
import { McpSidebar } from '../sidebar';
import { testFeatures } from './features';
import { testIntelligence } from './intelligence';

export async function run(): Promise<void> {
  const extension = vscode.extensions.all.find(item => item.packageJSON.name === 'vscode-mcp');
  assert.ok(extension, 'Development extension is loaded');
  assert.equal(vscode.workspace.getConfiguration('vscodeMcp').inspect<boolean>('auth.enabled')?.defaultValue, true, 'Authentication setting is registered from the extension manifest');
  const api = await extension.activate() as ExtensionApi;
  const sidebar = new McpSidebar(() => api.getConnectionInfo(), () => false, () => false);
  try {
    const sidebarCommands = sidebar.getChildren().map(item => item.command?.command);
    for (const command of ['vscode-mcp.toggleAuth', 'vscode-mcp.setKey', 'vscode-mcp.setPort', 'vscode-mcp.toggleAutoStart', 'vscode-mcp.toggleWrites', 'vscode-mcp.toggleApproval', 'vscode-mcp.toggleTasks', 'vscode-mcp.configureTasks']) {
      assert.ok(sidebarCommands.includes(command), `${command} is accessible from the sidebar`);
    }
    assert.equal(sidebarCommands.includes('vscode-mcp.openSettings'), false);
  } finally { sidebar.dispose(); }
  await vscode.commands.executeCommand('vscode-mcp.toggleAutoStart');
  assert.equal(vscode.workspace.getConfiguration('vscodeMcp').get('autoStart'), true);
  await vscode.commands.executeCommand('vscode-mcp.toggleAutoStart');
  assert.equal(vscode.workspace.getConfiguration('vscodeMcp').get('autoStart'), false);
  const info = await api.start();
  const client = new Client({ name: 'vscode-integration', version: '1.0.0' });
  const root = vscode.workspace.workspaceFolders?.[0];
  assert.ok(root);
  const fixture = path.join(root.uri.fsPath, 'fixture.txt');
  const diagnosticCollection = vscode.languages.createDiagnosticCollection('mcp-test');
  const call = async (name: string, args: Record<string, unknown> = {}, error?: string): Promise<Record<string, unknown>> => {
    const result = await client.callTool({ name, arguments: args });
    const data = result.structuredContent as Record<string, unknown>;
    if (error) { assert.equal(result.isError, true); assert.equal((data.error as { code: string }).code, error); }
    else { assert.notEqual(result.isError, true, JSON.stringify(result)); }
    return data;
  };
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(info.url), { requestInit: { headers: { Authorization: `Bearer ${info.token}` } } }));
    assert.equal((await client.listTools()).tools.length, 57);
    const workspace = await call('workspace_info');
    assert.equal((workspace.roots as unknown[]).length, 1);
    assert.equal(workspace.trusted, true);
    await call('terminals_list', {}, 'TERMINALS_DISABLED');
    await vscode.commands.executeCommand('vscode-mcp.toggleTerminals');
    try {
      await call('terminal_create', { path: path.join(root.uri.fsPath, '..') }, 'PATH_DENIED');
      const terminal = await call('terminal_create', { name: 'MCP integration test', show: !!process.env.MCP_TEST_SHELL });
      let terminalId = terminal.terminalId;
      assert.ok((await call('terminals_list')).terminals);
      if (!(workspace.terminals as { outputSupported: boolean }).outputSupported) {
        await call('terminal_read', { terminalId }, 'SHELL_INTEGRATION_UNAVAILABLE');
        await call('terminal_execute', { terminalId, command: 'echo test' }, 'SHELL_INTEGRATION_UNAVAILABLE');
      } else if (process.env.MCP_TEST_SHELL) {
        await call('terminal_write', { terminalId, text: 'echo MCP_TERMINAL_TEST', addNewLine: false });
        await call('terminal_close', { terminalId });
        const script = process.env.MCP_TEST_INTEGRATION_SCRIPT;
        const shellArgs = script ? ['-NoLogo', '-NoProfile', '-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', `. '${script.replace(/'/g, "''")}'`] : ['-NoLogo'];
        const existing = vscode.window.createTerminal({ name: 'Existing shell integration test', shellPath: process.env.MCP_TEST_SHELL, shellArgs, cwd: root.uri });
        existing.show(true);
        const existingList = (await call('terminals_list')).terminals as Record<string, unknown>[];
        terminalId = existingList.find(item => item.name === existing.name)!.terminalId;
        const deadline = Date.now() + 20000;
        let ready = false;
        while (Date.now() < deadline) {
          const list = (await call('terminals_list')).terminals as Record<string, unknown>[];
          if (list.find(item => item.terminalId === terminalId)?.shellIntegration) { ready = true; break; }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.ok(ready, 'Shell integration initializes in a real VS Code terminal');
        await call('terminal_execute', { terminalId, command: 'echo MCP_CAPTURE_TEST' });
        let output: Record<string, unknown> = {};
        while (Date.now() < deadline) {
          output = await call('terminal_read', { terminalId });
          if (output.status === 'completed' && !output.outputPending) { break; }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.equal(output.status, 'completed', JSON.stringify(output));
        assert.equal(output.exitCode, 0, JSON.stringify(output));
        assert.ok(String(output.text).includes('MCP_CAPTURE_TEST'), JSON.stringify(output));
        assert.equal((await call('terminal_read', { terminalId, offset: output.nextOffset })).text, '');
        console.log('PASS: real shell integration command output, exit code and incremental reads.');
      }
      await call('terminal_write', { terminalId, text: 'echo MCP_TERMINAL_TEST', addNewLine: false });
      await call('terminal_close', { terminalId });
    } finally { await vscode.commands.executeCommand('vscode-mcp.toggleTerminals'); }
    await call('file_read', { path: path.join(root.uri.fsPath, '..', 'outside.txt') }, 'PATH_DENIED');
    await call('file_read', { path: 'vscode-remote://ssh-remote/server/secret.txt' }, 'PATH_DENIED');
    const outside = path.join(root.uri.fsPath, '..', 'outside');
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, 'secret.txt'), 'secret');
    await symlink(outside, path.join(root.uri.fsPath, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    await call('file_read', { path: 'escape/secret.txt' }, 'PATH_DENIED');

    await call('editor_open', { path: 'fixture.txt', line: 1 });
    const doc = await vscode.workspace.openTextDocument(fixture);
    const manualEdit = new vscode.WorkspaceEdit();
    manualEdit.insert(doc.uri, new vscode.Position(0, 0), 'unsaved ');
    assert.equal(await vscode.workspace.applyEdit(manualEdit), true);
    const initial = await call('file_read', { path: 'fixture.txt' });
    assert.equal(initial.isDirty, true);
    assert.match(initial.text as string, /^unsaved/);
    assert.equal(await readFile(fixture, 'utf8'), 'alpha\nbeta\n');
    const context = await call('editor_context');
    assert.equal((context.active as { uri: string }).uri, doc.uri.toString());
    const search = await call('files_search', { query: 'unsaved', glob: '*.txt' });
    assert.equal((search.matches as unknown[]).length, 1);
    const ranged = await call('file_read', { path: 'fixture.txt', startLine: 2, endLine: 2 });
    assert.equal(ranged.text, 'beta'); assert.equal(ranged.contentHash, initial.contentHash);
    const shortened = await call('file_read', { path: 'fixture.txt', maxCharacters: 3 });
    assert.equal(shortened.truncated, true);
    await call('file_write', { path: 'fixture.txt', text: 'wrong' }, 'HASH_REQUIRED');
    await call('file_write', { path: 'fixture.txt', text: 'wrong', expectedHash: '0'.repeat(64) }, 'VERSION_CONFLICT');
    await call('file_apply_edits', { path: 'fixture.txt', expectedHash: initial.contentHash, edits: [
      { start: { line: 1, column: 1 }, end: { line: 1, column: 4 }, text: 'a' },
      { start: { line: 1, column: 2 }, end: { line: 1, column: 3 }, text: 'b' }
    ] }, 'OVERLAPPING_EDITS');
    const edited = await call('file_apply_edits', { path: 'fixture.txt', expectedHash: initial.contentHash, edits: [{ start: { line: 2, column: 1 }, end: { line: 2, column: 5 }, text: 'updated' }] });
    assert.equal(edited.isDirty, true); assert.match(doc.getText(), /updated/);
    await vscode.commands.executeCommand('undo');
    assert.equal(doc.getText(), initial.text);
    await vscode.commands.executeCommand('redo');
    assert.match(doc.getText(), /updated/);
    await call('file_save', { path: 'fixture.txt', expectedHash: initial.contentHash }, 'VERSION_CONFLICT');
    await call('file_save', { path: 'fixture.txt', expectedHash: edited.contentHash });
    assert.equal(await readFile(fixture, 'utf8'), 'unsaved alpha\nupdated\n');

    const concurrent = await Promise.all([client.callTool({ name: 'file_write', arguments: { path: 'fixture.txt', text: 'one\n', expectedHash: edited.contentHash } }), client.callTool({ name: 'file_write', arguments: { path: 'fixture.txt', text: 'two\n', expectedHash: edited.contentHash } })]);
    assert.equal(concurrent.filter(result => result.isError).length, 1);
    const current = await call('file_read', { path: 'fixture.txt' });
    await call('file_save', { path: 'fixture.txt', expectedHash: current.contentHash });
    await vscode.commands.executeCommand('vscode-mcp.toggleWrites');
    await call('file_write', { path: 'fixture.txt', text: 'disabled', expectedHash: current.contentHash }, 'WRITE_DISABLED');
    await vscode.commands.executeCommand('vscode-mcp.toggleWrites');

    await call('file_write', { path: 'created.txt', text: 'created\n', create: true, save: true });
    assert.equal((await readFile(path.join(root.uri.fsPath, 'created.txt'), 'utf8')).replace(/\r\n/g, '\n'), 'created\n');
    await call('file_write', { path: 'created.txt', text: 'overwrite', create: true }, 'ALREADY_EXISTS');
    const files = await call('files_list', { path: '.', limit: 1 });
    assert.equal((files.entries as unknown[]).length, 1); assert.equal(files.nextOffset, 1);
    await call('file_read', { path: 'binary.bin' }, 'BINARY_FILE');
    await call('file_read', { path: 'large.txt' }, 'FILE_TOO_LARGE');
    diagnosticCollection.set(doc.uri, [new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), 'integration diagnostic', vscode.DiagnosticSeverity.Warning)]);
    const diagnostics = await call('diagnostics_get', { path: 'fixture.txt' });
    assert.ok((diagnostics.diagnostics as { message: string }[]).some(item => item.message === 'integration diagnostic'));
    await testFeatures(client, root);
    await testIntelligence(client, root);

    // Batch validation must finish before changing any document.
    const beforeBatch = await call('file_read', { path: 'fixture.txt' });
    const createdBefore = await call('file_read', { path: 'created.txt' });
    const batchFiles = [{ path: 'fixture.txt', text: 'batch one\n', expectedHash: beforeBatch.contentHash }, { path: 'created.txt', text: 'batch two\n', expectedHash: createdBefore.contentHash }];
    await call('files_write', { files: [batchFiles[0], { ...batchFiles[1], expectedHash: '0'.repeat(64) }] }, 'VERSION_CONFLICT');
    assert.equal(doc.getText(), beforeBatch.text);
    await call('files_write', { files: [batchFiles[0], { ...batchFiles[0], path: './fixture.txt' }] }, 'DUPLICATE_PATH');
    await call('files_write', { files: [batchFiles[0], { path: 'escape/secret.txt', text: 'bad', expectedHash: beforeBatch.contentHash }] }, 'PATH_DENIED');
    assert.equal(doc.getText(), beforeBatch.text);
    const batch = await call('files_write', { files: batchFiles });
    assert.equal((batch.files as unknown[]).length, 2);
    assert.equal(doc.getText().replace(/\r\n/g, '\n'), 'batch one\n');

    const reviewBase = await call('file_read', { path: 'fixture.txt' });
    const preview = await call('files_preview', { files: [{ path: 'fixture.txt', text: 'accepted preview\n', expectedHash: reviewBase.contentHash }] });
    assert.equal(preview.status, 'pending');
    assert.equal(doc.getText(), reviewBase.text);
    const previewUri = vscode.Uri.from({ scheme: 'vscode-mcp-review', path: `/${preview.proposalId}/0/after/fixture.txt` });
    assert.equal((await vscode.workspace.openTextDocument(previewUri)).getText(), 'accepted preview\n');
    await vscode.commands.executeCommand('vscode-mcp.reviewAccept', preview.proposalId);
    assert.equal((await call('proposal_get', { proposalId: preview.proposalId })).status, 'accepted');
    assert.equal(doc.getText().replace(/\r\n/g, '\n'), 'accepted preview\n');

    const rejectedBase = await call('file_read', { path: 'fixture.txt' });
    const rejected = await call('files_preview', { files: [{ path: 'fixture.txt', text: 'rejected', expectedHash: rejectedBase.contentHash }] });
    await vscode.commands.executeCommand('vscode-mcp.reviewReject', rejected.proposalId);
    assert.equal((await call('proposal_get', { proposalId: rejected.proposalId })).status, 'rejected');
    assert.equal(doc.getText(), rejectedBase.text);
    const stale = await call('files_preview', { files: [{ path: 'fixture.txt', text: 'stale', expectedHash: rejectedBase.contentHash }] });
    await call('file_write', { path: 'fixture.txt', text: 'changed after preview', expectedHash: rejectedBase.contentHash });
    await vscode.commands.executeCommand('vscode-mcp.reviewAccept', stale.proposalId);
    const failedReview = await call('proposal_get', { proposalId: stale.proposalId });
    assert.equal(failedReview.status, 'failed');
    assert.equal(((failedReview.result as Record<string, unknown>).error as { code: string }).code, 'VERSION_CONFLICT');
    assert.equal(doc.getText(), 'changed after preview');

    await vscode.commands.executeCommand('vscode-mcp.toggleApproval');
    const approvalBase = await call('file_read', { path: 'fixture.txt' });
    const approval = await call('file_write', { path: 'fixture.txt', text: 'requires approval', expectedHash: approvalBase.contentHash });
    assert.equal(approval.status, 'pending');
    assert.equal(doc.getText(), 'changed after preview');
    await vscode.commands.executeCommand('vscode-mcp.reviewReject', approval.proposalId);
    const createPreview = await call('file_write', { path: 'review-created.txt', create: true, text: 'created by approval', save: true });
    await assert.rejects(readFile(path.join(root.uri.fsPath, 'review-created.txt')));
    await vscode.commands.executeCommand('vscode-mcp.reviewAccept', createPreview.proposalId);
    assert.equal(await readFile(path.join(root.uri.fsPath, 'review-created.txt'), 'utf8'), 'created by approval');
    const savePreview = await call('file_save', { path: 'fixture.txt', expectedHash: approvalBase.contentHash });
    assert.equal(savePreview.status, 'pending');
    assert.equal(doc.isDirty, true);
    await vscode.commands.executeCommand('vscode-mcp.reviewReject', savePreview.proposalId);
    const rangePreview = await call('file_apply_edits', { path: 'fixture.txt', expectedHash: approvalBase.contentHash, edits: [{ start: { line: 1, column: 1 }, end: { line: 1, column: 8 }, text: 'reviewed' }] });
    assert.equal(rangePreview.status, 'pending');
    assert.equal(doc.getText(), 'changed after preview');
    await vscode.commands.executeCommand('vscode-mcp.reviewAccept', rangePreview.proposalId);
    assert.equal(doc.getText(), 'reviewed after preview');
    await vscode.commands.executeCommand('vscode-mcp.toggleApproval');

    // Language providers can point outside the workspace; those results must be hidden.
    const sampleRange = new vscode.Range(0, 0, 0, 3);
    const selector = { scheme: 'file', language: 'plaintext' };
    const providers = [
      vscode.languages.registerDocumentSymbolProvider(selector, { provideDocumentSymbols: () => [new vscode.DocumentSymbol('fixtureSymbol', '', vscode.SymbolKind.Function, sampleRange, sampleRange)] }),
      vscode.languages.registerDefinitionProvider(selector, { provideDefinition: () => [{ targetUri: doc.uri, targetRange: sampleRange }, { targetUri: vscode.Uri.file(path.join(outside, 'secret.txt')), targetRange: sampleRange }] }),
      vscode.languages.registerReferenceProvider(selector, { provideReferences: () => [new vscode.Location(doc.uri, sampleRange), new vscode.Location(vscode.Uri.file(path.join(outside, 'secret.txt')), sampleRange)] })
    ];
    try {
      assert.ok((await call('symbols_get', { path: 'fixture.txt' })).symbols);
      for (const name of ['definitions_get', 'references_get']) {
        const result = await call(name, { path: 'fixture.txt', line: 1, column: 1 });
        assert.equal((result.locations as unknown[]).length, 1);
        assert.equal((result.locations as { uri: string }[])[0].uri, doc.uri.toString());
      }
    } finally { providers.forEach(item => item.dispose()); }

    const gitCommand = promisify(execFile);
    const gitFixture = path.join(root.uri.fsPath, 'git-fixture.txt');
    await writeFile(gitFixture, 'git original\n');
    await gitCommand('git', ['init', root.uri.fsPath]);
    await gitCommand('git', ['-C', root.uri.fsPath, 'add', 'git-fixture.txt']);
    await gitCommand('git', ['-C', root.uri.fsPath, '-c', 'user.name=MCP Test', '-c', 'user.email=mcp@example.invalid', 'commit', '-m', 'test fixture']);
    assert.match((await call('git_status')).text as string, /created.txt/);
    assert.match((await call('git_log', { limit: 1 })).text as string, /test fixture/);
    await writeFile(gitFixture, 'disk change\n');
    assert.match((await call('git_diff', { path: 'git-fixture.txt' })).text as string, /disk change/);
    await call('git_diff', { path: path.join(outside, 'secret.txt') }, 'PATH_DENIED');

    const availableTasks = await call('tasks_list');
    const taskList = availableTasks.tasks as { id: string; name: string }[];
    const successTask = taskList.find(task => task.name === 'mcp-test-exit-0');
    const failureTask = taskList.find(task => task.name === 'mcp-test-exit-7');
    const stopTask = taskList.find(task => task.name === 'mcp-test-stop');
    assert.ok(successTask); assert.ok(failureTask); assert.ok(stopTask);
    await call('task_run', { taskId: successTask.id }, 'TASKS_DISABLED');
    await vscode.commands.executeCommand('vscode-mcp.toggleTasks');
    await call('task_run', { taskId: successTask.id }, 'TASK_NOT_ALLOWED');
    await vscode.commands.executeCommand('vscode-mcp.configureTasks', [successTask.name, failureTask.name, stopTask.name]);
    for (const [task, exitCode] of [[successTask, 0], [failureTask, 7]] as const) {
      const run = await call('task_run', { taskId: task.id });
      const deadline = Date.now() + 15_000;
      let taskResult = await call('task_status', { runId: run.runId });
      while (taskResult.status !== 'completed' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 100));
        taskResult = await call('task_status', { runId: run.runId });
      }
      assert.equal(taskResult.status, 'completed'); assert.equal(taskResult.exitCode, exitCode);
    }
    const stopped = await call('task_run', { taskId: stopTask.id });
    await call('task_run', { taskId: stopTask.id }, 'TASK_ALREADY_RUNNING');
    await call('task_stop', { runId: stopped.runId });
    const stopDeadline = Date.now() + 10_000;
    let stoppedResult = await call('task_status', { runId: stopped.runId });
    while (stoppedResult.status !== 'completed' && Date.now() < stopDeadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
      stoppedResult = await call('task_status', { runId: stopped.runId });
    }
    assert.equal(stoppedResult.status, 'completed');
    await vscode.commands.executeCommand('vscode-mcp.toggleTasks');
    await vscode.commands.executeCommand('vscode-mcp.configureTasks', []);
    assert.deepEqual(vscode.workspace.getConfiguration('vscodeMcp').get('tasks.allowedNames'), []);

    await vscode.commands.executeCommand('vscode-mcp.copyCodex');
    assert.match(await vscode.env.clipboard.readText(), /http_headers = \{ Authorization = "Bearer /);
    await vscode.commands.executeCommand('vscode-mcp.copyOpenCode');
    assert.equal(JSON.parse(await vscode.env.clipboard.readText()).mcp.vscode.headers.Authorization, `Bearer ${info.token}`);
    await client.close();
    await api.stop();
    await vscode.commands.executeCommand('vscode-mcp.toggleAuth');
    assert.equal(vscode.workspace.getConfiguration('vscodeMcp').get('auth.enabled'), false);
    const noAuth = await api.start();
    assert.equal(noAuth.authEnabled, false);
    await vscode.commands.executeCommand('vscode-mcp.copyConnection');
    assert.deepEqual(JSON.parse(await vscode.env.clipboard.readText()), { url: noAuth.url });
    const noAuthClient = new Client({ name: 'no-auth-integration', version: '1.0.0' });
    try {
      await noAuthClient.connect(new StreamableHTTPClientTransport(new URL(noAuth.url)));
      assert.equal((await noAuthClient.listTools()).tools.length, 57);
    } finally { await noAuthClient.close(); }
    await vscode.commands.executeCommand('vscode-mcp.copyCodex');
    assert.equal((await vscode.env.clipboard.readText()).includes('http_headers'), false);
    await vscode.commands.executeCommand('vscode-mcp.copyOpenCode');
    assert.equal(JSON.parse(await vscode.env.clipboard.readText()).mcp.vscode.headers, undefined);
    await vscode.commands.executeCommand('vscode-mcp.toggleAuth');
    const fixedPort = Number(new URL(noAuth.url).port);
    await vscode.commands.executeCommand('vscode-mcp.setPort', fixedPort);
    const fixed = await api.restart();
    assert.equal(fixed.authEnabled, true);
    assert.equal(new URL(fixed.url).port, String(fixedPort));
    assert.equal(new URL((await api.restart()).url).port, String(fixedPort));
    console.log('PASS: 57 tools, dirty buffers, undo, conflicts, change review, Git queries, code understanding, debugger controls, tasks, terminal output, client configs and authentication.');
  } finally {
    diagnosticCollection.dispose(); await client.close(); await api.stop();
  }
}
