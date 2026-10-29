// Run with NODE_PATH pointing to a Sharp installation. The extension uses only
// the generated PNG and SVG assets; Sharp is not a runtime dependency.
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const sharp = require('sharp');
const source = await readFile(new URL('../resources/icon.svg', import.meta.url));
await sharp(source).resize(256, 256).png().toFile(fileURLToPath(new URL('../resources/icon.png', import.meta.url)));
if (process.argv.includes('--preview')) {
  const activity = await readFile(new URL('../resources/mcp.svg', import.meta.url), 'utf8');
  const placed = (x, y, size, color) => activity.replace('<svg ', `<svg x="${x}" y="${y}" width="${size}" height="${size}" `).replaceAll('currentColor', color);
  const board = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="200">
    <rect width="240" height="200" fill="#181818"/><rect x="240" width="240" height="200" fill="#f5f5f5"/>
    ${placed(72, 24, 96, '#ededed')}${placed(312, 24, 96, '#333333')}
    ${placed(108, 144, 24, '#ededed')}${placed(348, 144, 24, '#333333')}
  </svg>`;
  await sharp(Buffer.from(board)).png().toFile(fileURLToPath(new URL('../.vscode-test/icon-theme-preview.png', import.meta.url)));
}
