import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { SerialQueue, ToolError } from './core';

interface TaskRun { id: string; name: string; status: 'starting' | 'running' | 'completed' | 'failed'; startedAt: string; endedAt?: string; exitCode?: number; execution?: vscode.TaskExecution; readyToStop?: boolean; stopRequested?: boolean; listeners: vscode.Disposable[]; }
export function taskId(task: vscode.Task): string {
  const scope = typeof task.scope === 'object' ? task.scope.uri.toString() : String(task.scope);
  return JSON.stringify([scope, task.source, task.name, task.definition]);
}
export class TaskRuns implements vscode.Disposable {
  private readonly runs = new Map<string, TaskRun>();
  private readonly starts = new SerialQueue();
  constructor(private readonly record: (name: string, code: string, duration: number) => void) {}
  async list(): Promise<vscode.Task[]> {
    const roots = vscode.workspace.workspaceFolders ?? [];
    return (await vscode.tasks.fetchTasks()).filter(task => typeof task.scope === 'object' && task.scope.uri.scheme === 'file' && roots.some(root => root.uri.toString() === (task.scope as vscode.WorkspaceFolder).uri.toString()));
  }
  start(id: string): Promise<Record<string, unknown>> { return this.starts.run(() => this.startRun(id)); }
  private async startRun(id: string): Promise<Record<string, unknown>> {
    if (!vscode.workspace.isTrusted) { throw new ToolError('WORKSPACE_UNTRUSTED', 'Task execution requires workspace trust.'); }
    const configuration = vscode.workspace.getConfiguration('vscodeMcp');
    if (!configuration.get<boolean>('tasks.enabled', false)) { throw new ToolError('TASKS_DISABLED', 'Enable task execution in VSCode MCP settings.'); }
    const task = (await this.list()).find(item => taskId(item) === id);
    if (!task) { throw new ToolError('TASK_NOT_FOUND', 'Select an exact task ID from tasks_list.'); }
    const latest = vscode.workspace.getConfiguration('vscodeMcp');
    if (!vscode.workspace.isTrusted || !latest.get<boolean>('tasks.enabled', false)) { throw new ToolError('TASKS_DISABLED', 'Task execution is no longer enabled in a trusted workspace.'); }
    const allowed = latest.get<string[]>('tasks.allowedNames', []);
    if (!allowed.includes(task.name)) { throw new ToolError('TASK_NOT_ALLOWED', 'Add this task name to vscodeMcp.tasks.allowedNames.'); }
    if (vscode.tasks.taskExecutions.some(execution => taskId(execution.task) === id)) { throw new ToolError('TASK_ALREADY_RUNNING', 'This task is already running. Wait for it to finish before starting an MCP run.'); }
    if ([...this.runs.values()].filter(item => item.status === 'starting' || item.status === 'running').length >= 4) { throw new ToolError('TASK_LIMIT', 'At most four MCP tasks may run concurrently.'); }
    const run: TaskRun = { id: randomUUID(), name: task.name, status: 'starting', startedAt: new Date().toISOString(), listeners: [] };
    this.runs.set(run.id, run);
    const early = new Map<vscode.TaskExecution, { exitCode?: number; ended: boolean }>();
    const earlyStarts = new Set<vscode.TaskExecution>();
    const started = (execution: vscode.TaskExecution) => {
      if (!run.execution) { earlyStarts.add(execution); }
      else if (execution === run.execution) { run.readyToStop = true; if (run.stopRequested) { execution.terminate(); } }
    };
    const complete = (exitCode?: number) => {
      if (run.status === 'completed' || run.status === 'failed') { return; }
      run.exitCode = exitCode; run.status = 'completed'; run.endedAt = new Date().toISOString();
      this.record(task.name, exitCode === 0 ? 'OK' : exitCode === undefined ? 'EXIT_UNKNOWN' : `EXIT_${exitCode}`, Date.now() - Date.parse(run.startedAt));
    };
    run.listeners.push(vscode.tasks.onDidStartTaskProcess(event => started(event.execution)),
    vscode.tasks.onDidStartTask(event => { if (task.execution instanceof vscode.CustomExecution) { started(event.execution); } }),
    vscode.tasks.onDidEndTaskProcess(event => {
      if (!run.execution) { early.set(event.execution, { exitCode: event.exitCode, ended: false }); }
      else if (event.execution === run.execution) { complete(event.exitCode); }
    }), vscode.tasks.onDidEndTask(event => {
      if (!run.execution) { early.set(event.execution, { ...early.get(event.execution), ended: true }); }
      else if (event.execution === run.execution) { complete(run.exitCode); run.listeners.forEach(item => item.dispose()); run.listeners = []; run.execution = undefined; }
    }));
    try {
      run.execution = await vscode.tasks.executeTask(task);
      run.readyToStop = earlyStarts.has(run.execution);
      const ended = early.get(run.execution);
      if (ended) {
        complete(ended.exitCode);
        if (ended.ended) { run.listeners.forEach(item => item.dispose()); run.listeners = []; run.execution = undefined; }
      } else { run.status = 'running'; }
    } catch (error) {
      run.status = 'failed'; run.endedAt = new Date().toISOString(); run.listeners.forEach(item => item.dispose()); run.listeners = [];
      throw error;
    }
    for (const previous of [...this.runs.values()].filter(item => item.status === 'completed' || item.status === 'failed').slice(0, -100)) { this.runs.delete(previous.id); }
    return this.status(run.id);
  }
  status(id: string): Record<string, unknown> {
    const run = this.runs.get(id);
    if (!run) { throw new ToolError('TASK_NOT_FOUND', 'Task run is unavailable in this window.'); }
    return { runId: run.id, name: run.name, status: run.status, startedAt: run.startedAt, endedAt: run.endedAt ?? null, exitCode: run.exitCode ?? null, stopRequested: run.stopRequested ?? false, output: 'View the VS Code task terminal. Terminal text is not exposed by the VS Code 1.85 task API.' };
  }
  stop(id: string): Record<string, unknown> {
    const run = this.runs.get(id);
    if (!run) { throw new ToolError('TASK_NOT_FOUND', 'Task run is unavailable in this window.'); }
    if (run.status === 'starting' || run.status === 'running') {
      run.stopRequested = true;
      if (run.readyToStop) { run.execution?.terminate(); }
    }
    return this.status(id);
  }
  dispose(): void {
    for (const run of this.runs.values()) { run.execution?.terminate(); run.listeners.forEach(item => item.dispose()); }
    this.runs.clear();
  }
}
