import { runTests } from '@vscode/test-electron';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';

const unit = spawnSync(process.execPath, ['--test', 'out/test/core.test.js', 'out/test/server.test.js', 'out/test/connection.test.js', 'out/test/terminals.test.js'], { stdio: 'inherit' });
if (unit.status !== 0) { process.exit(unit.status ?? 1); }
const temp = await mkdtemp(path.join(os.tmpdir(), 'vscode-mcp-integration-'));
try {
  const workspace = path.join(temp, 'workspace');
  await mkdir(workspace);
  await writeFile(path.join(workspace, 'fixture.txt'), 'alpha\nbeta\n');
  await writeFile(path.join(workspace, 'binary.bin'), Buffer.from([0, 1, 2]));
  await writeFile(path.join(workspace, 'large.txt'), 'x'.repeat(1024 * 1024 + 1));
  await mkdir(path.join(workspace, '.vscode'));
  await writeFile(path.join(workspace, '.vscode', 'tasks.json'), JSON.stringify({ version: '2.0.0', tasks: [
    ...[0, 7].map(code => ({ label: `mcp-test-exit-${code}`, type: 'process', command: process.execPath, args: ['-e', `process.exit(${code})`], problemMatcher: [] })),
    { label: 'mcp-test-stop', type: 'process', command: process.execPath, args: ['-e', 'setTimeout(() => process.exit(0), 60000)'], problemMatcher: [] }
  ] }));
  await runTests({
    extensionDevelopmentPath: process.env.MCP_EXTENSION_UNDER_TEST ?? process.cwd(),
    extensionTestsPath: path.resolve('out/test/integration.js'),
    ...(process.env.VSCODE_EXECUTABLE_PATH ? { vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH } : { version: '1.85.0' }),
    launchArgs: [workspace, '--user-data-dir', path.join(temp, 'profile'), '--extensions-dir', path.join(temp, 'extensions'), '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-extensions', '--disable-gpu']
  });
} finally {
  if (!path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep)) { throw new Error('Unexpected test directory.'); }
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
