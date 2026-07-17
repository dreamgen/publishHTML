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

  const summary = workbook.addWorksheet("摘要");
  summary.addRows([
    ["區域", "營收"],
    ["北區", 120000],
    ["中區", 98000],
    ["南區", 110000],
  ]);
  summary.columns = [{ width: 20 }, { width: 18 }];
  summary.getRow(1).font = { bold: true };

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
    "vendor/pdf-lib/NotoSansCJKtc-Regular.otf"
  );
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
    async fetch() {
      const bytes = fs.readFileSync(fontPath);
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
  vm.runInContext(
    fs.readFileSync(path.join(editorRoot, "excel-worker.js"), "utf8"),
    context,
    { filename: "excel-worker.js" }
  );
  return {
    messages,
    async send(data) {
      await listeners.message({ data });
      const terminal = [...messages]
        .reverse()
        .find((message) =>
          ["parsed", "converted", "error"].includes(message.type)
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

  const converted = await harness.send({
    type: "convert",
    sheetIds: [parsed.sheets[0].id, parsed.sheets[1].id],
    options: {
      paperSize: "source",
      orientation: "source",
      scaling: "fit-width",
      usePrintArea: true,
    },
  });
  assert.equal(converted.type, "converted");
  assert.ok(converted.pageCount >= 2);
  const pdfBytes = new Uint8Array(converted.bytes);
  assert.ok(pdfBytes.byteLength > 1000);
  const pdf = await PDFLib.PDFDocument.load(pdfBytes);
  assert.equal(pdf.getPageCount(), converted.pageCount);
  if (process.env.PDF_EDITOR_TEST_OUTPUT) {
    fs.writeFileSync(process.env.PDF_EDITOR_TEST_OUTPUT, pdfBytes);
  }

  process.stdout.write(
    `Excel worker test passed: ${parsed.sheets.length} sheets, ${converted.pageCount} PDF pages, ${pdfBytes.byteLength} bytes\n`
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
