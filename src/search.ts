import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import { hash, ToolError } from './core';
import type { RegisterTool } from './advanced';

interface Session { files: vscode.Uri[]; index: number; line: number; column: number; documentHash?: string; query: string; regex: boolean; caseSensitive: boolean; limit: number; discoveryTruncated: boolean; touched: number; exclusions: string[]; }
interface ScanResult { matches: { line: number; column: number; length: number; preview: string }[]; line: number; column: number; complete: boolean; }
const workerCode = `
const { parentPort } = require('node:worker_threads');
parentPort.on('message', input => {
  const pattern = new RegExp(input.query, input.caseSensitive ? 'g' : 'gi');
  const lines = input.text.split(/\\r?\\n/);
  const matches = [];
  for (let line = input.line; line < lines.length; line++) {
    const text = lines[line];
    let offset = line === input.line ? input.column : 0;
    for (;;) {
      pattern.lastIndex = offset; const match = pattern.exec(text);
      if (!match) break;
      const next = match.index + Math.max(match[0].length, 1);
      matches.push({ line: line + 1, column: match.index + 1, length: match[0].length, preview: text.slice(Math.max(0, match.index - 80), match.index + 240) });
      offset = next;
      if (matches.length >= input.limit) { parentPort.postMessage({ matches, line, column: next, complete: false }); return; }
      if (next > text.length) break;
    }
  }
  parentPort.postMessage({ matches, line: lines.length, column: 0, complete: true });
});`;

