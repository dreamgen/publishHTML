/* global ExcelJS, PDFLib, fontkit */

importScripts(
  "./vendor/exceljs/exceljs.min.js",
  "./vendor/pdf-lib/pdf-lib.min.js",
  "./vendor/pdf-lib/fontkit.umd.min.js"
);

const { PDFDocument, StandardFonts, rgb } = PDFLib;
const DEFAULT_OPTIONS = {
  paperSize: "source",
  orientation: "source",
  scaling: "fit-width",
  usePrintArea: true,
};
const MAX_CELLS_PER_SHEET = 300000;
const MAX_TOTAL_CELLS = 750000;
const MAX_OUTPUT_PAGES = 250;
const MIN_FIT_SCALE = 0.35;
const PAPER_SIZES = {
  a4: [595.28, 841.89],
  letter: [612, 792],
};

let workbook = null;
let workbookName = "活頁簿.xlsx";

const postProgress = (title, detail, progress) =>
  postMessage({ type: "progress", title, detail, progress });

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function columnLetters(column) {
  let value = column;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result || "A";
}

function decodeCellAddress(value) {
  const match = String(value || "")
    .replace(/^.*!/, "")
    .replace(/\$/g, "")
    .match(/^([A-Z]+)(\d+)$/i);
  if (!match) return null;
  let column = 0;
  for (const character of match[1].toUpperCase()) {
    column = column * 26 + character.charCodeAt(0) - 64;
  }
  return { row: Number(match[2]), column };
}

function decodeRange(value) {
  const normalized = String(value || "")
    .replace(/^.*!/, "")
    .replace(/\$/g, "")
    .trim();
  const [startValue, endValue = startValue] = normalized.split(":");
  const start = decodeCellAddress(startValue);
  const end = decodeCellAddress(endValue);
  if (!start || !end) return null;
  return {
    top: Math.min(start.row, end.row),
    left: Math.min(start.column, end.column),
    bottom: Math.max(start.row, end.row),
    right: Math.max(start.column, end.column),
  };
}

function encodeRange(range) {
  return `${columnLetters(range.left)}${range.top}:${columnLetters(
    range.right
  )}${range.bottom}`;
}

function worksheetRange(worksheet, usePrintArea = true) {
  if (usePrintArea && worksheet.pageSetup?.printArea) {
    const parsed = String(worksheet.pageSetup.printArea)
      .split("&&")
      .map(decodeRange)
      .filter(Boolean);
    if (parsed.length) return parsed;
  }

  const dimensions = worksheet.dimensions?.model || worksheet.model?.dimensions;
  if (
    dimensions &&
    Number.isFinite(dimensions.top) &&
    Number.isFinite(dimensions.left) &&
    Number.isFinite(dimensions.bottom) &&
    Number.isFinite(dimensions.right)
  ) {
    return [
      {
        top: Math.max(1, dimensions.top),
        left: Math.max(1, dimensions.left),
        bottom: Math.max(1, dimensions.bottom),
        right: Math.max(1, dimensions.right),
      },
    ];
  }

  return [{ top: 1, left: 1, bottom: 1, right: 1 }];
}

function parseTitleRows(value, range) {
  const match = String(value || "")
    .replace(/^.*!/, "")
    .replace(/\$/g, "")
    .match(/^(\d+):(\d+)$/);
  if (!match) return [];
  const start = Math.max(range.top, Number(match[1]));
  const end = Math.min(range.bottom, Number(match[2]));
  const rows = [];
  for (let row = start; row <= end; row += 1) rows.push(row);
  return rows;
}

function excelColumnWidthToPoints(width) {
  const resolved = Number.isFinite(width) && width > 0 ? width : 8.43;
  return Math.max(5, Math.floor(resolved * 7 + 5) * 0.75);
}

function getColumnWidth(worksheet, columnNumber) {
  const column = worksheet.getColumn(columnNumber);
  if (column?.hidden) return 0;
  return excelColumnWidthToPoints(
    column?.width || worksheet.properties?.defaultColWidth || 8.43
  );
}

function getRowHeight(worksheet, rowNumber) {
  const row = worksheet.getRow(rowNumber);
  if (row?.hidden) return 0;
  const height = row?.height || worksheet.properties?.defaultRowHeight || 15;
  return clamp(Number(height) || 15, 2, 409);
}

function sourcePaperSize(worksheet) {
  return worksheet.pageSetup?.paperSize === 1 ? "letter" : "a4";
}

