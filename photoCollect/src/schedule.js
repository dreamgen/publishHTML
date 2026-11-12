// 排程（Cron 每天 03:17 UTC）：清除過期活動的照片
import { deleteAt, getConfig, saveConfig } from './config.js';
import { purgePhotos } from './stats.js';

export async function runPurge(env, now = Date.now()) {
  const summary = { checked: 0, purged: [] };
  let cursor;
  do {
    // 用 delimiter 只列出各活動資料夾，避免掃過所有照片
    const page = await env.PHOTOS.list({ prefix: 'events/', delimiter: '/', cursor, limit: 1000 });
    for (const prefix of page.delimitedPrefixes || []) {
      const id = prefix.slice('events/'.length).replace(/\/$/, '');
      try {
        const cfg = await getConfig(env, id);
        if (!cfg) continue;
        summary.checked++;
        if (cfg.deleted_at) {
          // 已刪除的活動：補刪先前中斷或上傳途中留下的殘檔（沒有殘檔時只是兩次 list）
          await purgePhotos(env, id);
          continue;
        }
        const del = deleteAt(cfg);
        if (!del || Date.parse(del) > now) continue;
        // 先標記 deleted_at 讓上傳立即關閉（條件寫入，與管理端並行修改時本次跳過、明天再試）
        cfg.deleted_at = new Date(now).toISOString();
        await saveConfig(env, cfg);
        await env.PHOTOS.delete(`codes/u/${cfg.upload_code}`); // 上傳連結失效
        await purgePhotos(env, id);
        summary.purged.push(id);
      } catch (e) {
        console.error('purge failed', id, e && e.message);
      }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  console.log('scheduled purge', JSON.stringify(summary));
  return summary;
}