export class FileSearch implements vscode.Disposable {
  private readonly sessions = new Map<string, Session>();
  private readonly workers = new Set<Worker>();
  private operations = 0;
  constructor(private readonly resolve: (input: { path: string; root?: string }) => Promise<vscode.Uri>, private readonly document: (uri: vscode.Uri) => Promise<vscode.TextDocument>) {}
  register(register: RegisterTool): void {
    register('files_search', 'Search literal text or per-line regex, including dirty buffers. Continue with nextCursor (five minute expiry). Each page scans at most 200 files / 16 MiB / five seconds; inspect nextCursor and discoveryTruncated.', {
      query: z.string().min(1).max(1024).regex(/^[^\r\n]+$/).optional(), cursor: z.string().uuid().optional(), regex: z.boolean().default(false), glob: z.string().min(1).default('**/*'), root: z.string().optional(), exclude: z.array(z.string().min(1).max(1024)).max(50).optional(), caseSensitive: z.boolean().default(true), limit: z.number().int().min(1).max(200).default(50)
    }, true, async args => {
      if (this.operations >= 10) { throw new ToolError('SEARCH_LIMIT', 'At most 10 searches may be processed concurrently.'); }
      this.operations++;
      try {
      for (const [cursor, session] of this.sessions) { if (Date.now() - session.touched > 5 * 60_000) { this.sessions.delete(cursor); } }
      let session: Session;
      if (args.cursor) {
        const found = this.sessions.get(args.cursor);
        if (!found) { throw new ToolError('SEARCH_CURSOR_EXPIRED', 'Cursor expired or was already used. Restart the search.'); }
        session = found; this.sessions.delete(args.cursor);
      } else {
        if (!args.query) { throw new ToolError('QUERY_REQUIRED', 'Provide query for a new search, or cursor to continue.'); }
        if (args.regex) { try { new RegExp(args.query); } catch { throw new ToolError('INVALID_REGEX', 'Regular expression is invalid.'); } }
        if (this.sessions.size + this.operations > 10) { throw new ToolError('SEARCH_LIMIT', 'At most 10 paginated searches may be retained or processed. Continue an existing search or wait for expiry.'); }
        const roots = (vscode.workspace.workspaceFolders ?? []).filter(root => root.uri.scheme === 'file' && (!args.root || root.uri.toString() === args.root));
        if (!roots.length) { throw new ToolError('ROOT_REQUIRED', 'No matching local workspace root.'); }
        const config = vscode.workspace.getConfiguration('vscodeMcp');
        const exclusions = [...new Set(['**/.git/**', ...(args.exclude ?? config.get<string[]>('search.exclude', ['**/{node_modules,out,dist,.vscode-test}/**']))])];
        const maximum = config.get<number>('search.maxFiles', 10000);
        const files = new Map<string, vscode.Uri>();
        let discoveryTruncated = false;
        const exclusionGlob = exclusions.length === 1 ? exclusions[0] : `{${exclusions.join(',')}}`;
        for (const root of roots) {
          const found = await vscode.workspace.findFiles(new vscode.RelativePattern(root, args.glob), exclusionGlob, maximum + 1);
          for (const uri of found) { files.set(uri.toString(), uri); }
          if (files.size > maximum) { discoveryTruncated = true; break; }
        }
        session = { files: [...files.values()].sort((a, b) => a.toString().localeCompare(b.toString())).slice(0, maximum), index: 0, line: 0, column: 0, query: args.query, regex: args.regex, caseSensitive: args.caseSensitive, limit: args.limit, discoveryTruncated, touched: Date.now(), exclusions };
      }
      const worker = new Worker(workerCode, { eval: true }); this.workers.add(worker);
      const matches: Record<string, unknown>[] = [];
      let scannedFiles = 0; let skippedFiles = 0; let scannedBytes = 0;
      const started = Date.now();
      try {
        while (session.index < session.files.length && matches.length < session.limit && scannedFiles + skippedFiles < 200 && scannedBytes < 16 * 1024 * 1024 && Date.now() - started < 5000) {
          const uri = session.files[session.index];
          let doc: vscode.TextDocument;
          try { await this.resolve({ path: uri.toString() }); doc = await this.document(uri); }
          catch { skippedFiles++; session.index++; session.line = 0; session.column = 0; session.documentHash = undefined; continue; }
          const text = doc.getText(); const contentHash = hash(text);
          if (session.documentHash && session.documentHash !== contentHash) { throw new ToolError('SEARCH_CHANGED', 'The current paginated file changed. Restart the search.'); }
          scannedFiles++; scannedBytes += Buffer.byteLength(text);
          const result = await new Promise<ScanResult>((resolve, reject) => {
            const timer = setTimeout(() => { cleanup(); reject(new ToolError('REGEX_TIMEOUT', 'Search pattern exceeded 500ms for one file. Simplify the pattern.')); }, 500);
            const done = (value: ScanResult) => { cleanup(); resolve(value); };
            const failed = () => { cleanup(); reject(new ToolError('SEARCH_FAILED', 'Search worker failed.')); };
            const cleanup = () => { clearTimeout(timer); worker.removeListener('message', done); worker.removeListener('error', failed); worker.removeListener('exit', failed); };
            worker.once('message', done); worker.once('error', failed); worker.once('exit', failed);
            worker.postMessage({ text, query: session.regex ? session.query : session.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive: session.caseSensitive, line: session.line, column: session.column, limit: session.limit - matches.length });
          });
          matches.push(...result.matches.map(item => ({ uri: uri.toString(), ...item, isDirty: doc.isDirty, contentHash })));
          if (result.complete) { session.index++; session.line = 0; session.column = 0; session.documentHash = undefined; }
          else { session.line = result.line; session.column = result.column; session.documentHash = contentHash; }
        }
      } finally { this.workers.delete(worker); await worker.terminate(); }
      let nextCursor: string | null = null;
      if (session.index < session.files.length) { nextCursor = randomUUID(); session.touched = Date.now(); this.sessions.set(nextCursor, session); }
      return { matches, scannedFiles, skippedFiles, scannedBytes, nextCursor, discoveryTruncated: session.discoveryTruncated, truncated: !!nextCursor || session.discoveryTruncated, candidateFiles: session.files.length, completedFiles: session.index, exclusions: session.exclusions };
      } finally { this.operations--; }
    });
  }
  dispose(): void { this.sessions.clear(); for (const worker of this.workers) { void worker.terminate(); } this.workers.clear(); }
}
