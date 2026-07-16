import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const directory = dirname(fileURLToPath(import.meta.url));
const corePath = join(directory, 'pure-reader-core.source.js');
const bridgePath = join(directory, 'pure-reader-pwa-bridge.source.js');
const outputPath = join(directory, 'pure-reader.user.js');

const [core, bridge] = await Promise.all([
  readFile(corePath, 'utf8'),
  readFile(bridgePath, 'utf8'),
]);

const bridgeBody = bridge.replace(
  /^\/\/ ==UserScript==[\s\S]*?^\/\/ ==\/UserScript==\s*/m,
  '',
);

if (bridgeBody === bridge) {
  throw new Error('找不到橋接程式的 Userscript metadata 區塊');
}

const output = `${core.trimEnd()}\n\n// ─── PureReader PWA direct-save bridge ───\n${bridgeBody.trimStart()}`;
await writeFile(outputPath, output, 'utf8');
console.log(`Built ${outputPath}`);
