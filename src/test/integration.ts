import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import * as path from 'node:path';
import { readFile, writeFile, mkdir, symlink } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ExtensionApi } from '../extension';

export async function run(): Promise<void> {
  const extension = vscode.extensions.all.find(item => item.packageJSON.name === 'vscode-mcp');
  assert.ok(extension, 'Development extension is loaded');
  assert.equal(vscode.workspace.getConfiguration('vscodeMcp').inspect<boolean>('auth.enabled')?.defaultValue, true, 'Authentication setting is registered from the extension manifest');
  const api = await extension.activate() as ExtensionApi;
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
    assert.equal((await client.listTools()).tools.length, 10);
    const workspace = await call('workspace_info');
    assert.equal((workspace.roots as unknown[]).length, 1);
    assert.equal(workspace.trusted, true);
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
    const configuration = vscode.workspace.getConfiguration('vscodeMcp');
    await configuration.update('allowWrites', false, vscode.ConfigurationTarget.Workspace);
    await call('file_write', { path: 'fixture.txt', text: 'disabled', expectedHash: current.contentHash }, 'WRITE_DISABLED');
    await configuration.update('allowWrites', true, vscode.ConfigurationTarget.Workspace);

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
      assert.equal((await noAuthClient.listTools()).tools.length, 10);
    } finally { await noAuthClient.close(); }
    await api.stop();
    await vscode.commands.executeCommand('vscode-mcp.toggleAuth');
    assert.equal((await api.start()).authEnabled, true);
    console.log('PASS: 10 tools, dirty buffers, ranges, conflicts, concurrent writes, save, search, diagnostics, path guards, permissions, create, limits and optional authentication.');
  } finally {
    diagnosticCollection.dispose(); await client.close(); await api.stop();
  }
}
