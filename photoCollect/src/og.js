// 分享預覽：公開的預覽圖 /og/{code}、上傳頁 /u/{code} 的 meta 改寫、預覽圖物件的 key
import { UPLOAD_CODE_RE, OG_EXT_MIME, ogKey } from './util.js';
import { inviteEffective } from './config.js';
import { resolveUpload } from './upload.js';
import { resolveAlbum } from './album.js';
import { loadPhotos } from './stats.js';

export const OG_DEFAULT_PATH = '/assets/og-default.png';

// 由上傳碼找活動；碼無效、已換碼、活動已刪除一律回 null（不丟錯，呼叫端改用通用內容）
async function activeEvent(env, code) {
  if (!UPLOAD_CODE_RE.test(code)) return null;
  try {
    const cfg = await resolveUpload(env, code);
    return cfg.deleted_at ? null : cfg;
  } catch {
    return null;
  }
}

async function defaultCard(env, req) {
  const r = await env.ASSETS.fetch(new Request(new URL(OG_DEFAULT_PATH, req.url), { method: 'GET' }));
  return new Response(r.body, {
    status: r.status,
    headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=300' },
  });
}

// GET /og/{code}：有卡片回卡片；沒有、碼無效、已換碼、活動已刪除都回預設圖
export async function serveOg(env, req, code) {
  const cfg = await activeEvent(env, code);
  const ext = cfg && cfg.invite && cfg.invite.card_ext;
  if (cfg && OG_EXT_MIME[ext]) {
    const obj = await env.PHOTOS.get(ogKey(cfg.id, ext));
    if (obj) {
      return new Response(req.method === 'HEAD' ? null : obj.body, {
        headers: { 'content-type': OG_EXT_MIME[ext], 'cache-control': 'public, max-age=300' },
      });
    }
  }
  return defaultCard(env, req);
}

// ---------- 上傳頁 meta 改寫 ----------
const SITE_NAME = '活動照片募集';
const GENERIC = {
  title: SITE_NAME,
  description: '請使用主辦者提供的連結，上傳你在活動中拍到的照片。',
};

// 組出要寫進 <head> 的內容；活動不存在或已刪除時只用通用文字，不洩露任何活動資訊
export function pageMeta(cfg, origin, code) {
  if (!cfg) {
    return {
      title: GENERIC.title,
      description: GENERIC.description,
      ogTitle: GENERIC.title,
      url: `${origin}/u/`,
      image: `${origin}${OG_DEFAULT_PATH}`,
      alt: SITE_NAME,
    };
  }
  const eff = inviteEffective(cfg, origin);
  return {
    title: `${eff.title}｜照片募集`,
    description: eff.message,
    ogTitle: eff.title,
    url: `${origin}/u/${code}`,
    image: eff.image_url,
    alt: `${eff.title}｜${SITE_NAME}`,
  };
}

// 靜態 upload.html 的 head 已放好各 meta 的預設值，這裡只改 content
export function rewriteUploadHead(res, m) {
  const content = new Map([
    ['description', m.description],
    ['og:type', 'website'],
    ['og:site_name', SITE_NAME],
    ['og:title', m.ogTitle],
    ['og:description', m.description],
    ['og:url', m.url],
    ['og:image', m.image],
    ['og:image:width', '1200'],
    ['og:image:height', '630'],
    ['og:image:alt', m.alt],
    ['twitter:card', 'summary_large_image'],
  ]);
  return new HTMLRewriter()
    .on('title', { element(e) { e.setInnerContent(m.title); } }) // setInnerContent 預設會跳脫 HTML
    .on('meta', {
      element(e) {
        const key = e.getAttribute('property') || e.getAttribute('name');
        if (key && content.has(key)) e.setAttribute('content', content.get(key));
      },
    })
    .transform(res);
}

// 供 index.js 呼叫：解析路徑中的上傳碼並取得活動（沒有則 null）
export async function eventForPage(env, code) {
  return activeEvent(env, code);
}

// ---------- 參與者相簿 /a/{code} ----------
export async function albumForPage(env, code) {
  try { return await resolveAlbum(env, code); } catch { return null; }
}

// 相簿頁 meta；只有「知道連結的人」可看的相簿才帶活動名稱與張數，其餘用通用文字
export async function albumMeta(env, cfg, origin, code) {
  const generic = {
    title: '活動相簿', description: '一起來挑選活動中最棒的照片！', ogTitle: '活動相簿',
    url: `${origin}/a/`, image: `${origin}${OG_DEFAULT_PATH}`, alt: '活動相簿',
  };
  if (!cfg) return generic;
  const name = cfg.basic.name;
  if (cfg.album.access !== 'link') return { ...generic, url: `${origin}/a/${code}`, image: `${origin}/og/a/${code}` };
  const ex = new Set([...(cfg.excluded || []), ...(cfg.optouts || []).map((o) => o.hash)]);
  const picked = cfg.album.source === 'picked' ? new Set(cfg.album_picked || []) : null;
  const n = (await loadPhotos(env, cfg.id)).photos.filter((p) => !ex.has(p.hash) && (!picked || picked.has(p.hash))).length;
  return {
    title: `${name} 活動相簿`,
    description: `${n} 張照片，來挑你心中的最佳照片吧！`,
    ogTitle: `${name} 活動相簿`,
    url: `${origin}/a/${code}`,
    image: `${origin}/og/a/${code}`,
    alt: `${name} 活動相簿`,
  };
}

// GET /og/a/{code}：相簿的預覽圖沿用活動預覽卡（不經由上傳碼，避免從相簿頁得知上傳連結）
export async function serveAlbumOg(env, req, code) {
  const cfg = await albumForPage(env, code);
  const ext = cfg && cfg.invite && cfg.invite.card_ext;
  if (cfg && cfg.album.access === 'link' && OG_EXT_MIME[ext]) {
    const obj = await env.PHOTOS.get(ogKey(cfg.id, ext));
    if (obj) {
      return new Response(req.method === 'HEAD' ? null : obj.body, {
        headers: { 'content-type': OG_EXT_MIME[ext], 'cache-control': 'public, max-age=300' },
      });
    }
  }
  return defaultCard(env, req);
}
