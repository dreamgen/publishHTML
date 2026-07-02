// ══════════════════════════════════════════════════════════════════════
// mahjong-game.js — 台灣麻將多人版（區域房間試作）
// 使用 React 18 UMD + Babel Standalone，透過 window._gameContext 存取 Firebase
// [2026 UI/UX 優化版 - 支援防呆出牌、直向雙排、房主管理與特效]
// ══════════════════════════════════════════════════════════════════════
(function () {
    const { useState, useEffect, useRef, useCallback } = React;

    // ── 取得 Firebase Context ──────────────────────────────────────────
    function getCtx() { return window._gameContext; }

    // ══════════════════════════════════════════════════════════════════
    // 1. 麻將常數與牌庫
    // ══════════════════════════════════════════════════════════════════
    const TILE_TYPES = [
        ...Array.from({ length: 9 }, (_, i) => ({ id: i, suit: 'wan', value: i + 1, label: `${i + 1}萬` })),
        ...Array.from({ length: 9 }, (_, i) => ({ id: i + 9, suit: 'tong', value: i + 1, label: `${i + 1}筒` })),
        ...Array.from({ length: 9 }, (_, i) => ({ id: i + 18, suit: 'suo', value: i + 1, label: `${i + 1}索` })),
        { id: 27, suit: 'feng', value: 'dong', label: '東' },
        { id: 28, suit: 'feng', value: 'nan', label: '南' },
        { id: 29, suit: 'feng', value: 'xi', label: '西' },
        { id: 30, suit: 'feng', value: 'bei', label: '北' },
        { id: 31, suit: 'yuan', value: 'zhong', label: '中' },
        { id: 32, suit: 'yuan', value: 'fa', label: '發' },
        { id: 33, suit: 'yuan', value: 'bai', label: '白' },
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
    // 2. 胡牌判定
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
    // 3. 吃牌組合
    // ══════════════════════════════════════════════════════════════════
    function getChowCombos(hand, discardedTile, fromSeat, forSeat) {
        if (fromSeat !== (forSeat + 3) % 4) return [];
        if (discardedTile.id >= 27) return [];
        const id = discardedTile.id;
        const has = (offset) => hand.find(t => t.id === id + offset);
        const combos = [];
        if (id % 9 >= 2 && has(-2) && has(-1)) combos.push([has(-2), has(-1)]);
        if (id % 9 >= 1 && id % 9 <= 7 && has(-1) && has(1)) combos.push([has(-1), has(1)]);
        if (id % 9 <= 6 && has(1) && has(2)) combos.push([has(1), has(2)]);
        return combos;
    }

    // ══════════════════════════════════════════════════════════════════
    // 4. GameBackend 抽象層
    // ══════════════════════════════════════════════════════════════════
    function makeLocalGameBackend(ctx, roomId) {
        const gPath = ctx.GAME_ROOT(roomId);
        const gRef = (sub) => ctx.ref(ctx.db, sub ? `${gPath}/${sub}` : gPath);
        return {
            onGameState: (cb) => {
                const r = gRef();
                ctx.onValue(r, snap => {
                    const val = snap.exists() ? snap.val() : { status: 'idle' };
                    if (val.seats) val.seats = Array.from({ length: 4 }, (_, i) => val.seats[i] ?? null);
                    if (val.seatNames) val.seatNames = Array.from({ length: 4 }, (_, i) => val.seatNames[i] ?? '');
                    cb(val);
                });
                return () => ctx.off(r);
            },
            setGameState: (patch) => ctx.update(gRef(), patch),
            initGame: (state) => ctx.set(gRef(), state),
            postAction: (action) => ctx.set(gRef('pendingAction'), action),
            clearAction: () => ctx.set(gRef('pendingAction'), null),
            resetGame: () => ctx.update(gRef(), { status: 'idle', pendingAction: null, winResult: null }),
        };
    }

    // ══════════════════════════════════════════════════════════════════
    // 5. React 元件 (UI 優化核心)
    // ══════════════════════════════════════════════════════════════════

    // ── Tile 元件 ──────────────────────────────────────────────────────
    const Tile = ({ tile, isHidden, onClick, isDiscard, isMeld, isOpenMeld, isAngangHidden, large, isClaimed, isDrawn, small, isHostHidden, isHostDiscard, isHostMeld }) => {
        // 牌背 (隱藏的牌)
        if (isHidden) {
            let hiddenClass = isHostHidden
                ? "w-[7.5vw] max-w-[36px] h-[11.5vw] max-h-[54px] sm:w-10 sm:h-14 md:w-12 md:h-18" // 房主版隱藏牌較大
                : small 
                    ? "w-[5vw] max-w-[24px] h-[7.5vw] max-h-[36px] sm:w-6 sm:h-10" 
                    : "w-[8.5vw] max-w-[28px] h-[12.5vw] max-h-[40px] sm:w-8 sm:h-12 md:w-10 md:h-14";
            
            return (
                <div className={`${hiddenClass} bg-gradient-to-b from-emerald-600 to-emerald-800 rounded-sm shadow-[1px_2px_4px_rgba(0,0,0,0.4)] border-b-[3px] border-l-[1px] border-emerald-900 m-[1px] flex-shrink-0 transition-transform`}></div>
            );
        }

        // 判斷顏色
        let textColor = "text-gray-900";
        if (tile.suit === 'wan') textColor = "text-red-700";
        if (tile.suit === 'tong') textColor = "text-blue-800";
        if (tile.suit === 'suo') textColor = "text-green-700";
        if (tile.suit === 'yuan') {
            if (tile.value === 'zhong') textColor = "text-red-600";
            if (tile.value === 'fa') textColor = "text-green-600";
        }

        // 依據不同情境與直橫向設定尺寸
        // 玩家手牌 (區分 portrait 與 landscape)
        let sizeClass = "w-[12vw] min-w-[36px] max-w-[64px] h-[18vw] min-h-[54px] max-h-[96px] text-[5.5vw] " + // portrait (直向放大)
                        "landscape:w-[6.5vw] landscape:min-w-[24px] landscape:max-w-[48px] landscape:h-[10vw] landscape:min-h-[36px] landscape:max-h-[72px] landscape:text-[4vw] " + // landscape (橫向維持單排)
                        "sm:w-12 sm:h-16 md:w-16 md:h-24 sm:text-xl md:text-3xl border-b-[3px] border-l-[1px] shadow-md cursor-pointer";

        if (small) {
            sizeClass = "w-[6vw] max-w-[32px] h-[8.5vw] max-h-[48px] sm:w-8 sm:h-11 md:w-10 md:h-14 text-[3.5vw] sm:text-sm md:text-base border-b-[2px] border-l-[1px]";
        }
        if (isDiscard) {
            sizeClass = isHostDiscard 
                ? "w-[8vw] max-w-[48px] h-[12vw] max-h-[72px] sm:w-11 sm:h-16 md:w-14 md:h-20 text-[4.5vw] sm:text-lg md:text-2xl border-b-[3px] border-l-[1px] shadow-md"
                : "w-[6vw] max-w-[38px] h-[9vw] max-h-[56px] sm:w-9 sm:h-12 md:w-11 md:h-16 text-[3.8vw] sm:text-base md:text-lg border-b-[2px] border-l-[1px] shadow-sm";
        }
        if (isOpenMeld) {
            sizeClass = isHostMeld
                ? "w-[8vw] max-w-[42px] h-[12vw] max-h-[64px] sm:w-12 sm:h-16 md:w-14 md:h-20 text-[4.5vw] sm:text-xl md:text-2xl border-b-[2px] border-l-[1px] shadow-sm cursor-default"
                : "w-[7vw] max-w-[40px] h-[10vw] max-h-[60px] sm:w-10 sm:h-14 md:w-12 md:h-18 text-[4vw] sm:text-lg md:text-xl border-b-[2px] border-l-[1px] shadow-sm cursor-default";
        }
        if (large) {
            sizeClass = "w-14 h-20 sm:w-16 sm:h-24 md:w-20 md:h-28 text-3xl sm:text-4xl md:text-5xl border-b-[4px] border-l-[2px] shadow-xl";
        }

        const claimedStyle = isClaimed ? "opacity-40 grayscale brightness-50 pointer-events-none" : "";
        const bgStyle = isOpenMeld
            ? "bg-gradient-to-br from-[#fef3c7] to-[#fde68a]" // 副露略帶琥珀色
            : isDrawn
                ? "ring-4 ring-yellow-400 shadow-[0_0_20px_rgba(250,204,21,0.8)] z-10 bg-gradient-to-br from-[#fef08a] to-[#fde047]"
                : "bg-gradient-to-br from-[#fdfbf7] to-[#fef3c7]"; // 帶點象牙白的麻將色

        const isBai = tile.suit === 'yuan' && tile.value === 'bai';

        return (
            <div onClick={onClick}
                className={`relative rounded-md border-gray-400 flex flex-col justify-center items-center m-[1px] sm:m-[1.5px] font-bold select-none transition-colors duration-200 ${sizeClass} ${claimedStyle} ${bgStyle}`}>

                {/* 白板特殊處理：藍色空心框 */}
                {isBai ? (
                    <div className="w-[70%] h-[70%] border-[2px] sm:border-[3px] border-blue-500 rounded-sm"></div>
                ) : (
                    <>
                        <span className={`${textColor} leading-none`}>{tile.label.substring(0, 1)}</span>
                        {tile.label.length > 1 && <span className={`${textColor} text-[0.6em] leading-none mt-1`}>{tile.label.substring(1)}</span>}
                    </>
                )}

                {/* 暗槓覆蓋層 */}
                {isAngangHidden && <div className="absolute inset-0 bg-gradient-to-b from-emerald-600 to-emerald-800 rounded-md border-b-[3px] border-l-[1px] border-emerald-950"></div>}
            </div>
        );
    };

    // ── LoadingView ────────────────────────────────────────────────────
    function LoadingView() {
        return (
            <div className="flex-1 flex items-center justify-center bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-green-800 to-green-950">
                <div className="text-center text-green-300">
                    <div className="w-10 h-10 border-4 border-yellow-400 border-t-transparent rounded-full animate-spin mx-auto mb-3 shadow-[0_0_15px_rgba(250,204,21,0.5)]"></div>
                    <p className="text-sm font-bold tracking-widest">載入牌局中...</p>
                </div>
            </div>
        );
    }

    // ── WinOverlay 結算畫面 ─────────────────────────────────────────────
    function WinOverlay({ winResult, seatNames, isHost, onReturn }) {
        const { winnerSeat, winType, yaku, totalFan } = winResult;
        const isFlowGame = winnerSeat < 0 || winType === '流局';
        const winnerName = !isFlowGame ? (seatNames[winnerSeat] || `座位${winnerSeat + 1}`) : null;
        return (
            <div className="absolute inset-0 bg-black/80 backdrop-blur-md flex flex-col items-center justify-center z-[100] p-4 animate-[fadeIn_0.3s_ease-out]">
                {!isFlowGame && <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-yellow-500/20 via-transparent to-transparent animate-pulse pointer-events-none"></div>}

                <h2 className={`text-4xl sm:text-6xl md:text-7xl font-black mb-3 drop-shadow-[0_5px_15px_rgba(0,0,0,0.8)] z-10 ${isFlowGame ? 'text-gray-300' : 'text-transparent bg-clip-text bg-gradient-to-b from-yellow-300 to-yellow-600'}`}>
                    {isFlowGame ? '流局（平手）' : `${winnerName} 胡牌！`}
                </h2>
                {winType && !isFlowGame && <p className="text-yellow-200 text-xl sm:text-2xl mb-6 tracking-[0.2em] font-bold z-10 drop-shadow-md">{winType}</p>}

                {yaku && yaku.length > 0 && (
                    <div className="bg-black/50 border border-yellow-600/50 rounded-2xl px-6 sm:px-10 py-5 mb-8 text-center z-10 shadow-2xl backdrop-blur-sm max-w-2xl w-full">
                        <div className="flex flex-wrap justify-center gap-x-4 gap-y-2 mb-4">
                            {yaku.map((y, i) => (
                                <span key={i} className="text-green-200 text-lg sm:text-xl">{y.name} <span className="text-yellow-400 font-bold ml-1">+{y.fan}台</span></span>
                            ))}
                        </div>
                        <div className="text-yellow-400 text-3xl sm:text-4xl font-black border-t border-yellow-600/30 pt-4">共 {totalFan} 台</div>
                    </div>
                )}
                
                {isHost ? (
                    <button onClick={onReturn}
                        className="bg-gradient-to-b from-emerald-500 to-emerald-700 hover:from-emerald-400 hover:to-emerald-600 text-white px-10 py-4 rounded-full text-xl sm:text-2xl font-black border-2 border-emerald-300 shadow-[0_0_30px_rgba(52,211,153,0.4)] mt-4 transition-transform hover:scale-105 active:scale-95 z-10">
                        返回大廳 (重新入座)
                    </button>
                ) : (
                    <div className="text-white text-lg mt-6 animate-pulse z-10 font-bold tracking-widest bg-black/50 px-6 py-3 rounded-full">等待房主返回大廳...</div>
                )}
            </div>
        );
    }

    // ── SeatDisplay（桌面視圖旁觀用）────────────────────────────────────
    function SeatDisplay({ idx, gs, seatNames, vertical, compact, hostView }) {
        const seatKey = `seat${idx}`;
        const hand = gs.hands?.[seatKey] || [];
        const myMelds = gs.melds?.[seatKey] || [];
        const isCurrent = gs.currentSeat === idx;
        const tileCount = hand.length;

        // 偵測是否離線
        const pid = gs.seats ? gs.seats[idx] : null;
        const isAI = pid && pid.startsWith('ai_');
        let isOffline = false;
        if (!isAI && pid) {
            const ctx = getCtx();
            if (ctx) {
                const rp = ctx.getMyState().roomPlayers;
                if (rp && rp[pid] && !rp[pid].isOnline) {
                    isOffline = true;
                }
            }
        }

        return (
            <div className={`flex flex-col items-center gap-1 sm:gap-2 transition-all duration-300 ${isCurrent ? 'opacity-100 scale-105 drop-shadow-[0_0_15px_rgba(250,204,21,0.5)]' : 'opacity-70 scale-100'}`}>
                <div className={`text-[10px] sm:text-xs md:text-sm font-bold px-3 py-1 md:px-5 md:py-2 rounded-full shadow-md flex items-center gap-1
                  ${isCurrent ? 'bg-yellow-400 text-yellow-900 animate-pulse ring-4 ring-yellow-400/80' : 'bg-black/60 text-yellow-200 border border-yellow-900/50'}
                  ${isOffline ? 'grayscale opacity-70' : ''}`}>
                    {isOffline && <i className="ph ph-wifi-slash text-red-400"></i>}
                    {seatNames[idx] || `座位${idx + 1}`} {isCurrent && ' ▶'}
                </div>

                {compact ? (
                    <div className="text-yellow-300 text-xs font-bold bg-black/40 px-3 py-1.5 rounded-lg border border-black/50">{tileCount}張</div>
                ) : (
                    <div className={`flex ${vertical ? 'flex-col -space-y-4 sm:-space-y-6 md:-space-y-8' : '-space-x-1 sm:-space-x-2 md:-space-x-3'} z-10`}>
                        {hand.map((_, i) => (
                            <div key={i} style={{ zIndex: i }}>
                                <Tile isHidden isHostHidden={hostView} small={vertical} />
                            </div>
                        ))}
                    </div>
                )}

                {myMelds.length > 0 && (
                    <div className={`flex gap-1 flex-wrap justify-center ${vertical ? 'flex-col mt-2' : ''}`}>
                        {myMelds.map((meld, mi) => (
                            <div key={mi} className={`flex ${vertical ? 'flex-col gap-0.5' : 'gap-px'} bg-black/30 p-1 rounded-md border border-black/50`}>
                                {meld.tiles.map((t, ti) => (
                                    <div key={t.uid} className={vertical ? 'rotate-90 origin-center my-1' : ''}>
                                        <Tile tile={t} isOpenMeld isHostMeld={hostView} small={vertical}
                                            isAngangHidden={meld.type === 'angang' && (ti === 1 || ti === 2)} />
                                    </div>
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
                className="bg-black/20 rounded-2xl p-3 sm:p-5 overflow-y-auto flex flex-wrap content-start gap-1 sm:gap-2 shadow-[inset_0_4px_15px_rgba(0,0,0,0.3)] border border-green-800/50 h-full scroll-smooth">
                {(gs.discards || []).map((t, i) => (
                    <div key={`d${i}`} className="relative">
                        <Tile tile={t} isDiscard isHostDiscard isClaimed={t.claimed} />
                        {/* 最新打出的牌加上提示點 */}
                        {i === (gs.discards || []).length - 1 && !t.claimed && !gs.actionPrompt && (
                            <div className="absolute -top-1 -right-1 w-3 h-3 bg-red-500 rounded-full animate-ping z-10 shadow-md"></div>
                        )}
                    </div>
                ))}
                {(gs.discards || []).length === 0 && (
                    <div className="text-green-600/50 text-sm font-bold tracking-widest w-full h-full flex items-center justify-center">棄牌區將顯示於此</div>
                )}
            </div>
        );
    }

    // ══════════════════════════════════════════════════════════════════
    // 6. 房主遊戲引擎（純函式）
    // ══════════════════════════════════════════════════════════════════
    async function processPendingAction(gs, backend) {
        const pa = gs.pendingAction;
        if (!pa || !pa.type) return;
        const { seat, type } = pa;
        const seatKey = `seat${seat}`;
        let hands = mapCopy(gs.hands);
        let melds = mapCopy(gs.melds);
        let discards = [...(gs.discards || [])];
        let deck = [...(gs.deck || [])];
        let log = [...(gs.gameLog || [])];
        const names = gs.seatNames || [];
        const ap = gs.actionPrompt;

        if (type === 'skip') {
            const nextSeat = ap ? (ap.from + 1) % 4 : (seat + 1) % 4;
            await backend.setGameState({ actionPrompt: null, currentSeat: nextSeat, pendingAction: null, gameLog: [...log, `[${names[seat]}] 過`] });
            return;
        }
        if (type === 'discard') {
            const tile = pa.tile;
            let hand = [...(hands[seatKey] || [])].filter(t => t.uid !== tile.uid).sort((a, b) => a.id - b.id);
            discards.push({ ...tile, by: seat, claimed: false });
            const promptResult = checkOtherPlayersCanRespond(gs, hands, seat, tile);
            if (promptResult) {
                await backend.setGameState({ hands: { ...hands, [seatKey]: hand }, discards, actionPrompt: promptResult, pendingAction: null, drawnTileUid: null, gameLog: [...log, `[${names[seat]}] 打出: ${tile.label}`] });
            } else {
                await backend.setGameState({ hands: { ...hands, [seatKey]: hand }, discards, currentSeat: (seat + 1) % 4, pendingAction: null, actionPrompt: null, drawnTileUid: null, gameLog: [...log, `[${names[seat]}] 打出: ${tile.label}`] });
            }
            return;
        }
        if (type === 'win') {
            const tile = ap?.tile;
            let hand = [...(hands[seatKey] || [])];
            if (tile) { hand = [...hand, tile].sort((a, b) => a.id - b.id); }
            if (discards.length > 0) discards[discards.length - 1] = { ...discards[discards.length - 1], claimed: true };
            const score = calculateScore(hand, melds[seatKey] || [], tile ? '放槍' : '自摸');
            await backend.setGameState({ hands: { ...hands, [seatKey]: hand }, discards, status: 'gameover', winResult: { winnerSeat: seat, winType: tile ? '放槍' : '自摸', ...score }, pendingAction: null, actionPrompt: null, gameLog: [...log, `[${names[seat]}] 胡牌！(${tile ? `放槍: ${names[ap.from]}打${tile.label}` : '自摸'})`] });
            return;
        }
        if (type === 'pong') {
            const tile = ap.tile;
            let hand = [...(hands[seatKey] || [])];
            const matches = hand.filter(t => t.id === tile.id).slice(0, 2);
            hand = hand.filter(t => !matches.includes(t));
            melds[seatKey] = [...(melds[seatKey] || []), { type: 'pong', tiles: [tile, ...matches] }];
            if (discards.length > 0) discards[discards.length - 1] = { ...discards[discards.length - 1], claimed: true };
            await backend.setGameState({ hands: { ...hands, [seatKey]: hand }, melds, discards, actionPrompt: null, currentSeat: seat, pendingAction: null, gameLog: [...log, `[${names[seat]}] 碰 ${tile.label}`] });
            return;
        }
        if (type === 'chow') {
            const tile = ap.tile;
            const combo = pa.combo;
            let hand = [...(hands[seatKey] || [])].filter(t => t.uid !== combo[0].uid && t.uid !== combo[1].uid);
            melds[seatKey] = [...(melds[seatKey] || []), { type: 'chow', tiles: [tile, ...combo].sort((a, b) => a.id - b.id) }];
            if (discards.length > 0) discards[discards.length - 1] = { ...discards[discards.length - 1], claimed: true };
            await backend.setGameState({ hands: { ...hands, [seatKey]: hand }, melds, discards, actionPrompt: null, currentSeat: seat, pendingAction: null, gameLog: [...log, `[${names[seat]}] 吃 ${tile.label}`] });
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
            if (!lingshang) { await backend.setGameState({ deck, hands: { ...hands, [seatKey]: hand }, melds, discards, status: 'gameover', winResult: { winnerSeat: -1, winType: '流局' }, pendingAction: null, actionPrompt: null }); return; }
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
            if (!lingshang) { await backend.setGameState({ deck, hands: { ...hands, [seatKey]: hand }, melds, status: 'gameover', winResult: { winnerSeat: -1, winType: '流局' }, pendingAction: null }); return; }
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
        if (type === 'skipgang') { await backend.setGameState({ gangPrompt: null, pendingAction: null }); return; }
        await backend.clearAction();
    }

    function checkOtherPlayersCanRespond(gs, hands, fromSeat, discardedTile) {
        const seats = gs.seats || [];
        for (let s = 0; s < 4; s++) {
            if (s === fromSeat) continue;
            const pid = seats[s];
            if (!pid || pid.startsWith('ai_')) continue;
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

    async function runAITurn(gs, backend, seat) {
        const seatKey = `seat${seat}`;
        let deck = [...(gs.deck || [])];
        let hands = mapCopy(gs.hands);
        let melds = mapCopy(gs.melds);
        let discards = [...(gs.discards || [])];
        const names = gs.seatNames || [];
        let hand = [...(hands[seatKey] || [])];
        let log = [...(gs.gameLog || [])];

        const needsDraw = hand.length % 3 === 1;
        if (needsDraw) {
            const drawn = deck.pop();
            if (!drawn) { await backend.setGameState({ status: 'gameover', winResult: { winnerSeat: -1, winType: '流局' }, gameLog: [...log, '=== 流局 ==='] }); return; }
            hand = [...hand, drawn];
            log.push(`[${names[seat]}] 摸牌`);
            if (checkWin(hand)) {
                const score = calculateScore(hand, melds[seatKey] || [], '自摸');
                await backend.setGameState({ deck, hands: { ...hands, [seatKey]: hand }, status: 'gameover', winResult: { winnerSeat: seat, winType: '自摸', ...score }, gameLog: [...log, `[${names[seat]}] 自摸！`] });
                return;
            }
            const aiGangs = findGangOptions(hand, melds[seatKey] || []);
            if (aiGangs.length > 0) {
                const g = aiGangs[0];
                if (g.type === 'angang') {
                    const gangTiles = []; let removed = 0;
                    hand = hand.filter(t => { if (t.id === g.tileId && removed < 4) { gangTiles.push(t); removed++; return false; } return true; });
                    melds[seatKey] = [...(melds[seatKey] || []), { type: 'angang', tiles: gangTiles }];
                    const lingshang = deck.pop();
                    if (!lingshang) { await backend.setGameState({ deck, hands: { ...hands, [seatKey]: hand }, melds, status: 'gameover', winResult: { winnerSeat: -1, winType: '流局' }, gameLog: [...log, '流局'] }); return; }
                    hand = [...hand, lingshang];
                    if (checkWin(hand)) {
                        const score = calculateScore(hand, melds[seatKey], '嶺上自摸');
                        await backend.setGameState({ deck, hands: { ...hands, [seatKey]: hand }, melds, status: 'gameover', winResult: { winnerSeat: seat, winType: '嶺上自摸', ...score }, gameLog: [...log, `[${names[seat]}] 嶺上自摸！`] });
                        return;
                    }
                }
            }
        }
        const discardIdx = Math.floor(Math.random() * hand.length);
        const discarded = hand[discardIdx];
        hand = hand.filter((_, i) => i !== discardIdx);
        discards.push({ ...discarded, by: seat, claimed: false });
        log.push(`[${names[seat]}] 打出: ${discarded.label}`);
        hands = { ...hands, [seatKey]: hand };

        const promptResult = checkOtherPlayersCanRespond({ ...gs, seats: gs.seats }, hands, seat, discarded);
        if (promptResult) {
            await backend.setGameState({ deck, hands, melds, discards, actionPrompt: promptResult, gameLog: log });
        } else {
            await backend.setGameState({ deck, hands, melds, discards, currentSeat: (seat + 1) % 4, actionPrompt: null, drawnTileUid: null, gameLog: log });
        }
    }

    function mapCopy(obj) {
        if (!obj) return { seat0: [], seat1: [], seat2: [], seat3: [] };
        return { seat0: [...(obj.seat0 || [])], seat1: [...(obj.seat1 || [])], seat2: [...(obj.seat2 || [])], seat3: [...(obj.seat3 || [])] };
    }

    // ══════════════════════════════════════════════════════════════════
    // 7. HostTableView（房主桌面視圖）
    // ══════════════════════════════════════════════════════════════════
    function HostTableView({ gameState: gs, backend }) {
        const lastActionId = useRef(null);

        useEffect(() => {
            if (gs.status !== 'playing') return;
            if (gs.pendingAction && gs.pendingAction !== lastActionId.current) {
                lastActionId.current = gs.pendingAction;
                processPendingAction(gs, backend);
                return;
            }
            if (gs.actionPrompt || gs.gangPrompt) return;
            const seats = gs.seats || [];
            const curSeat = gs.currentSeat;
            const pid = seats[curSeat];
            const isAI = !pid || pid.startsWith('ai_');

            if (!isAI) {
                const chairHand = gs.hands?.[`seat${curSeat}`] || [];
                if (chairHand.length % 3 === 1) {
                    const timer = setTimeout(() => {
                        let deck = [...(gs.deck || [])];
                        const drawn = deck.pop();
                        if (!drawn) { backend.setGameState({ status: 'gameover', winResult: { winnerSeat: -1, winType: '流局' }, gameLog: [...(gs.gameLog || []), '=== 流局 ==='] }); return; }
                        const seatKey = `seat${curSeat}`;
                        let hands = mapCopy(gs.hands);
                        hands[seatKey] = [...(hands[seatKey] || []), drawn];
                        const seatNames = gs.seatNames || [];
                        backend.setGameState({ deck, hands, drawnTileUid: drawn.uid, gameLog: [...(gs.gameLog || []), `[${seatNames[curSeat] || '玩家'}] 摸牌`] });
                    }, 300);
                    return () => clearTimeout(timer);
                }
                return;
            }
            const timer = setTimeout(() => runAITurn(gs, backend, curSeat), 800);
            return () => clearTimeout(timer);
        }, [gs.status, gs.currentSeat, gs.pendingAction, gs.actionPrompt, gs.gangPrompt, gs.hands?.seat0?.length, gs.hands?.seat1?.length, gs.hands?.seat2?.length, gs.hands?.seat3?.length]);

        const seatNames = gs.seatNames || ['座位1', '座位2', '座位3', '座位4'];

        // 房主專屬：結束遊戲並清空AI返回大廳
        const handleReturnToLobby = () => {
            const currentSeats = gs.seats || [];
            const currentNames = gs.seatNames || [];
            // 保留真人玩家，清除 AI
            const newSeats = currentSeats.map(s => (s && s.startsWith('ai_')) ? null : s);
            const newNames = currentNames.map((n, i) => (newSeats[i] ? n : ''));
            backend.setGameState({
                status: 'idle',
                pendingAction: null,
                winResult: null,
                seats: newSeats,
                seatNames: newNames,
                gameLog: []
            });
        };

        return (
            <div className="flex-1 h-full min-h-0 flex flex-col bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-green-700 to-green-950 relative overflow-hidden select-none">
                {/* 輪次資訊橫幅 - 電腦版字體加大 */}
                <div className="flex items-center justify-between px-3 py-2 bg-black/60 text-sm sm:text-base md:text-lg text-white flex-shrink-0 z-20 shadow-md backdrop-blur-sm">
                    <div className="flex items-center gap-2">
                        <button onClick={() => window.dispatchEvent(new CustomEvent('mahjong:exit-game'))} className="bg-gray-700/80 hover:bg-gray-600 px-3 py-1.5 rounded-lg font-bold border border-gray-500 transition-colors shadow-sm text-xs sm:text-sm md:text-base">
                            <i className="ph ph-arrow-left mr-1"></i>大廳
                        </button>
                        <button onClick={() => { if (confirm('確定要提前結束遊戲並返回大廳嗎？')) handleReturnToLobby(); }} className="bg-red-700/80 hover:bg-red-600 px-3 py-1.5 rounded-lg font-bold border border-red-500 transition-colors shadow-sm text-xs sm:text-sm md:text-base">
                            <i className="ph ph-stop-circle mr-1"></i>結束遊戲
                        </button>
                    </div>
                    <span className="font-bold text-yellow-400 text-center flex-1 mx-2 truncate tracking-widest bg-black/40 py-1 md:py-1.5 rounded-full">
                        {gs.status === 'playing' ? `▶ ${seatNames[gs.currentSeat]} 的回合` : '等待開始'}
                    </span>
                    <span className="text-emerald-300 font-bold shrink-0 bg-black/40 px-3 py-1 md:py-1.5 rounded-full text-xs sm:text-sm md:text-base">牌庫: <span className="text-yellow-400">{gs.deck?.length ?? 0}</span></span>
                </div>

                {/* 遊戲桌面區域 (十字佈局優化) */}
                <div className="flex-1 flex flex-col min-h-0 relative p-2 sm:p-4 justify-between">

                    {/* 上方 座位2 (對家) */}
                    <div className="flex justify-center items-start flex-shrink-0 h-20 sm:h-28 md:h-36">
                        <SeatDisplay idx={2} gs={gs} seatNames={seatNames} compact={false} hostView={true} />
                    </div>

                    {/* 中間行：左 座位3 + 棄牌區 + 右 座位1 */}
                    <div className="flex flex-1 items-stretch justify-between px-1 sm:px-6 min-h-0 w-full overflow-hidden gap-2 my-2">
                        {/* 左方 座位3 */}
                        <div className="flex flex-col items-center justify-center flex-shrink-0 w-16 sm:w-24 md:w-32">
                            <SeatDisplay idx={3} gs={gs} seatNames={seatNames} vertical={true} compact={false} hostView={true} />
                        </div>

                        {/* 中央棄牌區 */}
                        <div className="flex-1 min-w-0 max-w-3xl mx-auto h-full flex flex-col justify-center py-2 sm:py-6 relative z-0">
                            <HostDiscardArea gs={gs} />
                        </div>

                        {/* 右方 座位1 */}
                        <div className="flex flex-col items-center justify-center flex-shrink-0 w-16 sm:w-24 md:w-32">
                            <SeatDisplay idx={1} gs={gs} seatNames={seatNames} vertical={true} compact={false} hostView={true} />
                        </div>
                    </div>

                    {/* 下方 座位0 (莊家/自己) */}
                    <div className="flex justify-center items-end flex-shrink-0 h-20 sm:h-28 md:h-36 mb-2">
                        <SeatDisplay idx={0} gs={gs} seatNames={seatNames} compact={false} hostView={true} />
                    </div>
                </div>

                {/* 動作提示字幕（誰在做什麼） */}
                {gs.actionPrompt && (
                    <div className="absolute bottom-32 left-0 right-0 flex justify-center z-30 pointer-events-none animate-[slideUp_0.3s_ease-out]">
                        <div className="bg-black/80 text-yellow-300 text-sm sm:text-base font-bold px-6 py-3 rounded-full border-2 border-yellow-600 shadow-[0_5px_15px_rgba(0,0,0,0.5)] backdrop-blur-sm">
                            等待 {seatNames[gs.actionPrompt.forSeat]} 回應 ({gs.actionPrompt.options.map(o => ({ win: '胡', pong: '碰', chow: '吃', dagang: '槓' }[o] || o)).join('/')})
                        </div>
                    </div>
                )}

                {/* 結算 */}
                {gs.status === 'gameover' && gs.winResult && (
                    <WinOverlay winResult={gs.winResult} seatNames={seatNames} isHost={true} onReturn={handleReturnToLobby} />
                )}
            </div>
        );
    }

    // ══════════════════════════════════════════════════════════════════
    // 8. PlayerHandView（玩家手牌視圖）
    // ══════════════════════════════════════════════════════════════════
    function PlayerHandView({ gameState: gs, mySeat, myPlayerId, backend }) {
        const discardAreaRef = useRef(null);
        const [selectedTileUid, setSelectedTileUid] = useState(null); // 用於出牌防呆確認

        const seatKey = `seat${mySeat}`;
        const hand = gs.hands?.[seatKey] || [];
        const myMelds = gs.melds?.[seatKey] || [];
        const ap = gs.actionPrompt;
        const gp = gs.gangPrompt;
        const isMyTurn = gs.currentSeat === mySeat;
        const isMyActionPrompt = ap && ap.forSeat === mySeat;
        const isMyGangPrompt = gp && gp.forSeat === mySeat;
        const seatNames = gs.seatNames || [];

        const canDiscard = isMyTurn && !ap && !gp && hand.length % 3 === 2;
        const mySelfDrawWin = canDiscard && checkWin(hand);
        const myGangOptions = canDiscard ? findGangOptions(hand, myMelds) : [];

        // 當失去出牌權時，清空選牌狀態
        useEffect(() => {
            if (!canDiscard) setSelectedTileUid(null);
        }, [canDiscard]);

        // 棄牌區自動置底
        useEffect(() => {
            if (discardAreaRef.current) {
                discardAreaRef.current.scrollTop = discardAreaRef.current.scrollHeight;
            }
        }, [gs.discards?.length]);

        const handleTileClick = (tile) => {
            if (!canDiscard) return;
            if (selectedTileUid === tile.uid) {
                // 第二次點擊，確認打出
                handleDiscard(tile);
            } else {
                // 第一次點擊，選取
                setSelectedTileUid(tile.uid);
            }
        };

        const handleDiscard = async (tile) => {
            if (!canDiscard) return;
            setSelectedTileUid(null); // 清空狀態
            await backend.postAction({ seat: mySeat, type: 'discard', tile });
        };

        const handleAction = async (type, extra = {}) => {
            await backend.postAction({ seat: mySeat, type, ...extra });
        };

        if (mySeat < 0) {
            return (
                <div className="flex-1 flex items-center justify-center bg-green-900 text-white text-center p-6">
                    <div>
                        <p className="text-6xl mb-4 drop-shadow-md">👁️</p>
                        <p className="text-2xl font-bold text-yellow-400 mb-2 tracking-widest">觀戰模式</p>
                        <p className="text-green-300 text-sm">你沒有座位，請靜待下局或觀看大螢幕</p>
                    </div>
                </div>
            );
        }

        return (
            <div className="flex-1 h-full min-h-0 flex flex-col bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-emerald-800 to-emerald-950 overflow-hidden text-white relative">
                {/* 狀態列 - 電腦版字體加大 */}
                <div className="flex items-center justify-between px-3 sm:px-4 py-2 bg-black/50 text-sm sm:text-base md:text-lg flex-shrink-0 z-20 shadow-md backdrop-blur-sm">
                    <div className="flex items-center gap-2 shrink-0">
                        <button onClick={() => window.dispatchEvent(new CustomEvent('mahjong:exit-game'))} className="bg-gray-700/80 hover:bg-gray-600 px-3 py-1.5 rounded-lg font-bold border border-gray-500 transition-colors shadow-sm text-xs sm:text-sm md:text-base">
                            <i className="ph ph-arrow-left mr-1"></i>名單
                        </button>
                    </div>
                    <span className={`font-bold flex-1 text-center mx-2 truncate tracking-widest bg-black/40 py-1.5 md:py-2 rounded-full ${isMyTurn ? 'text-yellow-400 ring-1 ring-yellow-400/50 shadow-[0_0_10px_rgba(250,204,21,0.3)]' : 'text-gray-300'}`}>
                        {isMyTurn ? '▶ 你的回合' : `等待 ${seatNames[gs.currentSeat] || '?'} 出牌`}
                    </span>
                    <span className="text-emerald-300 font-bold shrink-0 bg-black/40 px-3 py-1.5 md:py-2 rounded-full text-xs sm:text-sm md:text-base">
                        庫:<span className="text-yellow-400 ml-1">{gs.deck?.length ?? 0}</span>
                    </span>
                </div>

                {/* 其他座位牌數概覽 */}
                <div className="flex justify-around px-2 py-2 bg-black/20 flex-shrink-0 z-10 border-b border-emerald-800/50">
                    {[0, 1, 2, 3].filter(s => s !== mySeat).map(s => {
                        const n = gs.hands?.[`seat${s}`]?.length ?? 0;
                        const isTurn = gs.currentSeat === s;
                        return (
                            <div key={s} className={`text-center px-3 py-1 rounded-lg transition-all ${isTurn ? 'bg-yellow-900/60 border border-yellow-500/50 shadow-md ring-2 ring-yellow-400/80' : 'bg-black/30'}`}>
                                <div className={`truncate max-w-[60px] sm:max-w-[90px] text-[10px] sm:text-xs font-bold ${isTurn ? 'text-yellow-200' : 'text-gray-400'}`}>{seatNames[s] || `座${s + 1}`}</div>
                                <div className={`font-bold text-sm ${isTurn ? 'text-yellow-400' : 'text-emerald-300'}`}>{n}張</div>
                            </div>
                        );
                    })}
                </div>

                {/* 中央棄牌區 */}
                <div className="flex-1 min-h-0 relative flex justify-center items-center p-2 sm:p-4 z-0">
                    <div ref={discardAreaRef} className="w-full h-full max-w-3xl bg-black/20 rounded-2xl p-2 sm:p-4 overflow-y-auto flex flex-wrap content-start gap-1 sm:gap-1.5 shadow-[inset_0_4px_15px_rgba(0,0,0,0.3)] border border-emerald-800/50 scroll-smooth hide-scrollbar">
                        {(gs.discards || []).map((t, i) => (
                            <div key={`d${i}`} className="relative">
                                <Tile tile={t} isDiscard isClaimed={t.claimed} />
                                {i === (gs.discards || []).length - 1 && !t.claimed && !ap && (
                                    <div className="absolute -top-1 -right-1 w-3 h-3 bg-red-500 rounded-full animate-ping z-10"></div>
                                )}
                            </div>
                        ))}
                        {(gs.discards || []).length === 0 && (
                            <div className="text-emerald-600/50 text-sm font-bold tracking-widest w-full text-center mt-10">棄牌區</div>
                        )}
                    </div>
                </div>

                {/* 底部玩家區域 (副露 + 手牌 + 操作區) */}
                <div className="flex-shrink-0 flex flex-col items-center pb-safe pt-2 bg-gradient-to-t from-black/80 via-black/40 to-transparent z-10 w-full relative">

                    {/* 動作按鈕區 (自摸、槓) 浮動在手牌上方 */}
                    {canDiscard && (mySelfDrawWin || myGangOptions.length > 0) && (
                        <div className="flex gap-2 items-center mb-3 animate-[slideUp_0.2s_ease-out]">
                            {mySelfDrawWin && (
                                <button onClick={() => handleAction('win')} className="bg-gradient-to-b from-red-500 to-red-700 hover:from-red-400 hover:to-red-600 text-white px-8 py-3 rounded-full font-black border-2 border-red-300 text-xl shadow-[0_5px_15px_rgba(239,68,68,0.5)] animate-bounce">自摸！</button>
                            )}
                            {myGangOptions.map((opt, i) => (
                                <button key={i} onClick={() => handleAction('gang', { gangOpt: opt })}
                                    className="bg-gradient-to-b from-purple-500 to-purple-700 hover:from-purple-400 hover:to-purple-600 text-white px-5 py-2 rounded-full font-bold border border-purple-300 text-sm sm:text-base shadow-lg transition-transform active:scale-95">
                                    {opt.type === 'angang' ? '暗' : '加'}槓 {TILE_TYPES[opt.tileId].label}
                                </button>
                            ))}
                        </div>
                    )}

                    {/* 我的副露 */}
                    {myMelds.length > 0 && (
                        <div className="flex gap-1.5 sm:gap-2 px-2 py-1 flex-wrap justify-center mb-1">
                            {myMelds.map((meld, i) => (
                                <div key={i} className="flex gap-px bg-black/40 px-1 py-0.5 rounded-md border border-black/50 shadow-sm">
                                    {meld.tiles.map((t, ti) => (
                                        <Tile key={t.uid} tile={t} isOpenMeld
                                            isAngangHidden={meld.type === 'angang' && (ti === 1 || ti === 2)} />
                                    ))}
                                </div>
                            ))}
                        </div>
                    )}

                    {/* 我的手牌 (針對直橫向採用不同佈局) */}
                    <div className={`w-full max-w-5xl mx-auto px-2 pb-6 sm:pb-8
                        portrait:flex portrait:flex-wrap portrait:justify-center portrait:content-end portrait:gap-y-2 portrait:-space-x-[1px]
                        landscape:flex landscape:flex-nowrap landscape:justify-start landscape:items-end landscape:-space-x-[2px] landscape:md:space-x-1 landscape:overflow-x-auto landscape:no-scrollbar
                        ${canDiscard ? 'cursor-pointer' : ''}`}>
                        {hand.map((tile) => {
                            const isSelected = selectedTileUid === tile.uid;
                            const isDrawnTile = gs.drawnTileUid === tile.uid;
                            return (
                                <div key={tile.uid} className={`relative group shrink-0 transition-transform duration-200
                                    ${isSelected ? '-translate-y-4 sm:-translate-y-6 z-30' : 'z-10'}
                                    ${isDrawnTile ? 'landscape:sticky landscape:-right-1 landscape:z-20 portrait:ml-2' : ''}`}>
                                    
                                    <Tile tile={tile}
                                        onClick={() => handleTileClick(tile)}
                                        isDrawn={isDrawnTile && !isSelected} />
                                    
                                    {/* 確認出牌按鈕 */}
                                    {isSelected && (
                                        <button onClick={(e) => { e.stopPropagation(); handleDiscard(tile); }}
                                            className="absolute -top-8 sm:-top-10 left-1/2 -translate-x-1/2 bg-red-600 hover:bg-red-500 text-white text-[10px] sm:text-xs font-bold px-3 py-1.5 rounded-lg shadow-xl whitespace-nowrap pointer-events-auto animate-[slideUp_0.1s_ease-out]">
                                            確認出牌
                                        </button>
                                    )}
                                </div>
                            );
                        })}
                        {hand.length === 0 && isMyTurn && (
                            <div className="text-emerald-400 font-bold text-base py-4 animate-pulse">等待摸牌...</div>
                        )}
                    </div>
                </div>

                {/* 動作提示 Popup (吃碰槓胡) - 縮小且置中避免遮擋 */}
                {isMyActionPrompt && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center z-50 pointer-events-none pb-10 sm:pb-20">
                        <div className="bg-emerald-900/95 p-3 sm:p-5 rounded-2xl border-[2px] sm:border-[3px] border-yellow-500 flex flex-col items-center gap-2 sm:gap-3 shadow-[0_10px_40px_rgba(0,0,0,0.8)] mx-4 w-max min-w-[200px] max-w-[90vw] sm:max-w-[340px] max-h-[85vh] overflow-y-auto no-scrollbar animate-[slideDown_0.2s_ease-out] pointer-events-auto backdrop-blur-md">
                            <p className="text-yellow-300 font-bold text-xs sm:text-sm tracking-widest bg-black/50 px-4 py-1 rounded-full shadow-inner">
                                {seatNames[ap.from] || `座位${ap.from + 1}`} 打出了
                            </p>
                            <div className="my-1 shadow-[0_0_15px_rgba(255,255,255,0.2)] rounded-md">
                                <Tile tile={ap.tile} large />
                            </div>
                            <div className="flex gap-2 flex-wrap justify-center mt-1 w-full relative z-50">
                                {ap.options.includes('win') && (
                                    <button onClick={() => handleAction('win')} className="flex-1 min-w-[60px] bg-gradient-to-b from-red-500 to-red-700 hover:from-red-400 hover:to-red-600 text-white px-2 py-2 rounded-xl font-black text-base sm:text-lg shadow-lg border-2 border-red-300 transition-transform active:scale-95 leading-none">胡</button>
                                )}
                                {ap.options.includes('pong') && (
                                    <button onClick={() => handleAction('pong')} className="flex-1 min-w-[60px] bg-gradient-to-b from-yellow-500 to-yellow-700 hover:from-yellow-400 hover:to-yellow-600 text-white px-2 py-2 rounded-xl font-black text-base sm:text-lg shadow-lg border-2 border-yellow-300 transition-transform active:scale-95 leading-none">碰</button>
                                )}
                                {ap.options.includes('dagang') && (
                                    <button onClick={() => handleAction('dagang')} className="flex-1 min-w-[60px] bg-gradient-to-b from-purple-500 to-purple-700 hover:from-purple-400 hover:to-purple-600 text-white px-2 py-2 rounded-xl font-black text-base sm:text-lg shadow-lg border-2 border-purple-300 transition-transform active:scale-95 leading-none">槓</button>
                                )}
                                {ap.options.includes('chow') && (ap.chowCombos || []).map((combo, ci) => (
                                    <button key={ci} onClick={() => handleAction('chow', { combo })}
                                        className="flex-1 min-w-[80px] bg-gradient-to-b from-blue-500 to-blue-700 hover:from-blue-400 hover:to-blue-600 text-white px-2 py-1.5 rounded-xl font-black text-sm sm:text-base shadow-lg border-2 border-blue-300 flex flex-col items-center justify-center leading-tight transition-transform active:scale-95">
                                        吃 <span className="text-[10px] font-normal opacity-90 mt-0.5">{combo[0].label}{combo[1].label}</span>
                                    </button>
                                ))}
                                <button onClick={() => handleAction('skip')} className="min-w-[60px] bg-gradient-to-b from-gray-600 to-gray-800 hover:from-gray-500 hover:to-gray-700 text-white px-3 py-2 rounded-xl font-bold text-sm sm:text-base shadow-lg border-2 border-gray-500 transition-transform active:scale-95 ml-auto leading-none">過</button>
                            </div>
                        </div>
                    </div>
                )}

                {/* 槓宣告提示 */}
                {isMyGangPrompt && (
                    <div className="absolute bottom-32 sm:bottom-40 left-0 right-0 flex justify-center z-40 animate-[slideUp_0.2s_ease-out]">
                        <div className="bg-emerald-900/95 px-6 py-4 rounded-2xl border-2 border-purple-400 flex flex-wrap gap-3 items-center shadow-[0_10px_30px_rgba(0,0,0,0.5)] max-w-[90%] justify-center">
                            <span className="text-yellow-300 text-sm font-bold mr-2 tracking-widest bg-black/30 px-3 py-1 rounded-full">可宣告：</span>
                            {(gp.options || []).map((opt, i) => (
                                <button key={i} onClick={() => handleAction('gang', { gangOpt: opt })}
                                    className="bg-gradient-to-b from-purple-500 to-purple-700 hover:from-purple-400 hover:to-purple-600 text-white px-5 py-2.5 rounded-xl font-bold border border-purple-300 text-sm shadow-md transition-transform active:scale-95">
                                    {opt.type === 'angang' ? '暗' : '明'}槓 {TILE_TYPES[opt.tileId].label}
                                </button>
                            ))}
                            <button onClick={() => handleAction('skipgang')}
                                className="bg-gradient-to-b from-gray-500 to-gray-700 hover:from-gray-400 hover:to-gray-600 text-white px-5 py-2.5 rounded-xl font-bold border border-gray-400 text-sm shadow-md transition-transform active:scale-95">不槓</button>
                        </div>
                    </div>
                )}

                {/* 結算 */}
                {gs.status === 'gameover' && gs.winResult && (
                    <WinOverlay winResult={gs.winResult} seatNames={seatNames} isHost={false} />
                )}
            </div>
        );
    }

    // ══════════════════════════════════════════════════════════════════
    // 9. GameLobby（等待大廳）
    // ══════════════════════════════════════════════════════════════════
    function GameLobby({ gs, isHost, myPlayerId, myPlayerName, backend, roomId }) {
        const seats = gs?.seats || [null, null, null, null];
        const seatNames = gs?.seatNames || ['', '', '', ''];
        const mySeat = seats.indexOf(myPlayerId);

        const handleSitDown = async (seatIdx) => {
            if (seats[seatIdx] !== null) return;
            const newSeats = [...seats];
            const newNames = [...seatNames];
            newSeats[seatIdx] = myPlayerId;
            newNames[seatIdx] = myPlayerName;
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
            const finalSeats = seats.map((s, i) => s || `ai_${i}`);
            const finalNames = seatNames.map((n, i) => n || ['東家AI', '南家AI', '西家AI', '北家AI'][i]);
            const deck = generateDeck();
            const hands = {};
            for (let i = 0; i < 4; i++) {
                const hand = [];
                for (let j = 0; j < 16; j++) hand.push(deck.pop());
                if (!finalSeats[i].startsWith('ai_')) hand.sort((a, b) => a.id - b.id);
                hands[`seat${i}`] = hand;
            }
            const firstDraw = deck.pop();
            hands['seat0'] = [...hands['seat0'], firstDraw];

            await backend.initGame({
                status: 'playing',
                seats: finalSeats,
                seatNames: finalNames,
                deck,
                hands,
                melds: { seat0: [], seat1: [], seat2: [], seat3: [] },
                discards: [],
                currentSeat: 0,
                drawnTileUid: firstDraw.uid,
                actionPrompt: null,
                gangPrompt: null,
                winResult: null,
                gameLog: ['=== 對局開始 ===', `[座位0(${finalNames[0]})] 莊家摸牌: ${firstDraw.label}`],
                pendingAction: null,
            });
        };

        const seatWinds = ['東', '南', '西', '北'];
        return (
            <div className="flex-1 flex flex-col p-4 sm:p-6 overflow-y-auto text-white relative bg-gray-900">
                <div className="absolute top-4 left-4 z-10">
                    <button onClick={() => window.dispatchEvent(new CustomEvent('mahjong:exit-game'))} className="bg-gray-800 hover:bg-gray-700 px-3 py-1.5 rounded-lg text-sm font-bold border border-gray-600 transition-colors flex items-center shadow-md">
                        <i className="ph ph-arrow-left mr-1"></i> 隱藏遊戲
                    </button>
                </div>
                <div className="text-center mb-6 mt-10">
                    <h2 className="text-3xl font-black text-yellow-400 drop-shadow-md tracking-wider">🀄 台灣麻將</h2>
                    <p className="text-emerald-300 text-sm mt-2 font-medium">區域多人 · 4 座位 (未滿由 AI 自動補齊)</p>
                </div>

                <div className="grid grid-cols-2 gap-3 sm:gap-4 mb-6 max-w-lg mx-auto w-full">
                    {[0, 1, 2, 3].map(i => {
                        const pid = seats[i];
                        const name = seatNames[i];
                        const isMe = pid === myPlayerId;
                        const isAI = pid && pid.startsWith('ai_');
                        const empty = !pid;
                        return (
                            <button key={i}
                                onClick={() => { 
                                    if (empty && isHost) {
                                        alert('房主為桌面顯示端，無法入座。請朋友使用其他手機掃碼加入。');
                                        return;
                                    }
                                    if (empty && mySeat < 0) handleSitDown(i); 
                                }}
                                className={`p-4 rounded-2xl border-2 text-sm font-bold transition-all text-left relative overflow-hidden shadow-sm
                                    ${isMe ? 'border-yellow-400 bg-yellow-900/40 text-yellow-300 ring-2 ring-yellow-400/30' :
                                        isAI ? 'border-gray-600 bg-gray-800/50 text-gray-400 cursor-default' :
                                            pid ? 'border-emerald-500 bg-emerald-900/40 text-emerald-300 cursor-default' :
                                                isHost ? 'border-dashed border-gray-700 bg-black/40 text-gray-500 cursor-not-allowed' :
                                                    mySeat >= 0 ? 'border-dashed border-gray-700 bg-black/20 text-gray-600 cursor-default' :
                                                        'border-dashed border-gray-500 bg-black/20 text-gray-300 hover:border-yellow-400 hover:text-yellow-300 hover:bg-yellow-900/20 cursor-pointer active:scale-95'}`}
                            >
                                <div className="text-[10px] text-gray-400 mb-1 uppercase tracking-widest">{seatWinds[i]}家</div>
                                {empty
                                    ? <div className="text-base">{isHost ? '空位' : '空位（點擊入座）'}</div>
                                    : <div className="text-base truncate pr-6">{name || '玩家'}</div>
                                }
                                {isMe && <div className="absolute top-0 right-0 bg-yellow-500 text-yellow-900 text-[10px] px-2 py-0.5 rounded-bl-lg font-black">YOU</div>}
                            </button>
                        );
                    })}
                </div>

                {mySeat >= 0 && (
                    <div className="max-w-lg mx-auto w-full mb-4">
                        <button onClick={handleStandUp}
                            className="w-full py-3 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-xl text-sm font-bold border border-gray-600 transition-colors shadow-sm">
                            退出座位 / 僅觀戰
                        </button>
                    </div>
                )}

                <div className="max-w-lg mx-auto w-full mt-auto mb-4">
                    {isHost ? (
                        <button onClick={handleStartGame}
                            className="w-full py-4 bg-gradient-to-r from-red-600 to-red-800 hover:from-red-500 hover:to-red-700 text-white rounded-2xl font-black text-xl border-2 border-red-400 shadow-[0_10px_20px_rgba(220,38,38,0.3)] transition-all hover:scale-[1.02] active:scale-[0.98]">
                            開始對局
                        </button>
                    ) : (
                        <div className="text-center text-gray-400 text-sm py-4 border border-gray-700 border-dashed rounded-2xl bg-black/20">
                            等待房主開始對局...
                        </div>
                    )}

                    <div className="mt-6 p-4 bg-black/30 rounded-2xl border border-gray-800 text-xs text-gray-400 space-y-2 leading-relaxed">
                        <p className="flex items-start gap-2"><span className="text-lg leading-none">💡</span> <span><strong className="text-gray-300">房主介面</strong>是桌面大螢幕，可看到四家動態與完整棄牌區。</span></p>
                        <p className="flex items-start gap-2"><span className="text-lg leading-none">🀄</span> <span><strong className="text-gray-300">玩家介面</strong>專注於自己的手牌，輪到時點擊牌面兩次即可打出。</span></p>
                        <p className="flex items-start gap-2"><span className="text-lg leading-none">🤖</span> <span>未滿 4 人時，空位將由 AI 自動替補運作。</span></p>
                    </div>
                </div>
            </div>
        );
    }

    // ══════════════════════════════════════════════════════════════════
    // 10. MahjongGame Root Component
    // ══════════════════════════════════════════════════════════════════
    function MahjongGame({ roomId, isHost, myPlayerId, myPlayerName, backend }) {
        const [gameState, setGameState] = useState(null);

        useEffect(() => {
            if (!roomId) return;
            const unsub = backend.onGameState(gs => setGameState(gs));
            return unsub;
        }, [roomId]);

        if (!gameState) return <LoadingView />;

        const status = gameState.status || 'idle';
        const mySeat = (gameState.seats || []).indexOf(myPlayerId);
        const seatNames = gameState.seatNames || [];

        if (status === 'idle') {
            return <GameLobby gs={gameState} isHost={isHost} myPlayerId={myPlayerId} myPlayerName={myPlayerName} backend={backend} roomId={roomId} />;
        }

        if (status === 'playing' || status === 'gameover') {
            if (isHost) {
                return <HostTableView gameState={gameState} backend={backend} />;
            } else {
                return <PlayerHandView gameState={gameState} mySeat={mySeat} myPlayerId={myPlayerId} backend={backend} />;
            }
        }
        return <LoadingView />;
    }

    // ══════════════════════════════════════════════════════════════════
    // 11. 掛載邏輯
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
