import type { ConnectionInfo } from './server';

export function clientConfiguration(info: ConnectionInfo, client: 'codex' | 'opencode'): string {
  const headers = info.authEnabled ? { Authorization: `Bearer ${info.token}` } : undefined;
  if (client === 'codex') {
    return `[mcp_servers.vscode]\nurl = ${JSON.stringify(info.url)}\n${headers ? `http_headers = { Authorization = ${JSON.stringify(headers.Authorization)} }\n` : ''}`;
  }
  return JSON.stringify({ mcp: { vscode: { type: 'remote', url: info.url, enabled: true, oauth: false, ...(headers ? { headers } : {}) } } }, null, 2);
}
