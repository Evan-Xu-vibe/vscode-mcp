import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { hash, ToolError } from './core';
import type { RegisterTool } from './advanced';
import type { FileChange } from './review';

interface Access {
  resolve(input: { path: string; root?: string }): Promise<vscode.Uri>;
  document(uri: vscode.Uri): Promise<vscode.TextDocument>;
  position(doc: vscode.TextDocument, position: { line: number; column: number }): vscode.Position;
  allowWrite(): void;
  preview(changes: FileChange[]): Promise<Record<string, unknown>>;
}
const location = { path: z.string().min(1), root: z.string().optional() };
const expectedHash = z.string().regex(/^[a-f0-9]{64}$/);
const position = { line: z.number().int().min(1), column: z.number().int().min(1) };
interface Action { changes: FileChange[]; touched: number; }

export class CodeRefactors implements vscode.Disposable {
  private readonly actions = new Map<string, Action>();
  constructor(private readonly access: Access) {}
  private check(doc: vscode.TextDocument, expected: string): void {
    if (hash(doc.getText()) !== expected) { throw new ToolError('VERSION_CONFLICT', 'Document changed. Read again before requesting a refactor.'); }
  }
  private async changes(entries: [vscode.Uri, vscode.TextEdit[]][]): Promise<FileChange[]> {
    if (entries.length > 20) { throw new ToolError('BATCH_TOO_LARGE', 'Refactor preview is limited to 20 files.'); }
    const changes: FileChange[] = [];
    let totalBytes = 0;
    for (const [candidate, edits] of entries) {
      if (!edits.length) { continue; }
      if (edits.length > 1000) { throw new ToolError('BATCH_TOO_LARGE', 'Refactor preview is limited to 1000 edits per file.'); }
      const uri = await this.access.resolve({ path: candidate.toString() });
      const doc = await this.access.document(uri);
      const original = doc.getText();
      const ordered = edits.map(edit => {
        if (typeof edit.newText !== 'string' || !doc.validateRange(edit.range).isEqual(edit.range)) { throw new ToolError('UNSUPPORTED_EDIT', 'Only valid text edits to existing workspace files are supported.'); }
        return { start: doc.offsetAt(edit.range.start), end: doc.offsetAt(edit.range.end), text: edit.newText };
      }).sort((a, b) => a.start - b.start);
      for (let index = 1; index < ordered.length; index++) {
        if (ordered[index].start < ordered[index - 1].end || ordered[index].start === ordered[index - 1].start) { throw new ToolError('OVERLAPPING_EDITS', 'Language provider returned overlapping text edits.'); }
      }
      let text = original;
      for (const edit of [...ordered].reverse()) { text = text.slice(0, edit.start) + edit.text + text.slice(edit.end); }
      totalBytes += Buffer.byteLength(text) + Buffer.byteLength(original);
      if (Buffer.byteLength(text) > 1024 * 1024 || text.includes('\0') || totalBytes > 8 * 1024 * 1024) { throw new ToolError('BATCH_TOO_LARGE', 'Refactor texts exceed preview limits.'); }
      if (text !== original) { changes.push({ uri, original, text, expectedHash: hash(original), save: false }); }
    }
    return changes;
  }
  private async preview(changes: FileChange[]): Promise<Record<string, unknown>> {
    this.access.allowWrite();
    if (!changes.length) { return { changed: false, reason: 'Language provider returned no text changes.' }; }
    for (const change of changes) { this.check(await this.access.document(await this.access.resolve({ path: change.uri.toString() })), change.expectedHash!); }
    return { ...await this.access.preview(changes), providerTextEditsOnly: true };
  }
  register(register: RegisterTool): void {
    register('file_format', 'Ask the installed formatter for edits and submit a preview. Always requires user acceptance; does not save.', { ...location, expectedHash, tabSize: z.number().int().min(1).max(16).optional(), insertSpaces: z.boolean().optional() }, false, async args => {
      this.access.allowWrite();
      const doc = await this.access.document(await this.access.resolve(args)); this.check(doc, args.expectedHash);
      const config = vscode.workspace.getConfiguration('editor', doc.uri);
      const size = config.get<number | string>('tabSize', 4);
      const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>('vscode.executeFormatDocumentProvider', doc.uri, { tabSize: args.tabSize ?? (typeof size === 'number' ? size : 4), insertSpaces: args.insertSpaces ?? config.get<boolean>('insertSpaces', true) }) ?? [];
      this.check(doc, args.expectedHash);
      return this.preview(await this.changes([[doc.uri, edits]]));
    });
    register('symbol_rename', 'Ask language services to rename a symbol across existing workspace text files and submit a preview. Always requires user acceptance.', { ...location, ...position, newName: z.string().min(1).max(256), expectedHash }, false, async args => {
      this.access.allowWrite();
      const doc = await this.access.document(await this.access.resolve(args)); this.check(doc, args.expectedHash);
      const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit | undefined>('vscode.executeDocumentRenameProvider', doc.uri, this.access.position(doc, args), args.newName);
      this.check(doc, args.expectedHash);
      return this.preview(await this.changes(edit?.entries() ?? []));
    });
    register('code_actions_get', 'Query quick fixes or refactors for a range. Returns IDs for previewable text-only actions. Commands are never executed.', { ...location, ...position, endLine: z.number().int().min(1).optional(), endColumn: z.number().int().min(1).optional(), expectedHash, kind: z.string().min(1).default('quickfix'), limit: z.number().int().min(1).max(50).default(20) }, true, async args => {
      const doc = await this.access.document(await this.access.resolve(args)); this.check(doc, args.expectedHash);
      const start = this.access.position(doc, args);
      const end = this.access.position(doc, { line: args.endLine ?? args.line, column: args.endColumn ?? args.column });
      if (end.isBefore(start)) { throw new ToolError('INVALID_RANGE', 'Range end precedes start.'); }
      for (const [id, action] of this.actions) { if (Date.now() - action.touched > 5 * 60_000) { this.actions.delete(id); } }
      const found = await vscode.commands.executeCommand<(vscode.CodeAction | vscode.Command)[]>('vscode.executeCodeActionProvider', doc.uri, new vscode.Range(start, end), args.kind, args.limit) ?? [];
      this.check(doc, args.expectedHash);
      const actions: Record<string, unknown>[] = [];
      for (const item of found.slice(0, args.limit)) {
        let changes: FileChange[] | undefined; let reason: string | undefined;
        if (!('edit' in item) || !item.edit || item.command || item.disabled) { reason = 'Only enabled text-edit actions without commands can be previewed.'; }
        else {
          try { changes = await this.changes(item.edit.entries()); if (!changes.length) { reason = 'No text edits to existing files.'; } }
          catch (error) { reason = error instanceof Error ? error.message : String(error); }
        }
        let id: string | undefined;
        if (changes?.length && !reason) {
          const bytes = (values: FileChange[]) => values.reduce((sum, change) => sum + Buffer.byteLength(change.original) + Buffer.byteLength(change.text), 0);
          let used = [...this.actions.values()].reduce((sum, action) => sum + bytes(action.changes), 0);
          for (const [previous, action] of this.actions) { if (this.actions.size < 100 && used + bytes(changes) <= 10 * 1024 * 1024) { break; } used -= bytes(action.changes); this.actions.delete(previous); }
          id = randomUUID(); this.actions.set(id, { changes, touched: Date.now() });
        }
        actions.push({ id: id ?? null, title: item.title, kind: 'kind' in item ? item.kind?.value ?? null : null, previewable: !!id, reason: reason ?? null });
      }
      return { actions, truncated: found.length > args.limit, providerTextEditsOnly: true };
    });
    register('code_action_preview', 'Submit a previously listed quick fix for user review, checking all captured file hashes again. IDs expire after five minutes.', { actionId: z.string().uuid() }, false, async args => {
      const action = this.actions.get(args.actionId);
      if (!action || Date.now() - action.touched > 5 * 60_000) { this.actions.delete(args.actionId); throw new ToolError('ACTION_EXPIRED', 'Action expired. Query code actions again.'); }
      const result = await this.preview(action.changes); this.actions.delete(args.actionId); return result;
    });
  }
  dispose(): void { this.actions.clear(); }
}
