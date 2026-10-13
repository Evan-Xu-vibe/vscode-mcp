import * as esbuild from 'esbuild';
import { isBuiltin } from 'node:module';

const options = {
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
  sourcemap: true,
  metafile: true,
  logLevel: 'info'
};

if (process.argv.includes('--watch')) {
  const context = await esbuild.context(options);
  await context.watch();
} else {
  const result = await esbuild.build(options);
  for (const output of Object.values(result.metafile.outputs)) {
    for (const dependency of output.imports) {
      if (dependency.external && dependency.path !== 'vscode' && !isBuiltin(dependency.path)) {
        throw new Error(`Unbundled runtime dependency: ${dependency.path}`);
      }
    }
  }
}
