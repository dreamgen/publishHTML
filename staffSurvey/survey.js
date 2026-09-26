/**
 * 天達堂服務人員問卷 — 題目定義與純函式（不碰 DOM）
 * 題目沿用〈天達堂服務人員問卷_線上填寫.html〉2026-09 版，答案 key 完全相同，
 * 所以線上問卷存下來的 .json 可以直接匯入。
 */
'use strict';

const SURVEY = {"META":{"title":"天達堂服務人員問卷（排班用）","version":"2026-09 版","intro":"為了讓每位學長服務時更順利、不要太累，也讓需要接送的學長有人載，麻煩您花幾分鐘填寫。沒有標準答案，照實際狀況填就好。","notes":[["對象","所有列在服務名單上的人，以及從沒服務過或服務次數少的清口道親。"],["誰來填","本人填寫；年長或不方便填的，由區幹部或小組長當面或電話詢問後代填。"],["何時填","每年排班前更新一次（建議 10–11 月）；狀況有變（退休、搬家、身體狀況）隨時告訴小組長。"],["資料用途","只用於排班與安排接送，由人資處與各區幹部保管；不問病名、不問完整地址。"],["怎麼填","全卷 7 部分、共 31 題，多數是勾選，約 10 分鐘；標「相關的人填」的題目，不適用可以跳過。"]]},"SECTIONS":[{"id":"A","title":"基本資料","qs":[{"id":"A1","t":"姓名與所屬佛堂","type":"text","fields":[{"k":"姓名","req":true},{"k":"所屬佛堂"}]},{"id":"A2","col":"所屬區","t":"所屬區","type":"single","opts":["內湖","松山","瑞芳","三重","新莊","基隆",{"v":"其他","fill":"區名","col":"其他區名"}]},{"id":"A3","col":"乾坤","t":"乾道／坤道","type":"single","opts":["乾道","坤道"]},{"id":"A4","col":"年齡層","t":"年齡","type":"single","opts":["30 歲以下","30–49","50–64","65–74","75 歲以上"]},{"id":"A5","col":"工作狀況","t":"目前的工作狀況","type":"single","opts":["全職上班（平日需請假）","排班制或兼職（可調班）","退休或家管","學生"]}]},{"id":"B","title":"可服務的時間與次數","qs":[{"id":"B1","col":"平日服務","t":"平日（週一到週五）可以服務嗎？","type":"single","opts":["可以，不用請假",{"v":"可以，但要請假","fill":"一年最多能請幾天","num":true,"unit":"天","col":"平日可請假天數"},"平日沒辦法"]},{"id":"B2","col":"週六時段","t":"週六可以服務嗎？","type":"single","opts":["整天","只有上午","不行"]},{"id":"B3","col":"週日時段","t":"週日可以服務嗎？","type":"single","opts":["整天","只有上午","不行"]},{"id":"B4","col":"一年願意次數","t":"一年願意服務幾次？（所有服務合計）","type":"single","opts":["1–2 次","3–4 次","5–6 次","7–10 次","配合需要安排"]},{"id":"B5","col":"可否外宿","t":"可以外宿服務嗎？（忠恕會館輪廚，週三到週五住 2 晚）","type":"single","opts":["可以","不行"]},{"id":"B6","t":"哪些月份或期間不方便？","type":"compound","parts":[{"k":"不方便月份","type":"multi","opts":["1月","2月","3月","4月","5月","6月","7月","8月","9月","10月","11月","12月"],"compact":true},{"k":"原因（選填）","type":"multi","opts":["出國或遠行","農忙或工作旺季","照顧家人",{"v":"其他","fill":"原因","col":"其他原因"}]}]}]},{"id":"C","title":"服務項目與技能","note":"C1、C2、C5、C7 每一項分兩欄勾：「做過，可以做」或「沒做過，願意學」；不做的項目兩欄都不勾。","qs":[{"id":"C1","t":"天達堂的服務","type":"grid","rows":["環境整理","活動當天服務","洗碗","電梯引導","插花","交通指揮"]},{"id":"C2","t":"忠恕道院輪值的工作","type":"grid","rows":["服務台","佛堂打掃","廁所清潔","一樓打掃","外圍打掃","寶塔打掃","廚房幫忙"]},{"id":"C3","col":"廚務角色","t":"廚務角色（可複選）","type":"multi","opts":["主廚","大廚","二廚",{"v":"沒做過，願意學","excl":true},{"v":"不做廚務","excl":true}]},{"id":"C4","t":"廚務能力","cond":"廚務人員填","showIf":{"q":"C3","any":["主廚","大廚","二廚"]},"type":"compound","parts":[{"k":"最多能負責幾桌","type":"number","unit":"桌"},{"k":"能力與意願","type":"multi","opts":["有中餐證照","願意在分菜制負責一道菜","願意帶新手"]},{"k":"拿手的菜","type":"text"}]},{"id":"C5","t":"禮節可以擔任的崗位","type":"grid","rows":["參駕","燒香禮","獻供－上執","獻供－下執","獻供－立接","獻供－跪接","獻供－端果","獻供－助端","請壇禮","辦道禮","填表掛號","道義開釋","三寶講述","辦道操持"]},{"id":"C6","col":"導覽驗收","t":"忠恕道院導覽驗收","type":"single","opts":["已通過","沒有，願意參加驗收","不考慮"]},{"id":"C7","t":"其他專長","type":"grid","rows":["音響","攝影","電腦與表單","溝通與帶人"],"other":true}]},{"id":"D","title":"體力與工作負擔","note":"只問「能做什麼」，不問病名。","qs":[{"id":"D1","col":"可負擔工作","t":"下列哪些工作可以負擔？（可複選）","type":"multi","opts":["連續站 2 小時以上","搬 10 公斤左右的東西","上下樓梯","戶外日曬","以坐著的工作為主"]},{"id":"D2","t":"還有什麼排班時需要知道的事？","type":"text","fields":[{"k":"說明","long":true,"ph":"例：需要家人陪同、中午前要離開"}]}]},{"id":"E","title":"交通與接送","qs":[{"id":"E1","col":"開車","t":"會開車嗎？","type":"single","opts":["會開車，有車","會開車，沒有車","不開車"]},{"id":"E2","t":"可以載幾位？願意載誰？","cond":"有車者填","showIf":{"q":"E1","any":["會開車，有車"]},"type":"compound","parts":[{"k":"可載人數","type":"number","unit":"位"},{"k":"願意載","type":"multi","opts":["同區學長","順路的其他區學長",{"v":"只載自己","excl":true}]}]},{"id":"E3","t":"出發地點","type":"text","fields":[{"k":"所在的里或最近的捷運站","ph":"例：東湖里／捷運東湖站"}]},{"id":"E4","col":"到天達堂方式","t":"到天達堂怎麼去？","type":"single","opts":["自己前往","搭家人或同修的車","需要安排接送"]},{"id":"E5","col":"到忠恕方式","t":"到忠恕道院怎麼去？","type":"single","opts":["自己開車","搭別人的車","可搭捷運到迴龍再轉車","需要安排接送"]},{"id":"E6","col":"接送群組意願","t":"願意加入道親接送群組（Uber 群組）幫忙載人嗎？（可複選）","type":"multi","opts":["願意，平日可","願意，假日可",{"v":"不方便","excl":true}]}]},{"id":"F","title":"搭檔與承擔意願","qs":[{"id":"F1","t":"希望一起服務的人（最多 3 位，選填）","type":"compound","parts":[{"k":"姓名 1","col":"搭檔1","type":"text","inline":true},{"k":"姓名 2","col":"搭檔2","type":"text","inline":true},{"k":"姓名 3","col":"搭檔3","type":"text","inline":true},{"k":"","type":"multi","opts":["我們常一起搭車"]}]},{"id":"F2","col":"願意承擔角色","t":"願意承擔哪些角色？（可複選）","type":"multi","cols":2,"opts":["服務小組長","忠恕輪值小組長","主廚或行政主廚（安排人、不一定掌廚）","區聯絡窗口","交通與接送聯絡人","帶新人"]},{"id":"F3","col":"一年可帶場次","t":"如果擔任以上角色，一年最多能帶幾場？","cond":"F2 有勾選者填","showIf":{"q":"F2","nonEmpty":true},"type":"single","opts":["1–2 場","3–4 場","5–6 場"]}]},{"id":"G","title":"聯絡與提醒方式","qs":[{"id":"G1","col":"提醒方式","t":"排班通知與提醒用什麼方式？（可複選）","type":"multi","opts":["LINE","電話","簡訊","請小組長或家人轉達"]},{"id":"G2","t":"聯絡電話；如需家人代接，請填家人稱謂與電話","type":"text","fields":[{"k":"本人電話","tel":true},{"k":"代接家人稱謂","ph":"例：女兒"},{"k":"代接家人電話","tel":true}]}]}],"FEEDBACK":{"title":"服務後 1 分鐘回饋","note":"由當場小組長或主廚填，服務結束當天完成；用來補上輪值總表的「簽到狀況」與替代人力紀錄。","head":["服務日期","服務項目／地點","填表人（小組長或主廚）"],"qs":[{"id":"R2","col":"人力","t":"人力夠嗎？","type":"single","opts":["剛好",{"v":"少","fill":"少幾人","num":true,"unit":"人"},{"v":"多","fill":"多幾人","num":true,"unit":"人"}]},{"id":"R3","col":"交通","t":"交通順利嗎？（可複選）","type":"multi","opts":[{"v":"順利","excl":true},"有人遲到","有人沒車來不了",{"v":"自費搭計程車","fill":"人數","num":true,"unit":"人"}]},{"id":"R4","t":"下次要注意或改進什麼？（選填）","type":"text","fields":[{"k":"說明","long":true}]}],"attend":["到","請假","由他人代班"]},"SKILL_COLS":["做過，可以做","沒做過，願意學"]};
const GRIDV = { can: '可以做', learn: '願意學' };

