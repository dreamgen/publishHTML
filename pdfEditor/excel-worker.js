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
  scaling: "source",
  scalePercent: 100,
  rangeMode: "print-area",
  customRange: "",
  margins: "source",
  repeatRows: "",
  repeatColumns: "",
  rowBreaks: "",
  columnBreaks: "",
  pageOrder: "source",
  centerHorizontal: false,
  centerVertical: false,
  includeHeaderFooter: true,
  addPageNumbers: false,
  gridLines: false,
};
const MAX_CELLS_PER_SHEET = 300000;
const MAX_TOTAL_CELLS = 750000;
const MAX_OUTPUT_PAGES = 250;
const MIN_FIT_SCALE = 0.35;
const PAPER_SIZES = {
  a3: [841.89, 1190.55],
  a4: [595.28, 841.89],
  a5: [419.53, 595.28],
  letter: [612, 792],
  legal: [612, 1008],
  tabloid: [792, 1224],
};
const PAPER_SIZE_CODES = {
  1: "letter",
  3: "tabloid",
  5: "legal",
  8: "a3",
  9: "a4",
  11: "a5",
};

let workbook = null;
let workbookName = "活頁簿.xlsx";
let fontBytesPromise = null;
let outlineFontPromise = null;
let compatibilityReport = { summary: { error: 0, warning: 0, info: 0 }, items: [] };

const postProgress = (requestId, title, detail, progress) =>
  postMessage({ type: "progress", requestId, title, detail, progress });

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

function parseRanges(value) {
  return String(value || "")
    .split(/&&|[,;\n]/)
    .map(decodeRange)
    .filter(Boolean);
}

function worksheetRange(worksheet, rangeMode = "print-area", customRange = "") {
  if (rangeMode === "custom") {
    const parsed = parseRanges(customRange);
    if (!parsed.length) {
      throw new Error(`「${worksheet.name}」的自訂範圍格式不正確。`);
    }
    return parsed;
  }

  if (rangeMode === "print-area" && worksheet.pageSetup?.printArea) {
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

function parseTitleColumns(value, range) {
  const match = String(value || "")
    .replace(/^.*!/, "")
    .replace(/\$/g, "")
    .match(/^([A-Z]+):([A-Z]+)$/i);
  if (!match) return [];
  const startAddress = decodeCellAddress(`${match[1]}1`);
  const endAddress = decodeCellAddress(`${match[2]}1`);
  if (!startAddress || !endAddress) return [];
  const start = Math.max(range.left, Math.min(startAddress.column, endAddress.column));
  const end = Math.min(range.right, Math.max(startAddress.column, endAddress.column));
  const columns = [];
  for (let column = start; column <= end; column += 1) columns.push(column);
  return columns;
}

function parseRowBreaks(value) {
  return new Set(
    String(value || "")
      .split(/[,;\s]+/)
      .map((item) => Number(item))
      .filter((item) => Number.isInteger(item) && item > 0)
  );
}

function parseColumnBreaks(value) {
  return new Set(
    String(value || "")
      .split(/[,;\s]+/)
      .map((item) => {
        if (/^\d+$/.test(item)) return Number(item);
        return decodeCellAddress(`${item}1`)?.column;
      })
      .filter((item) => Number.isInteger(item) && item > 0)
  );
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
  return PAPER_SIZE_CODES[worksheet.pageSetup?.paperSize] || "a4";
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
  const marginPresets = {
    normal: { left: 50.4, right: 50.4, top: 54, bottom: 54 },
    narrow: { left: 18, right: 18, top: 36, bottom: 36 },
    wide: { left: 72, right: 72, top: 72, bottom: 72 },
  };
  const preset = marginPresets[options.margins];
  const margin = (key, fallback) => {
    if (preset) return preset[key];
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
      header: clamp((Number(sourceMargins.header) || 0.3) * 72, 9, 72),
      footer: clamp((Number(sourceMargins.footer) || 0.3) * 72, 9, 72),
    },
  };
}

function chunkBySize(items, availableSize, sizeOf, breaksAfter = new Set()) {
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
    if (breaksAfter.has(item.number)) {
      chunks.push(current);
      current = [];
      currentSize = 0;
    }
  }
  if (current.length) chunks.push(current);
  return chunks.length ? chunks : [[]];
}

