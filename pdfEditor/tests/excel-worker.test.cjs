const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const editorRoot = path.resolve(__dirname, "..");
const ExcelJS = require(path.join(
  editorRoot,
  "vendor/exceljs/exceljs.min.js"
));
const PDFLib = require(path.join(
  editorRoot,
  "vendor/pdf-lib/pdf-lib.min.js"
));
const fontkit = require(path.join(
  editorRoot,
  "vendor/pdf-lib/fontkit.umd.min.js"
));
const fflate = require(path.join(editorRoot, "vendor/fflate/fflate.min.js"));

const TEST_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function buildWorkbook() {
  const workbook = new ExcelJS.Workbook();
  const report = workbook.addWorksheet("銷售報表", {
    pageSetup: {
      paperSize: 9,
      orientation: "portrait",
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
    },
  });
  report.mergeCells("A1:D1");
  report.getCell("A1").value = "2026 年度銷售報表";
  report.getCell("A1").font = {
    bold: true,
    size: 18,
    color: { argb: "FFFFFFFF" },
  };
  report.getCell("A1").fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF18794E" },
  };
  report.getCell("A1").alignment = {
    horizontal: "center",
    vertical: "middle",
  };
  report.getRow(1).height = 28;
  report.addRow(["日期", "品項", "數量", "金額"]);
  for (let index = 1; index <= 24; index += 1) {
    const rowNumber = index + 2;
    const row = report.addRow([
      new Date(2026, (index - 1) % 12, 1),
      `商品 ${index}`,
      index * 2,
      { formula: `C${rowNumber}*125`, result: index * 250 },
    ]);
    row.getCell(1).numFmt = "yyyy/mm/dd";
    row.getCell(4).numFmt = "#,##0";
  }
  report.columns = [
    { width: 14 },
    { width: 24 },
    { width: 12 },
    { width: 16 },
  ];
  report.pageSetup.printArea = "A1:D26";
  report.pageSetup.printTitlesRow = "1:2";
  report.pageSetup.printTitlesColumn = "A:A";
  report.pageSetup.horizontalCentered = true;
  report.headerFooter = {
    oddHeader: "&L測試活頁簿&C&A&R第 &P / &N 頁",
    oddFooter: "&C&D &T",
  };
  report.getCell("E2").value = "公式檢查";
  report.getCell("E3").value = { formula: "C3*200" };
  report.getCell("B3").alignment = { textRotation: 45 };
  report.addConditionalFormatting({
    ref: "C3:C26",
    rules: [
      {
        type: "cellIs",
        operator: "greaterThan",
        formulae: ["20"],
        style: { font: { color: { argb: "FFFF0000" } } },
      },
    ],
  });
  const imageId = workbook.addImage({
    base64:
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    extension: "png",
  });
  report.addImage(imageId, "D2:D2");

  const summary = workbook.addWorksheet("摘要");
  summary.addRows([
    ["區域", "營收"],
    ["北區", 120000],
    ["中區", 98000],
    ["南區", 110000],
  ]);
  summary.columns = [{ width: 20 }, { width: 18 }];
  summary.getRow(1).font = { bold: true };
  summary.getCell("A5").value = {
    richText: [
      { text: "重要", font: { bold: true } },
      { text: "提示", font: { color: { argb: "FF18794E" } } },
    ],
  };
  summary.getCell("A6").value = {
    text: "OpenAI",
    hyperlink: "https://openai.com/",
  };
  summary.getCell("A7").value = {
    text: "https://example、com/meeting",
    hyperlink: "https://example.com/meeting",
  };
  // ASCII-only cells can still contain line breaks that WinAnsi fonts cannot
  // encode directly. The worker must preserve the break without replacing it
  // with a Unicode fallback glyph while still using Helvetica.
  summary.getCell("B5").value = "7:00~\n15:30";
  summary.getCell("B5").alignment = { wrapText: true };
  summary.getCell("B6").value = "□";

  // 框線繪製路徑（drawRectangle 細矩形）至少被執行一次。
  summary.getCell("B1").border = {
    top: { style: "thin" },
    bottom: { style: "medium" },
    left: { style: "thin" },
    right: { style: "thin" },
  };

  // 圖片轉換案例：PNG（oneCell 與 twoCell 錨點）應轉入 PDF，GIF 應略過。
  const pngImageId = workbook.addImage({
    buffer: Buffer.from(TEST_PNG_BASE64, "base64"),
    extension: "png",
  });
  summary.addImage(pngImageId, {
    tl: { col: 0.2, row: 3.2 },
    ext: { width: 64, height: 32 },
  });
  report.addImage(pngImageId, {
    tl: { col: 1, row: 13 },
    br: { col: 3, row: 17 },
  });
  const gifImageId = workbook.addImage({
    buffer: Buffer.from([0x47, 0x49, 0x46, 0x38]),
    extension: "gif",
  });
  report.addImage(gifImageId, {
    tl: { col: 3, row: 2 },
    ext: { width: 20, height: 20 },
  });
  // 錨在 used range（A1:B6 附近）之外的圖片：used 範圍應自動擴大涵蓋它。
  summary.addImage(pngImageId, {
    tl: { col: 0, row: 9 },
    ext: { width: 40, height: 60 },
  });

  const hidden = workbook.addWorksheet("內部設定");
  hidden.state = "hidden";
  hidden.addRow(["不應預設選取", 123]);
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const entries = fflate.unzipSync(new Uint8Array(buffer));
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const reportPath = "xl/worksheets/sheet1.xml";
  const reportXml = decoder.decode(entries[reportPath]).replace(
    "</worksheet>",
    '<rowBreaks count="1" manualBreakCount="1"><brk id="12" min="0" max="16383" man="1"/></rowBreaks>' +
      '<colBreaks count="1" manualBreakCount="1"><brk id="2" min="0" max="1048575" man="1"/></colBreaks>' +
      "</worksheet>"
  );
  entries[reportPath] = encoder.encode(reportXml);
  return fflate.zipSync(entries);
}