const SV = (() => {
  const { SECTIONS } = SURVEY;
  const ov = o => (typeof o === 'string' ? o : o.v);
  const j = v => (Array.isArray(v) ? v.join('、') : (v ?? ''));
  const has = v => (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && String(v).trim() !== '');
  const allQs = () => SECTIONS.flatMap(s => s.qs);

  function visible(q, S) {
    if (!q.showIf) return true;
    const v = S[q.showIf.q];
    if (q.showIf.nonEmpty) return Array.isArray(v) ? v.length > 0 : !!v;
    return (Array.isArray(v) ? v : [v]).some(x => q.showIf.any.includes(x));
  }

  function answered(q, S) {
    if (q.type === 'single' || q.type === 'multi') return has(S[q.id]);
    if (q.type === 'text') return q.fields.some(f => has(S[`${q.id}.${f.k}`]));
    if (q.type === 'grid') return [...q.rows, '其他'].some(r => has(S[`${q.id}.${r}`]));
    if (q.type === 'compound') return q.parts.some(p => has(S[`${q.id}.${p.k || '勾選'}`]));
    return false;
  }

  function progress(S) {
    let done = 0, total = 0;
    allQs().forEach(q => {
      if (!visible(q, S)) return;
      total++;
      if (answered(q, S)) done++;
    });
    return { done, total };
  }

  /** 問卷明細工作表的欄位：[欄名, answers => 值]（與線上問卷的 CSV 彙整欄位一致） */
  function columns() {
    const cols = [['填寫日期', s => s['meta.填寫日期']], ['填寫方式', s => s['meta.填寫方式']], ['代填人', s => s['meta.代填人']]];
    const fillCols = (q, key, opts) => opts.filter(o => typeof o === 'object' && o.fill)
      .forEach(o => cols.push([`${q.id}_${o.col || o.v + '_' + o.fill}`, s => s[`${key}.${o.v}.fill`]]));
    SECTIONS.forEach(sec => sec.qs.forEach(q => {
      if (q.type === 'single' || q.type === 'multi') { cols.push([`${q.id}_${q.col || q.t}`, s => j(s[q.id])]); fillCols(q, q.id, q.opts); }
      else if (q.type === 'text') q.fields.forEach(f => cols.push([`${q.id}_${f.k}`, s => s[`${q.id}.${f.k}`]]));
      else if (q.type === 'grid') {
        q.rows.forEach(r => cols.push([`${q.id}_${r}`, s => GRIDV[s[`${q.id}.${r}`]] || '']));
        if (q.other) { cols.push([`${q.id}_其他名稱`, s => s[`${q.id}.其他名稱`]]); cols.push([`${q.id}_其他`, s => GRIDV[s[`${q.id}.其他`]] || '']); }
      } else if (q.type === 'compound') q.parts.forEach(p => {
        const key = `${q.id}.${p.k || '勾選'}`;
        cols.push([`${q.id}_${(p.col || p.k || '勾選').replace(/（.*?）/g, '')}`.replace('F1_勾選', 'F1_常一起搭車'), s => j(s[key])]);
        if (p.type === 'multi') fillCols(q, key, p.opts);
      });
    }));
    return cols;
  }

  /** A2 所屬區（含「其他」填寫） */
  function region(S) {
    if (S.A2 === '其他') return String(S['A2.其他.fill'] || '').trim() || '其他';
    return S.A2 || '';
  }
  const gender = S => (S.A3 === '乾道' ? '乾' : S.A3 === '坤道' ? '坤' : '');

  /** 年紀（116 年）→ 問卷 A4 年齡選項（用 115 年的年紀換算） */
  function ageOption(age116) {
    const a = Number(age116) - 1;
    if (!a || a < 0) return '';
    if (a < 30) return '30 歲以下';
    if (a < 50) return '30–49';
    if (a < 65) return '50–64';
    if (a < 75) return '65–74';
    return '75 歲以上';
  }

  /** 名冊年齡層（116 年年紀）— 與名冊「年齡層」欄公式相同 */
  function ageBand(age) {
    const h = Number(age);
    if (!age || Number.isNaN(h)) return '';
    if (h < 18) return '未滿18';
    if (h <= 40) return '40以下';
    if (h <= 55) return '41-55';
    if (h <= 65) return '56-65';
    if (h <= 75) return '66-75';
    return '76以上';
  }

  /**
   * 問卷答案 → 名冊黃底摘要欄（工作狀態…116年意願備註）
   * 下拉選單欄位（工作狀態、會開車/可載人）用名冊原本的選項值。
   */
  function rosterSummary(S) {
    const out = {};
    const A5 = { '全職上班（平日需請假）': '全職上班', '排班制或兼職（可調班）': '兼職/彈性', '退休或家管': '退休/家管', '學生': '學生' };
    if (S.A5) out['工作狀態'] = A5[S.A5] || S.A5;

    if (S.B1 === '可以，不用請假') out['平日可請假天數/年'] = '不需請假';
    else if (S.B1 === '可以，但要請假') {
      const n = S['B1.可以，但要請假.fill'];
      out['平日可請假天數/年'] = has(n) && !Number.isNaN(Number(n)) ? Number(n) : '需請假（天數未填）';
    } else if (S.B1 === '平日沒辦法') out['平日可請假天數/年'] = 0;

    const e2 = S['E2.願意載'] || [];
    if (S.E1 === '會開車，有車') {
      out['會開車/可載人'] = (e2.includes('只載自己') || String(S['E2.可載人數'] ?? '') === '0') ? '會開車不載人' : '會開車可載人';
    } else if (S.E1 || S.E4 || S.E5) {
      out['會開車/可載人'] = (S.E4 === '需要安排接送' || S.E5 === '需要安排接送') ? '不開車需接送' : '自行搭車';
    }

    const e3 = String(S['E3.所在的里或最近的捷運站'] || '').trim();
    if (e3) out['出發地點(行政區)'] = e3;
    if (S.B4) out['一年願意服務次數'] = S.B4;

    // 可支援項目
    const can = [], learn = [];
    ['C1', 'C2', 'C5', 'C7'].forEach(id => {
      const q = allQs().find(x => x.id === id);
      q.rows.forEach(r => { const v = S[`${id}.${r}`]; if (v === 'can') can.push(r); else if (v === 'learn') learn.push(r); });
      if (q.other) {
        const nm = String(S[`${id}.其他名稱`] || '').trim() || '其他專長';
        const v = S[`${id}.其他`]; if (v === 'can') can.push(nm); else if (v === 'learn') learn.push(nm);
      }
    });
    (S.C3 || []).forEach(v => { if (['主廚', '大廚', '二廚'].includes(v)) can.push(v); else if (v === '沒做過，願意學') learn.push('廚務'); });
    if (S.C6 === '已通過') can.push('忠恕導覽'); else if (S.C6 === '沒有，願意參加驗收') learn.push('忠恕導覽');
    (S.E6 || []).forEach(v => { if (v.startsWith('願意')) can.push('接送' + v.replace('願意，', '（').replace('可', '）')); });
    const sup = [];
    if (can.length) sup.push('可做：' + can.join('、'));
    if (learn.length) sup.push('願學：' + learn.join('、'));
    if (sup.length) out['可支援項目'] = sup.join('；');

    // 116年意願備註
    const note = [];
    const time = [];
    if (S.B1) time.push('平日' + (S.B1 === '可以，但要請假' ? `需請假${has(S['B1.可以，但要請假.fill']) ? '（' + S['B1.可以，但要請假.fill'] + '天/年）' : ''}` : S.B1 === '平日沒辦法' ? '不行' : '可'));
    if (S.B2) time.push('週六' + S.B2);
    if (S.B3) time.push('週日' + S.B3);
    if (time.length) note.push('時間：' + time.join('／'));
    if (S.B5) note.push('外宿：' + S.B5);
    const months = S['B6.不方便月份'] || [];
    const why = (S['B6.原因（選填）'] || []).map(v => v === '其他' ? (S['B6.原因（選填）.其他.fill'] || '其他') : v);
    if (months.length || why.length) note.push('不便：' + [months.join('、'), why.length ? `（${why.join('、')}）` : ''].join(''));
    if (has(S['C4.最多能負責幾桌'])) note.push(`廚務最多 ${S['C4.最多能負責幾桌']} 桌`);
    if (has(S['C4.能力與意願'])) note.push('廚務：' + j(S['C4.能力與意願']));
    if (has(S['C4.拿手的菜'])) note.push('拿手菜：' + S['C4.拿手的菜']);
    if (has(S.D1)) note.push('體力：' + j(S.D1));
    if (S.E4) note.push('到天達堂：' + S.E4);
    if (S.E5) note.push('到忠恕：' + S.E5);
    if (has(S['E2.可載人數'])) note.push(`可載 ${S['E2.可載人數']} 位`);
    if (has(S.F2)) note.push('願承擔：' + j(S.F2) + (S.F3 ? `（一年 ${S.F3}）` : ''));
    const mates = ['姓名 1', '姓名 2', '姓名 3'].map(k => String(S[`F1.${k}`] || '').trim()).filter(Boolean);
    if (mates.length) note.push('搭檔：' + mates.join('、') + (has(S['F1.勾選']) ? '（常一起搭車）' : ''));
    if (has(S.G1)) note.push('提醒：' + j(S.G1));
    const d2 = String(S['D2.說明'] || '').trim();
    if (d2) note.push('說明：' + d2);
    if (note.length) out['116年意願備註'] = note.join('；');

    if (S.A4) out['年齡層'] = S.A4;
    return out;
  }

  return { ov, j, has, allQs, visible, answered, progress, columns, region, gender, ageOption, ageBand, rosterSummary };
})();
