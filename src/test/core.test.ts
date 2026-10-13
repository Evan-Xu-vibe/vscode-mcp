import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { assertWorkspacePath, contains, hash, SerialQueue } from '../core';

test('workspace boundary rejects traversal, sibling prefixes and escaping junctions', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'vscode-mcp-core-'));
  try {
    const root = path.join(temp, 'workspace');
    const outside = path.join(temp, 'outside');
    await mkdir(root); await mkdir(outside);
    await writeFile(path.join(outside, 'secret.txt'), 'private');
    assert.equal(contains(root, `${root}-other`), false);
    await assertWorkspacePath([root], path.join(root, 'new.txt'));
    await assert.rejects(assertWorkspacePath([root], path.join(root, '..', 'outside', 'secret.txt')), /outside the workspace/);
    await symlink(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(assertWorkspacePath([root], path.join(root, 'escape', 'secret.txt')), /outside the workspace/);
    await assert.rejects(assertWorkspacePath([root], path.join(root, 'escape', 'new.txt')), /outside the workspace/);
  } finally {
    assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(temp, { recursive: true, force: true });
  }
});

test('write queue serializes operations and recovers after failure', async () => {
  const queue = new SerialQueue();
  const events: number[] = [];
  const first = queue.run(async () => { events.push(1); await Promise.resolve(); events.push(2); throw new Error('conflict'); });
  const second = queue.run(async () => { events.push(3); return hash('current'); });
  await assert.rejects(first, /conflict/);
  assert.equal(await second, hash('current'));
  assert.deepEqual(events, [1, 2, 3]);
  assert.notEqual(hash('current'), hash('changed'));
});
