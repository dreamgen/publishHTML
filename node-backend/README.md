# liveInteraction — Node.js Backend (Socket.io)

> 適用場景：**遠端異地連線**（4 人在不同縣市也能一起玩）
> 面對面聚會請使用現有 Firebase 主機權威模式（`liveInteraction/index.html`）

---

## 本地開發

```bash
cd node-backend
npm install
npm run dev        # nodemon 熱重載
# 伺服器啟動於 http://localhost:3000
```

---

## 部署到 Render（免費）

### 步驟一：推送到 GitHub

將 `node-backend/` 資料夾推送到 GitHub repo（已在現有 `publishHTML` repo 中）。

### 步驟二：Render 設定

1. 登入 [render.com](https://render.com) → **New+ > Web Service**
2. 選擇 `publishHTML` repo
3. 設定以下欄位：

| 欄位 | 值 |
|------|-----|
| **Root Directory** | `node-backend` |
| **Runtime** | `Node` |
| **Build Command** | `npm install` |
| **Start Command** | `node server.js` |
| **Instance Type** | Free |

4. **Environment Variables** → 新增：

| Key | Value |
|-----|-------|
| `ALLOWED_ORIGIN` | `https://dreamgen.github.io` |

5. 點擊 **Deploy** → 部署網址：**`https://publishhtml-liveinteraction.onrender.com`**

> ⚠️ **Render 免費方案**：15 分鐘無流量後伺服器休眠，下次連線需等約 30~50 秒冷啟動。

---

## 前端連線（Socket.io 模式）

在 `liveInteraction/index.html` 中切換至 Socket.io 模式時，前端需引入：

```html
<script src="https://cdn.socket.io/4.7.5/socket.io.min.js"></script>
<script>
  const socket = io("https://publishhtml-liveinteraction.onrender.com");
  socket.on("connect", () => console.log("已連上伺服器"));
</script>
```

---

## Socket 事件對照表

### 客戶端 → 伺服器

| 事件 | 資料 | 說明 |
|------|------|------|
| `create_room` | `{ roomId, playerId, playerName }` | 建立房間 |
| `join_room` | `{ roomId, playerId, playerName }` | 加入房間 |
| `send_message` | `{ text, recipients: 'all'\|[id] }` | 發送訊息 |
| `send_reaction` | `{ emoji }` | 發送表情 |
| `leave_room` | — | 主動離開 |

### 伺服器 → 客戶端

| 事件 | 資料 | 說明 |
|------|------|------|
| `room_created` | `{ roomId }` | 房間建立成功 |
| `room_joined` | `{ roomId, isHost, existed }` | 加入成功 |
| `players_updated` | `{ players, hostId }` | 玩家清單更新 |
| `new_message` | `{ sender, senderId, text, isPrivate, timestamp }` | 新訊息 |
| `new_reaction` | `{ emoji, senderName }` | 新表情 |
| `error` | `{ message }` | 錯誤通知 |
