import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ToolError } from './core';
import type { RegisterTool } from './advanced';

const MAX_BUFFER = 256 * 1024;
// Optional stable APIs added in VS Code 1.93. Keep the extension's 1.85 minimum
// and runtime feature detection instead of requiring these APIs on old hosts.
interface ShellExecution { commandLine: { value: string }; read(): AsyncIterable<string>; }
interface ShellIntegration { executeCommand(commandLine: string): ShellExecution; }
type IntegratedTerminal = vscode.Terminal & { shellIntegration?: ShellIntegration };
interface ShellWindow {
  onDidStartTerminalShellExecution?: vscode.Event<{ terminal: vscode.Terminal; execution: ShellExecution }>;
  onDidEndTerminalShellExecution?: vscode.Event<{ terminal: vscode.Terminal; execution: ShellExecution; exitCode?: number }>;
}
const shellWindow = vscode.window as typeof vscode.window & ShellWindow;
const integration = (terminal: vscode.Terminal) => (terminal as IntegratedTerminal).shellIntegration;
interface TerminalState {
  id: string; terminal: vscode.Terminal; owned: boolean; closed: boolean;
  text: string; offset: number; execution?: ShellExecution;
  command?: string; exitCode?: number; status: 'idle' | 'running' | 'completed' | 'closed';
  outputPending: boolean; outputError?: string;
}

