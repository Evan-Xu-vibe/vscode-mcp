import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { z } from 'zod';
import type { RegisterTool } from '../advanced';

test('debugger rejects stale handles and rechecks permissions after asynchronous responses', async () => {
  let enabled = true; let evaluation = false; let trusted = true; let tracker: any;
  const callbacks = new Map<string, (value: any) => void>();
  const event = (name: string) => (callback: (value: any) => void) => { callbacks.set(name, callback); return { dispose: () => callbacks.delete(name) }; };
  const root = { uri: { scheme: 'file', toString: () => 'file:///workspace' } };
  let respond = async (command: string): Promise<any> => {
    if (command === 'threads') { return { threads: [{ id: 1, name: 'main' }] }; }
    if (command === 'stackTrace') { return { stackFrames: [{ id: 10, name: 'example', line: 1, column: 1, source: { path: '/outside/file' } }], totalFrames: 1 }; }
    if (command === 'scopes') { return { scopes: [{ name: 'locals', variablesReference: 20 }] }; }
    if (command === 'variables') { return { variables: [{ name: 'first', value: '1', variablesReference: 21 }, { name: 'second', value: '2', variablesReference: 0 }] }; }
    if (command === 'evaluate') { return { result: '42', variablesReference: 0 }; }
    return {};
  };
  const session = { id: 'session', type: 'test', name: 'test', workspaceFolder: root, customRequest: (command: string) => respond(command) };
  const api = {
    env: { remoteName: undefined },
    workspace: { get isTrusted() { return trusted; }, workspaceFolders: [root], getConfiguration: () => ({ get: (key: string, fallback: unknown) => key === 'debug.enabled' ? enabled : key === 'debug.allowEvaluation' ? evaluation : fallback }), onDidChangeConfiguration: event('config') },
    debug: { activeDebugSession: session, registerDebugAdapterTrackerFactory: (_type: string, factory: any) => { tracker = factory.createDebugAdapterTracker(session); return { dispose: () => undefined }; },
      onDidStartDebugSession: event('start'), onDidTerminateDebugSession: event('end') }
  };
  const Module = require('node:module'); const original = Module._load;
  Module._load = function (name: string, ...args: unknown[]) { return name === 'vscode' ? api : original.call(this, name, ...args); };
  let DebugControls: typeof import('../debugger').DebugControls;
  try { DebugControls = require('../debugger').DebugControls; } finally { Module._load = original; }
  const controls = new DebugControls(async input => { if (input.path.startsWith('/outside')) { throw new Error('denied'); } return root.uri as any; });
  const handlers = new Map<string, (args: unknown) => Promise<Record<string, any>>>();
  const register: RegisterTool = (name, _description, schema, _readOnly, handler) => { handlers.set(name, args => handler(z.object(schema).parse(args))); };
  controls.register(register);
  const call = (name: string, args = {}) => handlers.get(name)!(args);
  const error = (code: string) => (value: any) => value.code === code;
  const stopped = () => tracker.onDidSendMessage({ type: 'event', event: 'stopped', body: { threadId: 1, reason: 'breakpoint' } });
  const continued = () => tracker.onDidSendMessage({ type: 'event', event: 'continued', body: {} });
  try {
    stopped(); const stopId = (await call('debug_sessions')).sessions[0].stopId; const ids = { sessionId: 'session', stopId };
    await assert.rejects(call('debug_scopes', { ...ids, frameId: 999 }), error('DEBUG_REFERENCE_INVALID'));
    const stack = await call('debug_stack', { ...ids, threadId: 1 }); assert.equal(stack.frames[0].uri, null, 'external source paths are hidden');
    await call('debug_scopes', { ...ids, frameId: 10 });
    await assert.rejects(call('debug_variables', { ...ids, variablesReference: 999 }), error('DEBUG_REFERENCE_INVALID'));
    const first = await call('debug_variables', { ...ids, variablesReference: 20, count: 1 }); assert.equal(first.variables.length, 1); assert.equal(first.nextStart, 1);
    assert.equal((await call('debug_variables', { ...ids, variablesReference: 20, start: 1 })).variables[0].name, 'second');
    await assert.rejects(call('debug_evaluate', { ...ids, frameId: 10, expression: 'value' }), error('DEBUG_EVALUATION_DISABLED'));
    evaluation = true; assert.equal((await call('debug_evaluate', { ...ids, frameId: 10, expression: 'value' })).result, '42');
    const normal = respond;
    respond = async command => { const body = await normal(command); continued(); return body; };
    await assert.rejects(call('debug_scopes', { ...ids, frameId: 10 }), error('DEBUG_STATE_CHANGED'));
    await assert.rejects(call('debug_variables', { ...ids, variablesReference: 20 }), error('DEBUG_STATE_CHANGED'));
    respond = normal; stopped(); const newStop = (await call('debug_sessions')).sessions[0].stopId;
    await assert.rejects(call('debug_scopes', { sessionId: 'session', stopId: newStop, frameId: 10 }), error('DEBUG_REFERENCE_INVALID'));
    await call('debug_stack', { sessionId: 'session', stopId: newStop, threadId: 1 });
    respond = async command => { const body = await normal(command); enabled = false; return body; };
    await assert.rejects(call('debug_scopes', { sessionId: 'session', stopId: newStop, frameId: 10 }), error('DEBUG_DISABLED'));
    enabled = true; respond = normal; trusted = false;
    await assert.rejects(call('debug_sessions'), error('WORKSPACE_UNTRUSTED')); trusted = true;
    await assert.rejects(call('debug_control', { sessionId: 'session', action: 'continue', threadId: 1 }), error('DEBUG_STATE_CHANGED'));
    callbacks.get('end')!(session); api.debug.activeDebugSession = undefined as any;
    await assert.rejects(call('debug_threads', { sessionId: 'session' }), error('DEBUG_SESSION_NOT_FOUND'));
  } finally { controls.dispose(); }
  assert.equal(callbacks.size, 0);
});
