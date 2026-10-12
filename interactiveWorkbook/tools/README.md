# 記事本共編元件建置

靜態部署直接使用已提交的 `../vendor/notebook-editor.js`，不需在伺服器安裝 Node。

在此目錄執行：

```sh
npm ci
npm run build
```

版本由 package-lock.json 固定。entry.js 只匯出記事本需要的 Yjs、CodeMirror 6 與官方綁定功能；授權見 `../vendor/THIRD_PARTY_NOTICES.md`。調整版本或匯出後，重新建置並執行 `../test/` 的記事本測試。
