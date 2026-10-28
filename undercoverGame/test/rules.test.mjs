// node test/rules.test.mjs —— 以修正方案第一節「任務」表的 6 人組試算驗證判定與扣除
import assert from 'node:assert/strict';
import { ROLE, MISSION, judge, splitGroups, makeGroupCfg, roleAllowed, drawSpies, generateMapping, QR } from '../modules/rules.js';

const res = {};
const mk = (...ids) => ids.map((id) => ({ code: id, role: id, money: res[id].money, leave: res[id].leave }));
const apply = (r) => { for (const [c, d] of Object.entries(r.deltas)) { res[c].money += d.money; res[c].leave += d.leave; } };
for (const id of ['sen', 'car', 'pow', 'rich', 'sel', 'two', 'lie']) res[id] = { money: ROLE[id].money, leave: ROLE[id].leave };

// 示範：出國開荒（不實際扣除）
let r = judge(MISSION.m0, mk('rich', 'sen', 'car'));
assert.equal(r.ok, true);
assert.deepEqual(r.deltas.car, { money: -10000, leave: -7 });
assert.deepEqual(r.deltas.rich, { money: -24000, leave: -3 });
assert.deepEqual(r.deltas.sen, { money: -17000, leave: -29 });

// 1 輪值司機 → 資深 23、有交通工具 2、有錢人 0
r = judge(MISSION.m1, mk('sen', 'car', 'rich')); assert.equal(r.ok, true); apply(r);
assert.deepEqual([res.sen.leave, res.car.leave, res.rich.leave], [23, 2, 0]);
// 2 大專夏令營 → 有錢人 39,000、資深 14,000、體力怪 0
r = judge(MISSION.m2, mk('pow', 'rich', 'sen')); assert.equal(r.ok, true); apply(r);
assert.deepEqual([res.rich.money, res.sen.money, res.pow.money], [39000, 14000, 0]);
// 3 旅遊辦道 → 有錢人 25,000、資深 2,000、有交通工具 0
r = judge(MISSION.m3, mk('car', 'rich', 'sen')); assert.equal(r.ok, true); apply(r);
assert.deepEqual([res.rich.money, res.sen.money, res.car.money], [25000, 2000, 0]);
// 4 秋季祭典幫廚（只算體力＋車輛）：體力 50＋20＋10 剛好 80、遊覽車＋轎車；不扣除
r = judge(MISSION.m4, mk('pow', 'car', 'sen')); assert.equal(r.ok, true); apply(r);
assert.equal(r.totals.power, 80);
assert.deepEqual([res.sen.leave, res.pow.leave, res.car.leave], [23, 1, 2]);
assert.equal(judge(MISSION.m4, mk('pow', 'car', 'rich')).ok, true);
assert.equal(judge(MISSION.m4, mk('pow', 'rich', 'sen')).reason, '體力');
// 第 4 回合後好人剩存款 27,000、特休 26 天
const goods = ['sen', 'car', 'pow', 'rich'];
assert.equal(goods.reduce((s, k) => s + res[k].money, 0), 27000);
assert.equal(goods.reduce((s, k) => s + res[k].leave, 0), 26);

// 失敗原因（重設資源）
for (const id of Object.keys(res)) res[id] = { money: ROLE[id].money, leave: ROLE[id].leave };
assert.equal(judge(MISSION.m2, mk('pow', 'rich', 'sel')).reason, '人');
assert.equal(judge(MISSION.m5, mk('pow', 'car', 'sen')).reason, '體力');
assert.equal(judge(MISSION.m1, mk('pow', 'two', 'car')).reason, '交通');
// 災後復原：體力怪 50＋圖方便說謊 40＋10
for (const id of ['pow', 'lie', 'sen']) res[id] = { money: ROLE[id].money, leave: ROLE[id].leave };
assert.equal(judge(MISSION.m5, mk('pow', 'lie', 'sen')).ok, true);

// 分組
assert.deepEqual(splitGroups(11), [11]);
assert.deepEqual(splitGroups(12), [6, 6]);
assert.deepEqual(splitGroups(13), [6, 7]);
// 臥底不分型、不控比例
assert.equal(drawSpies(8).length, 3);
const phys = makeGroupCfg(6, 'A');
assert.equal(phys.draw, 'physical');
assert.equal(roleAllowed(phys, 'sel', ['sen']), null);
assert.equal(roleAllowed(phys, 'yang', ['sel']), null); // 兩張都是破壞型也可以
assert.match(roleAllowed(phys, 'face', ['sel', 'yang']), /臥底已滿/);
assert.match(roleAllowed(phys, 'nA', []), /不使用/);
const dash = makeGroupCfg(6, 'A', 'dashboard', ['two', 'yes']);
assert.equal(roleAllowed(dash, 'yes', []), null);
assert.match(roleAllowed(dash, 'sel', []), /不是儀表板抽中/);
assert.throws(() => makeGroupCfg(8, 'A', 'dashboard', ['sel', 'two']));

// QR
const map = generateMapping();
assert.equal(Object.keys(map.A).length, 13);
assert.equal(new Set([...Object.keys(map.A), ...Object.keys(map.B)]).size, 26);
const back = QR.parse(QR.map(3, 'A', map.A));
assert.deepEqual(back.map, map.A);
assert.deepEqual(QR.parse('https://x/undercoverGame/?join=AB12.2.1'), { type: 'join', ev: 'AB12', batch: 2, g: 1 });
assert.equal(QR.parse('UG:E:A:Q-4827:v3').code, 'Q-4827');
console.log('rules tests passed');
