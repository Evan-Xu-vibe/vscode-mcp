import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { clientConfiguration } from '../connection';

test('client configs omit auth when disabled and escape custom keys', () => {
  const base = { url: 'http://127.0.0.1:1234/mcp', authEnabled: false, keySource: 'none' as const };
  assert.equal(clientConfiguration(base, 'codex').includes('http_headers'), false);
  assert.equal(JSON.parse(clientConfiguration(base, 'opencode')).mcp.vscode.headers, undefined);
  const info = { ...base, authEnabled: true, keySource: 'custom' as const, token: 'key"with\\quotes!' };
  assert.equal(JSON.parse(clientConfiguration(info, 'opencode')).mcp.vscode.headers.Authorization, `Bearer ${info.token}`);
  assert.match(clientConfiguration(info, 'codex'), /Authorization = "Bearer key\\"with\\\\quotes!"/);
});
