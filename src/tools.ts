import * as vscode from 'vscode';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { assertWorkspacePath, canonicalPath, hash, SerialQueue, ToolError } from './core';
import { registerAdvanced } from './advanced';
import { ChangeReviews, FileChange } from './review';
import { TaskRuns } from './tasks';
import type { CallRecord } from './history';

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TEXT = 64 * 1024;
const EXCLUDE = '**/{node_modules,.git,out,dist,.vscode-test}/**';
const locationSchema = {
  path: z.string().min(1).describe('Absolute local path, file URI, or path relative to a workspace root.'),
  root: z.string().optional().describe('Workspace root URI. Required for relative paths in multi-root workspaces.')
};
const positionSchema = z.object({ line: z.number().int().min(1), column: z.number().int().min(1) });
const expectedHashSchema = z.string().regex(/^[a-f0-9]{64}$/).describe('Full-document contentHash from file_read, even when reading a range.');

export class WorkspaceTools implements vscode.Disposable {
  readonly instanceId = randomUUID();
  private readonly writes = new SerialQueue();
  readonly reviews: ChangeReviews;
  readonly tasks: TaskRuns;
  constructor(private readonly log: (message: string) => void, private readonly record: (record: CallRecord) => void = () => undefined) {
    this.reviews = new ChangeReviews(changes => this.writes.run(async () => {
      const started = Date.now();
      try { const result = await this.applyChanges(changes); this.record({ tool: 'review_accept', target: changes.map(item => item.uri.fsPath).join(', '), code: 'OK', durationMs: Date.now() - started, time: new Date().toISOString() }); return result; }
      catch (error) { this.record({ tool: 'review_accept', code: error instanceof ToolError ? error.code : 'OPERATION_FAILED', durationMs: Date.now() - started, time: new Date().toISOString() }); throw error; }
    }));
    this.tasks = new TaskRuns((name, code, durationMs) => this.record({ tool: 'task_completed', target: name, code, durationMs, time: new Date().toISOString() }));
  }
  dispose(): void { this.reviews.dispose(); this.tasks.dispose(); }

