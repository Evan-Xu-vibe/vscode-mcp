import * as vscode from 'vscode';
import * as path from 'node:path';
import { lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { canonicalPath, contains, hash, ToolError } from './core';
import type { RegisterTool } from './advanced';
import { z } from 'zod';

export interface ResourceChange {
  kind: 'resource'; operation: 'mkdir' | 'move' | 'delete'; uri: vscode.Uri; target?: vscode.Uri;
  fingerprint: string; recursive: boolean; original: string; text: string; save: false;
}
interface Access {
  resolve(input: { path: string; root?: string }): Promise<vscode.Uri>;
  allowWrite(): void;
  submit(change: ResourceChange, preview: boolean): Promise<Record<string, unknown>>;
}
const location = { path: z.string().min(1), root: z.string().optional() };
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);

export class FileResources {
  constructor(private readonly access: Access) {}
  private async checked(uri: vscode.Uri): Promise<void> {
    await this.access.resolve({ path: uri.toString() });
    const roots = vscode.workspace.workspaceFolders ?? [];
    for (const root of roots) {
      if (root.uri.scheme !== 'file') { continue; }
      const relative = path.relative(root.uri.fsPath, uri.fsPath);
      if (contains(root.uri.fsPath, uri.fsPath) && (!relative || relative.split(path.sep).some(part => part.toLowerCase() === '.git'))) {
        throw new ToolError('PROTECTED_PATH', 'Workspace roots and Git metadata cannot be managed with resource tools.');
      }
    }
    const actual = await canonicalPath(uri.fsPath);
    for (const root of roots.filter(item => item.uri.scheme === 'file')) {
      const actualRoot = await canonicalPath(root.uri.fsPath);
      const relative = path.relative(actualRoot, actual);
      if (contains(actualRoot, actual) && (!relative || relative.split(path.sep).some(part => part.toLowerCase() === '.git'))) { throw new ToolError('PROTECTED_PATH', 'Workspace roots and Git metadata are protected.'); }
    }
  }
  private async hasDirty(uri: vscode.Uri): Promise<boolean> {
    const actual = await canonicalPath(uri.fsPath);
    for (const doc of vscode.workspace.textDocuments.filter(item => item.isDirty && item.uri.scheme === 'file')) {
      if (contains(actual, await canonicalPath(doc.uri.fsPath))) { return true; }
    }
    return false;
  }
  private async dirty(uri: vscode.Uri): Promise<void> {
    if (await this.hasDirty(uri)) { throw new ToolError('DIRTY_DOCUMENT', 'Save or discard unsaved documents before moving or deleting this resource.'); }
  }
  async inspect(uri: vscode.Uri): Promise<Record<string, unknown>> {
    await this.checked(uri);
    const entries: { path: string; type: string; bytes?: number; hash?: string }[] = [];
    let bytes = 0;
    const walk = async (current: vscode.Uri): Promise<void> => {
      await this.checked(current);
      if ((await lstat(current.fsPath)).isSymbolicLink()) { throw new ToolError('SYMLINK_UNSUPPORTED', 'Resource operations do not follow symlinks or junctions.'); }
      if (entries.length >= 1000) { throw new ToolError('RESOURCE_TOO_LARGE', 'Resource snapshots are limited to 1000 entries and 16 MiB.'); }
      const stat = await vscode.workspace.fs.stat(current);
      const relative = path.relative(uri.fsPath, current.fsPath).split(path.sep).join('/') || '.';
      if (stat.type === vscode.FileType.Directory) {
        entries.push({ path: relative, type: 'directory' });
        const children = (await vscode.workspace.fs.readDirectory(current)).sort(([a], [b]) => a.localeCompare(b));
        for (const [name] of children) { await walk(vscode.Uri.joinPath(current, name)); }
      } else if (stat.type === vscode.FileType.File) {
        bytes += stat.size;
        if (bytes > 16 * 1024 * 1024) { throw new ToolError('RESOURCE_TOO_LARGE', 'Resource snapshots are limited to 16 MiB.'); }
        const data = await vscode.workspace.fs.readFile(current);
        bytes += data.byteLength - stat.size;
        if (bytes > 16 * 1024 * 1024) { throw new ToolError('RESOURCE_TOO_LARGE', 'Resource snapshots are limited to 16 MiB.'); }
        entries.push({ path: relative, type: 'file', bytes: data.byteLength, hash: createHash('sha256').update(data).digest('hex') });
      } else { throw new ToolError('NOT_A_FILE', 'Only ordinary files and directories are supported.'); }
    };
    await walk(uri);
    return { uri: uri.toString(), type: entries[0].type, fingerprint: hash(JSON.stringify(entries)), entries, bytes, dirty: await this.hasDirty(uri) };
  }
  private async absent(uri: vscode.Uri): Promise<void> {
    await this.checked(uri);
    try { await vscode.workspace.fs.stat(uri); throw new ToolError('ALREADY_EXISTS', 'Destination already exists.'); }
    catch (error) { if (!(error instanceof vscode.FileSystemError) || error.code !== 'FileNotFound') { throw error; } }
  }
  async apply(change: ResourceChange): Promise<Record<string, unknown>> {
    this.access.allowWrite();
    await this.checked(change.uri);
    if (change.operation === 'mkdir') {
      await this.absent(change.uri);
      const parent = await vscode.workspace.fs.stat(vscode.Uri.file(path.dirname(change.uri.fsPath)));
      if (parent.type !== vscode.FileType.Directory) { throw new ToolError('NOT_A_DIRECTORY', 'Parent directory must exist.'); }
      this.access.allowWrite();
      await vscode.workspace.fs.createDirectory(change.uri);
      return { applied: true, operation: 'mkdir', uri: change.uri.toString() };
    }
    await this.dirty(change.uri);
    const snapshot = await this.inspect(change.uri);
    if (snapshot.fingerprint !== change.fingerprint) { throw new ToolError('VERSION_CONFLICT', 'Resource changed. Inspect it again before moving or deleting.'); }
    const edit = new vscode.WorkspaceEdit();
    if (change.operation === 'move') {
      const target = change.target!;
      await this.absent(target);
      if (contains(change.uri.fsPath, target.fsPath)) { throw new ToolError('INVALID_DESTINATION', 'Destination cannot be inside the source.'); }
      const parent = await vscode.workspace.fs.stat(vscode.Uri.file(path.dirname(target.fsPath)));
      if (parent.type !== vscode.FileType.Directory) { throw new ToolError('NOT_A_DIRECTORY', 'Destination parent must exist.'); }
      edit.renameFile(change.uri, target, { overwrite: false, ignoreIfExists: false });
    } else {
      if (snapshot.type === 'directory' && (snapshot.entries as unknown[]).length > 1 && !change.recursive) { throw new ToolError('DIRECTORY_NOT_EMPTY', 'Use recursive=true to delete a nonempty directory.'); }
      edit.deleteFile(change.uri, { recursive: change.recursive, ignoreIfNotExists: false });
    }
    await this.dirty(change.uri);
    if (change.target) { await this.absent(change.target); }
    const finalSnapshot = await this.inspect(change.uri);
    if (finalSnapshot.dirty) { throw new ToolError('DIRTY_DOCUMENT', 'Document became dirty while preparing the operation.'); }
    if (finalSnapshot.fingerprint !== change.fingerprint) { throw new ToolError('VERSION_CONFLICT', 'Resource changed while preparing the operation.'); }
    this.access.allowWrite();
    if (change.operation === 'delete' && finalSnapshot.type === 'directory') {
      // Bulk text edits try to capture a directory as a file for undo; use the directory API.
      await vscode.workspace.fs.delete(change.uri, { recursive: change.recursive });
    } else if (!await vscode.workspace.applyEdit(edit)) { throw new ToolError('EDIT_FAILED', 'VS Code rejected the resource operation.'); }
    return { applied: true, operation: change.operation, uri: change.uri.toString(), ...(change.target ? { target: change.target.toString() } : {}) };
  }
  register(register: RegisterTool): void {
    register('resource_info', 'Inspect a file or directory (binary files supported) and obtain a fingerprint for move/delete. Workspace roots, Git metadata, symlinks, and oversized trees are excluded.', location, true, async args => this.inspect(await this.access.resolve(args)));
    register('directory_create', 'Create one directory under an existing parent. May return a review proposal.', { ...location, preview: z.boolean().default(false) }, false, async args => {
      this.access.allowWrite(); const uri = await this.access.resolve(args); await this.absent(uri);
      const parent = await vscode.workspace.fs.stat(vscode.Uri.file(path.dirname(uri.fsPath)));
      if (parent.type !== vscode.FileType.Directory) { throw new ToolError('NOT_A_DIRECTORY', 'Parent directory must exist.'); }
      return this.access.submit({ kind: 'resource', operation: 'mkdir', uri, fingerprint: '', recursive: false, original: '目录不存在。', text: `创建目录：${uri.fsPath}`, save: false }, args.preview);
    });
    for (const operation of ['move', 'delete'] as const) {
      const schema = { ...location, expectedFingerprint: fingerprint, target: z.string().min(1).optional(), recursive: z.boolean().default(false), preview: z.boolean().default(false) };
      register(operation === 'move' ? 'resource_move' : 'resource_delete', operation === 'move' ? 'Move/rename one file or directory without overwriting. Requires fingerprint from resource_info.' : 'Delete one file or directory. Nonempty directories require recursive=true. Requires resource_info fingerprint.', schema, false, async args => {
        this.access.allowWrite(); const uri = await this.access.resolve(args); await this.dirty(uri);
        const snapshot = await this.inspect(uri);
        if (snapshot.fingerprint !== args.expectedFingerprint) { throw new ToolError('VERSION_CONFLICT', 'Resource changed since inspection.'); }
        let target: vscode.Uri | undefined;
        if (operation === 'move') {
          if (!args.target) { throw new ToolError('TARGET_REQUIRED', 'Moving requires a destination path.'); }
          target = await this.access.resolve({ path: args.target, root: args.root }); await this.absent(target);
          if (contains(uri.fsPath, target.fsPath)) { throw new ToolError('INVALID_DESTINATION', 'Destination cannot be inside the source.'); }
          const parent = await vscode.workspace.fs.stat(vscode.Uri.file(path.dirname(target.fsPath)));
          if (parent.type !== vscode.FileType.Directory) { throw new ToolError('NOT_A_DIRECTORY', 'Destination parent must exist.'); }
        } else if (snapshot.type === 'directory' && (snapshot.entries as unknown[]).length > 1 && !args.recursive) { throw new ToolError('DIRECTORY_NOT_EMPTY', 'Use recursive=true for nonempty directories.'); }
        return this.access.submit({ kind: 'resource', operation, uri, target, fingerprint: args.expectedFingerprint, recursive: args.recursive, original: JSON.stringify(snapshot, null, 2), text: operation === 'move' ? `移动：${uri.fsPath}\n到：${target!.fsPath}` : `删除：${uri.fsPath}${args.recursive ? '\n包括全部子项' : ''}`, save: false }, args.preview);
      });
    }
  }
}
