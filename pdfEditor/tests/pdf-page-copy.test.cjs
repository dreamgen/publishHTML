const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");

const editorRoot = path.resolve(__dirname, "..");
const PDFLib = require(path.join(editorRoot, "vendor/pdf-lib/pdf-lib.min.js"));
const fontkit = require(path.join(editorRoot, "vendor/pdf-lib/fontkit.umd.min.js"));
const moduleUrl = pathToFileURL(path.join(editorRoot, "pdf-page-copy.mjs")).href;

async function sourceDocumentWithSharedFont() {
  const source = await PDFLib.PDFDocument.create();
  source.registerFontkit(fontkit);
  const fontBytes = fs.readFileSync(
    path.join(editorRoot, "vendor/pdf-lib/NotoSansTC-Regular.ttf")
  );
  const font = await source.embedFont(fontBytes, { subset: true });
  source.addPage().drawText("第一頁共用字型", { font, size: 14, x: 40, y: 700 });
  source.addPage().drawText("第二頁共用字型", { font, size: 14, x: 40, y: 700 });
  return PDFLib.PDFDocument.load(await source.save({ useObjectStreams: true }));
}

function embeddedFontFileCount(pdf) {
  const refs = new Set();
  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFLib.PDFDict)) continue;
    const fontFile = object.get(PDFLib.PDFName.of("FontFile2"));
    if (fontFile) refs.add(String(fontFile));
  }
  return refs.size;
}

test("pages from the same source share embedded font resources", async () => {
  const { copyPagesBySource } = await import(moduleUrl);
  const source = await sourceDocumentWithSharedFont();
  const output = await PDFLib.PDFDocument.create();
  const copied = await copyPagesBySource(output, [
    { key: "page-1", sourceDocument: source, sourcePageIndex: 0 },
    { key: "page-2", sourceDocument: source, sourcePageIndex: 1 },
  ]);
  output.addPage(copied.get("page-1"));
  output.addPage(copied.get("page-2"));
  const bytes = await output.save({ useObjectStreams: true });
  const saved = await PDFLib.PDFDocument.load(bytes);
  assert.equal(saved.getPageCount(), 2);
  assert.equal(
    embeddedFontFileCount(saved),
    1,
    "同一來源 PDF 的共用字型應只複製一次"
  );

  const naiveOutput = await PDFLib.PDFDocument.create();
  for (const pageIndex of [0, 1]) {
    const [page] = await naiveOutput.copyPages(source, [pageIndex]);
    naiveOutput.addPage(page);
  }
  const naiveBytes = await naiveOutput.save({ useObjectStreams: true });
  const naiveSaved = await PDFLib.PDFDocument.load(naiveBytes);
  assert.equal(
    embeddedFontFileCount(naiveSaved),
    2,
    "測試基準應能重現逐頁 copyPages 的字型重複"
  );
  assert.ok(bytes.byteLength < naiveBytes.byteLength);
});
