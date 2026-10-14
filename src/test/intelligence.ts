import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

export async function testIntelligence(client: Client, root: vscode.WorkspaceFolder): Promise<void> {
  const call = async (name: string, args: Record<string, unknown> = {}, error?: string): Promise<Record<string, any>> => {
    const result = await client.callTool({ name, arguments: args }); const data = result.structuredContent as Record<string, any>;
    if (error) { assert.equal(result.isError, true, JSON.stringify(result)); assert.equal(data.error.code, error); }
    else { assert.notEqual(result.isError, true, JSON.stringify(result)); } return data;
  };
  const uri = vscode.Uri.joinPath(root.uri, 'intelligence.txt'); await writeFile(uri.fsPath, 'function example(value) { return value; }\nexample(1);\n');
  const doc = await vscode.workspace.openTextDocument(uri); const selector = { scheme: 'file', pattern: '**/intelligence.txt' };
  const range = new vscode.Range(0, 9, 0, 16);
  const symbol = new vscode.CallHierarchyItem(vscode.SymbolKind.Function, 'example', 'test', uri, range, range);
  const outside = vscode.Uri.file(path.join(root.uri.fsPath, '..', 'outside', 'secret.txt'));
  const external = new vscode.CallHierarchyItem(vscode.SymbolKind.Function, 'external', 'test', outside, range, range);
  const providers = [
    vscode.languages.registerHoverProvider(selector, { provideHover: () => new vscode.Hover(new vscode.MarkdownString('**example** documentation')) }),
    vscode.languages.registerCompletionItemProvider(selector, { provideCompletionItems: () => {
      const completion = new vscode.CompletionItem('example', vscode.CompletionItemKind.Function); completion.insertText = new vscode.SnippetString('example(${1:value})'); completion.documentation = 'completion docs';
      completion.command = { command: 'must-not-run', title: 'never run' }; return new vscode.CompletionList([completion], true);
    } }),
    vscode.languages.registerSignatureHelpProvider(selector, { provideSignatureHelp: () => {
      const help = new vscode.SignatureHelp(); const signature = new vscode.SignatureInformation('example(value)', 'signature docs'); signature.parameters = [new vscode.ParameterInformation('value', 'parameter docs')];
      help.signatures = [signature]; help.activeParameter = 0; help.activeSignature = 0; return help;
    } }, '('),
    vscode.languages.registerTypeDefinitionProvider(selector, { provideTypeDefinition: () => [new vscode.Location(uri, range), new vscode.Location(outside, range)] }),
    vscode.languages.registerImplementationProvider(selector, { provideImplementation: () => [new vscode.Location(uri, range)] }),
    vscode.languages.registerWorkspaceSymbolProvider({ provideWorkspaceSymbols: () => [new vscode.SymbolInformation('example', vscode.SymbolKind.Function, 'test', new vscode.Location(uri, range)), new vscode.SymbolInformation('external', vscode.SymbolKind.Function, 'test', new vscode.Location(outside, range))] }),
    vscode.languages.registerCallHierarchyProvider(selector, { prepareCallHierarchy: () => symbol, provideCallHierarchyIncomingCalls: () => [new vscode.CallHierarchyIncomingCall(symbol, [range]), new vscode.CallHierarchyIncomingCall(external, [range])], provideCallHierarchyOutgoingCalls: () => [new vscode.CallHierarchyOutgoingCall(symbol, [range])] })
  ];
  const point = { path: 'intelligence.txt', line: 1, column: 10 };
  try {
    assert.ok((await call('hover_get', point)).hovers[0].text.includes('documentation'));
    const completion = await call('completions_get', point); assert.equal(completion.items[0].snippet, true); assert.equal(completion.items[0].command, undefined); assert.equal(completion.isIncomplete, true);
    assert.equal((await call('signature_help_get', point)).signatures[0].parameters[0].label, 'value');
    assert.equal((await call('type_definitions_get', point)).locations.length, 1);
    assert.equal((await call('implementations_get', point)).locations[0].start.column, 10);
    assert.equal((await call('workspace_symbols_get', { query: 'example' })).symbols.length, 1);
    assert.equal((await call('call_hierarchy_get', point)).calls.length, 1);
    assert.equal((await call('call_hierarchy_get', { ...point, direction: 'outgoing' })).calls[0].item.name, 'example');
    await call('call_hierarchy_get', { ...point, itemIndex: 1 }, 'INVALID_RANGE');
    await call('hover_get', { ...point, line: 999 }, 'INVALID_RANGE');
    await call('hover_get', { ...point, path: outside.fsPath }, 'PATH_DENIED');
    assert.equal(doc.getText(), 'function example(value) { return value; }\nexample(1);\n', 'Queries must not modify source');
    let release: ((value: vscode.Hover) => void) | undefined;
    let started: (() => void) | undefined;
    const providerStarted = new Promise<void>(resolve => { started = resolve; });
    const slow = vscode.languages.registerHoverProvider(selector, { provideHover: () => new Promise<vscode.Hover>(resolve => { release = resolve; started!(); }) });
    try {
      const pending = call('hover_get', point, 'VERSION_CONFLICT');
      await providerStarted;
      const edit = new vscode.WorkspaceEdit(); edit.insert(uri, new vscode.Position(0, 0), '// changed\n'); await vscode.workspace.applyEdit(edit);
      release!(new vscode.Hover('stale')); await pending;
    } finally { slow.dispose(); }
  } finally { providers.forEach(provider => provider.dispose()); }
  console.log('PASS: hover, completion snippets, signatures, type/implementation locations, workspace symbols, incoming/outgoing calls and path boundaries.');

  await call('debug_sessions', {}, 'DEBUG_DISABLED');
  await call('debug_start', { name: 'missing' }, 'DEBUG_DISABLED');
  await vscode.commands.executeCommand('vscode-mcp.toggleDebug');
  try {
    await call('debug_start', { name: 'missing' }, 'DEBUG_CONFIG_NOT_FOUND');
    const bp = await call('debug_breakpoint_add', { path: 'intelligence.txt', line: 1 });
    assert.ok((await call('debug_breakpoints_get')).breakpoints.some((item: any) => item.breakpointId === bp.breakpointId));
    await call('debug_breakpoint_add', { path: 'intelligence.txt', line: 1, condition: 'true' }, 'DEBUG_EVALUATION_DISABLED');
    await call('debug_breakpoint_add', { path: 'intelligence.txt', line: 999 }, 'INVALID_RANGE');
    await call('debug_breakpoint_add', { path: outside.fsPath, line: 1 }, 'PATH_DENIED');
    await call('debug_breakpoint_remove', { breakpointId: bp.breakpointId });
    await call('debug_breakpoint_remove', { breakpointId: bp.breakpointId }, 'DEBUG_BREAKPOINT_NOT_FOUND');
    await call('debug_threads', { sessionId: 'nonexistent' }, 'DEBUG_SESSION_NOT_FOUND');
    if (process.env.MCP_TEST_DEBUG === '1') { await testRealDebugger(call, root); }
  } finally {
    if (vscode.workspace.getConfiguration('vscodeMcp').get('debug.allowEvaluation', false)) { await vscode.commands.executeCommand('vscode-mcp.toggleDebugEvaluation'); }
    await vscode.commands.executeCommand('vscode-mcp.toggleDebug');
  }
  console.log('PASS: debugger permissions, source breakpoint management and invalid session handling.');
}

