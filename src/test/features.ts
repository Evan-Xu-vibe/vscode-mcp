import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import * as path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { HealthReport } from '../server';

export async function testFeatures(client: Client, root: vscode.WorkspaceFolder): Promise<void> {
  const call = async (name: string, args: Record<string, unknown> = {}, error?: string) => {
    const result = await client.callTool({ name, arguments: args });
    const data = result.structuredContent as Record<string, unknown>;
    if (error) { assert.equal(result.isError, true); assert.equal((data.error as { code: string }).code, error); }
    else { assert.notEqual(result.isError, true, JSON.stringify(result)); }
    return data;
  };
  const accepted = async (proposal: Record<string, unknown>) => {
    assert.equal(proposal.status, 'pending');
    await vscode.commands.executeCommand('vscode-mcp.reviewAccept', proposal.proposalId);
    const result = await call('proposal_get', { proposalId: proposal.proposalId });
    assert.equal(result.status, 'accepted', JSON.stringify(result)); return result;
  };
  const health = await vscode.commands.executeCommand<HealthReport>('vscode-mcp.checkConnection');
  assert.equal(health?.passed, true); assert.equal(health?.toolCount, 57);

  // Resource operations share the approval queue and recheck the entire captured tree.
  const directory = await call('directory_create', { path: 'resource-test', preview: true });
  await assert.rejects(Promise.resolve(vscode.workspace.fs.stat(vscode.Uri.joinPath(root.uri, 'resource-test'))));
  await accepted(directory);
  const resourceFile = path.join(root.uri.fsPath, 'resource-test', 'old.txt');
  await writeFile(resourceFile, 'resource original');
  const info = await call('resource_info', { path: 'resource-test/old.txt' });
  const move = await call('resource_move', { path: 'resource-test/old.txt', target: 'resource-test/new.txt', expectedFingerprint: info.fingerprint, preview: true });
  await vscode.commands.executeCommand('vscode-mcp.reviewReject', move.proposalId);
  assert.equal(await readFile(resourceFile, 'utf8'), 'resource original');
  await vscode.commands.executeCommand('vscode-mcp.toggleApproval');
  await accepted(await call('resource_move', { path: 'resource-test/old.txt', target: 'resource-test/new.txt', expectedFingerprint: info.fingerprint }));
  assert.equal(await readFile(path.join(root.uri.fsPath, 'resource-test', 'new.txt'), 'utf8'), 'resource original');
  const newInfo = await call('resource_info', { path: 'resource-test/new.txt' });
  const staleDelete = await call('resource_delete', { path: 'resource-test/new.txt', expectedFingerprint: newInfo.fingerprint });
  await writeFile(path.join(root.uri.fsPath, 'resource-test', 'new.txt'), 'changed');
  await vscode.commands.executeCommand('vscode-mcp.reviewAccept', staleDelete.proposalId);
  assert.equal((await call('proposal_get', { proposalId: staleDelete.proposalId })).status, 'failed');
  assert.equal(await readFile(path.join(root.uri.fsPath, 'resource-test', 'new.txt'), 'utf8'), 'changed');
  const tree = await call('resource_info', { path: 'resource-test' });
  await call('resource_delete', { path: 'resource-test', expectedFingerprint: tree.fingerprint }, 'DIRECTORY_NOT_EMPTY');
  await accepted(await call('resource_move', { path: 'resource-test', target: 'resource-moved', expectedFingerprint: tree.fingerprint }));
  const moved = await call('resource_info', { path: 'resource-moved' });
  await accepted(await call('resource_delete', { path: 'resource-moved', expectedFingerprint: moved.fingerprint, recursive: true }));
  await assert.rejects(Promise.resolve(vscode.workspace.fs.stat(vscode.Uri.joinPath(root.uri, 'resource-moved'))));
  await vscode.commands.executeCommand('vscode-mcp.toggleApproval');
  await call('directory_create', { path: '.' }, 'PROTECTED_PATH');
  await call('directory_create', { path: '.git/injected' }, 'PROTECTED_PATH');
  await call('directory_create', { path: '../escape-dir' }, 'PATH_DENIED');
  const dirtyPath = path.join(root.uri.fsPath, 'resource-dirty.txt');
  await writeFile(dirtyPath, 'dirty');
  const dirtyInfo = await call('resource_info', { path: 'resource-dirty.txt' });
  const dirtyDoc = await vscode.workspace.openTextDocument(dirtyPath);
  const dirtyEdit = new vscode.WorkspaceEdit(); dirtyEdit.insert(dirtyDoc.uri, new vscode.Position(0, 0), 'unsaved '); await vscode.workspace.applyEdit(dirtyEdit);
  await call('resource_delete', { path: 'resource-dirty.txt', expectedFingerprint: dirtyInfo.fingerprint }, 'DIRTY_DOCUMENT');
  await dirtyDoc.save();

  // Search must reach files beyond the old 200-file limit, avoid duplicate matches, and obey exclusions.
  const searchDir = path.join(root.uri.fsPath, 'search-test'); await mkdir(searchDir);
  await Promise.all(Array.from({ length: 205 }, (_, index) => writeFile(path.join(searchDir, `${String(index).padStart(3, '0')}.txt`), index === 204 ? 'beyond200 target' : 'nothing here')));
  let page = await call('files_search', { query: 'beyond200', glob: 'search-test/*.txt' });
  assert.equal((page.matches as unknown[]).length, 0); assert.ok(page.nextCursor);
  const firstCursor = page.nextCursor;
  page = await call('files_search', { cursor: page.nextCursor });
  assert.equal((page.matches as unknown[]).length, 1); assert.equal(page.discoveryTruncated, false);
  await call('files_search', { cursor: firstCursor }, 'SEARCH_CURSOR_EXPIRED');
  await writeFile(path.join(searchDir, 'literal.txt'), 'a.b axb\nfoo42 foo43\n');
  assert.equal(((await call('files_search', { query: 'a.b', glob: 'search-test/literal.txt' })).matches as unknown[]).length, 1);
  assert.equal(((await call('files_search', { query: 'a.b', regex: true, glob: 'search-test/literal.txt' })).matches as unknown[]).length, 2);
  const regexPage = await call('files_search', { query: 'foo\\d+', regex: true, glob: 'search-test/literal.txt', limit: 1 });
  assert.equal((regexPage.matches as { column: number }[])[0].column, 1);
  const continued = await call('files_search', { cursor: regexPage.nextCursor });
  assert.equal((continued.matches as { column: number }[])[0].column, 7);
  await call('files_search', { query: '[', regex: true }, 'INVALID_REGEX');
  await vscode.commands.executeCommand('vscode-mcp.configureSearchExclude', ['**/search-test/**']);
  assert.equal(((await call('files_search', { query: 'beyond200', glob: 'search-test/*.txt' })).matches as unknown[]).length, 0);
  assert.equal(((await call('files_search', { query: 'beyond200', glob: 'search-test/204.txt', exclude: [] })).matches as unknown[]).length, 1);
  await vscode.commands.executeCommand('vscode-mcp.configureSearchExclude', ['**/{node_modules,out,dist,.vscode-test}/**']);
  await vscode.commands.executeCommand('vscode-mcp.setSearchMaxFiles', 100);
  assert.equal((await call('files_search', { query: 'nothing', glob: 'search-test/*.txt' })).discoveryTruncated, true);
  await vscode.commands.executeCommand('vscode-mcp.setSearchMaxFiles', 10000);
  const changePage = await call('files_search', { query: 'foo', glob: 'search-test/literal.txt', limit: 1 });
  const literal = await vscode.workspace.openTextDocument(path.join(searchDir, 'literal.txt'));
  const changed = new vscode.WorkspaceEdit(); changed.insert(literal.uri, new vscode.Position(0, 0), 'changed '); await vscode.workspace.applyEdit(changed);
  await call('files_search', { cursor: changePage.nextCursor }, 'SEARCH_CHANGED'); await literal.save();
  await writeFile(path.join(searchDir, 'slow.txt'), `${'a'.repeat(20000)}!`);
  await call('files_search', { query: '(a+)+$', regex: true, glob: 'search-test/slow.txt' }, 'REGEX_TIMEOUT');
  assert.ok((await call('workspace_info')).instanceId, 'Timed-out regex must not freeze the extension host');

  // Mock providers give deterministic multi-file rename, formatting, quick-fix, and boundary checks.
  const refactorPath = path.join(root.uri.fsPath, 'refactor-test.txt');
  const secondPath = path.join(root.uri.fsPath, 'refactor-second.txt');
  await writeFile(refactorPath, 'foo'); await writeFile(secondPath, 'foo');
  const refactorDoc = await vscode.workspace.openTextDocument(refactorPath);
  const selector = { scheme: 'file', pattern: '**/refactor-test.txt' };
  let outside = false;
  const providers = [
    vscode.languages.registerDocumentFormattingEditProvider(selector, { provideDocumentFormattingEdits: () => [vscode.TextEdit.replace(new vscode.Range(0, 0, 0, 3), 'bar')] }),
    vscode.languages.registerRenameProvider(selector, { provideRenameEdits: (_document, _position, name) => {
      const edit = new vscode.WorkspaceEdit(); edit.replace(refactorDoc.uri, new vscode.Range(0, 0, 0, 3), name);
      edit.replace(vscode.Uri.file(outside ? path.join(root.uri.fsPath, '..', 'outside', 'secret.txt') : secondPath), new vscode.Range(0, 0, 0, 3), name); return edit;
    } }),
    vscode.languages.registerCodeActionsProvider(selector, { provideCodeActions: () => {
      const action = new vscode.CodeAction('test quick fix', vscode.CodeActionKind.QuickFix);
      action.edit = new vscode.WorkspaceEdit(); action.edit.replace(refactorDoc.uri, new vscode.Range(0, 0, 0, 3), refactorDoc.getText() === 'fix' ? 'fix2' : 'fix');
      const commandAction = new vscode.CodeAction('unsupported command fix', vscode.CodeActionKind.QuickFix);
      commandAction.command = { command: 'not-a-permitted-command', title: 'command' };
      return [action, commandAction];
    } })
  ];
  try {
    let base = await call('file_read', { path: 'refactor-test.txt' });
    const formatted = await call('file_format', { path: 'refactor-test.txt', expectedHash: base.contentHash });
    assert.equal(refactorDoc.getText(), 'foo'); await accepted(formatted); assert.equal(refactorDoc.getText(), 'bar');
    base = await call('file_read', { path: 'refactor-test.txt' });
    const rename = await call('symbol_rename', { path: 'refactor-test.txt', line: 1, column: 1, newName: 'baz', expectedHash: base.contentHash });
    assert.equal((rename.files as unknown[]).length, 2); await accepted(rename); assert.equal(refactorDoc.getText(), 'baz');
    const second = await vscode.workspace.openTextDocument(secondPath); assert.equal(second.getText(), 'baz');
    base = await call('file_read', { path: 'refactor-test.txt' });
    outside = true;
    await call('symbol_rename', { path: 'refactor-test.txt', line: 1, column: 1, newName: 'bad', expectedHash: base.contentHash }, 'PATH_DENIED'); outside = false;
    const fixes = await call('code_actions_get', { path: 'refactor-test.txt', line: 1, column: 1, expectedHash: base.contentHash });
    const actions = fixes.actions as { id: string | null; previewable: boolean }[];
    assert.equal(actions.length, 2); assert.equal(actions[0].previewable, true); assert.equal(actions[1].previewable, false);
    const fix = await call('code_action_preview', { actionId: actions[0].id });
    assert.equal(refactorDoc.getText(), 'baz'); await accepted(fix); assert.equal(refactorDoc.getText(), 'fix');
    base = await call('file_read', { path: 'refactor-test.txt' });
    const staleFixes = await call('code_actions_get', { path: 'refactor-test.txt', line: 1, column: 1, expectedHash: base.contentHash });
    await call('file_write', { path: 'refactor-test.txt', text: 'manually changed', expectedHash: base.contentHash });
    await call('code_action_preview', { actionId: (staleFixes.actions as { id: string }[])[0].id }, 'VERSION_CONFLICT');
    await refactorDoc.save(); await second.save();
  } finally { providers.forEach(provider => provider.dispose()); }
  console.log('PASS: connection check, resource previews/moves/deletes, dirty/protected paths, >200 file search, regex timeout, exclusions, pagination and reviewed language-service refactors.');
}
