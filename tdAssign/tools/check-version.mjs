#!/usr/bin/env node
// 部署前檢查（無相依）：node tdAssign/tools/check-version.mjs [--against <git ref>]
//   1. sw.js 的 SW_VERSION、ASSETS 內的 ?v=、index.html 的 ?v= 必須是同一個版號
//   2. ASSETS 與 index.html 的資源網址一致，ASSETS 列的檔案都存在
//   3. 指定 --against（例如 HEAD、HEAD~1、某個 commit）時：與該版本比對，
//      ASSETS 內任何檔案的內容有變、但 SW_VERSION 沒變就失敗（使用者會永遠停在舊版）
// 結束碼：0 通過、1 有問題。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const ai = args.indexOf('--against');
const against = ai >= 0 ? args[ai + 1] : (args.find((a) => a.startsWith('--against=')) || '').split('=')[1];
if (ai >= 0 && !against) { console.error('--against 需要一個 git ref'); process.exit(1); }

const errors = [];
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const sw = read('sw.js'), html = read('index.html');

const ver = (sw.match(/const\s+SW_VERSION\s*=\s*['"]([^'"]+)['"]/) || [])[1];
if (!ver) errors.push('sw.js 找不到 SW_VERSION');
const num = ver && ver.replace(/^v/, '');

const block = (sw.match(/const\s+ASSETS\s*=\s*\[([\s\S]*?)\]/) || [])[1];
if (!block) errors.push('sw.js 找不到 ASSETS');
const assets = block ? [...block.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]) : [];

// index.html 的資源網址（script src、link href，只看同源相對路徑）
const htmlRefs = [...html.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)=["'](\.\/[^"']+)["']/g)].map((m) => m[1])
  .filter((u) => !/rel=["']?(?:apple-touch-icon|icon)/.test(u));
const verOf = (u) => (u.match(/[?&]v=([^&]+)/) || [])[1];

for (const a of assets) {
  const v = verOf(a);
  if (v !== undefined && v !== num) errors.push(`ASSETS 的 ${a} 版號 ${v} 與 SW_VERSION ${ver} 不一致`);
}
for (const u of htmlRefs) {
  const v = verOf(u);
  if (/\.(js|css|webmanifest)(\?|$)/.test(u)) {
    if (v === undefined) errors.push(`index.html 的 ${u} 沒有 ?v= 參數`);
    else if (v !== num) errors.push(`index.html 的 ${u} 版號 ${v} 與 SW_VERSION ${ver} 不一致`);
    if (assets.length && !assets.includes(u)) errors.push(`index.html 的 ${u} 沒有列在 sw.js 的 ASSETS（網址要完全相同）`);
  }
}
for (const a of assets) {
  if (a === './') continue;
  const f = path.posix.normalize(a.split('?')[0]);
  if (!fs.existsSync(path.join(root, f))) errors.push(`ASSETS 列的檔案不存在：${f}`);
}
for (const a of assets.filter((x) => /\.(js|css|webmanifest)\?/.test(x))) {
  if (!htmlRefs.includes(a) && a.indexOf('manifest') < 0) errors.push(`ASSETS 的 ${a} 沒有出現在 index.html（網址要完全相同）`);
}

if (against) {
  let top;
  try { top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' }).trim(); }
  catch (e) { errors.push('不是 git 資料夾，無法使用 --against'); }
  if (top) {
    const rel = path.relative(top, root).split(path.sep).join('/');
    const show = (p) => { try { return execFileSync('git', ['show', `${against}:${rel ? rel + '/' : ''}${p}`], { cwd: top, encoding: 'buffer', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { return null; } };
    const oldSw = show('sw.js');
    const oldVer = oldSw && (oldSw.toString('utf8').match(/const\s+SW_VERSION\s*=\s*['"]([^'"]+)['"]/) || [])[1];
    if (!oldSw) errors.push(`找不到 ${against} 的 sw.js`);
    else {
      const changed = [];
      const files = new Set(['index.html', ...assets.map((a) => (a === './' ? 'index.html' : path.posix.normalize(a.split('?')[0])))]);
      files.delete('sw.js'); // sw.js 本身一定會因版號改變
      for (const f of files) {
        if (!fs.existsSync(path.join(root, f))) continue;
        const now = fs.readFileSync(path.join(root, f)), old = show(f);
        if (!old || !old.equals(now)) changed.push(f);
      }
      if (changed.length && oldVer === ver) errors.push(`與 ${against} 相比，這些檔案有變動但 SW_VERSION 仍是 ${ver}（請遞增）：${changed.join('、')}`);
      else if (changed.length) console.log(`與 ${against} 相比有 ${changed.length} 個資產變動，版號 ${oldVer} → ${ver}：${changed.join('、')}`);
      else console.log(`與 ${against} 相比資產沒有變動`);
    }
  }
}

if (errors.length) { console.error('版本檢查失敗：\n  - ' + errors.join('\n  - ')); process.exit(1); }
console.log(`版本檢查通過：SW_VERSION ${ver}，ASSETS ${assets.length} 項，index.html 參數一致，檔案都存在。`);
