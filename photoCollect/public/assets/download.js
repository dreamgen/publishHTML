// 下載頁：讀取 /download/latest.json（由 scripts/build-download.sh 產生），顯示檔案資訊與安裝提示詞
import { installPrompt } from './prompts.js';

const $ = (id) => document.getElementById(id);
const toast = (msg) => {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 1800);
};
const copy = async (text, msg) => {
  try { await navigator.clipboard.writeText(text); toast(msg); }
  catch { toast('無法自動複製，請手動選取文字'); }
};

const prompt = installPrompt({ downloadUrl: `${location.origin}/download/` });
$('prompt-a').textContent = prompt;
$('copy-a').addEventListener('click', () => copy(prompt, '已複製，請貼給你的 AI 助理'));

let sha = '';
$('copy-sha').addEventListener('click', () => sha && copy(sha, '已複製 SHA-256'));

fetch('/download/latest.json', { cache: 'no-store' })
  .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
  .then((info) => {
    sha = info.sha256 || '';
    $('dl-sha').textContent = sha || '—';
    $('dl-ver').textContent = info.version ? `${info.version}（${(info.built_at || '').slice(0, 10)}）` : '—';
    if (info.file) $('dl-link').href = `/download/${info.file}`;
    if (info.size) $('dl-size').textContent = `${(info.size / 1024 / 1024).toFixed(1)} MB`;
  })
  .catch(() => { $('dl-sha').textContent = '尚未發佈安裝包'; });
