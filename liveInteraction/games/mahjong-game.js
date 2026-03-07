// ══════════════════════════════════════════════════════════════════════
// mahjong-game.js — 台灣麻將多人版（區域房間試作）
// 使用 React 18 UMD + Babel Standalone，透過 window._gameContext 存取 Firebase
// ══════════════════════════════════════════════════════════════════════
(function () {
    const { useState, useEffect, useRef, useCallback } = React;

    // ── 取得 Firebase Context ──────────────────────────────────────────
    function getCtx() { return window._gameContext; }

    // ══════════════════════════════════════════════════════════════════
    // 1. 麻將常數與牌庫（同 mahjongPractice）
    // ══════════════════════════════════════════════════════════════════
    const TILE_TYPES = [
        ...Array.from({ length: 9 }, (_, i) => ({ id: i,      suit: 'wan',  value: i + 1, label: `${i + 1}萬` })),
        ...Array.from({ length: 9 }, (_, i) => ({ id: i + 9,  suit: 'tong', value: i + 1, label: `${i + 1}筒` })),
        ...Array.from({ length: 9 }, (_, i) => ({ id: i + 18, suit: 'suo',  value: i + 1, label: `${i + 1}索` })),
        { id: 27, suit: 'feng', value: 'dong', label: '東' },
        { id: 28, suit: 'feng', value: 'nan',  label: '南' },
        { id: 29, suit: 'feng', value: 'xi',   label: '西' },
        { id: 30, suit: 'feng', value: 'bei',  label: '北' },
        { id: 31, suit: 'yuan', value: 'zhong',label: '中' },
        { id: 32, suit: 'yuan', value: 'fa',   label: '發' },
        { id: 33, suit: 'yuan', value: 'bai',  label: '白' },
    ];

    function generateDeck() {
        let deck = [], uid = 0;
        for (const type of TILE_TYPES)
            for (let i = 0; i < 4; i++) deck.push({ ...type, uid: uid++ });
        for (let i = deck.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [deck[i], deck[j]] = [deck[j], deck[i]];
        }
        return deck;
    }

    // ══════════════════════════════════════════════════════════════════
    // 2. 胡牌判定（同 mahjongPractice）
    // ══════════════════════════════════════════════════════════════════
    function convertHandToCounts(handTiles) {
        const counts = new Array(34).fill(0);
        handTiles.forEach(t => { if (t && t.id !== undefined) counts[t.id]++; });
        return counts;
    }

    function checkCombinations(counts) {
        let i = 0;
        while (i < 34 && counts[i] === 0) i++;
        if (i === 34) return true;
        if (counts[i] >= 3) {
            counts[i] -= 3;
            if (checkCombinations(counts)) { counts[i] += 3; return true; }
            counts[i] += 3;
        }
        if (i < 27 && i % 9 <= 6 && counts[i + 1] > 0 && counts[i + 2] > 0) {
            counts[i]--; counts[i + 1]--; counts[i + 2]--;
            if (checkCombinations(counts)) { counts[i]++; counts[i + 1]++; counts[i + 2]++; return true; }
            counts[i]++; counts[i + 1]++; counts[i + 2]++;
        }
        return false;
    }

    function checkWin(handTiles) {
        if (handTiles.length % 3 !== 2) return false;
        const counts = convertHandToCounts(handTiles);
        for (let i = 0; i < 34; i++) {
            if (counts[i] >= 2) {
                counts[i] -= 2;
                if (checkCombinations(counts)) return true;
                counts[i] += 2;
            }
        }
        return false;
    }

    function findGangOptions(hand, melds) {
        const options = [];
        const counts = {};
        hand.forEach(t => counts[t.id] = (counts[t.id] || 0) + 1);
        Object.entries(counts).forEach(([id, n]) => {
            if (n === 4) options.push({ type: 'angang', tileId: parseInt(id) });
        });
        melds.filter(m => m.type === 'pong').forEach(m => {
            if (hand.some(t => t.id === m.tiles[0].id))
                options.push({ type: 'minggang', tileId: m.tiles[0].id });
        });
        return options;
    }

    function checkCombinationsNoSeq(counts) {
        let i = 0;
        while (i < 34 && counts[i] === 0) i++;
        if (i === 34) return true;
        if (counts[i] >= 3) {
            counts[i] -= 3;
            const r = checkCombinationsNoSeq(counts);
            counts[i] += 3;
            return r;
        }
        return false;
    }

    function calculateScore(hand, melds, winType) {
        const yaku = [];
        if (winType === '自摸' || winType === '嶺上自摸') yaku.push({ name: '自摸', fan: 1 });
        if (winType === '嶺上自摸') yaku.push({ name: '嶺上花', fan: 1 });
        const hasOpenMeld = melds.some(m => m.type === 'pong' || m.type === 'chow' || m.type === 'minggang');
        if (!hasOpenMeld) yaku.push({ name: '門前清', fan: 1 });
        if (!melds.some(m => m.type === 'chow')) {
            const counts = convertHandToCounts(hand);
            for (let i = 0; i < 34; i++) {
                if (counts[i] >= 2) {
                    counts[i] -= 2;
                    if (checkCombinationsNoSeq(counts)) { yaku.push({ name: '碰碰和', fan: 3 }); break; }
                    counts[i] += 2;
                }
            }
        }
        const allTiles = [...hand, ...melds.flatMap(m => m.tiles)];
        const suitSet = new Set(allTiles.map(t => t.suit));
        const honorSuits = new Set(['feng', 'yuan']);
        const seqSuits = [...suitSet].filter(s => !honorSuits.has(s));
        if (seqSuits.length === 1 && suitSet.size === 1) yaku.push({ name: '清一色', fan: 4 });
        else if (seqSuits.length === 1 && suitSet.size > 1) yaku.push({ name: '混一色', fan: 2 });
        const totalFan = yaku.reduce((s, y) => s + y.fan, 0);
        return { yaku, totalFan };
    }

    // ══════════════════════════════════════════════════════════════════
    // 3. 吃牌組合（通用版：支援任意座位）
    // ══════════════════════════════════════════════════════════════════
    function getChowCombos(hand, discardedTile, fromSeat, forSeat) {
        // 只有上家打出的牌才可以吃
        if (fromSeat !== (forSeat + 3) % 4) return [];
        if (discardedTile.id >= 27) return []; // 字牌不能吃
        const id = discardedTile.id;
        const has = (offset) => hand.find(t => t.id === id + offset);
        const combos = [];
        if (id % 9 >= 2 && has(-2) && has(-1)) combos.push([has(-2), has(-1)]);
        if (id % 9 >= 1 && id % 9 <= 7 && has(-1) && has(1)) combos.push([has(-1), has(1)]);
        if (id % 9 <= 6 && has(1) && has(2)) combos.push([has(1), has(2)]);
        return combos;
    }

    // ══════════════════════════════════════════════════════════════════
    // 4. GameBackend 抽象層（區域房間 Firebase 實作）
    //    未來可替換為 CloudGameBackend（Socket.io）
    // ══════════════════════════════════════════════════════════════════
    function makeLocalGameBackend(ctx, roomId) {
        const gPath = ctx.GAME_ROOT(roomId);
        const gRef  = (sub) => ctx.ref(ctx.db, sub ? `${gPath}/${sub}` : gPath);
        return {
            onGameState: (cb) => {
                const r = gRef();
                ctx.onValue(r, snap => cb(snap.exists() ? snap.val() : { status: 'idle' }));
                return () => ctx.off(r);
            },
            setGameState: (patch) => ctx.update(gRef(), patch),
            initGame:     (state) => ctx.set(gRef(), state),
            postAction:   (action) => ctx.set(gRef('pendingAction'), action),
            clearAction:  ()       => ctx.set(gRef('pendingAction'), null),
            resetGame:    ()       => ctx.update(gRef(), { status: 'idle', pendingAction: null, winResult: null }),
        };
    }

    // ══════════════════════════════════════════════════════════════════
    // 5. React 元件
    // ══════════════════════════════════════════════════════════════════

    // ── Tile 元件（同 mahjongPractice，稍作尺寸調整）─────────────────
    const Tile = ({ tile, isHidden, onClick, isDiscard, isMeld, isOpenMeld, isAngangHidden, large, isClaimed, isDrawn, small }) => {
        if (isHidden) {
            return <div className="w-7 h-10 sm:w-8 sm:h-12 bg-green-700 rounded shadow-[inset_0_0_6px_rgba(0,0,0,0.4)] border-b-4 border-green-900 m-px flex-shrink-0"></div>;
        }
        let textColor = "text-gray-900";
        if (tile.suit === 'wan')  textColor = "text-red-700";
        if (tile.suit === 'tong') textColor = "text-blue-700";
        if (tile.suit === 'suo')  textColor = "text-green-700";
        if (tile.suit === 'yuan') {
            if (tile.value === 'zhong') textColor = "text-red-600";
            if (tile.value === 'fa')    textColor = "text-green-600";
            if (tile.value === 'bai')   textColor = isOpenMeld ? "text-blue-500" : "text-blue-500 border border-blue-500 rounded-sm m-1 px-1";
        }
        let sizeClass = "w-9 h-13 sm:w-11 sm:h-16 text-base sm:text-lg border-b-4 hover:-translate-y-2 cursor-pointer";
        if (small)      sizeClass = "w-6 h-9 text-[10px] border-b-2";
        if (isDiscard)  sizeClass = "w-6 h-9 sm:w-7 sm:h-10 text-[10px] sm:text-xs border-b-2";
        if (isOpenMeld) sizeClass = "w-9 h-6 text-[9px] border border-gray-400 cursor-default";
        if (large)      sizeClass = "w-14 h-20 text-2xl border-b-[6px] shadow-xl";
        const claimedStyle = isClaimed ? "opacity-30 grayscale brightness-50 pointer-events-none" : "";
        const bgStyle = isOpenMeld
            ? "bg-amber-50 shadow-sm"
            : isDrawn
                ? "ml-3 -translate-y-2 ring-4 ring-yellow-400 shadow-[0_0_12px_rgba(250,204,21,0.8)] z-10 bg-yellow-100"
                : "bg-yellow-50";
        return (
            <div onClick={onClick}
                className={`relative rounded border-gray-300 flex flex-col justify-center items-center m-px font-bold select-none transition-transform ${isOpenMeld ? '' : 'shadow-md'} ${sizeClass} ${claimedStyle} ${bgStyle}`}>
                {isOpenMeld ? (
                    <span className={`${textColor} whitespace-nowrap leading-none`}>{tile.label}</span>
                ) : (
                    <>
                        <span className={textColor}>{tile.label.substring(0, 1)}</span>
                        {tile.label.length > 1 && <span className={`${textColor} text-[70%]`}>{tile.label.substring(1)}</span>}
                    </>
                )}
                {isAngangHidden && <div className="absolute inset-0 bg-green-900/80 rounded"></div>}
            </div>
        );
    };

    // ── LoadingView ────────────────────────────────────────────────────
    function LoadingView() {
        return (
            <div className="flex-1 flex items-center justify-center bg-green-900">
                <div className="text-center text-green-300">
                    <div className="w-8 h-8 border-4 border-yellow-400 border-t-transparent rounded-full animate-spin mx-auto mb-2"></div>
                    <p className="text-sm">載入遊戲中...</p>
                </div>
            </div>
        );
    }

    // ── WinOverlay ─────────────────────────────────────────────────────
    function WinOverlay({ winResult, seatNames, backend }) {
        const { winnerSeat, winType, yaku, totalFan } = winResult;
        const isFlowGame = winnerSeat < 0 || winType === '流局';
        const winnerName = !isFlowGame ? (seatNames[winnerSeat] || `座位${winnerSeat + 1}`) : null;
        return (
            <div className="absolute inset-0 bg-black/85 flex flex-col items-center justify-center z-50 p-4">
                <h2 className={`text-3xl sm:text-5xl font-bold mb-2 drop-shadow-xl ${isFlowGame ? 'text-gray-200' : 'text-yellow-400'}`}>
                    {isFlowGame ? '流局（平手）' : `${winnerName} 胡牌！`}
                </h2>
                {winType && !isFlowGame && <p className="text-white text-xl mb-3 tracking-widest">{winType}</p>}
                {yaku && yaku.length > 0 && (
                    <div className="bg-black/40 rounded-xl px-5 py-3 mb-4 text-center">
                        <div className="flex flex-wrap justify-center gap-x-3 gap-y-1 mb-1">
                            {yaku.map((y, i) => (
                                <span key={i} className="text-green-300 text-base">{y.name} <span className="text-yellow-300">+{y.fan}台</span></span>
                            ))}
                        </div>
                        <div className="text-yellow-400 text-2xl font-bold">共 {totalFan} 台</div>
                    </div>
                )}
                <button onClick={() => backend.resetGame()}
                    className="bg-green-600 hover:bg-green-500 text-white px-8 py-3 rounded-full text-xl font-bold border-2 border-green-400 shadow-2xl mt-4 transition-transform hover:scale-105">
                    返回大廳
                </button>
            </div>
        );
    }

    // ── SeatDisplay（給桌面視圖用）────────────────────────────────────
    function SeatDisplay({ idx, gs, seatNames, vertical, compact }) {
        const seatKey = `seat${idx}`;
        const hand    = gs.hands?.[seatKey] || [];
        const myMelds = gs.melds?.[seatKey] || [];
        const isCurrent = gs.currentSeat === idx;
        const tileCount = hand.length;
        return (
            <div className={`flex flex-col items-center gap-1 transition-opacity ${isCurrent ? 'opacity-100' : 'opacity-60'}`}>
                {/* 名字標籤 */}
                <div className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${isCurrent ? 'bg-yellow-400 text-black' : 'bg-black/50 text-yellow-200'}`}>
                    {seatNames[idx] || `座位${idx + 1}`}
                    {isCurrent && ' ▶'}
                </div>
                {/* 手牌（背面） */}
                {compact ? (
                    <div className="text-yellow-300 text-xs font-bold">{tileCount}張</div>
                ) : (
                    <div className={`flex ${vertical ? 'flex-col -space-y-3' : '-space-x-1.5'}`}>
                        {hand.map((_, i) => (
                            <div key={i} className="w-5 h-7 bg-green-700 rounded border-b-2 border-green-900 m-[1px] shadow flex-shrink-0"></div>
                        ))}
                    </div>
                )}
                {/* 副露 */}
                {myMelds.length > 0 && (
                    <div className="flex gap-px flex-wrap justify-center">
                        {myMelds.map((meld, mi) => (
                            <div key={mi} className="flex bg-green-950/40 rounded px-0.5">
                                {meld.tiles.map((t, ti) => (
                                    <Tile key={t.uid} tile={t} isOpenMeld
                                        isAngangHidden={meld.type === 'angang' && (ti === 1 || ti === 2)} />
                                ))}
                            </div>
                        ))}
                    </div>
                )}
            </div>
        );
    }

    // ── HostDiscardArea ────────────────────────────────────────────────
    function HostDiscardArea({ gs }) {
        const areaRef = useRef(null);
        useEffect(() => {
            if (areaRef.current) areaRef.current.scrollTop = areaRef.current.scrollHeight;
        }, [gs.discards?.length]);
        return (
            <div ref={areaRef}
                className="bg-green-900/60 rounded-xl p-2 overflow-y-auto flex flex-wrap content-start gap-0.5 shadow-inner"
                style={{ maxHeight: '140px' }}>
                {(gs.discards || []).map((t, i) => (
                    <Tile key={`d${i}`} tile={t} isDiscard isClaimed={t.claimed} />
                ))}
                {(gs.discards || []).length === 0 && (
                    <div className="text-green-600 text-xs w-full text-center py-4">棄牌區</div>
                )}
            </div>
        );
    }

    // ══════════════════════════════════════════════════════════════════
    // 6. 房主遊戲引擎（純函式，由 HostTableView 呼叫）
    // ══════════════════════════════════════════════════════════════════

    // 處理玩家送來的動作
    async function processPendingAction(gs, backend) {
        const pa = gs.pendingAction;
        if (!pa || !pa.type) return;
        const { seat, type } = pa;
        const seatKey = `seat${seat}`;
        let hands    = mapCopy(gs.hands);
        let melds    = mapCopy(gs.melds);
        let discards = [...(gs.discards || [])];
        let deck     = [...(gs.deck || [])];
        let log      = [...(gs.gameLog || [])];
        const names  = gs.seatNames || [];
        const ap     = gs.actionPrompt;

        if (type === 'skip') {
            const nextSeat = ap ? (ap.from + 1) % 4 : (seat + 1) % 4;
            await backend.setGameState({ actionPrompt: null, currentSeat: nextSeat, pendingAction: null, gameLog: [...log, `[${names[seat]}] 過`] });
            return;
        }
        if (type === 'discard') {
            const tile = pa.tile;
            let hand = [...(hands[seatKey] || [])].filter(t => t.uid !== tile.uid).sort((a, b) => a.id - b.id);
            discards.push({ ...tile, by: seat, claimed: false });
            // 檢查其他真人玩家能否回應
            const promptResult = checkOtherPlayersCanRespond(gs, hands, seat, tile);
            if (promptResult) {
                await backend.setGameState({
                    hands: { ...hands, [seatKey]: hand }, discards,
                    actionPrompt: promptResult, pendingAction: null,
                    drawnTileUid: null,
                    gameLog: [...log, `[${names[seat]}] 打出: ${tile.label}`]
                });
            } else {
                await backend.setGameState({
                    hands: { ...hands, [seatKey]: hand }, discards,
                    currentSeat: (seat + 1) % 4, pendingAction: null,
                    actionPrompt: null, drawnTileUid: null,
                    gameLog: [...log, `[${names[seat]}] 打出: ${tile.label}`]
                });
            }
            return;
        }
        if (type === 'win') {
            const tile = ap?.tile;
            let hand = [...(hands[seatKey] || [])];
            if (tile) { hand = [...hand, tile].sort((a, b) => a.id - b.id); }
            if (discards.length > 0) discards[discards.length - 1] = { ...discards[discards.length - 1], claimed: true };
            const score = calculateScore(hand, melds[seatKey] || [], tile ? '放槍' : '自摸');
            await backend.setGameState({
                hands: { ...hands, [seatKey]: hand }, discards,
                status: 'gameover',
                winResult: { winnerSeat: seat, winType: tile ? '放槍' : '自摸', ...score },
                pendingAction: null, actionPrompt: null,
                gameLog: [...log, `[${names[seat]}] 胡牌！(${tile ? `放槍: ${names[ap.from]}打${tile.label}` : '自摸'})`]
            });
            return;
        }
        if (type === 'pong') {
            const tile = ap.tile;
            let hand = [...(hands[seatKey] || [])];
            const matches = hand.filter(t => t.id === tile.id).slice(0, 2);
            hand = hand.filter(t => !matches.includes(t));
            melds[seatKey] = [...(melds[seatKey] || []), { type: 'pong', tiles: [tile, ...matches] }];
            if (discards.length > 0) discards[discards.length - 1] = { ...discards[discards.length - 1], claimed: true };
            await backend.setGameState({
                hands: { ...hands, [seatKey]: hand }, melds, discards,
                actionPrompt: null, currentSeat: seat, pendingAction: null,
                gameLog: [...log, `[${names[seat]}] 碰 ${tile.label}`]
            });
            return;
        }
        if (type === 'chow') {
            const tile  = ap.tile;
            const combo = pa.combo;
            let hand = [...(hands[seatKey] || [])].filter(t => t.uid !== combo[0].uid && t.uid !== combo[1].uid);
            melds[seatKey] = [...(melds[seatKey] || []), { type: 'chow', tiles: [tile, ...combo].sort((a, b) => a.id - b.id) }];
            if (discards.length > 0) discards[discards.length - 1] = { ...discards[discards.length - 1], claimed: true };
            await backend.setGameState({
                hands: { ...hands, [seatKey]: hand }, melds, discards,
                actionPrompt: null, currentSeat: seat, pendingAction: null,
                gameLog: [...log, `[${names[seat]}] 吃 ${tile.label}`]
            });
            return;
        }
        if (type === 'dagang') {
            const tile = ap.tile;
            let hand = [...(hands[seatKey] || [])];
            const matches = hand.filter(t => t.id === tile.id).slice(0, 3);
            hand = hand.filter(t => !matches.includes(t));
            melds[seatKey] = [...(melds[seatKey] || []), { type: 'minggang', tiles: [tile, ...matches] }];
            if (discards.length > 0) discards[discards.length - 1] = { ...discards[discards.length - 1], claimed: true };
            const lingshang = deck.pop();
            if (!lingshang) {
                await backend.setGameState({ deck, hands: { ...hands, [seatKey]: hand }, melds, discards, status: 'gameover', winResult: { winnerSeat: -1, winType: '流局' }, pendingAction: null, actionPrompt: null });
                return;
            }
            hand = [...hand, lingshang];
            if (checkWin(hand)) {
                const score = calculateScore(hand, melds[seatKey], '嶺上自摸');
                await backend.setGameState({ deck, hands: { ...hands, [seatKey]: hand }, melds, discards, status: 'gameover', winResult: { winnerSeat: seat, winType: '嶺上自摸', ...score }, pendingAction: null, actionPrompt: null, drawnTileUid: lingshang.uid });
                return;
            }
            await backend.setGameState({ deck, hands: { ...hands, [seatKey]: hand }, melds, discards, actionPrompt: null, currentSeat: seat, pendingAction: null, drawnTileUid: lingshang.uid, gameLog: [...log, `[${names[seat]}] 大明槓後摸嶺上: ${lingshang.label}`] });
            return;
        }
        if (type === 'gang') {
            const gangOpt = pa.gangOpt;
            let hand = [...(hands[seatKey] || [])];
            const gangLabel = TILE_TYPES[gangOpt.tileId].label;
            if (gangOpt.type === 'angang') {
                const gangTiles = []; let removed = 0;
                hand = hand.filter(t => { if (t.id === gangOpt.tileId && removed < 4) { gangTiles.push(t); removed++; return false; } return true; });
                melds[seatKey] = [...(melds[seatKey] || []), { type: 'angang', tiles: gangTiles }];
            } else {
                const mIdx = (melds[seatKey] || []).findIndex(m => m.type === 'pong' && m.tiles[0].id === gangOpt.tileId);
                const gt = hand.find(t => t.id === gangOpt.tileId);
                hand = hand.filter(t => t !== gt);
                melds[seatKey] = (melds[seatKey] || []).map((m, i) => i === mIdx ? { ...m, type: 'minggang', tiles: [...m.tiles, gt] } : m);
            }
            const lingshang = deck.pop();
            if (!lingshang) {
                await backend.setGameState({ deck, hands: { ...hands, [seatKey]: hand }, melds, status: 'gameover', winResult: { winnerSeat: -1, winType: '流局' }, pendingAction: null });
                return;
            }
            hand = [...hand, lingshang];
            if (checkWin(hand)) {
                const score = calculateScore(hand, melds[seatKey], '嶺上自摸');
                await backend.setGameState({ deck, hands: { ...hands, [seatKey]: hand }, melds, status: 'gameover', winResult: { winnerSeat: seat, winType: '嶺上自摸', ...score }, pendingAction: null, drawnTileUid: lingshang.uid, gameLog: [...log, `[${names[seat]}] ${gangLabel}槓後嶺上自摸！`] });
                return;
            }
            const moreGangs = findGangOptions(hand, melds[seatKey] || []);
            await backend.setGameState({ deck, hands: { ...hands, [seatKey]: hand }, melds, gangPrompt: moreGangs.length > 0 ? { forSeat: seat, options: moreGangs } : null, pendingAction: null, drawnTileUid: lingshang.uid, gameLog: [...log, `[${names[seat]}] 槓${gangLabel}後摸嶺上: ${lingshang.label}`] });
            return;
        }
        if (type === 'skipgang') {
            await backend.setGameState({ gangPrompt: null, pendingAction: null });
            return;
        }
        // 未識別的動作 → 清除
        await backend.clearAction();
    }

    // 檢查其他（真人）玩家能否對剛打出的牌有動作
    function checkOtherPlayersCanRespond(gs, hands, fromSeat, discardedTile) {
        const seats = gs.seats || [];
        for (let s = 0; s < 4; s++) {
            if (s === fromSeat) continue;
            const pid = seats[s];
            if (!pid || pid.startsWith('ai_')) continue; // AI 座位略過
            const h = hands[`seat${s}`] || [];
            const opts = [];
            const chowCombos = getChowCombos(h, discardedTile, fromSeat, s);
            if (checkWin([...h, discardedTile])) opts.push('win');
            const pongTiles = h.filter(t => t.id === discardedTile.id);
            if (pongTiles.length >= 2) opts.push('pong');
            if (pongTiles.length >= 3) opts.push('dagang');
            if (chowCombos.length > 0) opts.push('chow');
            if (opts.length > 0) return { forSeat: s, options: opts, tile: discardedTile, from: fromSeat, chowCombos };
        }
        return null;
    }

    // AI 回合
    async function runAITurn(gs, backend, seat) {
        const seatKey = `seat${seat}`;
        let deck     = [...(gs.deck || [])];
        let hands    = mapCopy(gs.hands);
        let melds    = mapCopy(gs.melds);
        let discards = [...(gs.discards || [])];
        const names  = gs.seatNames || [];
        let hand     = [...(hands[seatKey] || [])];
        let log      = [...(gs.gameLog || [])];

        const needsDraw = hand.length % 3 === 1;
        if (needsDraw) {
            const drawn = deck.pop();
            if (!drawn) {
                await backend.setGameState({ status: 'gameover', winResult: { winnerSeat: -1, winType: '流局' }, gameLog: [...log, '=== 流局 ==='] });
                return;
            }
            hand = [...hand, drawn];
            log.push(`[${names[seat]}] 摸牌`);
            if (checkWin(hand)) {
                const score = calculateScore(hand, melds[seatKey] || [], '自摸');
                await backend.setGameState({ deck, hands: { ...hands, [seatKey]: hand }, status: 'gameover', winResult: { winnerSeat: seat, winType: '自摸', ...score }, gameLog: [...log, `[${names[seat]}] 自摸！`] });
                return;
            }
            // AI 自動槓（簡化：只做暗槓）
            const aiGangs = findGangOptions(hand, melds[seatKey] || []);
            if (aiGangs.length > 0) {
                const g = aiGangs[0];
                if (g.type === 'angang') {
                    const gangTiles = []; let removed = 0;
                    hand = hand.filter(t => { if (t.id === g.tileId && removed < 4) { gangTiles.push(t); removed++; return false; } return true; });
                    melds[seatKey] = [...(melds[seatKey] || []), { type: 'angang', tiles: gangTiles }];
                    const lingshang = deck.pop();
                    if (!lingshang) {
                        await backend.setGameState({ deck, hands: { ...hands, [seatKey]: hand }, melds, status: 'gameover', winResult: { winnerSeat: -1, winType: '流局' }, gameLog: [...log, '流局'] });
                        return;
                    }
                    hand = [...hand, lingshang];
                    if (checkWin(hand)) {
                        const score = calculateScore(hand, melds[seatKey], '嶺上自摸');
                        await backend.setGameState({ deck, hands: { ...hands, [seatKey]: hand }, melds, status: 'gameover', winResult: { winnerSeat: seat, winType: '嶺上自摸', ...score }, gameLog: [...log, `[${names[seat]}] 嶺上自摸！`] });
                        return;
                    }
                }
            }
        }

        // AI 隨機棄牌
        const discardIdx = Math.floor(Math.random() * hand.length);
        const discarded  = hand[discardIdx];
        hand = hand.filter((_, i) => i !== discardIdx);
        discards.push({ ...discarded, by: seat, claimed: false });
        log.push(`[${names[seat]}] 打出: ${discarded.label}`);
        hands = { ...hands, [seatKey]: hand };

        // 檢查其他真人玩家能否吃碰胡
        const promptResult = checkOtherPlayersCanRespond({ ...gs, seats: gs.seats }, hands, seat, discarded);
        if (promptResult) {
            await backend.setGameState({ deck, hands, melds, discards, actionPrompt: promptResult, gameLog: log });
        } else {
            await backend.setGameState({ deck, hands, melds, discards, currentSeat: (seat + 1) % 4, actionPrompt: null, drawnTileUid: null, gameLog: log });
        }
    }

    // ── 工具：深複製 hands/melds map ───────────────────────────────────
    function mapCopy(obj) {
        if (!obj) return { seat0: [], seat1: [], seat2: [], seat3: [] };
        return { seat0: [...(obj.seat0 || [])], seat1: [...(obj.seat1 || [])], seat2: [...(obj.seat2 || [])], seat3: [...(obj.seat3 || [])] };
    }

    // ══════════════════════════════════════════════════════════════════
    // 7. HostTableView（房主桌面視圖）
    // ══════════════════════════════════════════════════════════════════
    function HostTableView({ gameState: gs, backend }) {
        const lastActionId = useRef(null);

        // 房主遊戲引擎
        useEffect(() => {
            if (gs.status !== 'playing') return;

            // 處理玩家動作
            if (gs.pendingAction && gs.pendingAction !== lastActionId.current) {
                lastActionId.current = gs.pendingAction;
                processPendingAction(gs, backend);
                return;
            }

            // AI 回合自動推進
            if (gs.actionPrompt || gs.gangPrompt) return;
            const seats = gs.seats || [];
            const curSeat = gs.currentSeat;
            const pid = seats[curSeat];
            const isAI = !pid || pid.startsWith('ai_');
            if (!isAI) return;

            const timer = setTimeout(() => runAITurn(gs, backend, curSeat), 800);
            return () => clearTimeout(timer);
        }, [
            gs.status, gs.currentSeat, gs.pendingAction,
            gs.actionPrompt, gs.gangPrompt,
            gs.hands?.seat0?.length, gs.hands?.seat1?.length,
            gs.hands?.seat2?.length, gs.hands?.seat3?.length,
        ]);

        const seatNames = gs.seatNames || ['座位1', '座位2', '座位3', '座位4'];

        return (
            <div className="flex-1 flex flex-col bg-green-800 relative overflow-hidden select-none">
                {/* 輪次資訊橫幅 */}
                <div className="flex items-center justify-between px-3 py-1.5 bg-black/40 text-xs text-white flex-shrink-0">
                    <span className="text-green-300">牌庫 <span className="text-yellow-300 font-bold">{gs.deck?.length ?? 0}</span> 張</span>
                    <span className="font-bold text-yellow-400">
                        {gs.status === 'playing' ? `${seatNames[gs.currentSeat]} 的回合` : '等待開始'}
                    </span>
                    <span className="text-green-300">桌面視圖</span>
                </div>

                {/* 上方 座位2（對家） */}
                <div className="flex justify-center items-start pt-2 px-4 flex-shrink-0" style={{ minHeight: '80px' }}>
                    <SeatDisplay idx={2} gs={gs} seatNames={seatNames} compact={false} />
                </div>

                {/* 中間行：左 座位3 + 棄牌區 + 右 座位1 */}
                <div className="flex flex-1 items-center gap-2 px-2 min-h-0">
                    {/* 左方 座位3 */}
                    <div className="flex flex-col items-center flex-shrink-0" style={{ width: '70px' }}>
                        <SeatDisplay idx={3} gs={gs} seatNames={seatNames} vertical compact />
                    </div>

                    {/* 中央棄牌區 */}
                    <div className="flex-1 min-w-0">
                        <HostDiscardArea gs={gs} />
                    </div>

                    {/* 右方 座位1 */}
                    <div className="flex flex-col items-center flex-shrink-0" style={{ width: '70px' }}>
                        <SeatDisplay idx={1} gs={gs} seatNames={seatNames} vertical compact />
                    </div>
                </div>

                {/* 下方 座位0（莊家/東家） */}
                <div className="flex justify-center items-end pb-2 px-4 flex-shrink-0" style={{ minHeight: '80px' }}>
                    <SeatDisplay idx={0} gs={gs} seatNames={seatNames} compact={false} />
                </div>

                {/* 動作提示字幕（誰在做什麼） */}
                {gs.actionPrompt && (
                    <div className="absolute bottom-20 left-0 right-0 flex justify-center z-30 pointer-events-none">
                        <div className="bg-black/70 text-yellow-300 text-sm font-bold px-4 py-2 rounded-xl border border-yellow-600">
                            {seatNames[gs.actionPrompt.forSeat]} 可以回應 {gs.actionPrompt.options.map(o => ({ win: '胡', pong: '碰', chow: '吃', dagang: '槓' }[o] || o)).join('/')} ➜ {seatNames[gs.actionPrompt.from]} 打的 {gs.actionPrompt.tile?.label}
                        </div>
                    </div>
                )}

                {/* 結算 */}
                {gs.status === 'gameover' && gs.winResult && (
                    <WinOverlay winResult={gs.winResult} seatNames={seatNames} backend={backend} />
                )}
            </div>
        );
    }

    // ══════════════════════════════════════════════════════════════════
    // 8. PlayerHandView（玩家手牌視圖）
    // ══════════════════════════════════════════════════════════════════
    function PlayerHandView({ gameState: gs, mySeat, myPlayerId, backend }) {
        const seatKey = `seat${mySeat}`;
        const hand    = gs.hands?.[seatKey] || [];
        const myMelds = gs.melds?.[seatKey] || [];
        const ap      = gs.actionPrompt;
        const gp      = gs.gangPrompt;
        const isMyTurn         = gs.currentSeat === mySeat;
        const isMyActionPrompt = ap && ap.forSeat === mySeat;
        const isMyGangPrompt   = gp && gp.forSeat === mySeat;
        const seatNames = gs.seatNames || [];

        const canDiscard = isMyTurn && !ap && !gp && hand.length % 3 === 2;

        const handleDiscard = async (tile) => {
            if (!canDiscard) return;
            await backend.postAction({ seat: mySeat, type: 'discard', tile });
        };

        const handleAction = async (type, extra = {}) => {
            await backend.postAction({ seat: mySeat, type, ...extra });
        };

        if (mySeat < 0) {
            return (
                <div className="flex-1 flex items-center justify-center bg-green-900 text-white text-center p-6">
                    <div>
                        <p className="text-5xl mb-4">👁️</p>
                        <p className="text-xl font-bold text-yellow-400 mb-2">觀戰模式</p>
                        <p className="text-gray-300 text-sm">你沒有座位，靜待下局</p>
                    </div>
                </div>
            );
        }

        return (
            <div className="flex-1 flex flex-col bg-green-800 overflow-hidden text-white relative">
                {/* 狀態列 */}
                <div className="flex items-center justify-between px-3 py-2 bg-black/30 text-xs flex-shrink-0">
                    <span>牌庫: <span className="text-yellow-300 font-bold">{gs.deck?.length ?? 0}</span></span>
                    <span className={`font-bold ${isMyTurn ? 'text-yellow-400 animate-pulse' : 'text-gray-300'}`}>
                        {isMyTurn ? '▶ 你的回合' : `${seatNames[gs.currentSeat] || '?'} 的回合`}
                    </span>
                    <span className="text-green-300">座位 {mySeat + 1}</span>
                </div>

                {/* 其他座位牌數概覽 */}
                <div className="flex justify-around px-2 py-1.5 bg-green-900/60 text-xs flex-shrink-0">
                    {[0, 1, 2, 3].filter(s => s !== mySeat).map(s => {
                        const n = gs.hands?.[`seat${s}`]?.length ?? 0;
                        return (
                            <div key={s} className={`text-center px-2 py-0.5 rounded ${gs.currentSeat === s ? 'bg-yellow-900/60 border border-yellow-600' : ''}`}>
                                <div className="text-gray-300 truncate max-w-[60px]">{seatNames[s] || `座${s + 1}`}</div>
                                <div className="text-yellow-300 font-bold">{n}張</div>
                            </div>
                        );
                    })}
                </div>

                {/* 中央棄牌區 */}
                <div className="flex-1 mx-2 my-1 bg-green-900/50 rounded-xl p-2 overflow-y-auto flex flex-wrap content-start gap-0.5 min-h-0">
                    {(gs.discards || []).map((t, i) => (
                        <Tile key={`d${i}`} tile={t} isDiscard isClaimed={t.claimed} />
                    ))}
                    {(gs.discards || []).length === 0 && (
                        <div className="text-green-700 text-xs w-full text-center py-4">棄牌區（空）</div>
                    )}
                </div>

                {/* 我的副露 */}
                {myMelds.length > 0 && (
                    <div className="flex gap-1 px-2 py-1 flex-wrap flex-shrink-0">
                        {myMelds.map((meld, i) => (
                            <div key={i} className="flex gap-px bg-green-950/40 px-1 py-0.5 rounded border border-green-800">
                                {meld.tiles.map((t, ti) => (
                                    <Tile key={t.uid} tile={t} isOpenMeld
                                        isAngangHidden={meld.type === 'angang' && (ti === 1 || ti === 2)} />
                                ))}
                            </div>
                        ))}
                    </div>
                )}

                {/* 我的手牌 */}
                <div className={`flex flex-wrap justify-center gap-0.5 px-2 pb-2 flex-shrink-0 ${canDiscard ? 'cursor-pointer' : ''}`}>
                    {hand.map((tile) => (
                        <Tile key={tile.uid} tile={tile}
                            onClick={() => handleDiscard(tile)}
                            isDrawn={gs.drawnTileUid === tile.uid} />
                    ))}
                    {hand.length === 0 && isMyTurn && (
                        <div className="text-green-600 text-sm py-2">等待摸牌...</div>
                    )}
                </div>

                {/* 操作提示：等待摸牌 */}
                {isMyTurn && !canDiscard && !ap && !gp && hand.length % 3 !== 2 && (
                    <div className="absolute bottom-16 left-0 right-0 flex justify-center pointer-events-none">
                        <div className="bg-black/60 text-yellow-300 text-xs px-3 py-1.5 rounded-full animate-pulse">等待摸牌...</div>
                    </div>
                )}

                {/* 動作提示 Popup */}
                {isMyActionPrompt && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/60 z-40">
                        <div className="bg-green-800/98 p-5 rounded-2xl border-4 border-yellow-500 flex flex-col items-center gap-3 shadow-2xl mx-4">
                            <p className="text-white font-bold text-base">{seatNames[ap.from] || `座位${ap.from + 1}`} 打出了：</p>
                            <div className="transform scale-110 mb-1">
                                <Tile tile={ap.tile} large />
                            </div>
                            <div className="flex gap-2 flex-wrap justify-center">
                                {ap.options.includes('win') && (
                                    <button onClick={() => handleAction('win')} className="bg-red-600 hover:bg-red-500 text-white px-5 py-2.5 rounded-xl font-bold border-2 border-red-400 text-lg">胡</button>
                                )}
                                {ap.options.includes('pong') && (
                                    <button onClick={() => handleAction('pong')} className="bg-yellow-600 hover:bg-yellow-500 text-white px-5 py-2.5 rounded-xl font-bold border-2 border-yellow-400 text-lg">碰</button>
                                )}
                                {ap.options.includes('dagang') && (
                                    <button onClick={() => handleAction('dagang')} className="bg-purple-600 hover:bg-purple-500 text-white px-5 py-2.5 rounded-xl font-bold border-2 border-purple-400 text-lg">槓</button>
                                )}
                                {ap.options.includes('chow') && (ap.chowCombos || []).map((combo, ci) => (
                                    <button key={ci} onClick={() => handleAction('chow', { combo })}
                                        className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-2.5 rounded-xl font-bold border-2 border-blue-400">
                                        吃 {combo[0].label}{combo[1].label}
                                    </button>
                                ))}
                                <button onClick={() => handleAction('skip')} className="bg-gray-600 hover:bg-gray-500 text-white px-5 py-2.5 rounded-xl font-bold border-2 border-gray-400 text-lg">過</button>
                            </div>
                        </div>
                    </div>
                )}

                {/* 槓宣告提示 */}
                {isMyGangPrompt && (
                    <div className="absolute bottom-24 left-0 right-0 flex justify-center z-30">
                        <div className="bg-green-800/98 px-4 py-3 rounded-xl border-2 border-purple-500 flex gap-2 items-center shadow-2xl">
                            <span className="text-white text-sm font-bold mr-1">可宣告槓：</span>
                            {(gp.options || []).map((opt, i) => (
                                <button key={i} onClick={() => handleAction('gang', { gangOpt: opt })}
                                    className="bg-purple-600 hover:bg-purple-500 text-white px-3 py-1.5 rounded-lg font-bold border border-purple-400 text-sm">
                                    {opt.type === 'angang' ? '暗' : '明'}槓 {TILE_TYPES[opt.tileId].label}
                                </button>
                            ))}
                            <button onClick={() => handleAction('skipgang')}
                                className="bg-gray-600 hover:bg-gray-500 text-white px-3 py-1.5 rounded-lg font-bold border border-gray-400 text-sm">不槓</button>
                        </div>
                    </div>
                )}

                {/* 結算 */}
                {gs.status === 'gameover' && gs.winResult && (
                    <WinOverlay winResult={gs.winResult} seatNames={seatNames} backend={backend} />
                )}
            </div>
        );
    }

    // ══════════════════════════════════════════════════════════════════
    // 9. GameLobby（等待大廳）
    // ══════════════════════════════════════════════════════════════════
    function GameLobby({ gs, isHost, myPlayerId, myPlayerName, backend, roomId }) {
        const seats     = gs?.seats     || [null, null, null, null];
        const seatNames = gs?.seatNames || ['', '', '', ''];
        const mySeat    = seats.indexOf(myPlayerId);

        const handleSitDown = async (seatIdx) => {
            if (seats[seatIdx] !== null) return;
            const newSeats = [...seats];
            const newNames = [...seatNames];
            newSeats[seatIdx]  = myPlayerId;
            newNames[seatIdx]  = myPlayerName;
            await backend.setGameState({ seats: newSeats, seatNames: newNames });
        };

        const handleStandUp = async () => {
            if (mySeat < 0) return;
            const newSeats = [...seats];
            const newNames = [...seatNames];
            newSeats[mySeat] = null;
            newNames[mySeat] = '';
            await backend.setGameState({ seats: newSeats, seatNames: newNames });
        };

        const handleStartGame = async () => {
            if (!isHost) return;
            // 補足空座位為 AI
            const finalSeats = seats.map((s, i) => s || `ai_${i}`);
            const finalNames = seatNames.map((n, i) => n || ['東家AI', '南家AI', '西家AI', '北家AI'][i]);
            // 洗牌發牌
            const deck = generateDeck();
            const hands = {};
            for (let i = 0; i < 4; i++) {
                const hand = [];
                for (let j = 0; j < 16; j++) hand.push(deck.pop());
                // 真人座位排序手牌
                if (!finalSeats[i].startsWith('ai_')) hand.sort((a, b) => a.id - b.id);
                hands[`seat${i}`] = hand;
            }
            // 莊家（座位0）多摸一張
            const firstDraw = deck.pop();
            hands['seat0'] = [...hands['seat0'], firstDraw];

            await backend.initGame({
                status:       'playing',
                seats:        finalSeats,
                seatNames:    finalNames,
                deck,
                hands,
                melds:        { seat0: [], seat1: [], seat2: [], seat3: [] },
                discards:     [],
                currentSeat:  0,
                drawnTileUid: firstDraw.uid,
                actionPrompt: null,
                gangPrompt:   null,
                winResult:    null,
                gameLog:      ['=== 對局開始 ===', `[座位0(${finalNames[0]})] 莊家摸牌: ${firstDraw.label}`],
                pendingAction: null,
            });
        };

        const seatWinds = ['東', '南', '西', '北'];
        return (
            <div className="flex-1 flex flex-col p-4 overflow-y-auto text-white">
                <div className="text-center mb-5">
                    <h2 className="text-2xl font-bold text-yellow-400">🀄 台灣麻將</h2>
                    <p className="text-green-300 text-sm mt-1">區域多人 · 4 座位（未滿由 AI 補）</p>
                </div>

                {/* 座位選擇 */}
                <div className="grid grid-cols-2 gap-3 mb-5">
                    {[0, 1, 2, 3].map(i => {
                        const pid   = seats[i];
                        const name  = seatNames[i];
                        const isMe  = pid === myPlayerId;
                        const isAI  = pid && pid.startsWith('ai_');
                        const empty = !pid;
                        return (
                            <button key={i}
                                onClick={() => { if (empty && mySeat < 0) handleSitDown(i); }}
                                className={`p-3 rounded-xl border-2 text-sm font-semibold transition-all text-left
                                    ${isMe    ? 'border-yellow-400 bg-yellow-900/50 text-yellow-300' :
                                      isAI    ? 'border-gray-600 bg-gray-800/50 text-gray-400 cursor-default' :
                                      pid     ? 'border-green-500 bg-green-900/50 text-green-300 cursor-default' :
                                      mySeat >= 0 ? 'border-dashed border-gray-600 bg-black/20 text-gray-500 cursor-default' :
                                                'border-dashed border-gray-500 bg-black/20 text-gray-400 hover:border-yellow-400 hover:text-yellow-300 cursor-pointer'}`}
                            >
                                <div className="text-xs text-gray-400 mb-0.5">{seatWinds[i]}家</div>
                                {empty
                                    ? <div>空位（點擊入座）</div>
                                    : <div>{name || '玩家'}{isMe ? ' 👈 我' : ''}</div>
                                }
                            </button>
                        );
                    })}
                </div>

                {/* 已入座：可以退座 */}
                {mySeat >= 0 && (
                    <button onClick={handleStandUp}
                        className="w-full mb-3 py-2 bg-gray-700 hover:bg-gray-600 text-gray-300 rounded-xl text-sm font-semibold border border-gray-600">
                        退出座位
                    </button>
                )}

                {/* 房主開局 */}
                {isHost ? (
                    <button onClick={handleStartGame}
                        className="w-full py-3.5 bg-red-700 hover:bg-red-600 text-white rounded-xl font-bold text-lg border-2 border-red-500 shadow-lg transition-all hover:scale-[1.02]">
                        開始對局（空座由 AI 填補）
                    </button>
                ) : (
                    <div className="text-center text-gray-400 text-sm mt-2 py-3 border border-gray-700 rounded-xl">
                        等待房主開始對局...
                    </div>
                )}

                {/* 提示 */}
                <div className="mt-4 p-3 bg-black/30 rounded-xl text-xs text-gray-400 space-y-1">
                    <p>💡 <strong className="text-gray-300">房主</strong>是桌面，可看到全場座位與棄牌</p>
                    <p>🀄 <strong className="text-gray-300">玩家</strong>看自己手牌，輪到自己時點牌棄牌</p>
                    <p>🤖 未滿 4 人時，AI 自動填補並由房主控制</p>
                </div>
            </div>
        );
    }

    // ══════════════════════════════════════════════════════════════════
    // 10. MahjongGame Root Component
    // ══════════════════════════════════════════════════════════════════
    function MahjongGame({ roomId, isHost, myPlayerId, myPlayerName, backend }) {
        const [gameState, setGameState] = useState(null);

        // 訂閱 Firebase 遊戲狀態
        useEffect(() => {
            if (!roomId) return;
            const unsub = backend.onGameState(gs => setGameState(gs));
            return unsub;
        }, [roomId]);

        if (!gameState) return <LoadingView />;

        const status  = gameState.status || 'idle';
        const mySeat  = (gameState.seats || []).indexOf(myPlayerId);
        const seatNames = gameState.seatNames || [];

        if (status === 'idle') {
            return (
                <GameLobby
                    gs={gameState}
                    isHost={isHost}
                    myPlayerId={myPlayerId}
                    myPlayerName={myPlayerName}
                    backend={backend}
                    roomId={roomId}
                />
            );
        }

        if (status === 'playing' || status === 'gameover') {
            if (isHost) {
                return <HostTableView gameState={gameState} backend={backend} />;
            } else {
                return (
                    <PlayerHandView
                        gameState={gameState}
                        mySeat={mySeat}
                        myPlayerId={myPlayerId}
                        backend={backend}
                    />
                );
            }
        }
        return <LoadingView />;
    }

    // ══════════════════════════════════════════════════════════════════
    // 11. 掛載邏輯：監聽 room-enter / room-leave 事件
    // ══════════════════════════════════════════════════════════════════
    let _mahjongRoot = null;

    window.addEventListener('mahjong:room-enter', (e) => {
        const { roomId, isHost, myPlayerId, myPlayerName } = e.detail;
        const ctx = getCtx();
        if (!ctx) { console.warn('[MahjongGame] Firebase context not ready'); return; }

        const backend = makeLocalGameBackend(ctx, roomId);
        const container = document.getElementById('mahjong-root');
        if (!container) return;

        if (_mahjongRoot) { try { _mahjongRoot.unmount(); } catch (_) { } _mahjongRoot = null; }
        _mahjongRoot = ReactDOM.createRoot(container);
        _mahjongRoot.render(
            React.createElement(MahjongGame, { roomId, isHost, myPlayerId, myPlayerName, backend })
        );
    });

    window.addEventListener('mahjong:room-leave', () => {
        if (_mahjongRoot) { try { _mahjongRoot.unmount(); } catch (_) { } _mahjongRoot = null; }
        const container = document.getElementById('mahjong-root');
        if (container) container.innerHTML = '';
    });

})();