function resolvePageGeometry(worksheet, range, options) {
  const paperKey =
    options.paperSize === "source"
      ? sourcePaperSize(worksheet)
      : options.paperSize;
  let [pageWidth, pageHeight] = PAPER_SIZES[paperKey] || PAPER_SIZES.a4;

  const rawContentWidth = Array.from(
    { length: range.right - range.left + 1 },
    (_, index) => getColumnWidth(worksheet, range.left + index)
  ).reduce((sum, width) => sum + width, 0);

  let orientation = options.orientation;
  if (orientation === "source") {
    orientation = worksheet.pageSetup?.orientation || "portrait";
  } else if (orientation === "auto") {
    orientation = rawContentWidth > 540 ? "landscape" : "portrait";
  }
  if (orientation === "landscape" && pageHeight > pageWidth) {
    [pageWidth, pageHeight] = [pageHeight, pageWidth];
  }
  if (orientation === "portrait" && pageWidth > pageHeight) {
    [pageWidth, pageHeight] = [pageHeight, pageWidth];
  }

  const sourceMargins = worksheet.pageSetup?.margins || {};
  const margin = (key, fallback) => {
    const value = Number(sourceMargins[key]);
    return clamp(Number.isFinite(value) ? value * 72 : fallback, 9, 108);
  };

  return {
    pageWidth,
    pageHeight,
    margins: {
      left: margin("left", 36),
      right: margin("right", 36),
      top: margin("top", 36),
      bottom: margin("bottom", 36),
    },
  };
}

function chunkBySize(items, availableSize, sizeOf) {
  const chunks = [];
  let current = [];
  let currentSize = 0;
  for (const item of items) {
    const itemSize = sizeOf(item);
    if (current.length && currentSize + itemSize > availableSize) {
      chunks.push(current);
      current = [];
      currentSize = 0;
    }
    current.push(item);
    currentSize += itemSize;
  }
  if (current.length) chunks.push(current);
  return chunks.length ? chunks : [[]];
}

function createRangeLayout(worksheet, range, options) {
  const geometry = resolvePageGeometry(worksheet, range, options);
  const availableWidth =
    geometry.pageWidth - geometry.margins.left - geometry.margins.right;
  const availableHeight =
    geometry.pageHeight - geometry.margins.top - geometry.margins.bottom;
  const columns = [];
  for (let column = range.left; column <= range.right; column += 1) {
    const width = getColumnWidth(worksheet, column);
    if (width > 0) columns.push({ number: column, width });
  }
  const rows = [];
  for (let row = range.top; row <= range.bottom; row += 1) {
    const height = getRowHeight(worksheet, row);
    if (height > 0) rows.push({ number: row, height });
  }

  const totalWidth = columns.reduce((sum, column) => sum + column.width, 0);
  let scale = 1;
  if (options.scaling === "fit-width" && totalWidth > availableWidth) {
    scale = Math.max(MIN_FIT_SCALE, availableWidth / totalWidth);
  }

  const columnChunks = chunkBySize(
    columns,
    availableWidth / scale,
    (column) => column.width
  );
  const titleRowNumbers = parseTitleRows(
    worksheet.pageSetup?.printTitlesRow,
    range
  );
  const titleRows = rows.filter((row) => titleRowNumbers.includes(row.number));
  const titleHeight = titleRows.reduce((sum, row) => sum + row.height, 0);
  const bodyRows = rows.filter((row) => !titleRowNumbers.includes(row.number));
  const rowChunks = chunkBySize(
    bodyRows,
    Math.max(20, availableHeight / scale - titleHeight),
    (row) => row.height
  );

  const pages = [];
  const pageOrder = worksheet.pageSetup?.pageOrder || "downThenOver";
  const addPage = (columnChunk, rowChunk, rowChunkIndex) => {
    const repeatedTitles = rowChunkIndex > 0 ? titleRows : [];
    const firstPageTitles = rowChunkIndex === 0 ? titleRows : [];
    pages.push({
      range,
      columns: columnChunk,
      rows: [...firstPageTitles, ...repeatedTitles, ...rowChunk],
      scale,
      ...geometry,
    });
  };

  if (pageOrder === "overThenDown") {
    for (let rowIndex = 0; rowIndex < rowChunks.length; rowIndex += 1) {
      for (const columnChunk of columnChunks) {
        addPage(columnChunk, rowChunks[rowIndex], rowIndex);
      }
    }
  } else {
    for (const columnChunk of columnChunks) {
      for (let rowIndex = 0; rowIndex < rowChunks.length; rowIndex += 1) {
        addPage(columnChunk, rowChunks[rowIndex], rowIndex);
      }
    }
  }

  return pages;
}

