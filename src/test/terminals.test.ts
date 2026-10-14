import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { z } from 'zod';
import type { RegisterTool } from '../advanced';

test('terminal control permissions, output streaming, offsets, exit status and old API compatibility', async () => {
  const listeners = new Map<string, Set<(event: any) => void>>();
  const event = (name: string) => (callback: (value: any) => void) => {
    const set = listeners.get(name) ?? new Set(); listeners.set(name, set); set.add(callback);
    return { dispose: () => set.delete(callback) };
  };
  const emit = (name: string, value: any) => { listeners.get(name)?.forEach(callback => callback(value)); };
  let enabled = false; let trusted = true;
  const sent: unknown[] = []; const terminals: any[] = [];
  let execution: any;
  const api = {
    env: { remoteName: undefined as string | undefined },
    FileType: { Directory: 2 },
    workspace: { get isTrusted() { return trusted; }, getConfiguration: () => ({ get: () => enabled }),
      onDidChangeConfiguration: event('config'), fs: { stat: async () => ({ type: 2 }) } },
    window: { terminals, activeTerminal: undefined, onDidCloseTerminal: event('close'),
      onDidStartTerminalShellExecution: event('start'), onDidEndTerminalShellExecution: event('end'),
      createTerminal: () => {
        const terminal = { name: 'test', sendText: (...args: unknown[]) => sent.push(args), show: () => undefined,
          shellIntegration: { executeCommand: () => execution },
          dispose: () => { terminals.splice(terminals.indexOf(terminal), 1); emit('close', terminal); } };
        terminals.push(terminal); return terminal;
      } }
  };
  // Only this test process mocks vscode; production always uses the real extension API.
  const Module = require('node:module'); const original = Module._load;
  Module._load = function (name: string, ...args: unknown[]) { return name === 'vscode' ? api : original.call(this, name, ...args); };
  let TerminalControls: typeof import('../terminals').TerminalControls;
  try { TerminalControls = require('../terminals').TerminalControls; } finally { Module._load = original; }
  const controls = new TerminalControls(async () => ({ fsPath: '/workspace' } as any));
  const handlers = new Map<string, (args: unknown) => Promise<Record<string, any>>>();
  const register: RegisterTool = (name, _description, schema, _readOnly, handler) => {
    handlers.set(name, args => handler(z.object(schema).parse(args)));
  };
  controls.register(register);
  const call = (name: string, args = {}) => handlers.get(name)!(args);
  const error = (code: string) => (value: any) => value.code === code;
  const tick = () => new Promise(resolve => setImmediate(resolve));
  try {
    await assert.rejects(call('terminals_list'), error('TERMINALS_DISABLED'));
    enabled = true; trusted = false;
    await assert.rejects(call('terminal_create'), error('WORKSPACE_UNTRUSTED'));
    trusted = true; api.env.remoteName = 'ssh';
    await assert.rejects(call('terminals_list'), error('TERMINAL_UNSUPPORTED')); api.env.remoteName = undefined;
    const created = await call('terminal_create'); const terminalId = created.terminalId;
    await call('terminal_write', { terminalId, text: 'input', addNewLine: false });
    assert.deepEqual(sent, [['input', false]]);
    let reads = 0;
    execution = { commandLine: { value: 'echo test' }, read: () => { reads++; return (async function* () { yield '\u001b[31mtest\r\n'; yield 'x'.repeat(300000); })(); } };
    await call('terminal_execute', { terminalId, command: 'echo test' }); emit('start', { terminal: terminals[0], execution });
    await tick(); assert.equal(reads, 1, 'execute and start event must share one reader');
    emit('end', { terminal: terminals[0], execution, exitCode: 7 });
    const first = await call('terminal_read', { terminalId, maxCharacters: 10 });
    assert.equal(first.truncated, true); assert.equal(first.text, 'x'.repeat(10)); assert.equal(first.exitCode, 7);
    assert.equal(first.status, 'completed'); assert.equal(first.outputPending, false); assert.equal(first.hasMore, true);
    const tail = await call('terminal_read', { terminalId, offset: first.endOffset - 3 });
    assert.equal(tail.text, 'xxx'); assert.equal(tail.hasMore, false); assert.equal(tail.nextOffset, tail.endOffset);
    await assert.rejects(call('terminal_read', { terminalId, offset: tail.endOffset + 1 }), error('INVALID_RANGE'));
    // Output is preserved verbatim, and unknown exit codes stay null.
    execution = { commandLine: { value: 'echo raw' }, read: () => (async function* () { yield '\u001b[31mraw\r\n'; })() };
    await call('terminal_execute', { terminalId, command: 'echo raw' }); await tick();
    emit('end', { terminal: terminals[0], execution, exitCode: undefined });
    const raw = await call('terminal_read', { terminalId, offset: tail.endOffset }); assert.equal(raw.text, '\u001b[31mraw\r\n'); assert.equal(raw.exitCode, null);
    enabled = false; emit('config', { affectsConfiguration: () => true });
    await assert.rejects(call('terminal_write', { terminalId, text: 'blocked' }), error('TERMINALS_DISABLED'));
    enabled = true; assert.equal((await call('terminal_read', { terminalId })).text, '');
    terminals[0].shellIntegration = undefined;
    await assert.rejects(call('terminal_execute', { terminalId, command: 'echo test' }), error('SHELL_INTEGRATION_UNAVAILABLE'));
    await call('terminal_close', { terminalId });
    assert.equal((await call('terminal_read', { terminalId })).closed, true);
    await assert.rejects(call('terminal_write', { terminalId, text: 'closed' }), error('TERMINAL_NOT_FOUND'));
    (api.window as any).onDidStartTerminalShellExecution = undefined;
    const legacy = new TerminalControls(async () => ({} as any));
    try { assert.equal(legacy.outputSupported, false); } finally { legacy.dispose(); }
  } finally { controls.dispose(); }
  assert.ok([...listeners.values()].every(set => set.size === 0), 'all event subscriptions disposed');
});
