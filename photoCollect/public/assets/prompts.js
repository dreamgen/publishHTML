// 交給 MV 製作者的三份提示詞（A 安裝、B 製作、C 接續）
// 文字依規劃範本，只代入 [...] 處。

// 活動名稱等欄位壓成單行，避免換行文字混入提示詞結構
const oneLine = (v) => String(v ?? '').replace(/[\r\n\u2028\u2029\t]+/g, ' ').trim();

/** A：安裝提示詞。downloadUrl 例如 https://example.com/download/ */
export function installPrompt({ downloadUrl }) {
  return `請幫我在這台電腦安裝「照片回憶 MV 工具（MV Studio）」，並確認可以使用。
安裝包：${downloadUrl}（頁面上有檔案與 SHA-256 檢查碼）
請依序進行：
1. 先告訴我你能不能直接在我的電腦執行指令，以及我的作業系統。可以執行就由你完成以下步驟；不能執行就一次只給我一個指令，告訴我貼在哪裡（Mac：終端機；Windows：PowerShell），等我貼回結果再繼續。
2. 下載安裝包並核對 SHA-256，對不上就停止並告訴我。
3. 解壓縮後完整閱讀裡面的 SKILL.md 與 README.md，之後的安裝與操作都照 SKILL.md 進行。程式裝在 Mac 的 ~/MVStudio 或 Windows 的 C:\\MVStudio，不要裝在 OneDrive 同步的資料夾。
4. 需要安裝 Python、FFmpeg、Homebrew，或需要系統管理員權限時，先用一句話說明要裝什麼、為什麼，等我同意再裝。
5. 執行安裝腳本與環境健檢（mvctl.py doctor），有 ❌ 的項目幫我解決，直到全部通過。
6. 如果你支援 Skill，請把安裝包中的 Skill 裝起來；不支援就告訴我，以後我會用製作提示詞開始。
7. 最後用三行以內告訴我：裝在哪裡、怎麼打開網頁介面、下次怎麼開始做 MV。
過程中請用繁體中文、白話說明，我不熟指令。`;
}

/** B：製作提示詞。含同步金鑰，請勿公開貼上 */
export function makePrompt({ name: rawName, syncUrl, key }) {
  const name = oneLine(rawName);
  return `請用我電腦上的 MV Studio（Mac：~/MVStudio；Windows：C:\\MVStudio）幫我製作一支活動回顧 MV。
開始前請先完整閱讀該資料夾內的 SKILL.md，全程依照它的六個階段進行。若還沒安裝，請先告訴我要用安裝提示詞。
活動名稱：${name}
照片同步網址：${syncUrl}
同步金鑰：${key}（請只存在專案設定裡，不要貼到其他地方）
我會另外提供：配樂檔（mp3）與正確的歌詞文字。如果我還沒給，請先問我。
請依序：
1. 建立專案，用 mvctl link 連上雲端活動，再用 mvctl sync 下載照片，告訴我各環節、各小隊各有幾張。
2. 照 SKILL.md 繼續完成對齊、規劃、照片分析、排程、渲染；規劃完成後用 mvctl push-requirements 把每個環節需要的張數回傳到雲端。
3. 兩個人工把關點（看校對影片、檢查照片分配）一定要停下來，告訴我開哪個檔案或網頁、看什麼。
4. 某個主題照片不夠時告訴我缺哪些畫面，我可以請大家補傳後再 sync。
5. 每個階段結束用一兩句話回報。照片不要上傳到任何其他服務。`;
}

/** C：接續提示詞 */
export function resumePrompt({ name: rawName }) {
  const name = oneLine(rawName);
  return `請打開我電腦上的 MV Studio，先讀 SKILL.md，再執行 mvctl projects 與 mvctl status，告訴我「${name}」做到哪一步，然後從下一步繼續。若雲端有新照片，先 sync 再接續。`;
}
