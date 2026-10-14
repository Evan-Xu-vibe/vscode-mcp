import * as vscode from 'vscode';
import { z } from 'zod';
import { ToolError } from './core';
import type { RegisterTool } from './advanced';

interface LanguageAccess {
  resolve(input: { path: string; root?: string }): Promise<vscode.Uri>;
  document(uri: vscode.Uri): Promise<vscode.TextDocument>;
  position(doc: vscode.TextDocument, position: { line: number; column: number }): vscode.Position;
}
const location = { path: z.string().min(1), root: z.string().optional() };
const point = { ...location, line: z.number().int().min(1), column: z.number().int().min(1) };
const limit = z.number().int().min(1).max(200).default(50);
const range = (value: vscode.Range) => ({ start: { line: value.start.line + 1, column: value.start.character + 1 }, end: { line: value.end.line + 1, column: value.end.character + 1 } });
const text = (value: vscode.MarkedString | vscode.MarkdownString | undefined): string => typeof value === 'string' ? value : value?.value ?? '';

export function registerLanguage(register: RegisterTool, access: LanguageAccess): void {
  const query = async <T>(command: string, args: { path: string; root?: string; line: number; column: number }, ...extra: unknown[]): Promise<T | undefined> => {
    const doc = await access.document(await access.resolve(args)); const version = doc.version;
    const pending = vscode.commands.executeCommand<T>(command, doc.uri, access.position(doc, args), ...extra);
    const value = await timed(pending);
    if (doc.version !== version) { throw new ToolError('VERSION_CONFLICT', 'Document changed during the language query; retry at the current position.'); }
    return value;
  };
  const permitted = async (uri: vscode.Uri) => { try { await access.resolve({ path: uri.toString() }); return true; } catch { return false; } };
  const item = (value: vscode.CallHierarchyItem) => ({ name: value.name.slice(0, 1024), kind: vscode.SymbolKind[value.kind], detail: value.detail?.slice(0, 4096) ?? null, uri: value.uri.toString(), ...range(value.selectionRange) });
  register('hover_get', 'Read language-provider hover text at a position. Markdown is returned as plain data, never executed.', { ...point, limit }, true, async args => {
    const found = await query<vscode.Hover[]>('vscode.executeHoverProvider', args) ?? [];
    let remaining = 65536;
    const hovers = found.slice(0, args.limit).map(hover => {
      const content = hover.contents.map(value => text(value)).join('\n\n'); const value = content.slice(0, remaining); remaining -= value.length;
      return { text: value, truncated: value.length < content.length, range: hover.range ? range(hover.range) : null };
    });
    return { hovers, truncated: found.length > args.limit || hovers.some(value => value.truncated), source: 'language-provider' };
  });
  register('completions_get', 'Read completion suggestions without applying edits or executing completion commands. Snippets remain snippet text.', {
    ...point, limit, triggerCharacter: z.string().length(1).optional()
  }, true, async args => {
    const found = await query<vscode.CompletionList>('vscode.executeCompletionItemProvider', args, args.triggerCharacter, 0);
    return { items: (found?.items ?? []).slice(0, args.limit).map(value => ({ label: (typeof value.label === 'string' ? value.label : value.label.label).slice(0, 1024), kind: value.kind === undefined ? null : vscode.CompletionItemKind[value.kind],
      detail: value.detail?.slice(0, 2048) ?? null, documentation: text(value.documentation).slice(0, 2048), insertText: (typeof value.insertText === 'string' ? value.insertText : value.insertText?.value ?? null)?.slice(0, 4096) ?? null,
      snippet: value.insertText instanceof vscode.SnippetString })), isIncomplete: found?.isIncomplete ?? false, truncated: (found?.items.length ?? 0) > args.limit, source: 'language-provider' };
  });
  register('signature_help_get', 'Read function signatures and active parameter from the installed language provider.', { ...point, limit, triggerCharacter: z.string().length(1).optional() }, true, async args => {
    const found = await query<vscode.SignatureHelp>('vscode.executeSignatureHelpProvider', args, args.triggerCharacter);
    const cap = Math.min(args.limit, 20);
    return { signatures: (found?.signatures ?? []).slice(0, cap).map(value => ({ label: value.label.slice(0, 4096), documentation: text(value.documentation).slice(0, 2048), activeParameter: value.activeParameter ?? null,
      parameters: value.parameters.slice(0, 40).map(parameter => ({ label: typeof parameter.label === 'string' ? parameter.label.slice(0, 1024) : parameter.label, documentation: text(parameter.documentation).slice(0, 512) })), parametersTruncated: value.parameters.length > 40 })), activeSignature: found?.activeSignature ?? null, activeParameter: found?.activeParameter ?? null, truncated: (found?.signatures.length ?? 0) > cap, source: 'language-provider' };
  });
  for (const [name, command] of [['type_definitions_get', 'vscode.executeTypeDefinitionProvider'], ['implementations_get', 'vscode.executeImplementationProvider']]) {
    register(name, 'Query language providers for workspace locations. Coordinates are 1-based UTF-16.', { ...point, limit }, true, async args => {
      const found = await query<(vscode.Location | vscode.LocationLink)[]>(command, args) ?? []; const locations: Record<string, unknown>[] = [];
      let total = 0;
      for (const value of found) {
        const uri = 'targetUri' in value ? value.targetUri : value.uri;
        if (!await permitted(uri)) { continue; } total++;
        if (locations.length < args.limit) { locations.push({ uri: uri.toString(), ...range('targetUri' in value ? value.targetSelectionRange ?? value.targetRange : value.range) }); }
      }
      return { locations, total, truncated: total > args.limit, source: 'language-provider' };
    });
  }
  register('workspace_symbols_get', 'Search workspace symbols through installed language providers. Only workspace locations are returned.', { query: z.string().min(1).max(1024), limit }, true, async args => {
    const found = await timed(vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', args.query)) ?? [];
    const symbols: Record<string, unknown>[] = []; let total = 0;
    for (const value of found) {
      if (!await permitted(value.location.uri)) { continue; } total++;
      if (symbols.length < args.limit) { symbols.push({ name: value.name.slice(0, 1024), kind: vscode.SymbolKind[value.kind], containerName: value.containerName.slice(0, 1024), uri: value.location.uri.toString(), ...range(value.location.range) }); }
    }
    return { symbols, total, truncated: total > args.limit, source: 'language-provider' };
  });
  register('call_hierarchy_get', 'Query incoming or outgoing calls at a code position. Only workspace items and call ranges are returned.', { ...point, direction: z.enum(['incoming', 'outgoing']).default('incoming'), itemIndex: z.number().int().min(0).max(199).default(0), limit }, true, async args => {
    const prepared = await query<vscode.CallHierarchyItem[]>('vscode.prepareCallHierarchy', args) ?? [];
    const choices: vscode.CallHierarchyItem[] = [];
    for (const value of prepared.slice(0, 200)) { if (await permitted(value.uri)) { choices.push(value); } }
    if (!choices.length) { return { items: [], calls: [], source: 'language-provider' }; }
    const selected = choices[args.itemIndex];
    if (!selected) { throw new ToolError('INVALID_RANGE', 'itemIndex exceeds the prepared call hierarchy items.'); }
    const doc = await access.document(await access.resolve(args)); const version = doc.version;
    const calls: Record<string, unknown>[] = []; let total = 0;
    if (args.direction === 'incoming') {
      const found = await timed(vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>('vscode.provideIncomingCalls', selected)) ?? [];
      for (const value of found) { if (await permitted(value.from.uri)) { total++; if (calls.length < args.limit) { calls.push({ item: item(value.from), ranges: value.fromRanges.slice(0, 100).map(range), rangesTruncated: value.fromRanges.length > 100 }); } } }
    } else {
      const found = await timed(vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[]>('vscode.provideOutgoingCalls', selected)) ?? [];
      for (const value of found) { if (await permitted(value.to.uri)) { total++; if (calls.length < args.limit) { calls.push({ item: item(value.to), ranges: value.fromRanges.slice(0, 100).map(range), rangesTruncated: value.fromRanges.length > 100 }); } } }
    }
    if (doc.version !== version) { throw new ToolError('VERSION_CONFLICT', 'Document changed during the call hierarchy query.'); }
    return { items: choices.map(item), selected: args.itemIndex, direction: args.direction, calls, total, truncated: total > args.limit || prepared.length > 200, source: 'language-provider' };
  });
}

async function timed<T>(pending: Thenable<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([Promise.resolve(pending), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new ToolError('LANGUAGE_TIMEOUT', 'Language query exceeded 10 seconds.')), 10000); })]); }
  finally { if (timer) { clearTimeout(timer); } }
}
