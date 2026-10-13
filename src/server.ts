import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

export interface ConnectionInfo { url: string; authEnabled: boolean; token?: string; keySource: 'custom' | 'random' | 'none'; }
export interface AuthOptions { enabled?: boolean; key?: string; }
export function validateKey(key: string): boolean { return key.length <= 1024 && /^[\x21-\x7e]+$/.test(key); }
const MAX_BODY = 2 * 1024 * 1024;

export class McpHttpService {
  private listener?: Server;
  private info?: ConnectionInfo;
  private readonly active = new Set<McpServer>();
  constructor(private readonly register: (server: McpServer) => void, private readonly log: (message: string) => void, private readonly version = '0.1.0') {}
  get connection(): ConnectionInfo | undefined { return this.info ? { ...this.info } : undefined; }

  async start(port = 0, auth: AuthOptions = {}): Promise<ConnectionInfo> {
    if (this.info) { return { ...this.info }; }
    if (!Number.isInteger(port) || port < 0 || port > 65535) { throw new Error('MCP port must be an integer between 0 and 65535.'); }
    const authEnabled = auth.enabled ?? true;
    if (authEnabled && auth.key !== undefined && !validateKey(auth.key)) { throw new Error('Key must contain 1–1024 printable ASCII characters without spaces.'); }
    const token = authEnabled ? auth.key || randomBytes(32).toString('hex') : undefined;
    const listener = createServer((req, res) => { void this.handle(req, res, token).catch(error => {
      this.log(`HTTP request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) { this.reject(res, 500, 'Internal server error'); } else { res.end(); }
    }); });
    listener.requestTimeout = 15_000;
    listener.headersTimeout = 10_000;
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(port, '127.0.0.1', () => { listener.removeListener('error', reject); resolve(); });
    });
    listener.on('error', error => this.log(`Listener error: ${error.message}`));
    const address = listener.address();
    if (!address || typeof address === 'string') { listener.close(); throw new Error('No TCP address available.'); }
    this.listener = listener;
    this.info = { url: `http://127.0.0.1:${address.port}/mcp`, authEnabled, token, keySource: authEnabled ? auth.key ? 'custom' : 'random' : 'none' };
    this.log(`Listening on ${this.info.url}`);
    return { ...this.info };
  }

  async stop(): Promise<void> {
    const listener = this.listener;
    this.listener = undefined;
    this.info = undefined;
    if (!listener) { return; }
    const closed = new Promise<void>(resolve => listener.close(() => resolve()));
    listener.closeAllConnections();
    await Promise.allSettled([...this.active].map(server => server.close()));
    this.active.clear();
    await closed;
    this.log('Server stopped.');
  }

  private reject(res: ServerResponse, status: number, message: string): void {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: message }));
  }

  private async handle(req: IncomingMessage, res: ServerResponse, token: string | undefined): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    const address = this.listener?.address();
    if (!address || typeof address === 'string') { this.reject(res, 503, 'Server is stopping'); return; }
    const allowedHosts = [`127.0.0.1:${address.port}`, `localhost:${address.port}`];
    if (!req.headers.host || !allowedHosts.includes(req.headers.host)) { this.reject(res, 403, 'Invalid Host'); return; }
    if (req.headers.origin && !allowedHosts.some(host => req.headers.origin === `http://${host}`)) { this.reject(res, 403, 'Invalid Origin'); return; }
    if (token !== undefined) {
      const auth = req.headers.authorization ?? '';
      const expected = `Bearer ${token}`;
      if (Buffer.byteLength(auth) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(auth), Buffer.from(expected))) { this.reject(res, 401, 'Bearer token required'); return; }
    }
    if (req.url !== '/mcp') { this.reject(res, 404, 'Unknown endpoint'); return; }
    // Stateless JSON responses: no server-initiated SSE stream or resumable session.
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); this.reject(res, 405, 'Use POST'); return; }
    if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) { this.reject(res, 415, 'Use application/json'); return; }
    if (this.active.size >= 32) { this.reject(res, 429, 'Too many concurrent requests'); return; }
    if (Number(req.headers['content-length']) > MAX_BODY) { this.reject(res, 413, 'Request exceeds 2 MiB'); req.resume(); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_BODY) { this.reject(res, 413, 'Request exceeds 2 MiB'); req.resume(); return; }
      chunks.push(bytes);
    }
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { this.reject(res, 400, 'Invalid JSON'); return; }
    const server = new McpServer({ name: 'vscode-mcp', version: this.version });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    this.active.add(server);
    const cleanup = () => { this.active.delete(server); void server.close().catch(() => undefined); };
    res.once('close', cleanup);
    try { this.register(server); await server.connect(transport); await transport.handleRequest(req, res, body); }
    catch (error) { cleanup(); throw error; }
  }
}