async function testRealDebugger(call: (name: string, args?: Record<string, unknown>, error?: string) => Promise<Record<string, any>>, root: vscode.WorkspaceFolder): Promise<void> {
  const script = vscode.Uri.joinPath(root.uri, 'debug-test.js');
  await writeFile(script.fsPath, 'const value = 41;\ndebugger;\nconsole.log(value + 1);\nsetTimeout(() => {}, 60000);\n');
  await vscode.workspace.getConfiguration('launch', root.uri).update('configurations', [{ name: 'MCP real debugger', type: 'node', request: 'launch', program: script.fsPath, runtimeExecutable: process.env.MCP_TEST_NODE ?? 'node', console: 'internalConsole' }], vscode.ConfigurationTarget.Workspace);
  assert.ok((await call('debug_configurations')).configurations.some((value: any) => value.name === 'MCP real debugger'));
  let sessionId: string | undefined;
  try {
    await call('debug_start', { name: 'MCP real debugger', root: root.uri.toString() });
    const waitForPause = async () => {
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        const sessions = (await call('debug_sessions')).sessions as any[];
        const paused = sessions.find(value => value.status === 'paused' && (value.type === 'node' || value.type === 'pwa-node'));
        if (paused) { sessionId = paused.sessionId; return paused; }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error(`Node debugger did not pause within 20 seconds: ${JSON.stringify(await call('debug_sessions'))}`);
    };
    const paused = await waitForPause(); const ids = { sessionId: paused.sessionId, stopId: paused.stopId };
    const threads = await call('debug_threads', { sessionId }); assert.ok(threads.threads.length);
    const stack = await call('debug_stack', { ...ids, threadId: paused.threadId }); assert.ok(stack.frames.length);
    const frame = stack.frames.find((item: any) => item.uri === script.toString()); assert.ok(frame, JSON.stringify(stack));
    const scopes = await call('debug_scopes', { ...ids, frameId: frame.frameId }); assert.ok(scopes.scopes.length);
    const scope = scopes.scopes.find((item: any) => item.variablesReference > 0); assert.ok(scope);
    const variables = await call('debug_variables', { ...ids, variablesReference: scope.variablesReference }); assert.ok(variables.variables.length);
    await call('debug_evaluate', { ...ids, frameId: frame.frameId, expression: 'value + 1' }, 'DEBUG_EVALUATION_DISABLED');
    await vscode.commands.executeCommand('vscode-mcp.toggleDebugEvaluation');
    assert.equal((await call('debug_evaluate', { ...ids, frameId: frame.frameId, expression: 'value + 1' })).result, '42');
    await call('debug_control', { ...ids, threadId: paused.threadId, action: 'next' });
    await call('debug_scopes', { ...ids, frameId: frame.frameId }, 'DEBUG_STATE_CHANGED');
    const stepped = await waitForPause(); assert.notEqual(stepped.stopId, paused.stopId);
    await call('debug_control', { sessionId: stepped.sessionId, stopId: stepped.stopId, threadId: stepped.threadId, action: 'continue' });
    console.log('PASS: real Node debugger startup, pause events, threads, stack, scopes, variables, expression evaluation, stepping and stale reference rejection.');
  } finally { if (sessionId) { await call('debug_stop', { sessionId }); } }
}