  private validateText(text: string): void {
    if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES || text.includes('\0')) { throw new ToolError('INVALID_TEXT', 'Text must be non-binary and at most 1 MiB.'); }
  }

  private async prepareChange(args: { path: string; root?: string; text: string; create: boolean; expectedHash?: string; save: boolean }): Promise<FileChange> {
    this.allowWrite(); this.validateText(args.text);
    const uri = await this.resolve(args);
    if (args.create) {
      try { await vscode.workspace.fs.stat(uri); throw new ToolError('ALREADY_EXISTS', 'File already exists.'); }
      catch (error) { if (!(error instanceof vscode.FileSystemError) || error.code !== 'FileNotFound') { throw error; } }
      const parent = await vscode.workspace.fs.stat(vscode.Uri.file(path.dirname(uri.fsPath)));
      if (parent.type !== vscode.FileType.Directory) { throw new ToolError('NOT_A_DIRECTORY', 'Parent must be a directory.'); }
      return { uri, original: '', text: args.text, create: true, save: args.save };
    }
    if (!args.expectedHash) { throw new ToolError('HASH_REQUIRED', 'Read the file and supply expectedHash before replacing it.'); }
    const doc = await this.document(uri); this.checkHash(doc, args.expectedHash);
    return { uri, original: doc.getText(), text: args.text, expectedHash: args.expectedHash, save: args.save };
  }

  private async submitChanges(changes: FileChange[], preview = false, single = true): Promise<Record<string, unknown>> {
    this.allowWrite();
    if (preview || vscode.workspace.getConfiguration('vscodeMcp').get<boolean>('requireApproval', false)) { return this.reviews.submit(changes); }
    const result = await this.applyChanges(changes);
    return single ? { ...(result.files as Record<string, unknown>[])[0], ...(result.saveErrors ? { saveErrors: result.saveErrors } : {}) } : result;
  }

  private async applyChanges(changes: FileChange[]): Promise<Record<string, unknown>> {
    this.allowWrite();
    const validated: { change: FileChange; doc?: vscode.TextDocument }[] = [];
    const seen = new Set<string>();
    for (const change of changes) {
      const prepared = await this.prepareChange({ path: change.uri.toString(), text: change.text, create: change.create ?? false, expectedHash: change.expectedHash, save: change.save });
      const actualPath = await canonicalPath(prepared.uri.fsPath);
      const identity = process.platform === 'win32' ? actualPath.toLowerCase() : actualPath;
      if (seen.has(identity)) { throw new ToolError('DUPLICATE_PATH', 'Batch entries must refer to distinct files.'); }
      seen.add(identity);
      validated.push({ change: prepared, doc: prepared.create ? undefined : await this.document(prepared.uri) });
    }
    const edit = new vscode.WorkspaceEdit();
    for (const { change, doc } of validated) {
      if (doc) {
        this.checkHash(doc, change.expectedHash!);
        edit.replace(change.uri, new vscode.Range(0, 0, doc.lineCount - 1, doc.lineAt(doc.lineCount - 1).text.length), change.text);
      } else { edit.createFile(change.uri, { overwrite: false, ignoreIfExists: false }); edit.insert(change.uri, new vscode.Position(0, 0), change.text); }
    }
    this.allowWrite();
    if (!await vscode.workspace.applyEdit(edit)) { throw new ToolError('EDIT_FAILED', 'VS Code rejected the edit; inspect the files before retrying.'); }
    const files: Record<string, unknown>[] = [];
    const saveErrors: Record<string, unknown>[] = [];
    for (const { change } of validated) {
      const doc = await this.document(change.uri);
      if (change.save) {
        try { this.allowWrite(); await this.save(doc); } catch (error) { saveErrors.push({ uri: change.uri.toString(), message: error instanceof Error ? error.message : String(error) }); }
      }
      files.push({ ...this.snapshot(doc), saved: !doc.isDirty });
    }
    return { applied: true, files, ...(saveErrors.length ? { saveErrors } : {}) };
  }

  private roots(): vscode.WorkspaceFolder[] {
    return (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file');
  }

  private async resolve(input: { path: string; root?: string }): Promise<vscode.Uri> {
    const roots = this.roots();
    let target: string;
    if (input.path.startsWith('file:')) {
      const uri = vscode.Uri.parse(input.path, true);
      if (uri.authority) { throw new ToolError('PATH_DENIED', 'Network file URIs are not supported.'); }
      target = uri.fsPath;
    } else if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(input.path) && !/^[a-zA-Z]:[\\/]/.test(input.path)) {
      throw new ToolError('PATH_DENIED', 'Only local file URIs and filesystem paths are supported.');
    } else if (path.isAbsolute(input.path)) {
      target = input.path;
    } else {
      const root = input.root ? roots.find(folder => folder.uri.toString() === input.root) : roots.length === 1 ? roots[0] : undefined;
      if (!root) { throw new ToolError('ROOT_REQUIRED', 'Select a root URI from workspace_info.'); }
      target = path.resolve(root.uri.fsPath, input.path);
    }
    if (process.platform === 'win32' && (target.startsWith('\\\\') || target.slice(2).includes(':'))) {
      throw new ToolError('PATH_DENIED', 'Network paths and alternate data streams are not supported.');
    }
    await assertWorkspacePath(roots.map(folder => folder.uri.fsPath), target);
    return vscode.Uri.file(target);
  }

  private async document(uri: vscode.Uri): Promise<vscode.TextDocument> {
    const open = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri.toString() && !doc.isClosed);
    if (open) {
      if (Buffer.byteLength(open.getText(), 'utf8') > MAX_FILE_BYTES) { throw new ToolError('FILE_TOO_LARGE', 'Text files are limited to 1 MiB.'); }
      return open;
    }
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type !== vscode.FileType.File) { throw new ToolError('NOT_A_FILE', 'Expected an ordinary text file.'); }
    if (stat.size > MAX_FILE_BYTES) { throw new ToolError('FILE_TOO_LARGE', 'Text files are limited to 1 MiB.'); }
    const bytes = await vscode.workspace.fs.readFile(uri);
    if (bytes.includes(0)) { throw new ToolError('BINARY_FILE', 'Binary files are not supported.'); }
    const document = await vscode.workspace.openTextDocument(uri);
    if (Buffer.byteLength(document.getText(), 'utf8') > MAX_FILE_BYTES) { throw new ToolError('FILE_TOO_LARGE', 'Text files are limited to 1 MiB.'); }
    return document;
  }

  private snapshot(doc: vscode.TextDocument): Record<string, unknown> {
    return { uri: doc.uri.toString(), version: doc.version, contentHash: hash(doc.getText()), isDirty: doc.isDirty, languageId: doc.languageId, lineCount: doc.lineCount };
  }

  private allowWrite(): void {
    if (!vscode.workspace.isTrusted) { throw new ToolError('WORKSPACE_UNTRUSTED', 'Writes require a trusted workspace.'); }
    if (!vscode.workspace.getConfiguration('vscodeMcp').get<boolean>('allowWrites', true)) {
      throw new ToolError('WRITE_DISABLED', 'Writes are disabled in VSCode MCP settings.');
    }
  }

  private checkHash(doc: vscode.TextDocument, expected: string): void {
    if (hash(doc.getText()) !== expected) { throw new ToolError('VERSION_CONFLICT', 'Document changed. Read it again before modifying or saving.'); }
  }

  private position(doc: vscode.TextDocument, position: { line: number; column: number }): vscode.Position {
    if (position.line > doc.lineCount || position.column > doc.lineAt(position.line - 1).text.length + 1) {
      throw new ToolError('INVALID_RANGE', 'Position exceeds the document. Columns use UTF-16 code units.');
    }
    return new vscode.Position(position.line - 1, position.column - 1);
  }

  private async save(doc: vscode.TextDocument): Promise<void> {
    if (!await doc.save()) { throw new ToolError('SAVE_FAILED', 'Changes remain in the editor; saving failed.'); }
  }

  register(server: McpServer): void {
    const register = <S extends z.ZodRawShape>(name: string, description: string, schema: S, readOnly: boolean,
      handler: (args: z.infer<z.ZodObject<S>>) => Promise<Record<string, unknown>>) => {
      // Avoid the SDK's recursive v3/v4 schema union at this generic boundary.
      const registerTool = server.registerTool as unknown as (name: string, config: {
        description: string; inputSchema: z.ZodRawShape;
        annotations: { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean };
      }, callback: (args: Record<string, unknown>) => Promise<CallToolResult>) => unknown;
      registerTool.call(server, name, { description, inputSchema: schema, annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: false } }, async args => {
        const started = Date.now();
        try {
          const data = await handler(z.object(schema).parse(args));
          this.log(`${name} OK ${Date.now() - started}ms`);
          this.record({ tool: name, target: typeof args.path === 'string' ? args.path.slice(0, 500) : Array.isArray(args.files) ? args.files.map(item => String(item.path).slice(0, 200)).join(', ') : undefined, code: data.status === 'pending' ? 'PENDING_REVIEW' : data.saveErrors ? 'PARTIAL_SAVE' : 'OK', durationMs: Date.now() - started, time: new Date().toISOString() });
          return { content: [{ type: 'text' as const, text: JSON.stringify(data) }], structuredContent: data };
        } catch (error) {
          const code = error instanceof ToolError ? error.code : error instanceof vscode.FileSystemError ? error.code : 'OPERATION_FAILED';
          const data = { error: { code, message: error instanceof Error ? error.message : String(error) } };
          this.log(`${name} ${code} ${Date.now() - started}ms`);
          this.record({ tool: name, target: typeof args.path === 'string' ? args.path.slice(0, 500) : undefined, code, durationMs: Date.now() - started, time: new Date().toISOString() });
          return { content: [{ type: 'text' as const, text: JSON.stringify(data) }], structuredContent: data, isError: true };
        }
      });
    };

    register('workspace_info', 'Identify the connected VS Code window and its local workspace roots.', {}, true, async () => ({
      instanceId: this.instanceId, vscodeVersion: vscode.version, trusted: vscode.workspace.isTrusted,
      remoteName: vscode.env.remoteName ?? null,
      roots: this.roots().map(folder => ({ name: folder.name, uri: folder.uri.toString(), path: folder.uri.fsPath })),
      capabilities: { textFiles: true, debugging: false, writes: vscode.workspace.isTrusted && vscode.workspace.getConfiguration('vscodeMcp').get('allowWrites', true), remoteWorkspaces: false, changeReview: true, batchWrites: true, gitQueries: true, languageNavigation: true, taskExecution: vscode.workspace.isTrusted && vscode.workspace.getConfiguration('vscodeMcp').get('tasks.enabled', false), requireApproval: vscode.workspace.getConfiguration('vscodeMcp').get('requireApproval', false) },
      limits: { maxFileBytes: MAX_FILE_BYTES, maxReadCharacters: MAX_TEXT },
      coordinates: '1-based lines and UTF-16 columns; edit range ends are exclusive'
    }));

    register('files_list', 'List one directory, sorted with pagination. Symlinks are labelled; reading their targets is separately validated.', {
      ...locationSchema, offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(500).default(100)
    }, true, async args => {
      const uri = await this.resolve(args);
      const entries = (await vscode.workspace.fs.readDirectory(uri)).sort(([a], [b]) => a.localeCompare(b));
      return { uri: uri.toString(), entries: entries.slice(args.offset, args.offset + args.limit).map(([name, type]) => ({ name, uri: vscode.Uri.joinPath(uri, name).toString(), type: type & vscode.FileType.SymbolicLink ? 'symlink' : type & vscode.FileType.Directory ? 'directory' : 'file' })), total: entries.length, nextOffset: args.offset + args.limit < entries.length ? args.offset + args.limit : null };
    });

    register('file_read', 'Read current editor content, including unsaved changes. contentHash always covers the complete document. startLine/endLine are inclusive.', {
      ...locationSchema, startLine: z.number().int().min(1).default(1), endLine: z.number().int().min(1).optional(), maxCharacters: z.number().int().min(1).max(MAX_TEXT).default(MAX_TEXT)
    }, true, async args => {
      const doc = await this.document(await this.resolve(args));
      const end = args.endLine ?? doc.lineCount;
      if (args.startLine > end || end > doc.lineCount) { throw new ToolError('INVALID_RANGE', 'Line range exceeds the document.'); }
      const range = new vscode.Range(args.startLine - 1, 0, end - 1, doc.lineAt(end - 1).text.length);
      const text = doc.getText(range);
      return { ...this.snapshot(doc), source: 'editor', startLine: args.startLine, endLine: end, text: text.slice(0, args.maxCharacters), truncated: text.length > args.maxCharacters };
    });

    register('files_search', 'Search literal text in up to 200 matching workspace files and dirty documents. Uses case-sensitive matching by default. Always inspect truncated/scannedFiles/skippedFiles.', {
      query: z.string().min(1).max(1024).regex(/^[^\r\n]+$/, 'Search query must be a single line.'), glob: z.string().min(1).default('**/*'), root: z.string().optional(), caseSensitive: z.boolean().default(true), limit: z.number().int().min(1).max(200).default(50)
    }, true, async args => {
      const roots = this.roots().filter(folder => !args.root || folder.uri.toString() === args.root);
      if (!roots.length) { throw new ToolError('ROOT_REQUIRED', 'No matching local workspace root.'); }
      const files: vscode.Uri[] = [];
      let truncated = false;
      for (const root of roots) {
        const found = await vscode.workspace.findFiles(new vscode.RelativePattern(root, args.glob), EXCLUDE, 201);
        files.push(...found);
        if (files.length > 200) { truncated = true; break; }
      }
      const matches: Record<string, unknown>[] = [];
      let scannedFiles = 0;
      let skippedFiles = 0;
      const pattern = new RegExp(args.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), args.caseSensitive ? 'g' : 'gi');
      for (const uri of files.slice(0, 200)) {
        let doc: vscode.TextDocument;
        try { await this.resolve({ path: uri.toString() }); doc = await this.document(uri); }
        catch { skippedFiles++; continue; }
        scannedFiles++;
        for (let line = 0; line < doc.lineCount; line++) {
          const text = doc.lineAt(line).text;
          pattern.lastIndex = 0;
          for (;;) {
            const match = pattern.exec(text);
            if (!match) { break; }
            const column = match.index;
            if (matches.length >= args.limit) { truncated = true; break; }
            matches.push({ uri: uri.toString(), line: line + 1, column: column + 1, preview: text.slice(Math.max(0, column - 80), column + args.query.length + 160), isDirty: doc.isDirty });
          }
          if (matches.length >= args.limit) { truncated = true; break; }
        }
        if (matches.length >= args.limit) { break; }
      }
      return { matches, scannedFiles, skippedFiles, truncated, exclusions: EXCLUDE };
    });

    register('file_write', 'Create a text file (create=true) or replace an existing document (expectedHash required). Existing edits stay unsaved unless save=true. Creating a file creates an empty disk file before inserting content; parent directory must exist.', {
      ...locationSchema, text: z.string().max(MAX_FILE_BYTES), create: z.boolean().default(false), expectedHash: expectedHashSchema.optional(), save: z.boolean().default(false)
    }, false, args => this.writes.run(async () => {
      return this.submitChanges([await this.prepareChange(args)]);
    }));

    register('file_apply_edits', 'Apply non-overlapping edits to one file with conflict checking. Coordinates are 1-based UTF-16, end exclusive. Leaves changes unsaved unless save=true.', {
      ...locationSchema, expectedHash: expectedHashSchema,
      edits: z.array(z.object({ start: positionSchema, end: positionSchema, text: z.string().max(MAX_FILE_BYTES) })).min(1).max(100), save: z.boolean().default(false)
    }, false, args => this.writes.run(async () => {
      this.allowWrite();
      const doc = await this.document(await this.resolve(args));
      this.checkHash(doc, args.expectedHash);
      const edits = args.edits.map(edit => {
        const start = this.position(doc, edit.start);
        const end = this.position(doc, edit.end);
        if (end.isBefore(start)) { throw new ToolError('INVALID_RANGE', 'Edit end precedes start.'); }
        return { range: new vscode.Range(start, end), text: edit.text, start: doc.offsetAt(start), end: doc.offsetAt(end) };
      }).sort((a, b) => a.start - b.start);
      for (let i = 1; i < edits.length; i++) {
        if (edits[i].start < edits[i - 1].end || edits[i].start === edits[i - 1].start) { throw new ToolError('OVERLAPPING_EDITS', 'Edits overlap or share an insertion point.'); }
      }
      let result = doc.getText();
      for (const edit of [...edits].reverse()) { result = result.slice(0, edit.start) + edit.text + result.slice(edit.end); }
      if (Buffer.byteLength(result, 'utf8') > MAX_FILE_BYTES || result.includes('\0')) { throw new ToolError('INVALID_TEXT', 'Result must be non-binary and at most 1 MiB.'); }
      return this.submitChanges([{ uri: doc.uri, original: doc.getText(), text: result, expectedHash: args.expectedHash, save: args.save }]);
    }));

    register('file_save', 'Save one document only if expectedHash still matches. Save participants may format content; the returned hash reflects the result.', {
      ...locationSchema, expectedHash: expectedHashSchema
    }, false, args => this.writes.run(async () => {
      this.allowWrite();
      const doc = await this.document(await this.resolve(args));
      this.checkHash(doc, args.expectedHash);
      if (vscode.workspace.getConfiguration('vscodeMcp').get<boolean>('requireApproval', false)) {
        return this.reviews.submit([{ uri: doc.uri, original: doc.getText(), text: doc.getText(), expectedHash: args.expectedHash, save: true }]);
      }
      await this.save(doc);
      return { ...this.snapshot(doc), saved: !doc.isDirty };
    }));

    register('editor_context', 'Get active editor selection and workspace document metadata. Does not return document text.', {}, true, async () => {
      const documents: Record<string, unknown>[] = [];
      for (const doc of vscode.workspace.textDocuments) {
        try { await this.resolve({ path: doc.uri.toString() }); documents.push(this.snapshot(doc)); }
        catch { /* Hide documents outside the allowed workspace. */ }
      }
      const editor = vscode.window.activeTextEditor;
      let active: Record<string, unknown> | null = null;
      if (editor && documents.some(doc => doc.uri === editor.document.uri.toString())) {
        active = { uri: editor.document.uri.toString(), selections: editor.selections.map(selection => ({ start: { line: selection.start.line + 1, column: selection.start.character + 1 }, end: { line: selection.end.line + 1, column: selection.end.character + 1 } })) };
      }
      return { active, documents: documents.slice(0, 200), truncated: documents.length > 200 };
    });

    register('editor_open', 'Open a workspace text file and optionally select a position.', {
      ...locationSchema, line: z.number().int().min(1).default(1), column: z.number().int().min(1).default(1)
    }, false, async args => {
      const doc = await this.document(await this.resolve(args));
      const position = this.position(doc, { line: args.line, column: args.column });
      await vscode.window.showTextDocument(doc, { selection: new vscode.Range(position, position), preview: false });
      return { uri: doc.uri.toString(), line: args.line, column: args.column };
    });

    register('diagnostics_get', 'Get currently reported VS Code errors/warnings. Empty results do not guarantee language services have finished or are installed.', {
      path: z.string().optional(), root: z.string().optional(), limit: z.number().int().min(1).max(500).default(100)
    }, true, async args => {
      if (args.root && !this.roots().some(folder => folder.uri.toString() === args.root)) { throw new ToolError('ROOT_REQUIRED', 'No matching local workspace root.'); }
      const groups = args.path ? [[await this.resolve({ path: args.path, root: args.root }), []]] as [vscode.Uri, vscode.Diagnostic[]][] : vscode.languages.getDiagnostics();
      if (args.path) { groups[0][1] = vscode.languages.getDiagnostics(groups[0][0]); }
      const diagnostics: Record<string, unknown>[] = [];
      let total = 0;
      for (const [uri, items] of groups) {
        try { await this.resolve({ path: uri.toString() }); } catch { continue; }
        if (args.root && vscode.workspace.getWorkspaceFolder(uri)?.uri.toString() !== args.root) { continue; }
        for (const item of items) {
          total++;
          if (diagnostics.length >= args.limit) { continue; }
          diagnostics.push({ uri: uri.toString(), message: item.message.slice(0, 4096), severity: ['error', 'warning', 'information', 'hint'][item.severity], source: item.source ?? null,
            code: typeof item.code === 'object' ? item.code.value : item.code ?? null,
            start: { line: item.range.start.line + 1, column: item.range.start.character + 1 }, end: { line: item.range.end.line + 1, column: item.range.end.character + 1 } });
        }
      }
      return { diagnostics, total, truncated: total > args.limit, completeness: 'Current diagnostics only; language service readiness is not guaranteed.' };
    });
    const changeSchema = z.object({ ...locationSchema, text: z.string().max(MAX_FILE_BYTES), create: z.boolean().default(false), expectedHash: expectedHashSchema.optional(), save: z.boolean().default(false) });
    for (const [name, preview] of [['files_write', false], ['files_preview', true]] as const) {
      register(name, preview ? 'Submit up to 20 file replacements/creations for user review without modifying files. Query proposal_get for the result.' : 'Prevalidate up to 20 distinct file replacements/creations, then apply one WorkspaceEdit. Saves are per-file and may partially fail. May return a pending proposal when approval is enabled.', { files: z.array(changeSchema).min(1).max(20) }, false, args => this.writes.run(async () => {
        if (args.files.reduce((sum, item) => sum + Buffer.byteLength(item.text), 0) > 4 * MAX_FILE_BYTES) { throw new ToolError('BATCH_TOO_LARGE', 'Batch text is limited to 4 MiB.'); }
        const changes: FileChange[] = [];
        for (const file of args.files) { changes.push(await this.prepareChange(file)); }
        const paths = await Promise.all(changes.map(async item => { const actual = await canonicalPath(item.uri.fsPath); return process.platform === 'win32' ? actual.toLowerCase() : actual; }));
        if (new Set(paths).size !== paths.length) { throw new ToolError('DUPLICATE_PATH', 'Batch entries must refer to distinct files.'); }
        return this.submitChanges(changes, preview, false);
      }));
    }
    register('proposal_get', 'Get a user review proposal status: pending, applying, accepted, rejected, or failed.', { proposalId: z.string().uuid() }, true, async args => this.reviews.status(args.proposalId));
    registerAdvanced(register, { resolve: input => this.resolve(input), document: uri => this.document(uri), position: (doc, position) => this.position(doc, position), tasks: this.tasks });
  }
}