function resolvedScaling(worksheet, options, totalWidth, totalHeight, availableWidth, availableHeight) {
  let mode = options.scaling;
  let percent = clamp(Number(options.scalePercent) || 100, 10, 400) / 100;
  if (mode === "source") {
    const source = worksheet.pageSetup || {};
    if (source.fitToPage && Number(source.fitToHeight) === 1) mode = "fit-page";
    else if (source.fitToPage || Number(source.fitToWidth) === 1) mode = "fit-width";
    else {
      mode = "custom";
      percent = clamp(Number(source.scale) || 100, 10, 400) / 100;
    }
  }
  if (mode === "actual") return 1;
  if (mode === "custom") return percent;
  if (mode === "fit-page") {
    return Math.max(
      MIN_FIT_SCALE,
      Math.min(availableWidth / Math.max(1, totalWidth), availableHeight / Math.max(1, totalHeight))
    );
  }
  if (mode === "fit-width" && totalWidth > availableWidth) {
    return Math.max(MIN_FIT_SCALE, availableWidth / totalWidth);
  }
  return 1;
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
  const totalHeight = rows.reduce((sum, row) => sum + row.height, 0);
  const scale = resolvedScaling(
    worksheet,
    options,
    totalWidth,
    totalHeight,
    availableWidth,
    availableHeight
  );

  const titleColumnNumbers = parseTitleColumns(options.repeatColumns, range);
  const titleColumns = columns.filter((column) => titleColumnNumbers.includes(column.number));
  const titleWidth = titleColumns.reduce((sum, column) => sum + column.width, 0);
  const bodyColumns = columns.filter((column) => !titleColumnNumbers.includes(column.number));
  const columnChunks = chunkBySize(
    bodyColumns,
    Math.max(20, availableWidth / scale - titleWidth),
    (column) => column.width,
    parseColumnBreaks(options.columnBreaks)
  ).map((chunk) => [...titleColumns, ...chunk]);
  const titleRowNumbers = parseTitleRows(
    options.repeatRows,
    range
  );
  const titleRows = rows.filter((row) => titleRowNumbers.includes(row.number));
  const titleHeight = titleRows.reduce((sum, row) => sum + row.height, 0);
  const bodyRows = rows.filter((row) => !titleRowNumbers.includes(row.number));
  const rowChunks = chunkBySize(
    bodyRows,
    Math.max(20, availableHeight / scale - titleHeight),
    (row) => row.height,
    parseRowBreaks(options.rowBreaks)
  );

  const pages = [];
  const pageOrder =
    options.pageOrder === "source"
      ? worksheet.pageSetup?.pageOrder || "downThenOver"
      : options.pageOrder;
  const addPage = (columnChunk, rowChunk, rowChunkIndex) => {
    const repeatedTitles = rowChunkIndex > 0 ? titleRows : [];
    const firstPageTitles = rowChunkIndex === 0 ? titleRows : [];
    const pageRows = [...firstPageTitles, ...repeatedTitles, ...rowChunk];
    const contentWidth = columnChunk.reduce((sum, column) => sum + column.width, 0) * scale;
    const contentHeight = pageRows.reduce((sum, row) => sum + row.height, 0) * scale;
    pages.push({
      range,
      columns: columnChunk,
      rows: pageRows,
      scale,
      contentOffsetX: options.centerHorizontal
        ? Math.max(0, (availableWidth - contentWidth) / 2)
        : 0,
      contentOffsetY: options.centerVertical
        ? Math.max(0, (availableHeight - contentHeight) / 2)
        : 0,
      options,
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

function normalizeSheetOptions(worksheet, rawOptions = {}) {
  const legacyRangeMode =
    Object.prototype.hasOwnProperty.call(rawOptions || {}, "usePrintArea")
      ? rawOptions.usePrintArea
        ? "print-area"
        : "used"
      : undefined;
  return {
    ...DEFAULT_OPTIONS,
    ...rawOptions,
    rangeMode: legacyRangeMode || rawOptions?.rangeMode || DEFAULT_OPTIONS.rangeMode,
    repeatRows:
      rawOptions?.repeatRows ?? worksheet.pageSetup?.printTitlesRow ?? "",
    repeatColumns:
      rawOptions?.repeatColumns ?? worksheet.pageSetup?.printTitlesColumn ?? "",
    rowBreaks:
      rawOptions?.rowBreaks ??
      (worksheet.rowBreaks || []).map((item) => item.id).filter(Boolean).join(","),
    columnBreaks:
      rawOptions?.columnBreaks ??
      (worksheet.columnBreaks || []).map((item) => item.id).filter(Boolean).join(","),
    centerHorizontal:
      rawOptions?.centerHorizontal ?? !!worksheet.pageSetup?.horizontalCentered,
    centerVertical:
      rawOptions?.centerVertical ?? !!worksheet.pageSetup?.verticalCentered,
    gridLines: rawOptions?.gridLines ?? !!worksheet.pageSetup?.showGridLines,
  };
}

function createSheetLayout(worksheet, rawOptions = {}) {
  const options = normalizeSheetOptions(worksheet, rawOptions);
  const ranges = worksheetRange(worksheet, options.rangeMode, options.customRange);
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

function drawText(page, value, options) {
  const { font } = options;
  if (!font?.outlineSource) {
    page.drawText(value, options);
    return;
  }

  const run = font.outlineSource.layout(value);
  const scale = options.size / font.outlineSource.unitsPerEm;
  let cursorX = options.x;
  for (let index = 0; index < run.glyphs.length; index += 1) {
    const glyph = run.glyphs[index];
    const position = run.positions[index];
    let path = font.pathCache.get(glyph.id);
    if (!path) {
      // pdf-lib converts SVG's downward Y axis to PDF coordinates. Fontkit
      // glyph paths already use an upward Y axis, so invert them once first.
      path = glyph.path.scale(1, -1).toSVG();
      font.pathCache.set(glyph.id, path);
    }
    if (path) {
      page.drawSvgPath(path, {
        x: cursorX + position.xOffset * scale,
        y: options.y + position.yOffset * scale,
        scale,
        color: options.color,
      });
    }
    cursorX += position.xAdvance * scale;
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
    (layout.contentOffsetX || 0) +
    columns.slice(0, columnIndex).reduce((sum, item) => sum + item.width, 0) *
      scale;
  const top =
    layout.pageHeight -
    layout.margins.top -
    (layout.contentOffsetY || 0) -
    rows.slice(0, rowIndex).reduce((sum, item) => sum + item.height, 0) *
      scale;
  return {
    x,
    y: top - height * scale,
    width: width * scale,
    height: height * scale,
  };
}

function drawCell(page, cell, box, fonts, scale, options) {
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
  if (options?.gridLines) {
    page.drawRectangle({
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      borderColor: rgb(0.82, 0.84, 0.88),
      borderWidth: Math.max(0.2, 0.35 * scale),
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
    drawText(page, line, {
      x: Math.max(box.x + 0.5, x),
      y,
      size: fontSize,
      font,
      color: textColor,
    });
  });
}

function splitHeaderFooterSections(value) {
  const sections = { left: "", center: "", right: "" };
  let active = "center";
  const parts = String(value || "").split(/(&[LCR])/i);
  for (const part of parts) {
    if (/^&L$/i.test(part)) active = "left";
    else if (/^&C$/i.test(part)) active = "center";
    else if (/^&R$/i.test(part)) active = "right";
    else sections[active] += part;
  }
  return sections;
}

function expandHeaderFooter(value, worksheet, pageIndex, pageCount) {
  const now = new Date();
  const pageNumber =
    (worksheet.pageSetup?.useFirstPageNumber
      ? Number(worksheet.pageSetup?.firstPageNumber) || 1
      : 1) + pageIndex;
  const replacements = {
    P: String(pageNumber),
    N: String(pageCount),
    A: worksheet.name,
    F: workbookName,
    D: now.toLocaleDateString("zh-TW"),
    T: now.toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" }),
  };
  const escapedAmpersand = "\u0000";
  return String(value || "")
    .replace(/&&/g, escapedAmpersand)
    .replace(/&"[^"]*"/g, "")
    .replace(/&K[0-9A-F]{6}/gi, "")
    .replace(/&\d+(?:\.\d+)?/g, "")
    .replace(/&\[(?:Date|Time)\]/gi, "")
    .replace(/&([PNAFDT])/gi, (_, token) => replacements[token.toUpperCase()] || "")
    .replace(/&[BIEUSXYOGH+-]/gi, "")
    .replaceAll(escapedAmpersand, "&")
    .trim();
}

function sourceHeaderFooterValue(worksheet, kind, pageIndex) {
  const headerFooter = worksheet.headerFooter || {};
  const isHeader = kind === "header";
  if (pageIndex === 0 && headerFooter.differentFirst) {
    return headerFooter[isHeader ? "firstHeader" : "firstFooter"] || "";
  }
  if ((pageIndex + 1) % 2 === 0 && headerFooter.differentOddEven) {
    return headerFooter[isHeader ? "evenHeader" : "evenFooter"] || "";
  }
  return headerFooter[isHeader ? "oddHeader" : "oddFooter"] || "";
}

function drawHeaderFooterLine(page, rawValue, worksheet, fonts, layout, pageIndex, pageCount, kind) {
  if (!rawValue) return;
  const sections = splitHeaderFooterSections(rawValue);
  const font = fonts.unicode;
  const size = 8;
  const y =
    kind === "header"
      ? layout.pageHeight - layout.margins.header - size
      : layout.margins.footer;
  const left = layout.margins.left;
  const right = layout.pageWidth - layout.margins.right;
  const maxWidth = Math.max(24, (right - left) * 0.32);
  for (const [alignment, rawText] of Object.entries(sections)) {
    let value = expandHeaderFooter(rawText, worksheet, pageIndex, pageCount);
    if (!value) continue;
    value = sanitizeTextForFont(font, value, size);
    value = truncateText(font, value, size, maxWidth);
    const width = lineWidth(font, value, size);
    let x = left;
    if (alignment === "center") x = (layout.pageWidth - width) / 2;
    else if (alignment === "right") x = right - width;
    drawText(page, value, {
      x: Math.max(left, x),
      y,
      size,
      font,
      color: rgb(0.28, 0.3, 0.34),
    });
  }
}

function drawPageDecorations(page, worksheet, fonts, layout, pageIndex, pageCount) {
  if (layout.options?.includeHeaderFooter) {
    drawHeaderFooterLine(
      page,
      sourceHeaderFooterValue(worksheet, "header", pageIndex),
      worksheet,
      fonts,
      layout,
      pageIndex,
      pageCount,
      "header"
    );
    drawHeaderFooterLine(
      page,
      sourceHeaderFooterValue(worksheet, "footer", pageIndex),
      worksheet,
      fonts,
      layout,
      pageIndex,
      pageCount,
      "footer"
    );
  }
  if (layout.options?.addPageNumbers) {
    drawHeaderFooterLine(
      page,
      "&C第 &P / &N 頁",
      worksheet,
      fonts,
      layout,
      pageIndex,
      pageCount,
      "footer"
    );
  }
}

function renderWorksheetPage(pdf, worksheet, layout, fonts, pageIndex, pageCount) {
  const merges = buildMergeMaps(worksheet);
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
      drawCell(page, cell, box, fonts, layout.scale, layout.options);
    }
  }
  drawPageDecorations(page, worksheet, fonts, layout, pageIndex, pageCount);
  return page;
}

async function renderWorksheet(
  pdf,
  worksheet,
  layouts,
  fonts,
  progressState,
  requestId
) {
  for (let pageIndex = 0; pageIndex < layouts.length; pageIndex += 1) {
    renderWorksheetPage(pdf, worksheet, layouts[pageIndex], fonts, pageIndex, layouts.length);
    progressState.completed += 1;
    postProgress(
      requestId,
      "正在將 Excel 轉成 PDF",
      `${worksheet.name}：第 ${pageIndex + 1} / ${layouts.length} 頁`,
      Math.round((progressState.completed / progressState.total) * 92)
    );
  }
}

function createCompatibilityIssue(worksheet, severity, code, message, detail = "") {
  return {
    severity,
    code,
    sheetId: worksheet.id,
    sheetName: worksheet.name,
    message,
    detail,
  };
}

function auditWorksheet(worksheet) {
  const issues = [];
  const imageCount = worksheet.getImages?.().length || 0;
  if (imageCount) {
    issues.push(
      createCompatibilityIssue(
        worksheet,
        "warning",
        "images",
        `${imageCount} 張圖片不會轉入 PDF`,
        "目前保留儲存格內容與版面，嵌入圖片將略過。"
      )
    );
  }

  const conditionalCount = worksheet.conditionalFormattings?.length || 0;
  if (conditionalCount) {
    issues.push(
      createCompatibilityIssue(
        worksheet,
        "warning",
        "conditional-formatting",
        `${conditionalCount} 組條件格式可能與 Excel 不同`,
        "PDF 會使用儲存格的基礎樣式，不會計算條件格式規則。"
      )
    );
  }

  const counters = {
    missingFormulaResults: 0,
    externalFormulas: 0,
    richText: 0,
    hyperlinks: 0,
    rotatedText: 0,
    gradientFills: 0,
  };
  const examples = Object.fromEntries(Object.keys(counters).map((key) => [key, []]));
  const record = (key, cell) => {
    counters[key] += 1;
    if (examples[key].length < 3) examples[key].push(cell.address);
  };

  worksheet.eachRow({ includeEmpty: false }, (row) => {
    row.eachCell({ includeEmpty: false }, (cell) => {
      const value = cell.value;
      const formula = value?.formula || value?.sharedFormula;
      if (formula && value?.result == null) record("missingFormulaResults", cell);
      if (formula && /\[[^\]]+\]/.test(formula)) record("externalFormulas", cell);
      if (value?.richText) record("richText", cell);
      if (value?.hyperlink) record("hyperlinks", cell);
      if (cell.alignment?.textRotation) record("rotatedText", cell);
      if (cell.fill?.type === "gradient") record("gradientFills", cell);
    });
  });

  const exampleText = (key) =>
    examples[key].length ? `例如 ${examples[key].join("、")}` : "";
  if (counters.missingFormulaResults) {
    issues.push(
      createCompatibilityIssue(
        worksheet,
        "error",
        "formula-without-result",
        `${counters.missingFormulaResults} 個公式沒有已儲存結果`,
        `${exampleText("missingFormulaResults")}；這些儲存格在 PDF 中可能為空白。請先用 Excel 重新計算並儲存。`
      )
    );
  }
  if (counters.externalFormulas) {
    issues.push(
      createCompatibilityIssue(
        worksheet,
        "warning",
        "external-formula",
        `${counters.externalFormulas} 個公式引用外部活頁簿`,
        `${exampleText("externalFormulas")}；只會使用檔案中已儲存的結果。`
      )
    );
  }
  if (counters.richText) {
    issues.push(
      createCompatibilityIssue(
        worksheet,
        "info",
        "rich-text",
        `${counters.richText} 個 Rich Text 儲存格會合併成單一樣式`,
        exampleText("richText")
      )
    );
  }
  if (counters.hyperlinks) {
    issues.push(
      createCompatibilityIssue(
        worksheet,
        "info",
        "hyperlinks",
        `${counters.hyperlinks} 個超連結只保留顯示文字`,
        exampleText("hyperlinks")
      )
    );
  }
  if (counters.rotatedText) {
    issues.push(
      createCompatibilityIssue(
        worksheet,
        "warning",
        "rotated-text",
        `${counters.rotatedText} 個旋轉文字會改以水平顯示`,
        exampleText("rotatedText")
      )
    );
  }
  if (counters.gradientFills) {
    issues.push(
      createCompatibilityIssue(
        worksheet,
        "warning",
        "gradient-fill",
        `${counters.gradientFills} 個漸層填色不會轉換`,
        exampleText("gradientFills")
      )
    );
  }

  if (
    (worksheet.model?.merges || []).some((value) => {
      const range = decodeRange(value);
      return range && (range.bottom - range.top > 100 || range.right - range.left > 50);
    })
  ) {
    issues.push(
      createCompatibilityIssue(
        worksheet,
        "warning",
        "large-merge",
        "大型合併儲存格可能跨越分頁",
        "建議在預覽中確認分頁位置，或縮小自訂範圍。"
      )
    );
  }

  if (worksheet.pageSetup?.showRowColHeaders) {
    issues.push(
      createCompatibilityIssue(
        worksheet,
        "info",
        "row-column-headings",
        "Excel 的列號與欄名不會列印",
        "資料儲存格與格線設定仍會保留。"
      )
    );
  }
  if (
    worksheet.pageSetup?.paperSize &&
    !PAPER_SIZE_CODES[worksheet.pageSetup.paperSize]
  ) {
    issues.push(
      createCompatibilityIssue(
        worksheet,
        "info",
        "paper-size-fallback",
        "原始紙張尺寸目前不在支援清單",
        "使用「依 Excel 設定」時會改用 A4，可在 Sheet 設定中另選紙張。"
      )
    );
  }
  return issues;
}

function auditWorkbook() {
  const items = workbook.worksheets.flatMap(auditWorksheet);
  const summary = { error: 0, warning: 0, info: 0 };
  for (const item of items) summary[item.severity] += 1;
  return { summary, items };
}

function issuesForSheet(sheetId) {
  return compatibilityReport.items.filter((item) => item.sheetId === sheetId);
}

function sourceSheetSettings(worksheet) {
  const printRanges = worksheetRange(worksheet, "print-area");
  const usedRanges = worksheetRange(worksheet, "used");
  return {
    rangeMode: worksheet.pageSetup?.printArea ? "print-area" : "used",
    customRange: (worksheet.pageSetup?.printArea ? printRanges : usedRanges)
      .map(encodeRange)
      .join(","),
    paperSize: "source",
    sourcePaperSize: sourcePaperSize(worksheet),
    orientation: "source",
    scaling: "source",
    scalePercent: clamp(Number(worksheet.pageSetup?.scale) || 100, 10, 400),
    margins: "source",
    repeatRows: worksheet.pageSetup?.printTitlesRow || "",
    repeatColumns: worksheet.pageSetup?.printTitlesColumn || "",
    rowBreaks: (worksheet.rowBreaks || [])
      .map((item) => item.id)
      .filter(Boolean)
      .join(","),
    columnBreaks: (worksheet.columnBreaks || [])
      .map((item) => item.id)
      .filter(Boolean)
      .map(columnLetters)
      .join(","),
    pageOrder: "source",
    centerHorizontal: !!worksheet.pageSetup?.horizontalCentered,
    centerVertical: !!worksheet.pageSetup?.verticalCentered,
    includeHeaderFooter: true,
    addPageNumbers: false,
    gridLines: !!worksheet.pageSetup?.showGridLines,
  };
}

function describeWorkbook() {
  return workbook.worksheets.map((worksheet) => {
    const ranges = worksheetRange(worksheet, "print-area");
    const fallbackRanges = worksheetRange(worksheet, "used");
    const printSettings = sourceSheetSettings(worksheet);
    let estimatedPages = 1;
    try {
      estimatedPages = createSheetLayout(worksheet, printSettings).length;
    } catch {}
    const issues = issuesForSheet(worksheet.id);
    return {
      id: worksheet.id,
      name: worksheet.name,
      state: worksheet.state || "visible",
      range: ranges.map(encodeRange).join("、"),
      usedRange: fallbackRanges.map(encodeRange).join("、"),
      rowCount: worksheet.actualRowCount || worksheet.rowCount || 0,
      columnCount: worksheet.actualColumnCount || worksheet.columnCount || 0,
      estimatedPages,
      printSettings,
      compatibility: {
        error: issues.filter((item) => item.severity === "error").length,
        warning: issues.filter((item) => item.severity === "warning").length,
        info: issues.filter((item) => item.severity === "info").length,
      },
      warnings: issues
        .filter((item) => item.severity !== "info")
        .map((item) => `${worksheet.name}：${item.message}`),
    };
  });
}

async function parseWorkbook(message) {
  postProgress(message.requestId, "正在讀取 Excel", message.name || "活頁簿", 8);
  workbookName = message.name || workbookName;
  workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(message.buffer);
  compatibilityReport = auditWorkbook();
  const sheets = describeWorkbook();
  if (!sheets.length) throw new Error("Excel 中沒有可轉換的工作表。");
  postMessage({
    type: "parsed",
    requestId: message.requestId,
    name: workbookName,
    sheets,
    compatibility: compatibilityReport,
  });
}

function buildSheetJobs(message) {
  if (!workbook) throw new Error("Excel 尚未完成解析，請重新選擇檔案。");
  const specs = Array.isArray(message.sheets) && message.sheets.length
    ? message.sheets
    : (message.sheetIds || []).map((id) => ({ id, options: message.options || {} }));
  const jobs = specs.map((spec) => {
    const worksheet = workbook.getWorksheet(Number(spec.id));
    if (!worksheet) throw new Error(`找不到 Sheet ID ${spec.id}。`);
    const options = normalizeSheetOptions(worksheet, spec.options || {});
    return { worksheet, options, pages: createSheetLayout(worksheet, options) };
  });
  if (!jobs.length) throw new Error("請至少選取一個 Sheet。");
  return jobs;
}

function estimateWorkbook(message) {
  const jobs = buildSheetJobs(message);
  postMessage({
    type: "estimated",
    requestId: message.requestId,
    totalPages: jobs.reduce((sum, job) => sum + job.pages.length, 0),
    sheets: jobs.map((job) => ({
      id: job.worksheet.id,
      pageCount: job.pages.length,
      ranges: [...new Set(job.pages.map((page) => encodeRange(page.range)))],
    })),
  });
}

async function getPdfFonts(pdf, { outlineUnicode = false } = {}) {
  pdf.registerFontkit(fontkit);
  if (!fontBytesPromise) {
    fontBytesPromise = fetch(
      new URL("./vendor/pdf-lib/NotoSansTC-Regular.ttf", self.location.href)
    ).then(async (response) => {
      if (!response.ok) throw new Error("中文字型載入失敗。");
      return response.arrayBuffer();
    });
  }
  let unicode;
  if (outlineUnicode) {
    if (!outlineFontPromise) {
      outlineFontPromise = fontBytesPromise.then((bytes) => {
        const outlineSource = fontkit.create(new Uint8Array(bytes));
        return {
          outlineSource,
          pathCache: new Map(),
          widthOfTextAtSize(value, size) {
            const run = outlineSource.layout(String(value || ""));
            const units = run.positions.reduce(
              (sum, position) => sum + position.xAdvance,
              0
            );
            return (units * size) / outlineSource.unitsPerEm;
          },
        };
      });
    }
    unicode = await outlineFontPromise;
  } else {
    // fontkit can omit CJK glyphs when subsetting large Unicode fonts. Embed the
    // static TrueType font intact so exported PDFs render consistently across
    // PDF.js, Preview/Acrobat and Poppler-based viewers.
    unicode = await pdf.embedFont(await fontBytesPromise, { subset: false });
  }
  return {
    unicode,
    ascii: await pdf.embedFont(StandardFonts.Helvetica),
    asciiBold: await pdf.embedFont(StandardFonts.HelveticaBold),
    asciiItalic: await pdf.embedFont(StandardFonts.HelveticaOblique),
    asciiBoldItalic: await pdf.embedFont(StandardFonts.HelveticaBoldOblique),
  };
}

function setPdfMetadata(pdf) {
  pdf.setTitle(workbookName.replace(/\.(xlsx|xlsm)$/i, ""));
  pdf.setCreator("PDF 工坊");
  pdf.setProducer("PDF 工坊 / ExcelJS / pdf-lib");
  pdf.setModificationDate(new Date());
}

async function previewWorkbook(message) {
  const jobs = buildSheetJobs({ ...message, sheets: [message.sheet] });
  const job = jobs[0];
  const pageIndex = clamp(Number(message.pageIndex) || 0, 0, job.pages.length - 1);
  const layout = job.pages[pageIndex];
  const pdf = await PDFDocument.create();
  // Vector outlines keep one-page previews small and fast. The final PDF still
  // embeds the intact font so its text remains selectable and searchable.
  const fonts = await getPdfFonts(pdf, { outlineUnicode: true });
  setPdfMetadata(pdf);
  renderWorksheetPage(
    pdf,
    job.worksheet,
    layout,
    fonts,
    pageIndex,
    job.pages.length
  );
  const bytes = await pdf.save({ useObjectStreams: true, addDefaultPage: false });
  postMessage(
    {
      type: "previewed",
      requestId: message.requestId,
      sheetId: job.worksheet.id,
      pageIndex,
      pageCount: job.pages.length,
      pageWidth: layout.pageWidth,
      pageHeight: layout.pageHeight,
      bytes: bytes.buffer,
    },
    [bytes.buffer]
  );
}

async function convertWorkbook(message) {
  const layouts = buildSheetJobs(message);
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

  postProgress(message.requestId, "正在準備 Excel PDF", `共 ${totalPages} 頁`, 2);
  const pdf = await PDFDocument.create();
  const fonts = await getPdfFonts(pdf);
  setPdfMetadata(pdf);

  const progressState = { completed: 0, total: totalPages };
  const warnings = [];
  for (const item of layouts) {
    warnings.push(
      ...issuesForSheet(item.worksheet.id)
        .filter((issue) => issue.severity !== "info")
        .map((issue) => `${item.worksheet.name}：${issue.message}`)
    );
    await renderWorksheet(
      pdf,
      item.worksheet,
      item.pages,
      fonts,
      progressState,
      message.requestId
    );
  }

  postProgress(message.requestId, "正在完成 Excel PDF", "寫入檔案資料", 96);
  const bytes = await pdf.save({ useObjectStreams: true, addDefaultPage: false });
  postMessage(
    {
      type: "converted",
      requestId: message.requestId,
      bytes: bytes.buffer,
      pageCount: totalPages,
      warnings: [...new Set(warnings)],
    },
    [bytes.buffer]
  );
}

self.addEventListener("message", async (event) => {
  const requestId = event.data?.requestId;
  try {
    if (event.data?.type === "parse") {
      await parseWorkbook(event.data);
    } else if (event.data?.type === "estimate") {
      estimateWorkbook(event.data);
    } else if (event.data?.type === "preview") {
      await previewWorkbook(event.data);
    } else if (event.data?.type === "convert") {
      await convertWorkbook(event.data);
    }
  } catch (error) {
    console.error("[Excel Worker]", error);
    postMessage({
      type: "error",
      requestId,
      message: error?.message || "Excel 轉換失敗。",
      stack: error?.stack || "",
    });
  }
});
