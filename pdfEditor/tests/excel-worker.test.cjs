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

  // 圖片轉換案例：PNG（oneCell 與 twoCell 錨點）應轉入 PDF，GIF 應略過。
  const TEST_PNG_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
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

  const hidden = workbook.addWorksheet("內部設定");
  hidden.state = "hidden";
  hidden.addRow(["不應預設選取", 123]);
  return workbook.xlsx.writeBuffer();
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
  // hb-subset 包裝器會掛在 context.self 上；worker 端以全域 HBSubset 取用。
  vm.runInContext(
    fs.readFileSync(path.join(editorRoot, "vendor/hb-subset/hb-subset.js"), "utf8"),
    context,
    { filename: "hb-subset.js" }
  );
  context.HBSubset = context.self.HBSubset;
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

  process.stdout.write(
    `Excel worker test passed: ${parsed.sheets.length} sheets, ${converted.pageCount} PDF pages, ${pdfBytes.byteLength} bytes\n`
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
