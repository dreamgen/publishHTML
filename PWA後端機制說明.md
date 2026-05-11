🎮 PWA 連線桌遊架構實作指南：主機權威模式 (Host-Authoritative)
本指南將帶您實作「1 台大螢幕主機 + 多台私人手機」的派對桌遊架構。在這個架構中，所有的遊戲邏輯（洗牌、發牌、規則判定）都由「建立房間的那台設備（主機）」在前端瀏覽器中執行，Firebase 僅作為傳遞訊息的極速通道。
壹、 核心機制運作原理
1. 角色定義與 UI 差異
當玩家進入 PWA 時，首先要選擇自己的角色，這會決定他們看到的 UI 與執行的程式碼：
主機 (Host)： 負責點擊「建立房間」。UI 會顯示完整的「桌面（如海底的牌、剩餘牌數、風圈）」和一個 QRCode。程式背景會初始化完整的 GameState（遊戲狀態）。
玩家 (Player / Client)： 掃描 QRCode 或輸入代碼加入。UI 僅顯示「自己的手牌」與「操作按鈕（出牌、吃、碰）」。
2. 狀態過濾與資料同步 (State Masking)
為了防止玩家偷看牌，主機絕對不能把完整的遊戲狀態直接放上 Firebase 讓所有人讀取。必須透過「資料分流」的技巧來實作：
Firebase 資料庫結構設計範例：
{
  "rooms": {
    "A7K9": {
      "status": "playing",
      "public_board": {
        "current_turn": "player_1",
        "discard_pile": ["3_dot", "east_wind"]
      },
      "private_hands": {
        "player_1": { "hand": ["1_wan", "2_wan", "..."] },
        "player_2": { "hand": ["5_bamboo", "..."] }
      },
      "actions": {
        "latest_action": { "playerId": "player_1", "type": "discard", "tile": "3_dot", "timestamp": 123456 }
      }
    }
  }
}


3. 資料流動的三步曲 (主機與玩家的互動)
玩家出牌： 玩家 1 點擊手上的「三筒」。玩家的手機不直接修改牌桌，而是將一個「動作請求」寫入 Firebase 的 actions 路徑。
主機判定： 主機設備（平板）隨時監聽 actions 路徑。一收到玩家 1 打出「三筒」的請求，主機立刻檢查：現在是玩家 1 的回合嗎？他手上有三筒嗎？
主機更新畫面： 若判定合法，主機將自己的 GameState 扣除三筒，放到海底。然後主機負責更新 Firebase 上的 public_board（讓大家看到海底多一張牌）以及玩家 1 的 private_hands（讓玩家 1 的手機畫面少一張牌）。
貳、 實作開發注意事項
防止主機休眠 (Wake Lock API)：
主機的瀏覽器就是伺服器，若螢幕暗掉會導致全場卡死。必須在主機端加入螢幕長亮代碼：
async function requestWakeLock() {
  try {
    const wakeLock = await navigator.wakeLock.request('screen');
    console.log('螢幕喚醒鎖定已啟動');
  } catch (err) {
    console.error(`喚醒鎖定失敗: ${err.name}, ${err.message}`);
  }
}


主機斷線救援機制：
雖然主機理論上會一直放在桌上，但為防萬一（如不小心關閉分頁），主機在每次狀態改變時，可以將完整的加密 GameState 備份到 Firebase 或主機瀏覽器的 localStorage 中。若主機重新整理網頁，可瞬間從備份還原遊戲進度。
防止連點與競態條件 (Race Condition)：
玩家可能因為緊張連點兩次「碰」。主機在處理 actions 時，必須紀錄上一次處理的 timestamp，忽略過期或重複的非法動作。
附錄：替代方案 — 使用 Render 架設專屬 Node.js 後端
如果您最終決定「不想要有實體平板當主機」，希望 4 個人拿著手機在不同縣市也能隨時隨地公平開局，那麼將邏輯移到真正的雲端伺服器就是最佳解法。
方案架構
前端 (GitHub Pages)： 純粹的 UI 顯示、動畫渲染、聲音播放。
後端 (Render Web Service)： 執行 Node.js + Express，並使用 Socket.io 來維持 WebSocket 即時連線。
實作流程
步驟一：撰寫 Node.js 伺服器程式碼
建立一個簡單的 server.js，負責管理房間與 Socket 連線：
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
// 設定 CORS 允許您的 GitHub Pages 前端連線
const io = new Server(server, {
  cors: { origin: "[https://your-github-username.github.io](https://your-github-username.github.io)", methods: ["GET", "POST"] }
});

const rooms = new Map(); // 存放所有房間狀態的記憶體

io.on('connection', (socket) => {
  console.log('玩家連線:', socket.id);

  socket.on('join_room', (roomId) => {
    socket.join(roomId);
    // 在這裡處理加入邏輯...
  });

  socket.on('player_action', (data) => {
    // 伺服器在這裡執行「麻將判定邏輯」
    // 計算完成後，透過 io.to(roomId).emit(...) 廣播給房間內所有人
  });
});

server.listen(3000, () => console.log('伺服器運行中'));


步驟二：部署到 Render (免費)
將包含 server.js 和 package.json 的程式碼推送到您的 GitHub 倉庫。
登入 Render (render.com)，點擊 New+ > Web Service。
連結您的 GitHub 帳號並選擇該倉庫。
設定環境：
Runtime: Node
Build Command: npm install
Start Command: node server.js
Instance Type: Free (免費方案)
點擊 Deploy。約一分鐘後，Render 會給您一個網址（如 https://my-game.onrender.com）。
步驟三：前端連線設定
在您的 GitHub Pages 前端程式碼中，引入 Socket.io-client 並連線到 Render 網址：
<script src="[https://cdn.socket.io/4.7.2/socket.io.min.js](https://cdn.socket.io/4.7.2/socket.io.min.js)"></script>
<script>
  // 連線到 Render 上的 Node.js 伺服器
  const socket = io("[https://my-game.onrender.com](https://my-game.onrender.com)");
  
  socket.on("connect", () => {
    console.log("成功連上伺服器！");
  });
</script>


Render 方案的優缺點分析
優點： 真正的雲端伺服器權威，不怕任何單一玩家手機斷線或休眠，適用於遠端異地連線，架構最專業標準。
缺點： Render 的免費方案有 「15 分鐘休眠機制」。如果伺服器 15 分鐘沒人發送請求，它就會休眠。下次第一位玩家連線時，需要等待約 30~50 秒的「冷啟動 (Cold Start)」時間，伺服器才會醒來並正常運作（醒來後連線就完全無延遲了）。
總結建議：
如果是「面對面聚會」👉 強烈建議使用 主機權威模式（搭配 Firebase），開發最快、體驗最流暢、零冷啟動延遲。
如果是「遠端線上約戰」👉 建議使用 Render 後端方案，架構最穩固，不會因為某人手機關閉而導致整局遊戲中斷。
