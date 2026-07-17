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
  return workbook.xlsx.writeBuffer();
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
  assert.equal(parsed.sheets[0].printSettings.repeatColumns, "A:A");

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
  if (process.env.PDF_EDITOR_TEST_OUTPUT) {
    fs.writeFileSync(process.env.PDF_EDITOR_TEST_OUTPUT, pdfBytes);
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