export class TerminalControls implements vscode.Disposable {
  private readonly states = new Map<vscode.Terminal, TerminalState>();
  private readonly listeners: vscode.Disposable[] = [];
  private disposed = false;
  readonly outputSupported = typeof shellWindow.onDidStartTerminalShellExecution === 'function' && typeof shellWindow.onDidEndTerminalShellExecution === 'function';
  constructor(private readonly resolve: (input: { path: string; root?: string }) => Promise<vscode.Uri>) {
    this.listeners.push(vscode.window.onDidCloseTerminal(terminal => {
      const state = this.states.get(terminal);
      if (state) { state.closed = true; state.status = 'closed'; this.prune(); }
    }));
    if (this.outputSupported) {
      this.listeners.push(shellWindow.onDidStartTerminalShellExecution!(event => {
        if (this.enabled()) { this.capture(this.state(event.terminal), event.execution); }
      }), shellWindow.onDidEndTerminalShellExecution!(event => {
        const state = this.states.get(event.terminal);
        if (state?.execution === event.execution) {
          state.command = event.execution.commandLine.value; state.exitCode = event.exitCode;
          if (!state.closed) { state.status = 'completed'; }
        }
      }));
    }
    this.listeners.push(vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('vscodeMcp.terminals.enabled') && !this.enabled()) {
        for (const state of this.states.values()) { state.text = ''; state.offset = 0; state.command = undefined; state.execution = undefined; state.exitCode = undefined; state.status = state.closed ? 'closed' : 'idle'; state.outputPending = false; state.outputError = undefined; }
      }
    }));
  }
  private enabled(): boolean {
    return !this.disposed && vscode.workspace.isTrusted && !vscode.env.remoteName && vscode.workspace.getConfiguration('vscodeMcp').get<boolean>('terminals.enabled', false);
  }
  private allow(): void {
    if (!vscode.workspace.isTrusted) { throw new ToolError('WORKSPACE_UNTRUSTED', 'Terminal access requires workspace trust.'); }
    if (vscode.env.remoteName) { throw new ToolError('TERMINAL_UNSUPPORTED', 'Remote windows are not supported.'); }
    if (!this.enabled()) { throw new ToolError('TERMINALS_DISABLED', 'Enable terminal access in the VSCode MCP sidebar.'); }
  }
  private state(terminal: vscode.Terminal): TerminalState {
    let state = this.states.get(terminal);
    if (!state) {
      state = { id: randomUUID(), terminal, owned: false, closed: false, text: '', offset: 0, status: 'idle', outputPending: false };
      this.states.set(terminal, state);
    }
    return state;
  }
  private get(id: string, live = true): TerminalState {
    this.allow();
    const state = [...this.states.values()].find(item => item.id === id);
    if (!state || (live && (state.closed || !vscode.window.terminals.includes(state.terminal)))) { throw new ToolError('TERMINAL_NOT_FOUND', 'Select a live terminalId from terminals_list.'); }
    return state;
  }
  private prune(): void {
    for (const state of [...this.states.values()].filter(item => item.closed).slice(0, -20)) { this.states.delete(state.terminal); }
  }
  private summary(state: TerminalState): Record<string, unknown> {
    return { terminalId: state.id, name: state.terminal.name, owned: state.owned, closed: state.closed, active: vscode.window.activeTerminal === state.terminal,
      shellIntegration: !!integration(state.terminal), outputSupported: this.outputSupported, status: state.status,
      command: state.command ?? null, exitCode: state.exitCode ?? null, outputPending: state.outputPending, outputError: state.outputError ?? null };
  }
  private capture(state: TerminalState, execution: ShellExecution): void {
    if (state.execution === execution) { return; }
    state.execution = execution; state.command = execution.commandLine.value; state.exitCode = undefined; state.status = 'running'; state.outputPending = true; state.outputError = undefined;
    const stream = execution.read(); // Subscribe immediately; earlier output cannot be recovered.
    void (async () => {
      try {
        for await (const chunk of stream) {
          if (!this.enabled() || state.execution !== execution) { break; }
          state.text += chunk;
          if (state.text.length > MAX_BUFFER) { const drop = state.text.length - MAX_BUFFER; state.text = state.text.slice(drop); state.offset += drop; }
        }
      } catch { if (state.execution === execution) { state.outputError = 'OUTPUT_READ_FAILED'; } }
      finally { if (state.execution === execution) { state.outputPending = false; } }
    })();
  }
  register(register: RegisterTool): void {
    const id = { terminalId: z.string().uuid() };
    register('terminals_list', 'List terminals in this local VS Code window. Access must be enabled; IDs are window-local.', {}, true, async () => {
      this.allow();
      return { outputSupported: this.outputSupported, terminals: vscode.window.terminals.slice(0, 200).map(terminal => this.summary(this.state(terminal))), truncated: vscode.window.terminals.length > 200 };
    });
    register('terminal_create', 'Create a VS Code terminal using the default shell, with a workspace directory. Wait for shellIntegration before terminal_execute.', {
      name: z.string().min(1).max(100).default('MCP Terminal'), path: z.string().min(1).default('.'), root: z.string().optional(), show: z.boolean().default(true)
    }, false, async args => {
      this.allow();
      if ([...this.states.values()].filter(state => state.owned && !state.closed).length >= 10) { throw new ToolError('TERMINAL_LIMIT', 'At most ten MCP-created terminals may be open.'); }
      const cwd = await this.resolve(args);
      if ((await vscode.workspace.fs.stat(cwd)).type !== vscode.FileType.Directory) { throw new ToolError('NOT_A_DIRECTORY', 'Terminal cwd must be a directory.'); }
      this.allow();
      if ([...this.states.values()].filter(state => state.owned && !state.closed).length >= 10) { throw new ToolError('TERMINAL_LIMIT', 'At most ten MCP-created terminals may be open.'); }
      const state = this.state(vscode.window.createTerminal({ name: args.name, cwd })); state.owned = true;
      if (args.show) { state.terminal.show(true); }
      return this.summary(state);
    });
    register('terminal_write', 'Send text or control characters to a terminal. addNewLine submits input by default. No exit-code guarantee; output requires shell integration.', {
      ...id, text: z.string().min(1).max(64 * 1024), addNewLine: z.boolean().default(true), show: z.boolean().default(false)
    }, false, async args => {
      const state = this.get(args.terminalId);
      state.terminal.sendText(args.text, args.addNewLine); if (args.show) { state.terminal.show(true); }
      return { ...this.summary(state), sent: true };
    });
    register('terminal_execute', 'Execute a command through shell integration (VS Code 1.93+). Returns immediately; poll terminal_read for raw output, status and exitCode. May interrupt a running command.', {
      ...id, command: z.string().min(1).max(64 * 1024), show: z.boolean().default(false)
    }, false, async args => {
      const state = this.get(args.terminalId);
      const shell = integration(state.terminal);
      if (!this.outputSupported || !shell) { throw new ToolError('SHELL_INTEGRATION_UNAVAILABLE', 'Use VS Code 1.93+ with shell integration, or terminal_write for input without captured output.'); }
      this.capture(state, shell.executeCommand(args.command));
      if (args.show) { state.terminal.show(true); }
      return this.summary(state);
    });
    register('terminal_read', 'Read buffered raw command output captured while terminal access was enabled. Cannot read pre-existing scrollback or unsupported task terminals. Offsets are UTF-16; check truncated and nextOffset.', {
      ...id, offset: z.number().int().min(0).default(0), maxCharacters: z.number().int().min(1).max(64 * 1024).default(64 * 1024)
    }, true, async args => {
      const state = this.get(args.terminalId, false);
      if (!this.outputSupported) { throw new ToolError('SHELL_INTEGRATION_UNAVAILABLE', 'Terminal output capture requires VS Code 1.93+.'); }
      const endOffset = state.offset + state.text.length;
      if (args.offset > endOffset) { throw new ToolError('INVALID_RANGE', 'Output offset exceeds available output.'); }
      const start = Math.max(args.offset, state.offset); const text = state.text.slice(start - state.offset, start - state.offset + args.maxCharacters);
      return { ...this.summary(state), text, startOffset: start, nextOffset: start + text.length, endOffset, truncated: args.offset < state.offset,
        hasMore: start + text.length < endOffset, source: 'shellIntegration', historyAvailable: false };
    });
    register('terminal_close', 'Close the selected VS Code terminal, terminating its processes. Applies to existing and MCP-created terminals.', id, false, async args => {
      const state = this.get(args.terminalId); state.terminal.dispose(); return { terminalId: state.id, closeRequested: true };
    });
  }
  dispose(): void {
    this.disposed = true; this.listeners.forEach(listener => listener.dispose()); this.states.clear();
  }
}
