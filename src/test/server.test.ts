import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createServer, get } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpHttpService, validateKey } from '../server';

test('MCP SDK clients can initialize, discover and call tools; HTTP guards reject invalid requests', async () => {
  const service = new McpHttpService(server => {
    server.registerTool('workspace_info', { inputSchema: {} }, async () => ({ content: [{ type: 'text', text: '{"instanceId":"test"}' }], structuredContent: { instanceId: 'test' } }));
  }, () => undefined);
  const info = await service.start();
  const client = new Client({ name: 'test-agent', version: '1.0.0' });
  const headers = { Authorization: `Bearer ${info.token}` };
  try {
    assert.equal((await fetch(info.url)).status, 401);
    assert.equal((await fetch(info.url, { headers: { ...headers, Origin: 'http://attacker.example' } })).status, 403);
    const invalidHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      get(info.url, { headers: { ...headers, Host: 'attacker.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
    });
    assert.equal(invalidHostStatus, 403);
    assert.equal((await fetch(info.url, { headers })).status, 405);
    assert.equal((await fetch(info.url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{bad' })).status, 400);
    assert.equal((await fetch(info.url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: 'x'.repeat(2 * 1024 * 1024 + 1) })).status, 413);
    await client.connect(new StreamableHTTPClientTransport(new URL(info.url), { requestInit: { headers } }));
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['workspace_info']);
    const result = await client.callTool({ name: 'workspace_info', arguments: {} });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, { instanceId: 'test' });
    assert.equal((await client.callTool({ name: 'missing', arguments: {} })).isError, true);
  } finally { await client.close(); await service.stop(); }
  const restarted = await service.start();
  assert.notEqual(restarted.token, info.token);
  await service.stop();
});

test('authentication can be disabled and MCP clients can connect without headers', async () => {
  const service = new McpHttpService(server => {
    server.registerTool('ping', { inputSchema: {} }, async () => ({ content: [{ type: 'text', text: 'pong' }] }));
  }, () => undefined);
  const info = await service.start(0, { enabled: false, key: 'saved-key' });
  const client = new Client({ name: 'no-auth-agent', version: '1.0.0' });
  try {
    assert.equal(info.authEnabled, false);
    assert.equal(info.token, undefined);
    assert.equal(info.keySource, 'none');
    assert.equal((await fetch(info.url)).status, 405);
    assert.equal((await fetch(info.url, { headers: { Origin: 'http://attacker.example' } })).status, 403);
    const invalidHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      get(info.url, { headers: { Host: 'attacker.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
    });
    assert.equal(invalidHostStatus, 403);
    await client.connect(new StreamableHTTPClientTransport(new URL(info.url)));
    assert.equal((await client.listTools()).tools[0].name, 'ping');
    assert.deepEqual((await client.callTool({ name: 'ping' })).content, [{ type: 'text', text: 'pong' }]);
  } finally { await client.close(); await service.stop(); }
});

test('custom keys are used exactly, reject incorrect credentials and survive service restarts', async () => {
  const service = new McpHttpService(() => undefined, () => undefined);
  const key = 'my-custom_key.123!';
  const info = await service.start(0, { enabled: true, key });
  try {
    assert.equal(info.authEnabled, true);
    assert.equal(info.keySource, 'custom');
    assert.equal(info.token, key);
    assert.equal((await fetch(info.url)).status, 401);
    assert.equal((await fetch(info.url, { headers: { Authorization: `Bearer ${key.slice(0, -1)}?` } })).status, 401);
    assert.equal((await fetch(info.url, { headers: { Authorization: `Bearer ${key}` } })).status, 405);
  } finally { await service.stop(); }
  try {
    assert.equal((await service.start(0, { key })).token, key);
  } finally { await service.stop(); }
});

test('invalid custom keys fail before the server starts', async () => {
  const service = new McpHttpService(() => undefined, () => undefined);
  for (const key of ['', 'has space', 'line\nbreak', '中文', 'x'.repeat(1025)]) {
    assert.equal(validateKey(key), false);
    await assert.rejects(service.start(0, { key }), /Key must contain/);
    assert.equal(service.connection, undefined);
  }
  assert.equal(validateKey('x'.repeat(1024)), true);
});

test('occupied fixed ports report actionable errors and can be retried', async () => {
  const blocker = createServer();
  await new Promise<void>(resolve => blocker.listen(0, '127.0.0.1', resolve));
  const address = blocker.address();
  assert.ok(address && typeof address !== 'string');
  const service = new McpHttpService(() => undefined, () => undefined);
  try {
    await assert.rejects(service.start(address.port), /已被占用/);
    assert.equal(service.connection, undefined);
  } finally { await new Promise<void>(resolve => blocker.close(() => resolve())); }
  try { assert.equal(new URL((await service.start(address.port)).url).port, String(address.port)); }
  finally { await service.stop(); }
});

test('self-check validates MCP and auth without masquerading as an external client', async () => {
  for (const enabled of [true, false]) {
    const service = new McpHttpService(server => { server.registerTool('ping', { inputSchema: {} }, async () => ({ content: [{ type: 'text', text: 'pong' }] })); }, () => undefined);
    assert.equal((await service.checkConnection()).passed, false);
    const info = await service.start(0, { enabled, key: 'self-check-test-key' });
    const client = new Client({ name: 'external-client', version: '1.0.0' });
    try {
      const report = await service.checkConnection();
      assert.equal(report.passed, true, JSON.stringify(report));
      assert.equal(report.toolCount, 1);
      assert.equal(service.requests.requests, 0);
      assert.equal(service.requests.lastInitializedAt, undefined);
      if (enabled) {
        assert.equal((await fetch(info.url)).status, 401);
        assert.equal(service.requests.authFailures, 1);
      }
      await client.connect(new StreamableHTTPClientTransport(new URL(info.url), { requestInit: { headers: enabled ? { Authorization: `Bearer ${info.token}` } : {} } }));
      await client.callTool({ name: 'ping' });
      assert.ok(service.requests.lastRequestAt); assert.ok(service.requests.lastAuthorizedRequestAt);
      assert.ok(service.requests.lastInitializedAt); assert.ok(service.requests.lastToolCallAt);
      assert.equal(service.requests.clientName, 'external-client');
      const beforeCheck = service.requests;
      assert.equal((await service.checkConnection()).passed, true);
      assert.deepEqual(service.requests, beforeCheck);
    } finally { await client.close(); await service.stop(); }
  }
});
