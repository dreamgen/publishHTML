/**
 * 隨身閱讀 PocketReader 設定
 *
 * 1. workerUrl：部署 pocketReader/worker/ 後，可將得到的 *.workers.dev 網址填在此處，
 *    或直接在 App 的「雲端同步與分享」設定畫面貼上並測試連線。
 * 2. fallbackCorsProxyUrl：尚未設定專屬同步 Worker 時，擷取網頁文章仍可使用既有代理。
 */
export const DEFAULT_CONFIG = {
  workerUrl: 'https://pocket-reader-sync.ikt-checkin.workers.dev',
  fallbackCorsProxyUrl: 'https://purereader-proxy-cf.dreamgen-dev.workers.dev/?url=',
  maxPdfBlobBytes: 25 * 1024 * 1024,
  defaultCategories: ['常用置頂', '背誦經典', '工作查閱', '長篇書籍', '隨手筆記'],
};
