/**
 * liveInteraction — Node.js + Socket.io 後端
 * 部署到 Render (render.com) 作為 Web Service
 *
 * Firebase 主機權威模式：面對面聚會推薦
 * Socket.io  伺服器模式：遠端異地連線推薦（本檔案）
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// ── CORS 設定（允許 GitHub Pages 前端連線）─────────────
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://dreamgen.github.io';
// Render 部署網址：https://publishhtml-liveinteraction.onrender.com
const io = new Server(server, {
    cors: { origin: ALLOWED_ORIGIN, methods: ['GET', 'POST'] },
    pingInterval: 25000,
    pingTimeout: 60000,
});

app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json());
app.get('/', (_, res) => res.send('liveInteraction backend OK'));

// ── 狀態管理 ─────────────────────────────────────────
// rooms: { roomId: { hostId, players: { li_userId: { name, socketId, isOnline } } } }
const rooms = new Map();
// socketToPlayer: { socket.id: { li_userId, roomId } }
const socketMap = new Map();

function getRoomUrl(roomId) { return rooms.get(roomId); }
function broadcastPlayers(roomId) {
    const room = rooms.get(roomId);
    if (!room) return;
    const list = Object.entries(room.players).map(([id, p]) => ({ id, name: p.name, isOnline: p.isOnline }));
    io.to(roomId).emit('players_updated', { players: list, hostId: room.hostId });
}

// ── Socket 事件 ───────────────────────────────────────
io.on('connection', (socket) => {
    console.log('連線:', socket.id);

    // ── 建立房間 ───────────────────────────────────────
    socket.on('create_room', ({ roomId, playerId, playerName }) => {
        if (rooms.has(roomId)) {
            socket.emit('error', { message: '房間代號已存在' }); return;
        }
        rooms.set(roomId, {
            hostId: playerId,
            players: { [playerId]: { name: playerName, socketId: socket.id, isOnline: true } }
        });
        socketMap.set(socket.id, { playerId, roomId });
        socket.join(roomId);
        socket.emit('room_created', { roomId });
        broadcastPlayers(roomId);
        console.log(`房間 ${roomId} 建立，房主: ${playerName}`);
    });

    // ── 加入房間 ───────────────────────────────────────
    socket.on('join_room', ({ roomId, playerId, playerName }) => {
        const room = rooms.get(roomId);
        if (!room) { socket.emit('error', { message: '找不到房間' }); return; }
        const existed = !!room.players[playerId];
        room.players[playerId] = { name: playerName, socketId: socket.id, isOnline: true };
        socketMap.set(socket.id, { playerId, roomId });
        socket.join(roomId);
        socket.emit('room_joined', { roomId, isHost: room.hostId === playerId, existed });
        broadcastPlayers(roomId);
    });

    // ── 發送訊息（含指定接收者）───────────────────────
    socket.on('send_message', ({ text, recipients }) => {
        const info = socketMap.get(socket.id);
        if (!info) return;
        const { playerId, roomId } = info;
        const room = rooms.get(roomId);
        if (!room) return;
        const sender = room.players[playerId]?.name || '未知';
        const payload = { sender, senderId: playerId, text, timestamp: Date.now() };

        if (recipients === 'all') {
            // 廣播給所有房間成員
            io.to(roomId).emit('new_message', { ...payload, isPrivate: false });
        } else {
            // 只發給指定玩家 + 發送者自己 + 房主
            const targets = new Set(Array.isArray(recipients) ? recipients : [recipients]);
            targets.add(playerId);            // 發送者也收到
            targets.add(room.hostId);         // 房主永遠收到

            targets.forEach(targetId => {
                const targetSocket = room.players[targetId]?.socketId;
                if (targetSocket) {
                    io.to(targetSocket).emit('new_message', {
                        ...payload,
                        isPrivate: true,
                        recipients: [...targets].filter(id => id !== playerId)
                    });
                }
            });
        }
    });

    // ── 表情反應 ──────────────────────────────────────
    socket.on('send_reaction', ({ emoji }) => {
        const info = socketMap.get(socket.id);
        if (!info) return;
        const { playerId, roomId } = info;
        const room = rooms.get(roomId);
        if (!room) return;
        const sender = room.players[playerId]?.name || '未知';
        io.to(roomId).emit('new_reaction', { emoji, senderName: sender });
    });

    // ── 離開房間 ──────────────────────────────────────
    socket.on('leave_room', () => handleDisconnect(socket));

    // ── 斷線處理 ──────────────────────────────────────
    socket.on('disconnect', () => handleDisconnect(socket, true));
});

function handleDisconnect(socket, isAbrupt = false) {
    const info = socketMap.get(socket.id);
    if (!info) return;
    const { playerId, roomId } = info;
    socketMap.delete(socket.id);
    const room = rooms.get(roomId);
    if (!room) return;

    if (isAbrupt) {
        // 短暫斷線：標記離線但保留座位
        if (room.players[playerId]) room.players[playerId].isOnline = false;
        broadcastPlayers(roomId);
        // 60 秒後若仍未重連則移除
        setTimeout(() => {
            const r = rooms.get(roomId);
            if (!r?.players[playerId]) return;
            if (!r.players[playerId].isOnline) {
                delete r.players[playerId];
                broadcastPlayers(roomId);
                if (Object.keys(r.players).length === 0) rooms.delete(roomId);
            }
        }, 60000);
    } else {
        delete room.players[playerId];
        broadcastPlayers(roomId);
        if (Object.keys(room.players).length === 0) rooms.delete(roomId);
    }
}

// ── 啟動 ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ 伺服器運行中 port ${PORT}`));
