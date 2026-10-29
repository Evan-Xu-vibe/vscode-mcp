import * as vscode from 'vscode';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { z } from 'zod';
import { canonicalPath, ToolError } from './core';
import { TaskRuns, taskId } from './tasks';

export type RegisterTool = <S extends z.ZodRawShape>(name: string, description: string, schema: S, readOnly: boolean, handler: (args: z.infer<z.ZodObject<S>>) => Promise<Record<string, unknown>>) => void;
interface AdvancedAccess {
  checkTree(uri: vscode.Uri): Promise<void>;
  resolve(input: { path: string; root?: string }): Promise<vscode.Uri>;
  document(uri: vscode.Uri): Promise<vscode.TextDocument>;
  position(doc: vscode.TextDocument, position: { line: number; column: number }): vscode.Position;
  tasks: TaskRuns;
}
const location = { path: z.string().min(1), root: z.string().optional() };
const coordinates = { line: z.number().int().min(1), column: z.number().int().min(1) };
const limit = z.number().int().min(1).max(200).default(100);
const range = (value: vscode.Range) => ({ start: { line: value.start.line + 1, column: value.start.character + 1 }, end: { line: value.end.line + 1, column: value.end.character + 1 } });

async function git(cwd: string, args: string[]): Promise<string> {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' };
  for (const key of Object.keys(env)) { if (key.startsWith('GIT_') && key !== 'GIT_TERMINAL_PROMPT' && key !== 'GIT_PAGER') { delete env[key as keyof typeof env]; } }
  return new Promise((resolve, reject) => {
    execFile('git', ['--no-pager', '--no-optional-locks', '--literal-pathspecs', '-c', 'core.fsmonitor=false', '-C', cwd, ...args], { env, windowsHide: true, timeout: 10_000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
      if (error) { reject(new ToolError('GIT_FAILED', 'Git query failed. Check Git installation, repository state, and the 2 MiB / 10 second query limit.')); }
      else { resolve(stdout); }
    });
  });
}

export function registerAdvanced(register: RegisterTool, access: AdvancedAccess): void {
  const repository = async (root?: string) => {
    const folder = await access.resolve({ path: '.', root });
    const top = (await git(folder.fsPath, ['rev-parse', '--show-toplevel'])).trim();
    const actualFolder = await canonicalPath(folder.fsPath);
    const actualTop = await canonicalPath(top);
    if ((process.platform === 'win32' ? actualFolder.toLowerCase() === actualTop.toLowerCase() : actualFolder === actualTop)) { return folder.fsPath; }
    return (await access.resolve({ path: top })).fsPath;
  };
  const output = (text: string) => ({ text: text.slice(0, 65536), truncated: text.length > 65536, source: 'git-on-disk', includesUnsavedChanges: false });
  const checkedRepository = async (root?: string) => {
    const cwd = await repository(root); await access.checkTree(vscode.Uri.file(cwd)); return cwd;
  };
  register('git_status', 'Read on-disk Git status. Repository root must be inside the workspace.', { root: z.string().optional() }, true, async args => output(await git(await checkedRepository(args.root), ['status', '--porcelain=v1', '--untracked-files=normal'])));
  register('git_diff', 'Read on-disk Git diff (no external diff drivers or textconv). Does not include dirty editor buffers.', { root: z.string().optional(), path: z.string().optional(), staged: z.boolean().default(false) }, true, async args => {
    const cwd = await repository(args.root);
    const target = args.path ? await access.resolve({ path: args.path, root: args.root }) : undefined;
    await access.checkTree(target ?? vscode.Uri.file(cwd));
    const relative = target ? path.relative(cwd, target.fsPath) : undefined;
    if (relative && (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))) { throw new ToolError('PATH_DENIED', 'File is outside this repository.'); }
    return output(await git(cwd, ['diff', '--no-ext-diff', '--no-textconv', ...(args.staged ? ['--cached'] : []), '--', ...(relative ? [relative] : [])]));
  });
  register('git_log', 'Read recent Git commits without making changes.', { root: z.string().optional(), limit: z.number().int().min(1).max(100).default(20) }, true, async args => output(await git(await checkedRepository(args.root), ['log', `-n${args.limit}`, '--format=%H%x09%aI%x09%an%x09%s'])));

  register('symbols_get', 'Get document symbols from installed language providers. Empty results may indicate no provider.', { ...location, limit }, true, async args => {
    const doc = await access.document(await access.resolve(args));
    const found = await vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>('vscode.executeDocumentSymbolProvider', doc.uri) ?? [];
    const symbols: Record<string, unknown>[] = [];
    let total = 0;
    const visit = async (items: (vscode.DocumentSymbol | vscode.SymbolInformation)[]) => {
      for (const item of items) {
        const uri = 'location' in item ? item.location.uri : doc.uri;
        try { await access.resolve({ path: uri.toString() }); } catch { continue; }
        total++;
        if (symbols.length < args.limit) { symbols.push({ name: item.name, kind: vscode.SymbolKind[item.kind], uri: uri.toString(), ...range('location' in item ? item.location.range : item.range) }); }
        if ('children' in item) { await visit(item.children); }
      }
    };
    await visit(found);
    return { symbols, total, truncated: total > args.limit, source: 'language-provider' };
  });
  for (const [name, command] of [['definitions_get', 'vscode.executeDefinitionProvider'], ['references_get', 'vscode.executeReferenceProvider']]) {
    register(name, 'Query language providers; only workspace locations are returned. Coordinates are 1-based UTF-16.', { ...location, ...coordinates, limit }, true, async args => {
      const doc = await access.document(await access.resolve(args));
      const found = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(command, doc.uri, access.position(doc, args)) ?? [];
      const locations: Record<string, unknown>[] = [];
      let total = 0;
      for (const item of found) {
        const uri = 'targetUri' in item ? item.targetUri : item.uri;
        try { await access.resolve({ path: uri.toString() }); } catch { continue; }
        total++;
        if (locations.length < args.limit) { locations.push({ uri: uri.toString(), ...range('targetUri' in item ? item.targetSelectionRange ?? item.targetRange : item.range) }); }
      }
      return { locations, total, truncated: total > args.limit, source: 'language-provider' };
    });
  }
  register('tasks_list', 'List existing local VS Code tasks. Only explicitly allowed task names can be executed.', {}, true, async () => {
    const configuration = vscode.workspace.getConfiguration('vscodeMcp');
    const allowed = configuration.get<string[]>('tasks.allowedNames', []);
    const tasks = await access.tasks.list();
    return { enabled: vscode.workspace.isTrusted && configuration.get<boolean>('tasks.enabled', false), tasks: tasks.slice(0, 200).map(task => ({ id: taskId(task), name: task.name, source: task.source, root: (task.scope as vscode.WorkspaceFolder).uri.toString(), allowed: allowed.includes(task.name), background: task.isBackground })), truncated: tasks.length > 200 };
  });
  register('task_run', 'Run an existing allowlisted VS Code task and return a runId immediately. Poll task_status for exit code.', { taskId: z.string().min(1).max(16384) }, false, args => access.tasks.start(args.taskId));
  register('task_status', 'Get the state and exit code of a task started by this MCP window. Output is available in the task terminal.', { runId: z.string().uuid() }, true, async args => access.tasks.status(args.runId));
  register('task_stop', 'Stop a task started through this MCP window.', { runId: z.string().uuid() }, false, async args => access.tasks.stop(args.runId));
}
