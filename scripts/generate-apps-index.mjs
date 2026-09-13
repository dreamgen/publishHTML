#!/usr/bin/env node
/**
 * 掃描 publishHTML/ 下所有 PWA 子目錄，產生 appHub/apps.json。
 *
 * 目的：讓「PWA 總覽 (appHub)」頁面能自動列出目前所有工具，
 *       新增工具時只要照既有慣例建立子目錄，不需要手動維護清單。
 *
 * 判斷規則：
 * - 子目錄內有 index.html 才視為一個可開啟的 PWA
 * - 排除已知非 PWA 目錄（後端服務、暫存資料夾、本工具自己）
 * - 優先讀 manifest.webmanifest 取得 name / description / icon / theme_color / categories
 * - manifest 缺少的欄位（或整個 manifest 不存在，例如 myBadge 用動態 manifest），
 *   退回解析 index.html 的 <title> 與 <meta name="description">
 * - icon 在 manifest 找不到時，退回目錄下常見檔名（icon.svg / icon.png / favicon.*）
 *
 * 使用方式：
 *   node scripts/generate-apps-index.mjs
 *
 * GitHub Actions 部署流程（.github/workflows/deploy.yml）會在每次推送到
 * main 時自動執行一次，所以正式上線的總覽頁一定反映當時 repo 的最新內容，
 * 不需要額外手動步驟。
 */

import { readdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');            // publishHTML/
const OUT_DIR = join(ROOT, 'appHub');
const OUT_FILE = join(OUT_DIR, 'apps.json');

// 已知不是「可安裝 PWA 工具」的子目錄，掃描時略過
const EXCLUDE = new Set([
  'appHub',              // 本工具自己
  'node-backend',        // Node 後端服務，非 PWA
  'purereader-proxy-cf', // Cloudflare Worker 後端，非 PWA
  'tmp',                 // 暫存資料夾
]);

const COMMON_ICON_NAMES = ['icon.svg', 'icon.png', 'favicon.svg', 'favicon.png'];

function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function extractTitle(html) {
  const m = html.match(/<title>([^<]*)<\/title>/i);
  return m ? m[1].trim() : null;
}

function extractMetaDescription(html) {
  const m =
    html.match(/<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i) ||
    html.match(/<meta\s+content=["']([^"']*)["']\s+name=["']description["']/i);
  return m ? m[1].trim() : null;
}

function pickIcon(dirName, manifest, dirPath) {
  if (manifest && Array.isArray(manifest.icons) && manifest.icons.length) {
    const anyPurpose = (i) => !i.purpose || i.purpose.includes('any');
    const chosen =
      manifest.icons.find((i) => i.sizes === '192x192' && anyPurpose(i)) ||
      manifest.icons.find(anyPurpose) ||
      manifest.icons[0];
    if (chosen && chosen.src) {
      const rel = chosen.src.replace(/^\.\//, '');
      return `../${dirName}/${rel}`;
    }
  }
  for (const name of COMMON_ICON_NAMES) {
    if (existsSync(join(dirPath, name))) return `../${dirName}/${name}`;
  }
  return null;
}

function scan() {
  const entries = readdirSync(ROOT, { withFileTypes: true });
  const apps = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirName = entry.name;
    if (dirName.startsWith('.') || EXCLUDE.has(dirName)) continue;

    const dirPath = join(ROOT, dirName);
    const indexPath = join(dirPath, 'index.html');
    if (!existsSync(indexPath)) continue; // 沒有 index.html 就不是一個可開啟的 PWA 頁面

    const html = readText(indexPath) || '';
    const manifestPath = join(dirPath, 'manifest.webmanifest');
    let manifest = null;
    if (existsSync(manifestPath)) {
      try {
        manifest = JSON.parse(readText(manifestPath));
      } catch (e) {
        console.warn(`[警告] ${dirName}/manifest.webmanifest 解析失敗：${e.message}`);
      }
    }

    const name = (manifest && manifest.name) || extractTitle(html) || dirName;
    const shortName = (manifest && manifest.short_name) || name;
    const description = (manifest && manifest.description) || extractMetaDescription(html) || '';
    const themeColor = (manifest && manifest.theme_color) || '#667eea';
    const categories = (manifest && manifest.categories) || [];
    const icon = pickIcon(dirName, manifest, dirPath);

    apps.push({
      id: dirName,
      name,
      shortName,
      description,
      path: `../${dirName}/`,
      icon,
      themeColor,
      categories,
    });
  }

  apps.sort((a, b) => a.id.localeCompare(b.id));
  return apps;
}

const apps = scan();
const output = {
  generatedAt: new Date().toISOString(),
  count: apps.length,
  apps,
};

writeFileSync(OUT_FILE, JSON.stringify(output, null, 2) + '\n', 'utf8');
console.log(`已產生 ${OUT_FILE}，共 ${apps.length} 個工具`);