// 產生含 Excel 365「儲存格內圖片」（richValue）的 xlsx：先用 ExcelJS 產生
// 基本活頁簿，再直接改寫 zip 內容，把 B2 換成 vm 參照並注入 richData 部件。
async function buildInCellImageWorkbook() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("封面");
  sheet.getCell("A1").value = "儲存格內圖片測試";
  sheet.getCell("B2").value = 1;
  sheet.getRow(2).height = 60;
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const entries = fflate.unzipSync(new Uint8Array(buffer));
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const sheetPath = Object.keys(entries).find((name) =>
    /^xl\/worksheets\/sheet\d+\.xml$/.test(name)
  );
  const sheetXml = decoder
    .decode(entries[sheetPath])
    .replace(
      /<c r="B2"[^>]*>[\s\S]*?<\/c>/,
      '<c r="B2" t="e" vm="1"><v>#VALUE!</v></c>'
    );
  assert.ok(sheetXml.includes('vm="1"'), "測試 xlsx 注入 vm 失敗");
  entries[sheetPath] = encoder.encode(sheetXml);
  entries["xl/metadata.xml"] = encoder.encode(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<metadata xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:xlrd="http://schemas.microsoft.com/office/spreadsheetml/2017/richdata">' +
      '<metadataTypes count="1"><metadataType name="XLRICHVALUE" minSupportedVersion="120000"/></metadataTypes>' +
      '<futureMetadata name="XLRICHVALUE" count="1"><bk><extLst><ext uri="{3e2802c4-a4d2-4d8b-9148-e3be6c30e623}"><xlrd:rvb i="0"/></ext></extLst></bk></futureMetadata>' +
      '<valueMetadata count="1"><bk><rc t="1" v="0"/></bk></valueMetadata></metadata>'
  );
  entries["xl/richData/rdrichvalue.xml"] = encoder.encode(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<rvData xmlns="http://schemas.microsoft.com/office/spreadsheetml/2017/richdata" count="1">' +
      '<rv s="0"><v>0</v><v>5</v></rv></rvData>'
  );
  entries["xl/richData/rdrichvaluestructure.xml"] = encoder.encode(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<rvStructures xmlns="http://schemas.microsoft.com/office/spreadsheetml/2017/richdata" count="1">' +
      '<s t="_localImage"><k n="_rvRel:LocalImageIdentifier" t="i"/><k n="CalcOrigin" t="i"/></s></rvStructures>'
  );
  entries["xl/richData/richValueRel.xml"] = encoder.encode(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<richValueRels xmlns="http://schemas.openxmlformats.org/office/spreadsheetml/2022/richvaluerel" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<rel r:id="rId1"/></richValueRels>'
  );
  entries["xl/richData/_rels/richValueRel.xml.rels"] = encoder.encode(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image9.png"/></Relationships>'
  );
  entries["xl/media/image9.png"] = new Uint8Array(
    Buffer.from(TEST_PNG_BASE64, "base64")
  );
  return fflate.zipSync(entries);
}

async function createWorkerHarness() {
  const messages = [];
  const listeners = {};
  const fontPath = path.join(
    editorRoot,
    "vendor/pdf-lib/NotoSansTC-Regular.ttf"
  );
  const hbWasmPath = path.join(editorRoot, "vendor/hb-subset/hb-subset.wasm");
  const context = {
    ExcelJS,
    PDFLib,
    fontkit,
    console,
    URL,
    Date,
    Math,
    Set,
    Map,
    Array,
    Object,
    Number,
    String,
    RegExp,
    Error,
    Uint8Array,
    ArrayBuffer,
    importScripts() {},
    postMessage(message) {
      messages.push(message);
    },
    WebAssembly,
    TextDecoder,
    async fetch(resource) {
      const url = String(resource);
      const bytes = fs.readFileSync(
        url.includes("hb-subset.wasm") ? hbWasmPath : fontPath
      );
      return {
        ok: true,
        async arrayBuffer() {
          return bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength
          );
        },
      };
    },
    self: {
      location: { href: "http://localhost/excel-worker.js" },
      addEventListener(type, listener) {
        listeners[type] = listener;
      },
    },
  };
  vm.createContext(context);
  // hb-subset 與 fflate 會掛在 context.self 上；worker 端以全域名稱取用。
  vm.runInContext(
    fs.readFileSync(path.join(editorRoot, "vendor/hb-subset/hb-subset.js"), "utf8"),
    context,
    { filename: "hb-subset.js" }
  );
  context.HBSubset = context.self.HBSubset;
  vm.runInContext(
    fs.readFileSync(path.join(editorRoot, "vendor/fflate/fflate.min.js"), "utf8"),
    context,
    { filename: "fflate.min.js" }
  );
  context.fflate = context.self.fflate;
  vm.runInContext(
    fs.readFileSync(path.join(editorRoot, "excel-worker.js"), "utf8"),
    context,
    { filename: "excel-worker.js" }
  );
  return {
    messages,
    requestSequence: 0,
    evaluate(expression) {
      return vm.runInContext(expression, context);
    },
    async send(data) {
      const requestId = data.requestId || ++this.requestSequence;
      const startIndex = messages.length;
      await listeners.message({ data: { ...data, requestId } });
      const terminal = messages
        .slice(startIndex)
        .reverse()
        .find((message) =>
          ["parsed", "estimated", "previewed", "converted", "error"].includes(
            message.type
          ) && message.requestId === requestId
        );
      if (terminal?.type === "error") throw new Error(terminal.message);
      return terminal;
    },
  };
}

