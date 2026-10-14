import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { SerialQueue, ToolError } from './core';
import type { RegisterTool } from './advanced';

interface DebugState {
  session: vscode.DebugSession; status: 'unknown' | 'running' | 'paused'; stopId?: string;
  threadId?: number; reason?: string; frames: Set<number>; references: Set<number>;
}
const sessionSchema = { sessionId: z.string().min(1).max(200) };
const stoppedSchema = { ...sessionSchema, stopId: z.string().uuid() };
const positiveId = z.number().int().min(1).max(2147483647);
const threadId = z.number().int().min(0).max(2147483647);

export class DebugControls implements vscode.Disposable {
  private readonly states = new Map<string, DebugState>();
  private readonly listeners: vscode.Disposable[];
  private readonly mutations = new SerialQueue();
  constructor(private readonly resolve: (input: { path: string; root?: string }) => Promise<vscode.Uri>) {
    this.listeners = [vscode.debug.registerDebugAdapterTrackerFactory('*', { createDebugAdapterTracker: session => {
      if (!this.local(session)) { return undefined; }
      const state = this.state(session);
      return { onDidSendMessage: message => {
        if (message.type !== 'event') { return; }
        if (message.event === 'stopped') {
          this.invalidate(state); state.status = 'paused'; state.stopId = randomUUID();
          state.threadId = Number.isInteger(message.body?.threadId) ? message.body.threadId : undefined;
          state.reason = typeof message.body?.reason === 'string' ? message.body.reason.slice(0, 200) : undefined;
        } else if (message.event === 'continued') { this.invalidate(state); state.status = 'running'; }
        else if (message.event === 'terminated' || message.event === 'exited') { this.invalidate(state); state.status = 'unknown'; }
      } };
    } }), vscode.debug.onDidStartDebugSession(session => { if (this.local(session)) { this.state(session); } }),
    vscode.debug.onDidTerminateDebugSession(session => { this.states.delete(session.id); }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('vscodeMcp.debug') && !this.enabled()) {
        for (const state of this.states.values()) { state.frames.clear(); state.references.clear(); if (state.stopId) { state.stopId = randomUUID(); } }
      }
    })];
  }
  private local(session: vscode.DebugSession): boolean {
    return !vscode.env.remoteName && !!session.workspaceFolder && session.workspaceFolder.uri.scheme === 'file' && !!vscode.workspace.workspaceFolders?.some(root => root.uri.toString() === session.workspaceFolder!.uri.toString());
  }
  private enabled(): boolean { return vscode.workspace.isTrusted && !vscode.env.remoteName && vscode.workspace.getConfiguration('vscodeMcp').get<boolean>('debug.enabled', false); }
  private allow(): void {
    if (!vscode.workspace.isTrusted) { throw new ToolError('WORKSPACE_UNTRUSTED', 'Debug access requires workspace trust.'); }
    if (vscode.env.remoteName) { throw new ToolError('DEBUG_UNSUPPORTED', 'Remote debugging windows are not supported.'); }
    if (!this.enabled()) { throw new ToolError('DEBUG_DISABLED', 'Enable debugging in the VSCode MCP sidebar.'); }
  }
  private state(session: vscode.DebugSession): DebugState {
    let state = this.states.get(session.id);
    if (!state) { state = { session, status: 'unknown', frames: new Set(), references: new Set() }; this.states.set(session.id, state); }
    return state;
  }
  private invalidate(state: DebugState): void { state.stopId = undefined; state.threadId = undefined; state.reason = undefined; state.frames.clear(); state.references.clear(); }
  private get(id: string, stopId?: string): DebugState {
    this.allow(); const state = this.states.get(id);
    if (!state || !this.local(state.session)) { throw new ToolError('DEBUG_SESSION_NOT_FOUND', 'Select a sessionId from debug_sessions.'); }
    if (stopId && (state.status !== 'paused' || state.stopId !== stopId)) { throw new ToolError('DEBUG_STATE_CHANGED', 'Paused state changed; query debug_sessions and obtain fresh frame/reference IDs.'); }
    return state;
  }
  private summary(state: DebugState): Record<string, unknown> {
    return { sessionId: state.session.id, name: state.session.name, type: state.session.type, root: state.session.workspaceFolder!.uri.toString(), active: vscode.debug.activeDebugSession?.id === state.session.id,
      status: state.status, stopId: state.stopId ?? null, threadId: state.threadId ?? null, reason: state.reason ?? null };
  }
  private async request(state: DebugState, command: string, args: Record<string, unknown>, stopId?: string): Promise<Record<string, any>> {
    this.get(state.session.id, stopId); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const body = await Promise.race([state.session.customRequest(command, args), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new ToolError('DEBUG_TIMEOUT', 'Debugger request exceeded 10 seconds; inspect session state before retrying.')), 10000); })]);
      this.get(state.session.id, stopId); return body ?? {};
    } catch (error) {
      if (error instanceof ToolError) { throw error; }
      throw new ToolError('DEBUG_REQUEST_FAILED', `${command} failed: ${error instanceof Error ? error.message.slice(0, 1000) : 'Debugger rejected the request.'}`);
    } finally { if (timer) { clearTimeout(timer); } }
  }
  private frame(state: DebugState, id: number): void { if (!state.frames.has(id)) { throw new ToolError('DEBUG_REFERENCE_INVALID', 'Use a frameId from debug_stack for this stopId.'); } }
  register(register: RegisterTool): void {
    register('debug_configurations', 'List named launch configurations in local workspace folders, without exposing configuration secrets.', {}, true, async () => {
      const configurations = (vscode.workspace.workspaceFolders ?? []).filter(root => root.uri.scheme === 'file').flatMap(root => {
        const configs = vscode.workspace.getConfiguration('launch', root.uri).get<vscode.DebugConfiguration[]>('configurations', []);
        return configs.filter(config => typeof config.name === 'string').map(config => ({ name: config.name, type: config.type, request: config.request, root: root.uri.toString() }));
      });
      return { enabled: this.enabled(), configurations: configurations.slice(0, 200), truncated: configurations.length > 200 };
    });
    register('debug_sessions', 'List local debug sessions and current pause tokens. State is unknown until debugger events are observed.', {}, true, async () => {
      this.allow(); if (vscode.debug.activeDebugSession && this.local(vscode.debug.activeDebugSession)) { this.state(vscode.debug.activeDebugSession); }
      return { sessions: [...this.states.values()].slice(0, 200).map(state => this.summary(state)), truncated: this.states.size > 200 };
    });
    register('debug_start', 'Start one existing named launch configuration. Requires debug permission; may run preLaunchTask and execute program code.', { name: z.string().min(1).max(200), root: z.string().optional() }, false, args => this.mutations.run(async () => {
      this.allow(); const uri = await this.resolve({ path: '.', root: args.root });
      const folder = vscode.workspace.workspaceFolders?.find(root => root.uri.toString() === uri.toString());
      if (!folder) { throw new ToolError('ROOT_REQUIRED', 'Select a local workspace root.'); }
      const configs = vscode.workspace.getConfiguration('launch', folder.uri).get<vscode.DebugConfiguration[]>('configurations', []).filter(config => config.name === args.name);
      if (configs.length !== 1) { throw new ToolError('DEBUG_CONFIG_NOT_FOUND', 'Choose a unique named configuration from debug_configurations.'); }
      this.allow(); const started = await vscode.debug.startDebugging(folder, args.name);
      if (!started) { throw new ToolError('DEBUG_START_FAILED', 'VS Code could not start debugging. Check launch configuration and installed debugger.'); }
      return { started, sessions: [...this.states.values()].map(state => this.summary(state)) };
    }));
    register('debug_stop', 'Stop the selected local debug session. This may terminate the debuggee.', sessionSchema, false, args => this.mutations.run(async () => { const state = this.get(args.sessionId); await vscode.debug.stopDebugging(state.session); return { sessionId: args.sessionId, stopRequested: true }; }));
    register('debug_breakpoints_get', 'List source breakpoints inside the workspace. Function and external-file breakpoints are excluded.', {}, true, async () => {
      this.allow(); const breakpoints: Record<string, unknown>[] = [];
      for (const bp of vscode.debug.breakpoints) {
        if (!(bp instanceof vscode.SourceBreakpoint)) { continue; }
        try { await this.resolve({ path: bp.location.uri.toString() }); } catch { continue; }
        breakpoints.push({ breakpointId: bp.id, uri: bp.location.uri.toString(), line: bp.location.range.start.line + 1, column: bp.location.range.start.character + 1, enabled: bp.enabled, condition: bp.condition ?? null, hitCondition: bp.hitCondition ?? null, logMessage: bp.logMessage ?? null });
      }
      this.allow(); return { breakpoints: breakpoints.slice(0, 200), truncated: breakpoints.length > 200 };
    });
    register('debug_breakpoint_add', 'Add a workspace source breakpoint. Conditions and log expressions may execute debuggee code.', { path: z.string().min(1), root: z.string().optional(), line: z.number().int().min(1), column: z.number().int().min(1).default(1), condition: z.string().max(4096).optional(), hitCondition: z.string().max(100).optional(), logMessage: z.string().max(4096).optional() }, false, args => this.mutations.run(async () => {
      this.allow();
      if ((args.condition || args.hitCondition || args.logMessage) && !vscode.workspace.getConfiguration('vscodeMcp').get<boolean>('debug.allowEvaluation', false)) { throw new ToolError('DEBUG_EVALUATION_DISABLED', 'Enable debug expression evaluation for conditional breakpoints or log expressions.'); }
      const uri = await this.resolve(args); const doc = await vscode.workspace.openTextDocument(uri);
      if (args.line > doc.lineCount || args.column - 1 > doc.lineAt(args.line - 1).text.length) { throw new ToolError('INVALID_RANGE', 'Breakpoint position exceeds the document.'); }
      this.allow();
      if ((args.condition || args.hitCondition || args.logMessage) && !vscode.workspace.getConfiguration('vscodeMcp').get<boolean>('debug.allowEvaluation', false)) { throw new ToolError('DEBUG_EVALUATION_DISABLED', 'Expression evaluation is no longer enabled.'); }
      const bp = new vscode.SourceBreakpoint(new vscode.Location(uri, new vscode.Position(args.line - 1, args.column - 1)), true, args.condition, args.hitCondition, args.logMessage);
      vscode.debug.addBreakpoints([bp]); return { breakpointId: bp.id, uri: uri.toString(), line: args.line, column: args.column };
    }));
    register('debug_breakpoint_remove', 'Remove one workspace source breakpoint selected from debug_breakpoints_get.', { breakpointId: z.string().min(1).max(200) }, false, args => this.mutations.run(async () => {
      this.allow(); const bp = vscode.debug.breakpoints.find(bp => bp.id === args.breakpointId);
      if (!(bp instanceof vscode.SourceBreakpoint)) { throw new ToolError('DEBUG_BREAKPOINT_NOT_FOUND', 'Select a workspace source breakpoint ID.'); }
      await this.resolve({ path: bp.location.uri.toString() }); this.allow(); vscode.debug.removeBreakpoints([bp]); return { removed: true, breakpointId: bp.id };
    }));
    register('debug_threads', 'List debugger threads. IDs belong to the selected session.', sessionSchema, true, async args => {
      const body = await this.request(this.get(args.sessionId), 'threads', {});
      return { threads: (Array.isArray(body.threads) ? body.threads : []).slice(0, 200).map(value => ({ id: value.id, name: String(value.name ?? '').slice(0, 1024) })), truncated: (body.threads?.length ?? 0) > 200 };
    });
    register('debug_stack', 'Read paused stack frames. Use stopId from debug_sessions; sources outside the workspace are not exposed.', { ...stoppedSchema, threadId, startFrame: z.number().int().min(0).default(0), levels: z.number().int().min(1).max(100).default(20) }, true, async args => {
      const state = this.get(args.sessionId, args.stopId); const body = await this.request(state, 'stackTrace', { threadId: args.threadId, startFrame: args.startFrame, levels: args.levels }, args.stopId);
      const frames: Record<string, unknown>[] = [];
      for (const value of (Array.isArray(body.stackFrames) ? body.stackFrames : []).slice(0, args.levels)) {
        let uri: string | null = null;
        if (typeof value.source?.path === 'string') { try { uri = (await this.resolve({ path: value.source.path })).toString(); } catch { /* External runtime frames remain inspectable without exposing their source paths. */ } }
        frames.push({ frameId: value.id, name: String(value.name ?? '').slice(0, 1024), uri, line: value.line ?? null, column: value.column ?? null });
      }
      this.get(args.sessionId, args.stopId);
      for (const value of frames) { if (Number.isInteger(value.frameId)) { state.frames.add(value.frameId as number); } }
      return { stopId: args.stopId, frames, totalFrames: body.totalFrames ?? null, nextStartFrame: frames.length === args.levels && (body.totalFrames === undefined || args.startFrame + frames.length < body.totalFrames) ? args.startFrame + frames.length : null };
    });
    register('debug_scopes', 'Read scopes for a frame returned by debug_stack at the current stopId.', { ...stoppedSchema, frameId: z.number().int().min(0) }, true, async args => {
      const state = this.get(args.sessionId, args.stopId); this.frame(state, args.frameId);
      const body = await this.request(state, 'scopes', { frameId: args.frameId }, args.stopId);
      const scopes = (Array.isArray(body.scopes) ? body.scopes : []).slice(0, 100).map(value => ({ name: String(value.name ?? '').slice(0, 1024), variablesReference: value.variablesReference, expensive: !!value.expensive, namedVariables: value.namedVariables ?? null, indexedVariables: value.indexedVariables ?? null }));
      for (const scope of scopes) { if (Number.isInteger(scope.variablesReference) && scope.variablesReference > 0) { state.references.add(scope.variablesReference); } }
      return { stopId: args.stopId, scopes, truncated: (body.scopes?.length ?? 0) > 100 };
    });
    register('debug_variables', 'Read variables from a scope or child variablesReference at the current stopId. Values may contain secrets; adapters may invoke getters.', { ...stoppedSchema, variablesReference: positiveId, start: z.number().int().min(0).default(0), count: z.number().int().min(1).max(100).default(50), filter: z.enum(['indexed', 'named']).optional() }, true, async args => {
      const state = this.get(args.sessionId, args.stopId);
      if (!state.references.has(args.variablesReference)) { throw new ToolError('DEBUG_REFERENCE_INVALID', 'Use a variablesReference returned at this stopId.'); }
      // Fetch all then slice locally: adapters are permitted to ignore DAP pagination.
      const body = await this.request(state, 'variables', { variablesReference: args.variablesReference, ...(args.filter ? { filter: args.filter } : {}) }, args.stopId);
      const values = Array.isArray(body.variables) ? body.variables : [];
      const variables = values.slice(args.start, args.start + args.count).map(value => ({ name: String(value.name ?? '').slice(0, 1024), value: String(value.value ?? '').slice(0, 4096), valueTruncated: String(value.value ?? '').length > 4096, type: typeof value.type === 'string' ? value.type.slice(0, 1024) : null, variablesReference: value.variablesReference ?? 0, namedVariables: value.namedVariables ?? null, indexedVariables: value.indexedVariables ?? null }));
      for (const value of variables) { if (Number.isInteger(value.variablesReference) && value.variablesReference > 0) { state.references.add(value.variablesReference); } }
      return { stopId: args.stopId, variables, total: values.length, nextStart: args.start + args.count < values.length ? args.start + args.count : null };
    });
    register('debug_control', 'Pause, continue or step a thread. Stepping/continuing require the current stopId; execution may change program state.', { ...sessionSchema, action: z.enum(['pause', 'continue', 'next', 'stepIn', 'stepOut']), threadId, stopId: z.string().uuid().optional() }, false, args => this.mutations.run(async () => {
      if (args.action !== 'pause' && !args.stopId) { throw new ToolError('DEBUG_STATE_CHANGED', 'Continuing and stepping require the current stopId.'); }
      const state = this.get(args.sessionId, args.action === 'pause' ? undefined : args.stopId);
      if (args.action !== 'pause') { this.invalidate(state); state.status = 'running'; }
      try { await this.request(state, args.action, { threadId: args.threadId }); }
      catch (error) { if (state.status === 'running') { state.status = 'unknown'; } throw error; }
      return { requested: args.action, ...this.summary(state) };
    }));
    register('debug_evaluate', 'Evaluate an expression in a paused frame. May run arbitrary code; requires separate debug.allowEvaluation permission.', { ...stoppedSchema, frameId: z.number().int().min(0), expression: z.string().min(1).max(4096) }, false, args => this.mutations.run(async () => {
      const state = this.get(args.sessionId, args.stopId); this.frame(state, args.frameId);
      if (!vscode.workspace.getConfiguration('vscodeMcp').get<boolean>('debug.allowEvaluation', false)) { throw new ToolError('DEBUG_EVALUATION_DISABLED', 'Enable debug expression evaluation in the sidebar.'); }
      const body = await this.request(state, 'evaluate', { expression: args.expression, frameId: args.frameId, context: 'watch' }, args.stopId);
      if (!vscode.workspace.getConfiguration('vscodeMcp').get<boolean>('debug.allowEvaluation', false)) { throw new ToolError('DEBUG_EVALUATION_DISABLED', 'Expression evaluation permission changed.'); }
      if (Number.isInteger(body.variablesReference) && body.variablesReference > 0) { state.references.add(body.variablesReference); }
      return { stopId: args.stopId, result: String(body.result ?? '').slice(0, 65536), truncated: String(body.result ?? '').length > 65536, type: typeof body.type === 'string' ? body.type.slice(0, 1024) : null, variablesReference: body.variablesReference ?? 0 };
    }));
  }
  dispose(): void { this.listeners.forEach(listener => listener.dispose()); this.states.clear(); }
}