function createSheetLayout(worksheet, rawOptions = DEFAULT_OPTIONS) {
  const options = { ...DEFAULT_OPTIONS, ...rawOptions };
  const ranges = worksheetRange(worksheet, options.usePrintArea);
  return ranges.flatMap((range) => createRangeLayout(worksheet, range, options));
}

function argbToRgb(color, fallback = rgb(0.08, 0.1, 0.16)) {
  let value = color?.argb;
  if (!value && color?.indexed === 64) return fallback;
  if (!value || typeof value !== "string") return fallback;
  value = value.replace(/^#/, "").slice(-6).padStart(6, "0");
  return rgb(
    parseInt(value.slice(0, 2), 16) / 255,
    parseInt(value.slice(2, 4), 16) / 255,
    parseInt(value.slice(4, 6), 16) / 255
  );
}

function borderWidth(style) {
  if (!style) return 0;
  if (/thick|double/i.test(style)) return 1.5;
  if (/medium/i.test(style)) return 1;
  return 0.5;
}

function lineWidth(font, value, size) {
  try {
    return font.widthOfTextAtSize(value, size);
  } catch {
    return value.length * size * 0.55;
  }
}

function sanitizeTextForFont(font, value, size) {
  let result = "";
  for (const character of [...String(value || "")]) {
    try {
      font.widthOfTextAtSize(character, size);
      result += character;
    } catch {
      result += "□";
    }
  }
  return result;
}

function truncateText(font, value, size, maxWidth) {
  if (lineWidth(font, value, size) <= maxWidth) return value;
  const suffix = "…";
  let result = value;
  while (result.length && lineWidth(font, result + suffix, size) > maxWidth) {
    result = result.slice(0, -1);
  }
  return result ? result + suffix : "";
}

function wrapText(font, value, size, maxWidth, shouldWrap) {
  const sourceLines = String(value || "").replace(/\r/g, "").split("\n");
  if (!shouldWrap) {
    return sourceLines.map((line) => truncateText(font, line, size, maxWidth));
  }

  const lines = [];
  for (const sourceLine of sourceLines) {
    if (!sourceLine) {
      lines.push("");
      continue;
    }
    let current = "";
    for (const character of [...sourceLine]) {
      const candidate = current + character;
      if (current && lineWidth(font, candidate, size) > maxWidth) {
        lines.push(current);
        current = character;
      } else {
        current = candidate;
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

function buildMergeMaps(worksheet) {
  const masters = new Map();
  const children = new Set();
  for (const mergeValue of worksheet.model?.merges || []) {
    const range = decodeRange(mergeValue);
    if (!range) continue;
    const masterKey = `${range.top}:${range.left}`;
    masters.set(masterKey, range);
    for (let row = range.top; row <= range.bottom; row += 1) {
      for (let column = range.left; column <= range.right; column += 1) {
        const key = `${row}:${column}`;
        if (key !== masterKey) children.add(key);
      }
    }
  }
  return { masters, children };
}

function formatDateValue(value, numFmt) {
  const year = value.getFullYear();
  const month = value.getMonth() + 1;
  const day = value.getDate();
  const hours = value.getHours();
  const minutes = value.getMinutes();
  const seconds = value.getSeconds();
  let format = String(numFmt || "yyyy/mm/dd")
    .split(";")[0]
    .replace(/\[\$-[^\]]+\]/g, "")
    .replace(/"([^"]*)"/g, "$1")
    .toLowerCase();

  if (!/[yd]/.test(format)) format = "yyyy/mm/dd";
  const replacements = {
    yyyy: String(year).padStart(4, "0"),
    yy: String(year % 100).padStart(2, "0"),
    mm: String(month).padStart(2, "0"),
    m: String(month),
    dd: String(day).padStart(2, "0"),
    d: String(day),
    hh: String(hours).padStart(2, "0"),
    h: String(hours),
    ss: String(seconds).padStart(2, "0"),
    s: String(seconds),
  };
  format = format.replace(
    /yyyy|yy|mm|dd|hh|ss|m|d|h|s/g,
    (token) => replacements[token]
  );
  if (/[h]/i.test(String(numFmt || ""))) {
    format = format.replace(/(^|[^0-9])mm([^0-9]|$)/, (_, before, after) =>
      `${before}${String(minutes).padStart(2, "0")}${after}`
    );
  }
  return format;
}

function formatNumberValue(value, numFmt) {
  const format = String(numFmt || "").split(";")[0];
  if (!format || /^general$/i.test(format)) return String(value);
  const percent = format.includes("%");
  const decimalMatch = format.match(/[0#],?(?:[0#]{3},?)*\.([0#]+)/);
  const decimals = decimalMatch ? decimalMatch[1].length : 0;
  const useGrouping = /[0#],[0#]{3}/.test(format);
  const numericValue = percent ? value * 100 : value;
  const formatted = new Intl.NumberFormat("zh-TW", {
    useGrouping,
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(numericValue);
  const currency = format.match(/(?:NT\$|US\$|HK\$|[$¥€£])/i)?.[0] || "";
  return `${currency}${formatted}${percent ? "%" : ""}`;
}

function cellText(cell) {
  if (cell?.value == null) return "";
  if (cell.value?.richText) {
    return cell.value.richText.map((part) => part.text || "").join("");
  }
  if (cell.value?.error) return String(cell.value.error);
  const value = cell.value?.formula ? cell.value.result : cell.value;
  if (value == null) return "";
  if (value instanceof Date) return formatDateValue(value, cell.numFmt);
  if (typeof value === "number") return formatNumberValue(value, cell.numFmt);
  if (typeof cell.text === "string") return cell.text;
  return String(value);
}

function drawBorders(page, border, x, y, width, height, scale) {
  const sides = {
    top: [x, y + height, x + width, y + height],
    right: [x + width, y, x + width, y + height],
    bottom: [x, y, x + width, y],
    left: [x, y, x, y + height],
  };
  for (const [side, points] of Object.entries(sides)) {
    const style = border?.[side];
    const thickness = borderWidth(style?.style) * scale;
    if (!thickness) continue;
    page.drawLine({
      start: { x: points[0], y: points[1] },
      end: { x: points[2], y: points[3] },
      thickness,
      color: argbToRgb(style?.color, rgb(0.25, 0.28, 0.34)),
    });
  }
}

function calculateCellBox(layout, rowIndex, columnIndex, mergeRange) {
  const scale = layout.scale;
  const columns = layout.columns;
  const rows = layout.rows;
  const column = columns[columnIndex];
  const row = rows[rowIndex];
  let width = column.width;
  let height = row.height;

  if (mergeRange) {
    width = columns
      .filter(
        (item) =>
          item.number >= mergeRange.left && item.number <= mergeRange.right
      )
      .reduce((sum, item) => sum + item.width, 0);
    height = rows
      .filter(
        (item) => item.number >= mergeRange.top && item.number <= mergeRange.bottom
      )
      .reduce((sum, item) => sum + item.height, 0);
  }

  const x =
    layout.margins.left +
    columns.slice(0, columnIndex).reduce((sum, item) => sum + item.width, 0) *
      scale;
  const top =
    layout.pageHeight -
    layout.margins.top -
    rows.slice(0, rowIndex).reduce((sum, item) => sum + item.height, 0) *
      scale;
  return {
    x,
    y: top - height * scale,
    width: width * scale,
    height: height * scale,
  };
}

function drawCell(page, cell, box, fonts, scale) {
  const fill = cell.fill;
  if (fill?.type === "pattern" && fill.pattern === "solid") {
    page.drawRectangle({
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      color: argbToRgb(fill.fgColor, rgb(1, 1, 1)),
    });
  }
  drawBorders(page, cell.border, box.x, box.y, box.width, box.height, scale);

  const value = cellText(cell);
  if (!value) return;

  const asciiOnly = /^[\x00-\x7F]*$/.test(value);
  const wantsBold = !!cell.font?.bold;
  const wantsItalic = !!cell.font?.italic;
  let font = fonts.unicode;
  if (asciiOnly) {
    if (wantsBold && wantsItalic) font = fonts.asciiBoldItalic;
    else if (wantsBold) font = fonts.asciiBold;
    else if (wantsItalic) font = fonts.asciiItalic;
    else font = fonts.ascii;
  }

  const fontSize = clamp(Number(cell.font?.size) || 11, 5, 72) * scale;
  const safeValue = sanitizeTextForFont(font, value, fontSize);
  const padding = Math.max(1.5, 2.5 * scale);
  const maxWidth = Math.max(1, box.width - padding * 2);
  const maxHeight = Math.max(1, box.height - padding * 2);
  const lineHeight = fontSize * 1.18;
  let lines = wrapText(
    font,
    safeValue,
    fontSize,
    maxWidth,
    !!cell.alignment?.wrapText
  );
  const maxLines = Math.max(1, Math.floor(maxHeight / lineHeight));
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    lines[maxLines - 1] = truncateText(
      font,
      lines[maxLines - 1] + "…",
      fontSize,
      maxWidth
    );
  }

  const blockHeight = lines.length * lineHeight;
  const vertical = cell.alignment?.vertical || "middle";
  let firstBaseline;
  if (vertical === "top") {
    firstBaseline = box.y + box.height - padding - fontSize;
  } else if (vertical === "bottom") {
    firstBaseline = box.y + padding + blockHeight - lineHeight;
  } else {
    firstBaseline =
      box.y + (box.height + blockHeight) / 2 - lineHeight + (lineHeight - fontSize) / 2;
  }

  const textColor = argbToRgb(cell.font?.color, rgb(0.08, 0.1, 0.16));
  lines.forEach((line, lineIndex) => {
    const width = lineWidth(font, line, fontSize);
    const horizontal = cell.alignment?.horizontal || "left";
    let x = box.x + padding;
    if (horizontal === "center" || horizontal === "centerContinuous") {
      x = box.x + (box.width - width) / 2;
    } else if (horizontal === "right") {
      x = box.x + box.width - padding - width;
    }
    const y = firstBaseline - lineIndex * lineHeight;
    if (y < box.y - 0.1 || y + fontSize > box.y + box.height + 0.1) return;
    page.drawText(line, {
      x: Math.max(box.x + 0.5, x),
      y,
      size: fontSize,
      font,
      color: textColor,
    });
  });
}

async function renderWorksheet(pdf, worksheet, layouts, fonts, progressState) {
  const merges = buildMergeMaps(worksheet);
  for (let pageIndex = 0; pageIndex < layouts.length; pageIndex += 1) {
    const layout = layouts[pageIndex];
    const page = pdf.addPage();
    page.setSize(layout.pageWidth, layout.pageHeight);
    for (let rowIndex = 0; rowIndex < layout.rows.length; rowIndex += 1) {
      const row = layout.rows[rowIndex];
      for (
        let columnIndex = 0;
        columnIndex < layout.columns.length;
        columnIndex += 1
      ) {
        const column = layout.columns[columnIndex];
        const key = `${row.number}:${column.number}`;
        if (merges.children.has(key)) continue;
        const cell = worksheet.getCell(row.number, column.number);
        const box = calculateCellBox(
          layout,
          rowIndex,
          columnIndex,
          merges.masters.get(key)
        );
        drawCell(page, cell, box, fonts, layout.scale);
      }
    }

    progressState.completed += 1;
    postProgress(
      "正在將 Excel 轉成 PDF",
      `${worksheet.name}：第 ${pageIndex + 1} / ${layouts.length} 頁`,
      Math.round((progressState.completed / progressState.total) * 92)
    );
  }
}

function sheetWarnings(worksheet) {
  const warnings = [];
  const imageCount = worksheet.getImages?.().length || 0;
  if (imageCount) warnings.push(`${worksheet.name}：${imageCount} 張圖片尚未轉換`);
  if (worksheet.conditionalFormattings?.length) {
    warnings.push(`${worksheet.name}：條件格式可能與 Excel 顯示不同`);
  }
  if ((worksheet.model?.merges || []).some((value) => {
    const range = decodeRange(value);
    return range && (range.bottom - range.top > 100 || range.right - range.left > 50);
  })) {
    warnings.push(`${worksheet.name}：大型合併儲存格可能跨越分頁`);
  }
  return warnings;
}

function describeWorkbook() {
  return workbook.worksheets.map((worksheet) => {
    const ranges = worksheetRange(worksheet, true);
    const fallbackRanges = worksheetRange(worksheet, false);
    let estimatedPages = 1;
    try {
      estimatedPages = createSheetLayout(worksheet, DEFAULT_OPTIONS).length;
    } catch {}
    return {
      id: worksheet.id,
      name: worksheet.name,
      state: worksheet.state || "visible",
      range: ranges.map(encodeRange).join("、"),
      usedRange: fallbackRanges.map(encodeRange).join("、"),
      rowCount: worksheet.actualRowCount || worksheet.rowCount || 0,
      columnCount: worksheet.actualColumnCount || worksheet.columnCount || 0,
      estimatedPages,
      warnings: sheetWarnings(worksheet),
    };
  });
}

async function parseWorkbook(message) {
  postProgress("正在讀取 Excel", message.name || "活頁簿", 8);
  workbookName = message.name || workbookName;
  workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(message.buffer);
  const sheets = describeWorkbook();
  if (!sheets.length) throw new Error("Excel 中沒有可轉換的工作表。");
  postMessage({ type: "parsed", name: workbookName, sheets });
}

async function convertWorkbook(message) {
  if (!workbook) throw new Error("Excel 尚未完成解析，請重新選擇檔案。");
  const selectedIds = new Set((message.sheetIds || []).map(Number));
  const worksheets = workbook.worksheets.filter((sheet) => selectedIds.has(sheet.id));
  if (!worksheets.length) throw new Error("請至少選取一個 Sheet。");

  const options = { ...DEFAULT_OPTIONS, ...(message.options || {}) };
  const layouts = worksheets.map((worksheet) => ({
    worksheet,
    pages: createSheetLayout(worksheet, options),
  }));
  const totalCells = layouts.reduce(
    (total, item) =>
      total +
      item.pages.reduce(
        (sum, page) => sum + page.rows.length * page.columns.length,
        0
      ),
    0
  );
  for (const item of layouts) {
    const sheetCells = item.pages.reduce(
      (sum, page) => sum + page.rows.length * page.columns.length,
      0
    );
    if (sheetCells > MAX_CELLS_PER_SHEET) {
      throw new Error(`「${item.worksheet.name}」範圍過大，請先在 Excel 設定較小的列印範圍。`);
    }
  }
  if (totalCells > MAX_TOTAL_CELLS) {
    throw new Error("選取的工作表範圍過大，請減少 Sheet 或設定列印範圍。");
  }

  const totalPages = layouts.reduce((sum, item) => sum + item.pages.length, 0);
  if (totalPages > MAX_OUTPUT_PAGES) {
    throw new Error(`預估會產生 ${totalPages} 頁，超過單次上限 ${MAX_OUTPUT_PAGES} 頁。`);
  }

  postProgress("正在準備 Excel PDF", `共 ${totalPages} 頁`, 2);
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const fontResponse = await fetch(
    new URL("./vendor/pdf-lib/NotoSansCJKtc-Regular.otf", self.location.href)
  );
  if (!fontResponse.ok) throw new Error("中文字型載入失敗。");
  const unicode = await pdf.embedFont(await fontResponse.arrayBuffer(), {
    subset: true,
  });
  const fonts = {
    unicode,
    ascii: await pdf.embedFont(StandardFonts.Helvetica),
    asciiBold: await pdf.embedFont(StandardFonts.HelveticaBold),
    asciiItalic: await pdf.embedFont(StandardFonts.HelveticaOblique),
    asciiBoldItalic: await pdf.embedFont(StandardFonts.HelveticaBoldOblique),
  };
  pdf.setTitle(workbookName.replace(/\.(xlsx|xlsm)$/i, ""));
  pdf.setCreator("PDF 工坊");
  pdf.setProducer("PDF 工坊 / ExcelJS / pdf-lib");
  pdf.setModificationDate(new Date());

  const progressState = { completed: 0, total: totalPages };
  const warnings = [];
  for (const item of layouts) {
    warnings.push(...sheetWarnings(item.worksheet));
    await renderWorksheet(
      pdf,
      item.worksheet,
      item.pages,
      fonts,
      progressState
    );
  }

  postProgress("正在完成 Excel PDF", "寫入檔案資料", 96);
  const bytes = await pdf.save({ useObjectStreams: true, addDefaultPage: false });
  postMessage(
    {
      type: "converted",
      bytes: bytes.buffer,
      pageCount: totalPages,
      warnings: [...new Set(warnings)],
    },
    [bytes.buffer]
  );
}

self.addEventListener("message", async (event) => {
  try {
    if (event.data?.type === "parse") {
      await parseWorkbook(event.data);
    } else if (event.data?.type === "convert") {
      await convertWorkbook(event.data);
    }
  } catch (error) {
    console.error("[Excel Worker]", error);
    postMessage({
      type: "error",
      message: error?.message || "Excel 轉換失敗。",
      stack: error?.stack || "",
    });
  }
});