(async () => {
  const xlsx = await buildWorkbook();
  const harness = await createWorkerHarness();
  assert.equal(
    harness.evaluate(
      'resolvedScaling({pageSetup:{fitToPage:false,fitToWidth:1,scale:80}},{scaling:"source",scalePercent:100},500,900,500,800)'
    ),
    0.8,
    "未啟用 fitToPage 時應尊重 Excel scale，不得被 fitToWidth 預設值覆蓋"
  );
  assert.equal(
    harness.evaluate(
      'resolvedScaling({pageSetup:{fitToPage:true,fitToWidth:1,fitToHeight:2}},{scaling:"source",scalePercent:100},1000,2400,500,800)'
    ),
    0.5,
    "fitToWidth/fitToHeight 應共同決定縮放比例"
  );
  assert.equal(
    harness.evaluate('formatDateValue(new Date(1899,11,30,12,10,0),"h:mm")'),
    "12:10",
    "時間格式不得顯示成 1899/12/30"
  );
  assert.equal(
    harness.evaluate(
      'formatDateValue(new Date(2026,6,17,12,10,0),"yyyy/mm/dd hh:mm")'
    ),
    "2026/07/17 12:10",
    "日期時間混合格式應區分月份與分鐘"
  );
  assert.equal(
    harness.evaluate(`cellText({
      value: { sharedFormula: "B8", result: new Date(2026, 4, 11) },
      numFmt: "m/d",
      text: "Mon May 11 2026 00:00:00 GMT+0800"
    })`),
    "5/11",
    "共用公式的 Date result 應依 Excel 數字格式輸出，不得落入 Date.toString()"
  );
  assert.equal(
    harness.evaluate(
      'expandHeaderFooter("&P/&N",{name:"測試",pageSetup:{useFirstPageNumber:true,firstPageNumber:4294967295}},1,3,{documentPageOffset:5,documentPageCount:10})'
    ),
    "7/10",
    "Excel 自動頁碼 sentinel 不得輸出為 4294967295"
  );
  assert.equal(
    harness.evaluate(
      'headerFooterFontSize(\'&C&"Calibri Bold,粗體"&26&K000000 2026瑞周天達行事曆\')'
    ),
    26,
    "自訂頁首應保留 Excel 明確設定的字級"
  );
  assert.equal(
    harness.evaluate(
      'headerFooterDocumentScale({headerFooter:{}},{scaleX:0.67,scaleY:0.623})'
    ),
    0.623,
    "頁首應遵循 Excel 的隨文件縮放設定"
  );
  assert.deepEqual(
    JSON.parse(
      harness.evaluate(`(() => {
        const calls = [];
        drawHeaderFooterLine(
          { drawText(value, options) { calls.push({ value, size: options.size, y: options.y }); } },
          '&C&"Calibri Bold,粗體"&26&K000000 2026瑞周天達行事曆',
          { name: "天達行事曆2026", pageSetup: {} },
          { unicode: {
            hasGlyph() { return true; },
            widthOfTextAtSize(value, size) { return value.length * size; },
          } },
          {
            pageWidth: 595,
            pageHeight: 842,
            margins: { left: 48, right: 48, header: 40, footer: 30 },
          },
          0,
          1,
          "header",
          {}
        );
        return JSON.stringify(calls);
      })()`)
    ),
    [{ value: "2026瑞周天達行事曆", size: 26, y: 776 }],
    "單一置中頁首應使用完整列印寬度並維持來源字級"
  );
  assert.deepEqual(
    Array.from(
      harness.evaluate(
        'wrapText({widthOfTextAtSize:(value)=>value.length*10},"完整內容",10,5,false)'
      )
    ),
    ["完整內容"],
    "未換行文字應交由裁切區域處理，不應自行加入省略號"
  );
  assert.deepEqual(
    JSON.parse(
      harness.evaluate(`(() => {
        const cell = {
          font: {},
          value: {
            richText: [
              { text: "重要", font: { bold: true } },
              { text: "提示", font: { color: { argb: "FF18794E" } } },
            ],
          },
        };
        const runs = cellStyledRuns(cell);
        return JSON.stringify(
          runs.map((run) => ({
            text: run.text,
            bold: run.style.bold,
            color: run.style.color?.argb || null,
          }))
        );
      })()`)
    ),
    [
      { text: "重要", bold: true, color: null },
      { text: "提示", bold: false, color: "FF18794E" },
    ],
    "cellStyledRuns 應保留每個片段各自的有效顏色與粗細"
  );
  assert.equal(
    harness.evaluate(`(() => {
      const cell = {
        font: { bold: true, color: { argb: "FF000000" } },
        value: { richText: [{ text: "A" }, { text: "B" }] },
      };
      return cellStyledRuns(cell);
    })()`),
    null,
    "Rich text 片段樣式其實相同時，應回傳 null 交由既有單一樣式流程處理"
  );
  assert.deepEqual(
    JSON.parse(
      harness.evaluate(`(() => {
        const font = { widthOfTextAtSize: () => 1000 };
        const characters = [..."ABCDEF"].map((ch) => ({
          ch,
          font,
          color: null,
          bold: false,
        }));
        const lines = wrapStyledCharacters(characters, 10, 25, true);
        return JSON.stringify(lines.map((line) => line.map((c) => c.ch).join("")));
      })()`)
    ),
    ["AB", "CD", "EF"],
    "wrapStyledCharacters 應依逐字元寬度換行，與 wrapText 邏輯一致"
  );
  assert.deepEqual(
    JSON.parse(
      harness.evaluate(`(() => {
        const font = { widthOfTextAtSize: () => 1000 };
        const colorA = { tag: "A" };
        const colorB = { tag: "B" };
        const line = [
          { ch: "A", font, color: colorA, bold: false },
          { ch: "B", font, color: colorA, bold: false },
          { ch: "C", font, color: colorB, bold: true },
          { ch: "D", font, color: colorB, bold: true },
          { ch: "E", font, color: colorA, bold: false },
        ];
        const groups = groupStyledLine(line, 10);
        return JSON.stringify(
          groups.map((group) => ({ text: group.text, bold: group.bold, width: group.width }))
        );
      })()`)
    ),
    [
      { text: "AB", bold: false, width: 20 },
      { text: "CD", bold: true, width: 20 },
      { text: "E", bold: false, width: 10 },
    ],
    "groupStyledLine 應把連續同樣式字元合併成一段並正確加總寬度"
  );
  assert.ok(
    harness.evaluate('borderWidth("thick") > borderWidth("medium")') &&
      harness.evaluate('borderWidth("medium") > borderWidth("thin")'),
    "Excel thick／medium／thin 框線應映射成遞減線寬"
  );
  assert.deepEqual(
    Array.from(harness.evaluate('borderDashPattern("dotted", 1)')),
    [0.45, 2],
    "dotted 框線應保留點線 dash pattern"
  );
  assert.equal(
    harness.evaluate(
      'borderLineSegments("bottom", "double", 0, 0, 100, 20, 2.25).length'
    ),
    2,
    "double 框線應繪製兩條平行線"
  );
  assert.deepEqual(
    JSON.parse(
      harness.evaluate(`(() => {
        const borders = new Map([
          ["1:1", { top: { style: "medium" }, left: { style: "thin" } }],
          ["1:2", { top: { style: "medium" } }],
          ["1:3", { top: { style: "medium" }, right: { style: "thick" } }],
          ["2:1", { bottom: { style: "thick" }, left: { style: "thin" } }],
          ["2:2", { bottom: { style: "thick" } }],
          ["2:3", { bottom: { style: "thick" }, right: { style: "thick" } }],
        ]);
        const worksheet = {
          getCell(row, column) {
            return { border: borders.get(row + ":" + column) || {} };
          },
        };
        const border = mergedCellBorder(
          worksheet,
          { top: 1, left: 1, bottom: 2, right: 3 },
          worksheet.getCell(1, 1).border
        );
        return JSON.stringify(Object.fromEntries(
          Object.entries(border).map(([side, value]) => [side, value?.style])
        ));
      })()`)
    ),
    { top: "medium", right: "thick", bottom: "thick", left: "thin" },
    "合併儲存格應從最右／最下方子儲存格還原外框"
  );
  assert.equal(
    harness.evaluate(`(() => {
      const testWorkbook = new ExcelJS.Workbook();
      const sheet = testWorkbook.addWorksheet("可見範圍");
      sheet.getCell("A1").value = "列印內容";
      sheet.getColumn(8).hidden = true;
      sheet.getCell("H50").value = "隱藏輔助資料";
      return encodeRange(visibleUsedRange(sheet, {
        top: 1, left: 1, bottom: 50, right: 8
      }));
    })()`),
    "A1:A1",
    "隱藏輔助欄不得擴大列印範圍"
  );
  assert.ok(
    harness.evaluate(`(() => {
      const testWorkbook = new ExcelJS.Workbook();
      const sheet = testWorkbook.addWorksheet("文字延伸");
      sheet.getCell("A1").value = "可延伸到空白儲存格的說明";
      const layout = {
        columns: [
          { number: 1, width: 40 },
          { number: 2, width: 50 },
          { number: 3, width: 60 },
        ],
        rows: [{ number: 1, height: 20 }],
        scale: 1,
        scaleX: 1,
      };
      const box = { x: 0, y: 0, width: 40, height: 20 };
      return calculateOverflowTextBox(
        sheet, layout, 0, 0, sheet.getCell("A1"), box,
        buildMergeMaps(sheet), new Map()
      ).width;
    })()`) > 140,
    "未換行文字應延伸到右側連續空白儲存格"
  );
  assert.deepEqual(
    JSON.parse(
      harness.evaluate(`(() => {
        const testWorkbook = new ExcelJS.Workbook();
        const sheet = testWorkbook.addWorksheet("文字延伸範圍");
        sheet.getCell("A1").value = "三欄群組內容";
        const layout = {
          columns: [
            { number: 1, width: 40 },
            { number: 2, width: 50 },
            { number: 3, width: 60 },
          ],
          rows: [{ number: 1, height: 20 }],
          scale: 1,
          scaleX: 1,
        };
        const result = calculateOverflowTextBox(
          sheet,
          layout,
          0,
          0,
          sheet.getCell("A1"),
          { x: 0, y: 0, width: 40, height: 20 },
          buildMergeMaps(sheet),
          new Map()
        );
        return JSON.stringify({
          start: result.overflowStartColumnIndex,
          end: result.overflowEndColumnIndex,
        });
      })()`)
    ),
    { start: 0, end: 2 },
    "文字延伸應記錄實際跨越的可見欄範圍"
  );
  assert.deepEqual(
    JSON.parse(
      harness.evaluate(`(() => {
        const border = Object.fromEntries(
          ["top", "right", "bottom", "left"].map((side) => [
            side,
            { style: "thin" },
          ])
        );
        const boundaries = new Set();
        registerOverflowBoundaries(boundaries, 0, {
          overflowStartColumnIndex: 0,
          overflowEndColumnIndex: 2,
        });
        return JSON.stringify([0, 1, 2].map((columnIndex) => {
          const result = borderWithoutOverflowEdges(
            border,
            0,
            columnIndex,
            boundaries
          );
          return {
            top: result.top?.style || null,
            right: result.right?.style || null,
            bottom: result.bottom?.style || null,
            left: result.left?.style || null,
          };
        }));
      })()`)
    ),
    [
      { top: "thin", right: null, bottom: "thin", left: "thin" },
      { top: "thin", right: null, bottom: "thin", left: null },
      { top: "thin", right: "thin", bottom: "thin", left: null },
    ],
    "文字延伸範圍內應只隱藏內部直線並保留外框與水平線"
  );
  assert.ok(
    harness.evaluate(`(() => {
      const testWorkbook = new ExcelJS.Workbook();
      const sheet = testWorkbook.addWorksheet("隱藏欄文字延伸");
      sheet.getCell("A1").value = "開班日期：每星期二 19：00 ~ 21：30";
      sheet.getColumn(4).hidden = true;
      sheet.getCell("G1").value = "壇主：測試";
      const layout = {
        columns: [
          { number: 1, width: 30 },
          { number: 2, width: 30 },
          { number: 3, width: 40 },
          { number: 5, width: 35 },
          { number: 6, width: 250 },
          { number: 7, width: 120 },
        ],
        rows: [{ number: 1, height: 20 }],
        scale: 1,
        scaleX: 1,
      };
      const box = { x: 0, y: 0, width: 30, height: 20 };
      return calculateOverflowTextBox(
        sheet, layout, 0, 0, sheet.getCell("A1"), box,
        buildMergeMaps(sheet), new Map()
      ).width;
    })()`) > 380,
    "未換行文字應跨過空白隱藏欄，並在下一個有內容的可見欄前停止"
  );
  assert.deepEqual(
    JSON.parse(
      harness.evaluate(`(() => {
        const order = [];
        const page = {
          drawRectangle() { order.push("background"); },
          drawText(value) { order.push("text:" + value); },
        };
        const blankStyledCell = {
          fill: {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FFFFFFFF" },
          },
        };
        const textCell = {
          value: "完整表頭",
          font: { size: 12 },
          alignment: { horizontal: "left", vertical: "middle" },
        };
        const box = { x: 0, y: 0, width: 200, height: 24 };
        drawCellBackground(page, textCell, box);
        drawCellBackground(page, blankStyledCell, box);
        drawCellText(
          page,
          textCell,
          box,
          {
            unicode: {
              widthOfTextAtSize(value, size) { return value.length * size; },
            },
          },
          1,
          {},
          box
        );
        return JSON.stringify(order);
      })()`)
    ),
    ["background", "text:完整表頭"],
    "有底色的空白儲存格必須先於延伸文字繪製，避免表頭被覆蓋"
  );
  const input = xlsx.buffer.slice(xlsx.byteOffset, xlsx.byteOffset + xlsx.byteLength);
  const parsed = await harness.send({
    type: "parse",
    name: "測試活頁簿.xlsx",
    buffer: input,
  });
  assert.equal(parsed.type, "parsed");
  assert.equal(parsed.sheets.length, 3);
  assert.equal(parsed.sheets[0].name, "銷售報表");
  assert.equal(parsed.sheets[2].state, "hidden");
  assert.ok(parsed.compatibility.summary.error >= 1);
  assert.ok(parsed.compatibility.summary.warning >= 2);
  assert.ok(parsed.compatibility.summary.info >= 2);
  const compatibilityCodes = parsed.compatibility.items.map((item) => item.code);
  assert.ok(compatibilityCodes.includes("images"), "PNG/JPEG 圖片應回報將轉入");
  assert.ok(
    compatibilityCodes.includes("images-unsupported"),
    "GIF 應回報為不支援格式"
  );
  assert.ok(
    compatibilityCodes.includes("rich-text-styled"),
    "「摘要」A5 的顏色/粗細差異 Rich Text 應標示為已還原樣式，而非合併成單一樣式"
  );
  assert.ok(
    compatibilityCodes.includes("hyperlink-display-mismatch"),
    "顯示網址與實際目標不同時應提出警告"
  );
  assert.equal(parsed.sheets[0].printSettings.repeatColumns, "A:A");
  assert.equal(
    parsed.sheets[0].printSettings.rowBreaks,
    "12",
    "應從 worksheet OOXML 補回人工水平分頁"
  );
  assert.equal(
    parsed.sheets[0].printSettings.columnBreaks,
    "B",
    "應從 worksheet OOXML 補回人工垂直分頁"
  );
  assert.equal(
    harness.evaluate(`(() => {
      const sheet = workbook.getWorksheet(1);
      const layout = createSheetLayout(sheet, sourceSheetSettings(sheet))[0];
      return Math.abs(layout.scaleX - layout.scaleY) < 1e-12;
    })()`),
    true,
    "Excel 版面縮放必須等比例套用到 X/Y 軸"
  );

  const estimated = await harness.send({
    type: "estimate",
    sheets: [
      {
        id: parsed.sheets[1].id,
        options: {
          ...parsed.sheets[1].printSettings,
          rangeMode: "custom",
          customRange: "A1:B6",
          paperSize: "a5",
          orientation: "landscape",
          addPageNumbers: true,
        },
      },
      {
        id: parsed.sheets[0].id,
        options: {
          ...parsed.sheets[0].printSettings,
          rangeMode: "custom",
          customRange: "A1:D26",
          paperSize: "a4",
          orientation: "portrait",
          repeatRows: "1:2",
          repeatColumns: "A:A",
          rowBreaks: "12",
          columnBreaks: "C",
          addPageNumbers: true,
        },
      },
    ],
  });
  assert.equal(estimated.type, "estimated");
  assert.equal(estimated.sheets[0].id, parsed.sheets[1].id);
  assert.ok(estimated.totalPages >= 3);

  const previewed = await harness.send({
    type: "preview",
    sheet: {
      id: parsed.sheets[1].id,
      options: {
        ...parsed.sheets[1].printSettings,
        rangeMode: "custom",
        customRange: "A1:B6",
        paperSize: "a5",
        orientation: "landscape",
        addPageNumbers: true,
      },
    },
    pageIndex: 0,
  });
  assert.equal(previewed.type, "previewed");
  assert.ok(previewed.bytes.byteLength > 1000);
  assert.ok(previewed.pageWidth > previewed.pageHeight);
  const previewPdf = await PDFLib.PDFDocument.load(
    new Uint8Array(previewed.bytes)
  );
  assert.equal(previewPdf.getPageCount(), 1);
  assert.ok(previewed.bytes.byteLength < 500000);
  if (process.env.PDF_EDITOR_PREVIEW_TEST_OUTPUT) {
    fs.writeFileSync(
      process.env.PDF_EDITOR_PREVIEW_TEST_OUTPUT,
      new Uint8Array(previewed.bytes)
    );
  }

  const converted = await harness.send({
    type: "convert",
    sheets: [
      {
        id: parsed.sheets[1].id,
        options: {
          ...parsed.sheets[1].printSettings,
          rangeMode: "custom",
          customRange: "A1:B6",
          paperSize: "a5",
          orientation: "landscape",
          addPageNumbers: true,
        },
      },
      {
        id: parsed.sheets[0].id,
        options: {
          ...parsed.sheets[0].printSettings,
          rangeMode: "custom",
          customRange: "A1:D26",
          paperSize: "a4",
          orientation: "portrait",
          repeatRows: "1:2",
          repeatColumns: "A:A",
          rowBreaks: "12",
          columnBreaks: "C",
          centerHorizontal: true,
          includeHeaderFooter: true,
          addPageNumbers: true,
          gridLines: true,
        },
      },
    ],
  });
  assert.equal(converted.type, "converted");
  assert.ok(converted.pageCount >= 2);
  const pdfBytes = new Uint8Array(converted.bytes);
  assert.ok(pdfBytes.byteLength > 1000);
  const pdf = await PDFLib.PDFDocument.load(pdfBytes);
  assert.equal(pdf.getPageCount(), converted.pageCount);
  const firstPage = pdf.getPage(0).getSize();
  assert.ok(firstPage.width > firstPage.height);
  assert.ok(
    converted.warnings.some((warning) => warning.includes("網址顯示文字與連結目標不一致")),
    "轉檔結果應回傳網址顯示文字／目標不一致警告"
  );
  const linkUris = [];
  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFLib.PDFDict)) continue;
    if (
      object.get(PDFLib.PDFName.of("Subtype")) !==
      PDFLib.PDFName.of("Link")
    ) {
      continue;
    }
    const action = pdf.context.lookup(
      object.get(PDFLib.PDFName.of("A")),
      PDFLib.PDFDict
    );
    const uri = action?.get(PDFLib.PDFName.of("URI"));
    if (uri?.decodeText) linkUris.push(uri.decodeText());
  }
  assert.ok(
    linkUris.includes("https://openai.com/"),
    "外部超連結應轉換為 PDF Link Annotation"
  );
  if (process.env.PDF_EDITOR_TEST_OUTPUT) {
    fs.writeFileSync(process.env.PDF_EDITOR_TEST_OUTPUT, pdfBytes);
  }

  if (process.env.PDF_EDITOR_REAL_XLSX) {
    const realHarness = await createWorkerHarness();
    const realBytes = fs.readFileSync(process.env.PDF_EDITOR_REAL_XLSX);
    const realInput = realBytes.buffer.slice(
      realBytes.byteOffset,
      realBytes.byteOffset + realBytes.byteLength
    );
    const realParsed = await realHarness.send({
      type: "parse",
      name: path.basename(process.env.PDF_EDITOR_REAL_XLSX),
      buffer: realInput,
    });
    const realTargets = process.env.PDF_EDITOR_REAL_ALL === "1"
      ? realParsed.sheets.filter((sheet) => sheet.state === "visible")
      : [
          realParsed.sheets.find(
            (sheet) =>
              sheet.name ===
              (process.env.PDF_EDITOR_REAL_SHEET || "忠恕交通2026")
          ),
        ].filter(Boolean);
    assert.ok(realTargets.length, "Real workbook regression sheet was not found");
    if (process.env.PDF_EDITOR_REAL_DEBUG === "1") {
      const debugSheetNames = (process.env.PDF_EDITOR_REAL_DEBUG_SHEETS || "")
        .split("|")
        .map((name) => name.trim())
        .filter(Boolean);
      const layoutDetails = JSON.parse(
        realHarness.evaluate(`JSON.stringify(workbook.worksheets
          .filter((worksheet) => worksheet.state === "visible")
          .map((worksheet) => {
            const settings = sourceSheetSettings(worksheet);
            const layouts = createSheetLayout(worksheet, settings);
            const range = worksheetRange(
              worksheet,
              settings.rangeMode,
              settings.customRange
            )[0];
            let unscaledHeight = 0;
            for (let row = range.top; row <= range.bottom; row += 1) {
              unscaledHeight += getRowHeight(worksheet, row);
            }
            let unscaledWidth = 0;
            for (let column = range.left; column <= range.right; column += 1) {
              unscaledWidth += getColumnWidth(worksheet, column);
            }
            return {
              name: worksheet.name,
              range: encodeRange(range),
              pageSetup: {
                fitToPage: worksheet.pageSetup?.fitToPage,
                fitToWidth: worksheet.pageSetup?.fitToWidth,
                fitToHeight: worksheet.pageSetup?.fitToHeight,
                scale: worksheet.pageSetup?.scale,
                orientation: worksheet.pageSetup?.orientation,
                paperSize: worksheet.pageSetup?.paperSize,
                printArea: worksheet.pageSetup?.printArea,
                printTitlesRow: worksheet.pageSetup?.printTitlesRow,
              },
              rowBreaks: worksheet.rowBreaks,
              pages: layouts.length,
              scale: layouts[0]?.scale,
              scaleX: layouts[0]?.scaleX,
              unscaledWidth,
              unscaledHeight,
              availableWidth: layouts[0]
                ? layouts[0].pageWidth - layouts[0].margins.left - layouts[0].margins.right
                : 0,
              availableHeight: layouts[0]
                ? layouts[0].pageHeight - layouts[0].margins.top - layouts[0].margins.bottom
                : 0,
              rowPages: layouts.map((layout) => ({
                first: layout.rows[0]?.number,
                last: layout.rows[layout.rows.length - 1]?.number,
                rows: layout.rows.length,
              })),
            };
          }))`)
      );
      const debugTargets = debugSheetNames.length
        ? realTargets.filter((sheet) => debugSheetNames.includes(sheet.name))
        : realTargets;
      process.stdout.write(
        `${JSON.stringify(
          debugTargets.map((sheet) => ({
            name: sheet.name,
            estimatedPages: sheet.estimatedPages,
            layout: layoutDetails.find((item) => item.name === sheet.name),
          })),
          null,
          2
        )}\n`
      );
    }
    const realConverted = await realHarness.send({
      type: "convert",
      sheets: realTargets.map((sheet) => ({
        id: sheet.id,
        options: {
          ...sheet.printSettings,
          rangeMode: "print-area",
        },
      })),
    });
    const realPdfBytes = new Uint8Array(realConverted.bytes);
    const realPdf = await PDFLib.PDFDocument.load(realPdfBytes);
    assert.equal(realPdf.getPageCount(), realConverted.pageCount);
    if (process.env.PDF_EDITOR_REAL_EXPECTED_PAGES) {
      assert.equal(
        realConverted.pageCount,
        Number(process.env.PDF_EDITOR_REAL_EXPECTED_PAGES),
        "Real workbook page count differs from the reference PDF"
      );
    }
    if (process.env.PDF_EDITOR_REAL_TEST_OUTPUT) {
      fs.writeFileSync(process.env.PDF_EDITOR_REAL_TEST_OUTPUT, realPdfBytes);
    }
    process.stdout.write(
      `Real workbook regression passed: ${realTargets.length} sheets, ${realConverted.pageCount} PDF pages, ${realPdfBytes.byteLength} bytes\n`
    );
  }

  // 字型回歸測試：曾發生 fontkit 子集化產生損壞字型導致中文缺字（poppler
  // 報 "Embedded font file may be invalid"）。此處抽出內嵌的 FontFile2，
  // 斷言 fontkit 可重新解析、實際用到的字有 glyph、未用到的字已被裁掉，
  // 防止未來升級 pdf-lib / fontkit / harfbuzzjs 時無聲退化。
  const embeddedFontFiles = [];
  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFLib.PDFDict)) continue;
    const fontFileRef = object.get(PDFLib.PDFName.of("FontFile2"));
    if (!fontFileRef) continue;
    const stream = pdf.context.lookup(fontFileRef, PDFLib.PDFRawStream);
    embeddedFontFiles.push(PDFLib.decodePDFRawStream(stream).decode());
  }
  assert.equal(embeddedFontFiles.length, 1, "應恰好內嵌一份中文字型");
  const embeddedFont = fontkit.create(Buffer.from(embeddedFontFiles[0]));
  for (const character of "銷售報表南區重要提示第頁□…09") {
    assert.ok(
      embeddedFont.hasGlyphForCodePoint(character.codePointAt(0)),
      `內嵌字型缺少 glyph：${character}`
    );
  }
  assert.ok(
    !embeddedFont.hasGlyphForCodePoint("龜".codePointAt(0)),
    "內嵌字型未經子集化（包含未使用的 glyph）"
  );
  assert.ok(
    embeddedFontFiles[0].byteLength < 200000,
    `內嵌字型子集過大：${embeddedFontFiles[0].byteLength} bytes`
  );
  assert.ok(
    pdfBytes.byteLength < 500000,
    `輸出 PDF 過大（子集化可能失效）：${pdfBytes.byteLength} bytes`
  );

  // 圖片轉換：workbook 有兩張 PNG 媒體（D2 標題列 logo 與 B14 圖片，後者
  // 跨工作表重複使用但只嵌一份）與一張應略過的 GIF。排除 alpha 通道的
  // SMask 後，主圖 XObject 應恰好兩份。
  const imageStreams = new Map();
  const smaskRefs = new Set();
  for (const [ref, object] of pdf.context.enumerateIndirectObjects()) {
    if (
      object instanceof PDFLib.PDFRawStream &&
      object.dict.get(PDFLib.PDFName.of("Subtype")) ===
        PDFLib.PDFName.of("Image")
    ) {
      imageStreams.set(String(ref), object);
      const smask = object.dict.get(PDFLib.PDFName.of("SMask"));
      if (smask) smaskRefs.add(String(smask));
    }
  }
  const mainImageCount = [...imageStreams.keys()].filter(
    (ref) => !smaskRefs.has(ref)
  ).length;
  assert.equal(mainImageCount, 2, "應嵌入兩份主圖（GIF 略過、共用媒體不重複嵌入）");

  // used range 應被浮動圖片擴大：摘要工作表資料只到第 6 列，圖片錨在第
  // 10 列（高 60px ≈ 45pt），估算範圍的底列必須涵蓋圖片。
  const usedEstimate = await harness.send({
    type: "estimate",
    sheets: [
      {
        id: parsed.sheets[1].id,
        options: { ...parsed.sheets[1].printSettings, rangeMode: "used" },
      },
    ],
  });
  const usedRangeText = usedEstimate.sheets[0].ranges[0];
  const usedBottomRow = Number(usedRangeText.match(/(\d+)$/)?.[1]);
  assert.ok(
    usedBottomRow >= 11,
    `used range 未涵蓋浮動圖片：${usedRangeText}`
  );

  // 儲存格內圖片（richValue）：#VALUE! 應轉為圖片並繪製於儲存格內。
  const cellHarness = await createWorkerHarness();
  const cellXlsxBytes = await buildInCellImageWorkbook();
  const cellParsed = await cellHarness.send({
    type: "parse",
    name: "儲存格內圖片.xlsx",
    buffer: cellXlsxBytes.buffer.slice(
      cellXlsxBytes.byteOffset,
      cellXlsxBytes.byteOffset + cellXlsxBytes.byteLength
    ),
  });
  assert.ok(
    cellParsed.compatibility.items.some((item) => item.code === "cell-images"),
    "應回報儲存格內圖片將轉入"
  );
  const cellConverted = await cellHarness.send({
    type: "convert",
    sheets: [{ id: cellParsed.sheets[0].id, options: {} }],
  });
  const cellPdf = await PDFLib.PDFDocument.load(
    new Uint8Array(cellConverted.bytes)
  );
  let cellImageCount = 0;
  for (const [, object] of cellPdf.context.enumerateIndirectObjects()) {
    if (
      object instanceof PDFLib.PDFRawStream &&
      object.dict.get(PDFLib.PDFName.of("Subtype")) ===
        PDFLib.PDFName.of("Image")
    ) {
      cellImageCount += 1;
    }
  }
  assert.ok(cellImageCount >= 1, "儲存格內圖片未嵌入輸出 PDF");

  process.stdout.write(
    `Excel worker test passed: ${parsed.sheets.length} sheets, ${converted.pageCount} PDF pages, ${pdfBytes.byteLength} bytes\n`
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
