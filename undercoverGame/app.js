// 進入點：依網址決定顯示首頁、控場儀表板、列印頁、助理主持人手機或離線單機。
import { h, iconEl } from './modules/ui.js';
import { QR } from './modules/rules.js';
import { runUnmount } from './modules/nav.js';

const app = document.getElementById('app');
export const APP_VERSION = 'v14';
window.__UG_VERSION = APP_VERSION;

function home() {
  const joined = (() => { try { return JSON.parse(localStorage.getItem('ug.phone') || 'null'); } catch (e) { return null; } })();
  const dashEv = (() => { try { return localStorage.getItem('ug.dash.ev'); } catch (e) { return null; } })();
  app.replaceChildren(h('main', { class: 'wrap', style: { maxWidth: '880px' } },
    h('header', {}, h('div', {}, h('span', { class: 'eyebrow' }, '法會體驗課程'), h('h1', {}, '勿虛心假意・體驗遊戲結算'))),
    h('p', { class: 'muted' }, '控場講師用電腦開儀表板；助理主持人用手機掃儀表板上的組別 QR 碼加入。現場沒有網路時，手機可改用離線單機模式。'),
    h('div', { class: 'home-tiles' },
      h('a', { class: 'tile', href: '#/dash' }, h('b', {}, '控場講師儀表板'), h('span', { class: 'muted small' }, dashEv ? `繼續活動 ${dashEv}` : '建立活動、設定梯次、列印信封、控制回合')),
      h('a', { class: 'tile', href: '#/phone' }, h('b', {}, '助理主持人手機'), h('span', { class: 'muted small' }, joined ? `繼續：活動 ${joined.ev}・第 ${joined.batch} 梯次・第 ${joined.g} 組` : '掃組別 QR 碼加入')),
      h('a', { class: 'tile', href: '#/offline' }, h('b', {}, '離線單機操作'), h('span', { class: 'muted small' }, '不連網、不同步，各組手機獨立操作')),
      h('a', { class: 'tile', href: './guide.html' }, h('b', {}, '操作說明書'), h('span', { class: 'muted small' }, '給控場講師與助理主持人的完整說明，可分享、可列印'))),
    h('p', { class: 'muted tiny' }, `程式版本 ${APP_VERSION}`)));
}

async function route() {
  const hash = location.hash || '#/';
  // 相機 App 掃組別 QR 碼開啟時，網址帶 ?join=EV.batch.g
  const playerInfo = QR.parse(location.href);
  if ((playerInfo.type === 'player' || playerInfo.type === 'seat') && !hash.startsWith('#/player')) {
    try {
      let cur = JSON.parse(localStorage.getItem('ug.player') || 'null');
      if (!cur || cur.ev !== playerInfo.ev) cur = { ev: playerInfo.ev };
      // 自動抽角色：用手機相機掃座位 QR 開啟 → 進玩家頁後自動領這個座位
      if (playerInfo.type === 'seat') cur.seatTok = playerInfo;
      localStorage.setItem('ug.player', JSON.stringify(cur));
    } catch (e) { /* */ }
    history.replaceState(null, '', location.pathname + '#/player');
    return route();
  }
  const joinInfo = QR.parse(location.href);
  if (joinInfo.type === 'join' && !hash.startsWith('#/phone')) {
    try { localStorage.setItem('ug.phone', JSON.stringify({ ev: joinInfo.ev, batch: joinInfo.batch, g: joinInfo.g })); } catch (e) { /* */ }
    history.replaceState(null, '', location.pathname + '#/phone');
    return route();
  }
  try {
    if (hash.startsWith('#/dash')) { const m = await import('./modules/dashboard.js'); await m.mountDashboard(app); }
    else if (hash.startsWith('#/print/')) { const m = await import('./modules/print.js'); await m.mountPrint(app, hash.split('/').slice(2)); }
    else if (hash.startsWith('#/phone')) { const m = await import('./modules/phone.js'); await m.mountPhone(app, 'online'); }
    else if (hash.startsWith('#/player')) { const m = await import('./modules/player.js'); await m.mountPlayer(app); }
    else if (hash.startsWith('#/offline')) { const m = await import('./modules/phone.js'); await m.mountPhone(app, 'offline'); }
    else home();
  } catch (e) {
    console.error(e);
    app.replaceChildren(h('main', { class: 'wrap' }, h('div', { class: 'card' },
      h('h2', {}, '發生錯誤'), h('p', { class: 'muted' }, e.message || String(e)),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => route() }, '重試'), h('a', { class: 'btn', href: '#/' }, iconEl('back'), '回首頁')))));
  }
  window.__ugBooted = true;
}

window.addEventListener('hashchange', () => { runUnmount(); route(); });
route();
