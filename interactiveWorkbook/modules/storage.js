import { randomId } from './util.js';

// 本機記錄：講師自己開過的課程、學員上次加入的身分
export const LS = { COURSES: 'iw_myCourses', LAST: 'iw_lastJoin' };
export const loadJSON = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
export const saveJSON = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 無痕模式忽略 */ } };

export function rememberCourse(code, name) {
  const list = loadJSON(LS.COURSES, []).filter((c) => c.code !== code);
  list.unshift({ code, name, savedAt: Date.now() });
  saveJSON(LS.COURSES, list.slice(0, 20));
}
export function forgetCourse(code) {
  saveJSON(LS.COURSES, loadJSON(LS.COURSES, []).filter((c) => c.code !== code));
}

// 目前工作階段
export const SESSION_KEY = 'iw_session';
export const loadSession = () => { try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)); } catch { return null; } };
export const saveSession = (s) => { try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch { /* ignore */ } };
export const clearSession = () => { try { sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ } };

// 裝置 ID：live/<CODE> 的編輯鎖用來標示持有者是哪一台裝置，存在 localStorage 讓同一裝置重整後仍是同一個 ID。
const DEVICE_ID_KEY = 'iw_deviceId';
export function deviceId() {
  let id = null;
  try { id = localStorage.getItem(DEVICE_ID_KEY); } catch { id = null; }
  if (!id) {
    id = randomId(8);
    try { localStorage.setItem(DEVICE_ID_KEY, id); } catch { /* 無痕模式忽略 */ }
  }
  return id;
}
