import { createHash } from 'node:crypto';
import { realpath, lstat } from 'node:fs/promises';
import * as path from 'node:path';

export class ToolError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

export function hash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function contains(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

// Resolve the nearest existing ancestor so new files are checked too.
export async function canonicalPath(target: string): Promise<string> {
  const suffix: string[] = [];
  let ancestor = path.resolve(target);
  for (;;) {
    try {
      // A dangling symlink must not be treated as a missing ordinary file.
      await lstat(ancestor);
      return path.join(await realpath(ancestor), ...suffix.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
      try {
        const stat = await lstat(ancestor);
        if (stat.isSymbolicLink()) { throw new ToolError('PATH_DENIED', 'Dangling symlinks are not allowed.'); }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') { throw statError; }
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) { throw error; }
      suffix.push(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

export async function assertWorkspacePath(roots: string[], target: string): Promise<void> {
  if (!roots.some(root => contains(root, target))) {
    throw new ToolError('PATH_DENIED', 'Path is outside the workspace.');
  }
  const actual = await canonicalPath(target);
  const actualRoots = await Promise.all(roots.map(root => realpath(root)));
  if (!actualRoots.some(root => contains(root, actual))) {
    throw new ToolError('PATH_DENIED', 'Symlink or junction points outside the workspace.');
  }
}

export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
