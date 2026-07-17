/* global ExcelJS, PDFLib, fontkit, HBSubset, fflate */

importScripts(
  "./vendor/exceljs/exceljs.min.js",
  "./vendor/pdf-lib/pdf-lib.min.js",
  "./vendor/pdf-lib/fontkit.umd.min.js",
  "./vendor/hb-subset/hb-subset.js",
  "./vendor/fflate/fflate.min.js"
);

const {
  PDFDocument,
  StandardFonts,
  rgb,
  pushGraphicsState,
  popGraphicsState,
  moveTo,
  lineTo,
  closePath,
  clip,
  endPath,
} = PDFLib;
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
const EMU_PER_POINT = 12700;
const PIXEL_TO_POINT = 0.75;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const SUPPORTED_IMAGE_EXTENSIONS = new Set(["png", "jpeg", "jpg"]);
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
// Excel 365「儲存格內圖片」（richValue）：sheetName → Map("row:col" → {bytes, extension})
let inCellImagesBySheet = new Map();
let fontBytesPromise = null;
let outlineFontPromise = null;
let sourceFontPromise = null;
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

function cellHasVisibleFormatting(cell) {
  const fill = cell.fill;
  if (
    (fill?.type === "pattern" && fill.pattern && fill.pattern !== "none") ||
    fill?.type === "gradient"
  ) {
    return true;
  }
  return ["top", "right", "bottom", "left", "diagonal"].some(
    (side) => !!cell.border?.[side]?.style
  );
}

// Excel 的 dimensions 會把隱藏的輔助欄、查表資料與曾經編輯過的尾端儲存格
// 一併算入。這些內容不會出現在 Excel 的列印結果，若直接拿 dimensions
// 分頁，便會產生只有頁尾或完全空白的額外頁面。未設定明確 Print_Area 時，
// 以可見且實際能顯示的儲存格重新收斂範圍；合併儲存格的從屬格會自然把標題
// 或表格邊界擴展到完整寬度。
function visibleUsedRange(worksheet, fallback) {
  let top = Infinity;
  let left = Infinity;
  let bottom = 0;
  let right = 0;

  worksheet.eachRow({ includeEmpty: false }, (row) => {
    if (row.hidden) return;
    row.eachCell({ includeEmpty: false }, (cell) => {
      const columnNumber = Number(cell.col);
      if (!Number.isFinite(columnNumber) || worksheet.getColumn(columnNumber)?.hidden) {
        return;
      }
      if (!cellText(cell) && !cellHasVisibleFormatting(cell)) return;
      top = Math.min(top, row.number);
      left = Math.min(left, columnNumber);
      bottom = Math.max(bottom, row.number);
      right = Math.max(right, columnNumber);
    });
  });

  if (!Number.isFinite(top) || !bottom || !right) return fallback;
  return { top, left, bottom, right };
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
      expandRangeForDrawings(
        worksheet,
        visibleUsedRange(worksheet, {
          top: Math.max(1, dimensions.top),
          left: Math.max(1, dimensions.left),
          bottom: Math.max(1, dimensions.bottom),
          right: Math.max(1, dimensions.right),
        })
      ),
    ];
  }

  return [{ top: 1, left: 1, bottom: 1, right: 1 }];
}

// 儲存格的 used range 不含浮動圖片；若圖片錨在資料範圍之外（例如表尾附
// 圖），Excel 列印仍會涵蓋它。這裡依圖片的錨點範圍擴大 used range。僅在
// 未設定列印範圍、也未指定自訂範圍時套用（與 Excel 行為一致）。
function expandRangeForDrawings(worksheet, range) {
  for (const item of worksheet.getImages?.() || []) {
    const anchor = item.range;
    const tl = anchor?.tl;
    if (!tl) continue;
    const extension = String(
      workbook?.model?.media?.[item.imageId]?.extension || ""
    ).toLowerCase();
    if (!SUPPORTED_IMAGE_EXTENSIONS.has(extension)) continue;
    const topRow = (tl.nativeRow || 0) + 1;
    const leftColumn = (tl.nativeCol || 0) + 1;
    let bottomRow = topRow;
    let rightColumn = leftColumn;
    if (anchor.br) {
      bottomRow =
        (anchor.br.nativeRow || 0) + ((anchor.br.nativeRowOff || 0) > 0 ? 1 : 0);
      rightColumn =
        (anchor.br.nativeCol || 0) + ((anchor.br.nativeColOff || 0) > 0 ? 1 : 0);
    } else if (anchor.ext) {
      bottomRow = rowAtSheetOffset(
        worksheet,
        sheetOffsetY(worksheet, tl.nativeRow || 0, tl.nativeRowOff) +
          (Number(anchor.ext.height) || 0) * PIXEL_TO_POINT,
        topRow
      );
      rightColumn = columnAtSheetOffset(
        worksheet,
        sheetOffsetX(worksheet, tl.nativeCol || 0, tl.nativeColOff) +
          (Number(anchor.ext.width) || 0) * PIXEL_TO_POINT,
        leftColumn
      );
    }
    range.top = Math.min(range.top, topRow);
    range.left = Math.min(range.left, leftColumn);
    range.bottom = Math.max(range.bottom, Math.max(topRow, bottomRow));
    range.right = Math.max(range.right, Math.max(leftColumn, rightColumn));
  }
  return range;
}

const DRAWING_SCAN_LIMIT = 2000;

function rowAtSheetOffset(worksheet, absoluteY, startRow) {
  let accumulated = sheetOffsetY(worksheet, Math.max(0, startRow - 1), 0);
  for (let row = startRow; row < startRow + DRAWING_SCAN_LIMIT; row += 1) {
    accumulated += getRowHeight(worksheet, row);
    if (accumulated >= absoluteY) return row;
  }
  return startRow;
}

function columnAtSheetOffset(worksheet, absoluteX, startColumn) {
  let accumulated = sheetOffsetX(worksheet, Math.max(0, startColumn - 1), 0);
  for (
    let column = startColumn;
    column < startColumn + DRAWING_SCAN_LIMIT;
    column += 1
  ) {
    accumulated += getColumnWidth(worksheet, column);
    if (accumulated >= absoluteX) return column;
  }
  return startColumn;
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
  // 活頁簿的 Normal 樣式多為 Calibri 12；其最大數字寬約 7.75px。
  // 舊值 7px 是 Calibri 11 的近似值，會讓中文表格整體窄約一成。
  return Math.max(5, Math.floor(resolved * 7.75 + 5) * 0.75);
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

function chunksAtScale(
  items,
  scale,
  availableSize,
  repeatedTitleSize,
  sizeOf,
  breaksAfter
) {
  return chunkBySize(
    items,
    Math.max(20, availableSize / scale - repeatedTitleSize),
    sizeOf,
    breaksAfter
  );
}

// 連續尺寸的比例公式可能因「整列不可拆分」而多出一頁。二分搜尋仍可
// 保持最大的可用比例，同時確實符合指定的頁數上限。
function scaleForChunkTarget(
  items,
  upperScale,
  lowerScale,
  targetChunks,
  availableSize,
  repeatedTitleSize,
  sizeOf,
  breaksAfter
) {
  if (!items.length || targetChunks <= 0) return upperScale;
  const countAt = (scale) =>
    chunksAtScale(
      items,
      scale,
      availableSize,
      repeatedTitleSize,
      sizeOf,
      breaksAfter
    ).length;
  if (countAt(upperScale) <= targetChunks) return upperScale;
  if (countAt(lowerScale) > targetChunks) return lowerScale;

  let low = lowerScale;
  let high = upperScale;
  for (let iteration = 0; iteration < 36; iteration += 1) {
    const middle = (low + high) / 2;
    if (countAt(middle) <= targetChunks) low = middle;
    else high = middle;
  }
  return Math.max(MIN_FIT_SCALE, low * (1 - 1e-7));
}

function compactTrailingChunk(
  items,
  scale,
  availableSize,
  repeatedTitleSize,
  sizeOf,
  breaksAfter,
  maximumTrailingItems,
  maximumReduction
) {
  const chunks = chunksAtScale(
    items,
    scale,
    availableSize,
    repeatedTitleSize,
    sizeOf,
    breaksAfter
  );
  const trailingChunk = chunks[chunks.length - 1];
  if (
    chunks.length <= 1 ||
    !trailingChunk?.length ||
    trailingChunk.length > maximumTrailingItems
  ) {
    return scale;
  }
  const lowerScale = Math.max(MIN_FIT_SCALE, scale * (1 - maximumReduction));
  return scaleForChunkTarget(
    items,
    scale,
    lowerScale,
    chunks.length - 1,
    availableSize,
    repeatedTitleSize,
    sizeOf,
    breaksAfter
  );
}

function resolvedScaling(
  worksheet,
  options,
  totalWidth,
  totalHeight,
  availableWidth,
  availableHeight,
  repeatedTitleWidth = 0,
  repeatedTitleHeight = 0
) {
  let mode = options.scaling;
  let percent = clamp(Number(options.scalePercent) || 100, 10, 400) / 100;
  let fitWidth = 1;
  let fitHeight = 1;
  let maximumFitScale = 1;
  if (mode === "source") {
    const source = worksheet.pageSetup || {};
    // OOXML 常會保留 fitToWidth=1 的預設值；只有 fitToPage 啟用時
    // 才能採用 fitToWidth/fitToHeight，否則必須尊重 scale。
    if (source.fitToPage) {
      mode = "fit-target";
      fitWidth = Math.max(0, Number(source.fitToWidth) || 0);
      fitHeight = Math.max(0, Number(source.fitToHeight) || 0);
      const savedScale = Number(source.scale);
      if (Number.isFinite(savedScale) && savedScale > 0) {
        // Excel 仍會在部分 fitToPage 活頁簿保存最近一次實際列印比例。
        // 以它作為上限，可避免用近似欄寬重新計算後反而放大內容。
        maximumFitScale = Math.min(1, clamp(savedScale, 10, 400) / 100);
      }
    } else {
      mode = "custom";
      percent = clamp(Number(source.scale) || 100, 10, 400) / 100;
    }
  }
  if (mode === "actual") return 1;
  if (mode === "custom") return percent;
  if (mode === "fit-page") {
    mode = "fit-target";
    fitWidth = 1;
    fitHeight = 1;
  } else if (mode === "fit-width") {
    mode = "fit-target";
    fitWidth = 1;
    fitHeight = 0;
  }
  if (mode !== "fit-target") return 1;

  const candidates = [];
  if (fitWidth > 0) {
    const repeatedWidth = repeatedTitleWidth * Math.max(0, fitWidth - 1);
    candidates.push(
      (availableWidth * fitWidth) /
        Math.max(1, totalWidth + repeatedWidth)
    );
  }
  if (fitHeight > 0) {
    const repeatedHeight = repeatedTitleHeight * Math.max(0, fitHeight - 1);
    candidates.push(
      (availableHeight * fitHeight) /
        Math.max(1, totalHeight + repeatedHeight)
    );
  }
  if (!candidates.length) return maximumFitScale;
  return clamp(
    Math.min(maximumFitScale, ...candidates),
    MIN_FIT_SCALE,
    1
  );
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
  const titleColumnNumbers = parseTitleColumns(options.repeatColumns, range);
  const titleColumns = columns.filter((column) =>
    titleColumnNumbers.includes(column.number)
  );
  const titleWidth = titleColumns.reduce((sum, column) => sum + column.width, 0);
  const titleRowNumbers = parseTitleRows(options.repeatRows, range);
  const titleRows = rows.filter((row) => titleRowNumbers.includes(row.number));
  const titleHeight = titleRows.reduce((sum, row) => sum + row.height, 0);
  let scaleX = resolvedScaling(
    worksheet,
    options,
    totalWidth,
    0,
    availableWidth,
    Number.MAX_SAFE_INTEGER,
    titleWidth,
    0
  );
  let scaleY = resolvedScaling(
    worksheet,
    options,
    0,
    totalHeight,
    Number.MAX_SAFE_INTEGER,
    availableHeight,
    0,
    titleHeight
  );

  const bodyColumns = columns.filter((column) => !titleColumnNumbers.includes(column.number));
  const columnBreaks = parseColumnBreaks(options.columnBreaks);
  const bodyRows = rows.filter((row) => !titleRowNumbers.includes(row.number));
  const rowBreaks = parseRowBreaks(options.rowBreaks);
  if (options.scaling === "source" && worksheet.pageSetup?.fitToPage) {
    const targetColumnPages = Math.max(
      0,
      Number(worksheet.pageSetup.fitToWidth) || 0
    );
    const targetRowPages = Math.max(
      0,
      Number(worksheet.pageSetup.fitToHeight) || 0
    );
    if (targetColumnPages > 0) {
      scaleX = scaleForChunkTarget(
        bodyColumns,
        scaleX,
        MIN_FIT_SCALE,
        targetColumnPages,
        availableWidth,
        titleWidth,
        (column) => column.width,
        columnBreaks
      );
    } else {
      scaleX = compactTrailingChunk(
        bodyColumns,
        scaleX,
        availableWidth,
        titleWidth,
        (column) => column.width,
        columnBreaks,
        2,
        0.12
      );
    }
    if (targetRowPages > 0) {
      scaleY = scaleForChunkTarget(
        bodyRows,
        scaleY,
        MIN_FIT_SCALE,
        targetRowPages,
        availableHeight,
        titleHeight,
        (row) => row.height,
        rowBreaks
      );
    }
    // Fit-to-page 活頁簿常由 Excel 保留「自動高度」(fitToHeight=0)。若
    // 最後一頁只有極少數列，Excel 的列印引擎會以稍低比例消化尾頁；用
    // 12% 上限避免把真正的多頁表格過度縮小。
    scaleY = compactTrailingChunk(
      bodyRows,
      scaleY,
      availableHeight,
      titleHeight,
      (row) => row.height,
      rowBreaks,
      4,
      0.12
    );
  } else if (options.scaling === "source") {
    // 固定百分比只容許小幅修正，用來吸收 Excel、瀏覽器與 PDF 點數換算
    // 的四捨五入差異，不改變使用者原本的列印比例意圖。
    scaleX = compactTrailingChunk(
      bodyColumns,
      scaleX,
      availableWidth,
      titleWidth,
      (column) => column.width,
      columnBreaks,
      2,
      0.015
    );
    scaleY = compactTrailingChunk(
      bodyRows,
      scaleY,
      availableHeight,
      titleHeight,
      (row) => row.height,
      rowBreaks,
      2,
      0.015
    );
  }
  const columnChunks = chunkBySize(
    bodyColumns,
    Math.max(20, availableWidth / scaleX - titleWidth),
    (column) => column.width,
    columnBreaks
  ).map((chunk) => [...titleColumns, ...chunk]);
  const rowChunks = chunkBySize(
    bodyRows,
    Math.max(20, availableHeight / scaleY - titleHeight),
    (row) => row.height,
    rowBreaks
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
    const contentWidth =
      columnChunk.reduce((sum, column) => sum + column.width, 0) * scaleX;
    const contentHeight =
      pageRows.reduce((sum, row) => sum + row.height, 0) * scaleY;
    pages.push({
      range,
      columns: columnChunk,
      rows: pageRows,
      scale: scaleY,
      scaleX,
      scaleY,
      fontScale: scaleX,
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
  const normalized = String(style).toLowerCase();
  if (normalized === "hair") return 0.25;
  if (normalized === "thick" || normalized === "double") return 2.25;
  if (normalized.startsWith("medium")) return 1.5;
  return 0.75;
}

function strongestBorderSide(sides) {
  let strongest = null;
  let strongestWidth = 0;
  for (const side of sides) {
    const width = borderWidth(side?.style);
    if (width > strongestWidth) {
      strongest = side;
      strongestWidth = width;
    }
  }
  return strongest;
}

// ExcelJS 會把合併範圍的右、下框線保留在最右／最下方的子儲存格；只讀
// 左上角 master 會漏掉外框。逐邊彙整邊界儲存格，並在同一邊有不同線型
// 時保留較粗者，才能還原 Excel 顯示的完整合併框線。
function mergedCellBorder(worksheet, range, masterBorder = {}) {
  if (!range) return masterBorder || {};
  const top = [];
  const right = [];
  const bottom = [];
  const left = [];
  for (let column = range.left; column <= range.right; column += 1) {
    top.push(worksheet.getCell(range.top, column).border?.top);
    bottom.push(worksheet.getCell(range.bottom, column).border?.bottom);
  }
  for (let row = range.top; row <= range.bottom; row += 1) {
    left.push(worksheet.getCell(row, range.left).border?.left);
    right.push(worksheet.getCell(row, range.right).border?.right);
  }
  return {
    top: strongestBorderSide(top) || masterBorder?.top,
    right: strongestBorderSide(right) || masterBorder?.right,
    bottom: strongestBorderSide(bottom) || masterBorder?.bottom,
    left: strongestBorderSide(left) || masterBorder?.left,
  };
}

function borderStrength(border) {
  return Math.max(
    0,
    ...["top", "right", "bottom", "left"].map((side) =>
      borderWidth(border?.[side]?.style)
    )
  );
}

function lineWidth(font, value, size) {
  try {
    return font.widthOfTextAtSize(value, size);
  } catch {
    return value.length * size * 0.55;
  }
}

// 每個字型一份「字元 → 1000 單位寬度」快取，讓 wrapText 以 O(n) 增量
// 累計，避免對每個候選字串整串重新排版（外框字型時尤其昂貴）。
const fontWidthCaches = new WeakMap();

function characterWidth(font, character, size) {
  let cache = fontWidthCaches.get(font);
  if (!cache) {
    cache = new Map();
    fontWidthCaches.set(font, cache);
  }
  let unitWidth = cache.get(character);
  if (unitWidth === undefined) {
    try {
      unitWidth = font.widthOfTextAtSize(character, 1000) / 1000;
    } catch {
      unitWidth = 0.55;
    }
    cache.set(character, unitWidth);
  }
  return unitWidth * size;
}

function fontSupportsCharacter(font, character, size) {
  if (typeof font.hasGlyph === "function") {
    return font.hasGlyph(character.codePointAt(0));
  }
  try {
    font.widthOfTextAtSize(character, size);
    return true;
  } catch {
    return false;
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

function sanitizeTextForFont(
  font,
  value,
  size,
  { preserveLineBreaks = false } = {}
) {
  const missingGlyph = fontSupportsCharacter(font, "□", size) ? "□" : "?";
  let result = "";
  for (const character of [...String(value || "")]) {
    if (character === "\r") continue;
    if (character === "\n") {
      result += preserveLineBreaks ? "\n" : " ";
      continue;
    }
    if (character === "\t") {
      result += "    ";
      continue;
    }
    const codePoint = character.codePointAt(0);
    if (codePoint < 32 || codePoint === 127) {
      result += " ";
      continue;
    }
    result += fontSupportsCharacter(font, character, size)
      ? character
      : missingGlyph;
  }
  return result;
}

function wrapText(font, value, size, maxWidth, shouldWrap) {
  const sourceLines = String(value || "").replace(/\r/g, "").split("\n");
  if (!shouldWrap) return sourceLines;

  const lines = [];
  for (const sourceLine of sourceLines) {
    if (!sourceLine) {
      lines.push("");
      continue;
    }
    let current = "";
    let currentWidth = 0;
    for (const character of [...sourceLine]) {
      const width = characterWidth(font, character, size);
      if (current && currentWidth + width > maxWidth) {
        lines.push(current);
        current = character;
        currentWidth = width;
      } else {
        current += character;
        currentWidth += width;
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
    .replace(/\\(.)/g, "$1")
    .replace(/_(.)/g, " ")
    .replace(/\*(.)/g, "")
    .toLowerCase();

  const hasDateTokens = /[yd]/.test(format);
  const hasTimeTokens = /(?:\[h+\]|\[m+\]|\[s+\]|h|s|am\/pm|a\/p)/.test(format);
  if (!hasDateTokens && !hasTimeTokens) format = "yyyy/mm/dd";

  const usesMeridiem = /am\/pm|a\/p/i.test(format);
  const displayHours = usesMeridiem ? hours % 12 || 12 : hours;
  const weekdays = ["日", "一", "二", "三", "四", "五", "六"];
  const tokenValues = [];
  const tokenPattern =
    /\[h+\]|\[m+\]|\[s+\]|am\/pm|a\/p|yyyy|yy|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|ss|s/gi;
  const timeOnly = hasTimeTokens && !hasDateTokens;
  const marked = format.replace(tokenPattern, (token, offset, source) => {
    const normalized = token.toLowerCase();
    const before = source.slice(0, offset);
    const after = source.slice(offset + token.length);
    const isMinute =
      /^\[m+\]$/.test(normalized) ||
      ((normalized === "m" || normalized === "mm") &&
        (timeOnly ||
          /h{1,2}[^a-z0-9]*$/i.test(before) ||
          /^[^a-z0-9]*s{1,2}/i.test(after)));
    let replacement;
    if (normalized === "yyyy") replacement = String(year).padStart(4, "0");
    else if (normalized === "yy") replacement = String(year % 100).padStart(2, "0");
    else if (normalized === "mmmm" || normalized === "mmm") replacement = `${month}月`;
    else if (normalized === "mm" && !isMinute) replacement = String(month).padStart(2, "0");
    else if (normalized === "m" && !isMinute) replacement = String(month);
    else if (isMinute) {
      replacement = normalized.length > 1
        ? String(minutes).padStart(2, "0")
        : String(minutes);
    } else if (normalized === "dddd") replacement = `星期${weekdays[value.getDay()]}`;
    else if (normalized === "ddd") replacement = `週${weekdays[value.getDay()]}`;
    else if (normalized === "dd") replacement = String(day).padStart(2, "0");
    else if (normalized === "d") replacement = String(day);
    else if (normalized === "hh") replacement = String(displayHours).padStart(2, "0");
    else if (normalized === "h" || /^\[h+\]$/.test(normalized)) replacement = String(displayHours);
    else if (normalized === "ss" || /^\[s+\]$/.test(normalized)) {
      replacement = String(seconds).padStart(2, "0");
    } else if (normalized === "s") replacement = String(seconds);
    else if (normalized === "am/pm") replacement = hours < 12 ? "AM" : "PM";
    else if (normalized === "a/p") replacement = hours < 12 ? "A" : "P";
    else replacement = token;
    const marker = `\u0001${tokenValues.length}\u0002`;
    tokenValues.push(replacement);
    return marker;
  });
  return marked.replace(/\u0001(\d+)\u0002/g, (_, index) => tokenValues[Number(index)]);
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

// ---------------------------------------------------------------------------
// Rich text（同一儲存格內顏色／粗細逐段變化）
//
// 只支援顏色與粗細（bold）逐段變化；同一儲存格內若出現不同字級，一律
// 統一套用儲存格層級的 cell.font.size（不支援混合字級）。多數 rich text
// 儲存格其實每個片段的樣式都相同，這種情況完全交由既有的 cellText()／
// drawCell() 單一樣式流程處理，不受任何影響；只有偵測到真正的顏色或
// 粗細差異時，才會走下面新增的多樣式繪製路徑。
// ---------------------------------------------------------------------------

function richRunEffectiveStyle(cell, run) {
  const font = run?.font || {};
  return {
    color: font.color || cell.font?.color,
    bold: font.bold != null ? !!font.bold : !!cell.font?.bold,
  };
}

function richStyleKey(style) {
  const color = style.color;
  const colorKey =
    color?.argb || (color?.indexed != null ? `idx${color.indexed}` : "default");
  return `${colorKey}|${style.bold ? 1 : 0}`;
}

// 回傳 null 代表這個儲存格應繼續走原本的單一樣式流程：不是 rich text，
// 或 rich text 內每個片段的有效顏色／粗細其實都相同（沒有可見差異）。
function cellStyledRuns(cell) {
  const richText = cell.value?.richText;
  if (!Array.isArray(richText) || richText.length < 2) return null;
  const runs = richText
    .map((run) => ({
      text: String(run?.text || ""),
      style: richRunEffectiveStyle(cell, run),
    }))
    .filter((run) => run.text);
  if (runs.length < 2) return null;
  const firstKey = richStyleKey(runs[0].style);
  const hasVariation = runs.some((run) => richStyleKey(run.style) !== firstKey);
  return hasVariation ? runs : null;
}

// 與 drawCell() 的字型挑選邏輯一致（以「每個片段」而非整格為單位判斷
// 是否為純 ASCII）：中文字型（NotoSansTC）目前只有 Regular 一種字重，
// 無法切換至真正的 Bold 字型檔，因此中文粗體改用偽粗體（多次疊繪）。
function pickRunFont(fonts, run) {
  const asciiOnly = /^[\x00-\x7F]*$/.test(run.text);
  if (!asciiOnly) return { font: fonts.unicode, fauxBold: !!run.style.bold };
  return { font: run.style.bold ? fonts.asciiBold : fonts.ascii, fauxBold: false };
}

// 把 rich text runs 拆成帶樣式的字元陣列，供換行與繪製共用。
function buildStyledCharacters(fonts, runs, fontSize) {
  const characters = [];
  for (const run of runs) {
    const { font, fauxBold } = pickRunFont(fonts, run);
    const color = argbToRgb(run.style.color, rgb(0.08, 0.1, 0.16));
    const sanitized = sanitizeTextForFont(font, run.text, fontSize, {
      preserveLineBreaks: true,
    });
    for (const ch of [...sanitized]) {
      characters.push({ ch, font, color, bold: fauxBold });
    }
  }
  return characters;
}

function styledCharacterWidth(character, size) {
  return characterWidth(character.font, character.ch, size);
}

function splitStyledLines(characters) {
  const lines = [[]];
  for (const character of characters) {
    if (character.ch === "\n") lines.push([]);
    else lines[lines.length - 1].push(character);
  }
  return lines;
}

function wrapStyledCharacters(characters, size, maxWidth, shouldWrap) {
  const sourceLines = splitStyledLines(characters);
  if (!shouldWrap) return sourceLines;

  const lines = [];
  for (const sourceLine of sourceLines) {
    if (!sourceLine.length) {
      lines.push([]);
      continue;
    }
    let current = [];
    let currentWidth = 0;
    for (const character of sourceLine) {
      const width = styledCharacterWidth(character, size);
      if (current.length && currentWidth + width > maxWidth) {
        lines.push(current);
        current = [character];
        currentWidth = width;
      } else {
        current.push(character);
        currentWidth += width;
      }
    }
    if (current.length) lines.push(current);
  }
  return lines;
}

function styledLineWidth(line, size) {
  return line.reduce((sum, character) => sum + styledCharacterWidth(character, size), 0);
}

// 把一行內連續、樣式相同（同字型／同粗細／同顏色物件）的字元合併成一
// 段，減少 drawText 呼叫次數；寬度以逐字元寬度加總，與換行計算一致。
function groupStyledLine(line, size) {
  const groups = [];
  for (const character of line) {
    const width = styledCharacterWidth(character, size);
    const last = groups[groups.length - 1];
    if (
      last &&
      last.font === character.font &&
      last.bold === character.bold &&
      last.color === character.color
    ) {
      last.text += character.ch;
      last.width += width;
    } else {
      groups.push({
        text: character.ch,
        font: character.font,
        bold: character.bold,
        color: character.color,
        width,
      });
    }
  }
  return groups;
}

// 以極小位移多次疊繪達到「偽粗體」效果。
const FAUX_BOLD_OFFSETS = [
  [0, 0],
  [0.3, 0],
  [0, 0.3],
  [0.3, 0.3],
];

function drawStyledRun(page, group, x, y, size) {
  const offsets = group.bold ? FAUX_BOLD_OFFSETS : [[0, 0]];
  for (const [dx, dy] of offsets) {
    drawText(page, group.text, { x: x + dx, y: y + dy, size, font: group.font, color: group.color });
  }
}

// drawCell() 單一樣式流程的多樣式版本：換行／對齊／垂直置中／裁切的
// 公式與 drawCell() 完全相同，差別只在每一行由多個帶樣式片段組成。
function drawStyledCellText(page, runs, fonts, scale, textBox, cell, fontSize) {
  const padding = Math.max(1.5, 2.5 * scale);
  const verticalPadding = Math.max(0.2, Math.min(0.5, 0.5 * scale));
  const maxWidth = Math.max(1, textBox.width - padding * 2);
  const maxHeight = Math.max(1, textBox.height - verticalPadding * 2);
  const shouldWrap = !!cell.alignment?.wrapText;

  const characters = buildStyledCharacters(fonts, runs, fontSize);
  let size = fontSize;
  let lines = wrapStyledCharacters(characters, size, maxWidth, shouldWrap);

  if (cell.alignment?.shrinkToFit) {
    const minimumSize = Math.max(4, 5 * scale);
    for (let iteration = 0; iteration < 120 && size > minimumSize; iteration += 1) {
      const widest = Math.max(0, ...lines.map((line) => styledLineWidth(line, size)));
      const requiredHeight = lines.length * size * 1.18;
      if (widest <= maxWidth + 0.1 && requiredHeight <= maxHeight + 0.1) break;
      size = Math.max(minimumSize, size - Math.max(0.2, 0.25 * scale));
      lines = wrapStyledCharacters(characters, size, maxWidth, shouldWrap);
    }
  }

  let lineHeight = size * 1.18;
  if (lines.length > 1 && lines.length * lineHeight > maxHeight) {
    lineHeight = Math.max(size * 1.02, maxHeight / lines.length);
  }
  const maxLines = Math.max(1, Math.floor((maxHeight + lineHeight * 0.25) / lineHeight));
  if (lines.length > maxLines) lines = lines.slice(0, maxLines);

  const blockHeight = lines.length * lineHeight;
  const vertical = cell.alignment?.vertical || "middle";
  let firstBaseline;
  if (vertical === "top") {
    firstBaseline = textBox.y + textBox.height - verticalPadding - size;
  } else if (vertical === "bottom") {
    firstBaseline = textBox.y + verticalPadding + blockHeight - lineHeight;
  } else {
    firstBaseline =
      textBox.y + (textBox.height + blockHeight) / 2 - lineHeight + (lineHeight - size) / 2;
  }

  const needsClip =
    blockHeight > maxHeight + 0.1 ||
    lines.some((line) => styledLineWidth(line, size) > maxWidth + 0.1);
  if (needsClip) {
    page.pushOperators(
      pushGraphicsState(),
      moveTo(textBox.x + padding, textBox.y + verticalPadding),
      lineTo(textBox.x + textBox.width - padding, textBox.y + verticalPadding),
      lineTo(textBox.x + textBox.width - padding, textBox.y + textBox.height - verticalPadding),
      lineTo(textBox.x + padding, textBox.y + textBox.height - verticalPadding),
      closePath(),
      clip(),
      endPath()
    );
  }

  lines.forEach((line, lineIndex) => {
    const width = styledLineWidth(line, size);
    const horizontal = cell.alignment?.horizontal || "left";
    let x = textBox.x + padding;
    if (horizontal === "center" || horizontal === "centerContinuous") {
      x = textBox.x + (textBox.width - width) / 2;
    } else if (horizontal === "right") {
      x = textBox.x + textBox.width - padding - width;
    }
    const y = firstBaseline - lineIndex * lineHeight;
    if (y < textBox.y - 1 || y + size > textBox.y + textBox.height + 1) return;
    let cursorX = Math.max(textBox.x + 0.5, x);
    for (const group of groupStyledLine(line, size)) {
      drawStyledRun(page, group, cursorX, y, size);
      cursorX += group.width;
    }
  });

  if (needsClip) page.pushOperators(popGraphicsState());
}

function drawBorders(page, border, x, y, width, height, scale) {
  for (const side of ["top", "right", "bottom", "left"]) {
    const style = border?.[side];
    const thickness = borderWidth(style?.style) * scale;
    if (!thickness) continue;
    const half = thickness / 2;
    // 以細長矩形取代 drawLine：視覺等價，且選項不含巢狀座標物件
    //（pdf-lib 對巢狀物件做 instanceof 檢查，在測試的 vm 沙箱會誤判跨
    // realm 物件，改用 drawRectangle 讓正式與測試環境走同一條路）。
    const rect =
      side === "top"
        ? { x, y: y + height - half, width, height: thickness }
        : side === "bottom"
          ? { x, y: y - half, width, height: thickness }
          : side === "left"
            ? { x: x - half, y, width: thickness, height }
            : { x: x + width - half, y, width: thickness, height };
    page.drawRectangle({
      ...rect,
      color: argbToRgb(style?.color, rgb(0, 0, 0)),
    });
  }
}

function drawCellFrame(page, border, box, scale, options) {
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
  drawBorders(page, border, box.x, box.y, box.width, box.height, scale);
}

function calculateCellBox(layout, rowIndex, columnIndex, mergeRange) {
  const scaleX = layout.scaleX || layout.scale;
  const scaleY = layout.scaleY || layout.scale;
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
      scaleX;
  const top =
    layout.pageHeight -
    layout.margins.top -
    (layout.contentOffsetY || 0) -
    rows.slice(0, rowIndex).reduce((sum, item) => sum + item.height, 0) *
      scaleY;
  return {
    x,
    y: top - height * scaleY,
    width: width * scaleX,
    height: height * scaleY,
  };
}

function cellCanOverflow(cell) {
  if (cell.alignment?.wrapText || cell.alignment?.shrinkToFit) return false;
  const horizontal = cell.alignment?.horizontal || "left";
  if (!["left", "right", "general"].includes(horizontal)) return false;
  const rawValue = cell.value?.formula ? cell.value.result : cell.value;
  return (
    typeof rawValue === "string" ||
    !!rawValue?.richText ||
    typeof rawValue?.text === "string"
  );
}

// Excel 的未換行文字可延伸到相鄰空白儲存格；網址、備註與說明文字經常
// 仰賴此行為。只擴大文字的裁切盒，原儲存格的填色與框線仍維持原尺寸。
function calculateOverflowTextBox(
  worksheet,
  layout,
  rowIndex,
  columnIndex,
  cell,
  box,
  merges,
  cellImages
) {
  if (!cellCanOverflow(cell)) return box;
  const horizontal = cell.alignment?.horizontal || "left";
  const direction = horizontal === "right" ? -1 : 1;
  let edgeIndex = columnIndex;
  let width = box.width;
  let x = box.x;
  for (
    let nextIndex = columnIndex + direction;
    nextIndex >= 0 && nextIndex < layout.columns.length;
    nextIndex += direction
  ) {
    const previousColumn = layout.columns[edgeIndex];
    const nextColumn = layout.columns[nextIndex];
    if (Math.abs(nextColumn.number - previousColumn.number) !== 1) break;
    const nextKey = `${layout.rows[rowIndex].number}:${nextColumn.number}`;
    if (
      merges.masters.has(nextKey) ||
      merges.children.has(nextKey) ||
      cellImages?.has(nextKey) ||
      cellText(worksheet.getCell(layout.rows[rowIndex].number, nextColumn.number))
    ) {
      break;
    }
    const addedWidth = nextColumn.width * (layout.scaleX || layout.scale);
    width += addedWidth;
    if (direction < 0) x -= addedWidth;
    edgeIndex = nextIndex;
  }
  return { ...box, x, width };
}

// ---------------------------------------------------------------------------
// Excel 圖片（PNG/JPEG、儲存格錨點）
//
// ExcelJS 的錨點使用 0-based nativeCol/nativeRow 加上 EMU 位移（1pt = 12700
// EMU）。先把錨點換算成「工作表絕對座標（點）」，再映射到各頁的內容區。
// oneCell 錨（tl + ext，ext 單位為 px）與 twoCell 錨（tl + br）都支援。
// ---------------------------------------------------------------------------

function sheetOffsetX(worksheet, nativeCol, nativeColOff) {
  let x = 0;
  for (let column = 1; column <= nativeCol; column += 1) {
    x += getColumnWidth(worksheet, column);
  }
  return x + (Number(nativeColOff) || 0) / EMU_PER_POINT;
}

function sheetOffsetY(worksheet, nativeRow, nativeRowOff) {
  let y = 0;
  for (let row = 1; row <= nativeRow; row += 1) {
    y += getRowHeight(worksheet, row);
  }
  return y + (Number(nativeRowOff) || 0) / EMU_PER_POINT;
}

function imageSheetBox(worksheet, range) {
  const tl = range?.tl;
  if (!tl) return null;
  const left = sheetOffsetX(worksheet, tl.nativeCol || 0, tl.nativeColOff);
  const top = sheetOffsetY(worksheet, tl.nativeRow || 0, tl.nativeRowOff);
  let width = 0;
  let height = 0;
  if (range.br) {
    width =
      sheetOffsetX(worksheet, range.br.nativeCol || 0, range.br.nativeColOff) -
      left;
    height =
      sheetOffsetY(worksheet, range.br.nativeRow || 0, range.br.nativeRowOff) -
      top;
  } else if (range.ext) {
    width = (Number(range.ext.width) || 0) * PIXEL_TO_POINT;
    height = (Number(range.ext.height) || 0) * PIXEL_TO_POINT;
  }
  if (!(width > 0) || !(height > 0)) return null;
  return {
    left,
    top,
    width,
    height,
    anchorColumn: (tl.nativeCol || 0) + 1,
    anchorRow: (tl.nativeRow || 0) + 1,
  };
}

async function embedImageBytes(pdf, embedCache, cacheKey, bytes, extension) {
  let embeddedPromise = embedCache.get(cacheKey);
  if (!embeddedPromise) {
    embeddedPromise =
      extension === "png" ? pdf.embedPng(bytes) : pdf.embedJpg(bytes);
    embedCache.set(cacheKey, embeddedPromise);
  }
  return embeddedPromise;
}

// 每個 PDF 文件嵌入同一張媒體一次（embedCache 跨工作表共用）。回傳
// anchored（浮動圖片）與 cellImages（儲存格內圖片，鍵為 "row:col"）。
async function prepareWorksheetImages(pdf, worksheet, embedCache) {
  const anchored = [];
  for (const item of worksheet.getImages?.() || []) {
    const media = workbook?.model?.media?.[item.imageId];
    const extension = String(media?.extension || "").toLowerCase();
    if (!media?.buffer || !SUPPORTED_IMAGE_EXTENSIONS.has(extension)) continue;
    const bytes =
      media.buffer instanceof Uint8Array
        ? media.buffer
        : new Uint8Array(media.buffer);
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      console.warn("[Excel PDF] 圖片超過大小上限，已略過。");
      continue;
    }
    const box = imageSheetBox(worksheet, item.range);
    if (!box) continue;
    try {
      anchored.push({
        box,
        embedded: await embedImageBytes(
          pdf,
          embedCache,
          `media:${item.imageId}`,
          bytes,
          extension
        ),
      });
    } catch (error) {
      console.warn("[Excel PDF] 圖片嵌入失敗，已略過。", error);
    }
  }

  const cellImages = new Map();
  for (const [key, entry] of inCellImagesBySheet.get(worksheet.name) || []) {
    if (entry.bytes.byteLength > MAX_IMAGE_BYTES) continue;
    try {
      cellImages.set(
        key,
        await embedImageBytes(
          pdf,
          embedCache,
          `cell:${entry.mediaPath}`,
          entry.bytes,
          entry.extension
        )
      );
    } catch (error) {
      console.warn("[Excel PDF] 儲存格內圖片嵌入失敗，已略過。", error);
    }
  }
  return { anchored, cellImages };
}

// 儲存格內圖片：等比縮放置中，內縮一小段避免壓到框線。
function drawCellImage(page, embedded, box) {
  const padding = Math.min(1.5, box.width * 0.05, box.height * 0.05);
  const maxWidth = box.width - padding * 2;
  const maxHeight = box.height - padding * 2;
  if (maxWidth <= 0 || maxHeight <= 0) return;
  const ratio = Math.min(
    maxWidth / embedded.width,
    maxHeight / embedded.height
  );
  const width = embedded.width * ratio;
  const height = embedded.height * ratio;
  page.drawImage(embedded, {
    x: box.x + (box.width - width) / 2,
    y: box.y + (box.height - height) / 2,
    width,
    height,
  });
}

// 把工作表絕對座標映射為「本頁內容區內的未縮放位移」。頁面欄列可能不連續
// （重複標題欄列、隱藏欄列被剔除），逐段累計取得正確位置。
function pageContentOffset(entries, startOf, sizeOf, absolute) {
  let accumulated = 0;
  for (const entry of entries) {
    const start = startOf(entry);
    if (absolute < start) break;
    if (absolute < start + sizeOf(entry)) {
      return accumulated + (absolute - start);
    }
    accumulated += sizeOf(entry);
  }
  return accumulated;
}

function drawPageImages(page, worksheet, layout, images) {
  const anchored = images?.anchored;
  if (!anchored?.length) return;
  const visible = anchored.filter(
    (image) =>
      layout.columns.some((column) => column.number === image.box.anchorColumn) &&
      layout.rows.some((row) => row.number === image.box.anchorRow)
  );
  if (!visible.length) return;

  const contentLeft = layout.margins.left + (layout.contentOffsetX || 0);
  const contentTop =
    layout.pageHeight - layout.margins.top - (layout.contentOffsetY || 0);
  const clipLeft = layout.margins.left;
  const clipRight = layout.pageWidth - layout.margins.right;
  const clipBottom = layout.margins.bottom;
  const clipTop = layout.pageHeight - layout.margins.top;

  // 以內容區為剪裁範圍，避免跨分頁的圖片蓋到邊界與頁首頁尾。
  page.pushOperators(
    pushGraphicsState(),
    moveTo(clipLeft, clipBottom),
    lineTo(clipRight, clipBottom),
    lineTo(clipRight, clipTop),
    lineTo(clipLeft, clipTop),
    closePath(),
    clip(),
    endPath()
  );
  for (const image of visible) {
    const offsetX = pageContentOffset(
      layout.columns,
      (column) => sheetOffsetX(worksheet, column.number - 1, 0),
      (column) => column.width,
      image.box.left
    );
    const offsetY = pageContentOffset(
      layout.rows,
      (row) => sheetOffsetY(worksheet, row.number - 1, 0),
      (row) => row.height,
      image.box.top
    );
    const x = contentLeft + offsetX * (layout.scaleX || layout.scale);
    const yTop = contentTop - offsetY * (layout.scaleY || layout.scale);
    const width = image.box.width * (layout.scaleX || layout.scale);
    const height = image.box.height * (layout.scaleY || layout.scale);
    page.drawImage(image.embedded, { x, y: yTop - height, width, height });
  }
  page.pushOperators(popGraphicsState());
}

function drawCell(page, cell, box, fonts, scale, options, textBox = box) {
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

  let fontSize = clamp(Number(cell.font?.size) || 11, 5, 72) * scale;

  const styledRuns = cellStyledRuns(cell);
  if (styledRuns) {
    drawStyledCellText(page, styledRuns, fonts, scale, textBox, cell, fontSize);
    return;
  }

  const safeValue = sanitizeTextForFont(font, value, fontSize, {
    preserveLineBreaks: true,
  });
  const padding = Math.max(1.5, 2.5 * scale);
  const verticalPadding = Math.max(0.2, Math.min(0.5, 0.5 * scale));
  const maxWidth = Math.max(1, textBox.width - padding * 2);
  const maxHeight = Math.max(1, textBox.height - verticalPadding * 2);
  const shouldWrap = !!cell.alignment?.wrapText;
  let lines = wrapText(
    font,
    safeValue,
    fontSize,
    maxWidth,
    shouldWrap
  );
  if (cell.alignment?.shrinkToFit) {
    const minimumSize = Math.max(4, 5 * scale);
    for (let iteration = 0; iteration < 120 && fontSize > minimumSize; iteration += 1) {
      const widest = Math.max(0, ...lines.map((line) => lineWidth(font, line, fontSize)));
      const requiredHeight = lines.length * fontSize * 1.18;
      if (widest <= maxWidth + 0.1 && requiredHeight <= maxHeight + 0.1) break;
      fontSize = Math.max(
        minimumSize,
        fontSize - Math.max(0.2, 0.25 * scale)
      );
      lines = wrapText(font, safeValue, fontSize, maxWidth, shouldWrap);
    }
  }
  let lineHeight = fontSize * 1.18;
  // Excel 的列高常以較緊的行距容納多行（例如 16pt 字、34pt 列高塞兩行，
  // 行距僅約 1.06 倍）。預設 1.18 倍放不下時先壓縮行距（下限 1.02 倍字
  // 高），仍放不下才截行；行數計算加入小量容差，避免整行文字消失。
  if (lines.length > 1 && lines.length * lineHeight > maxHeight) {
    lineHeight = Math.max(fontSize * 1.02, maxHeight / lines.length);
  }
  const maxLines = Math.max(
    1,
    Math.floor((maxHeight + lineHeight * 0.25) / lineHeight)
  );
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
  }

  const blockHeight = lines.length * lineHeight;
  const vertical = cell.alignment?.vertical || "middle";
  let firstBaseline;
  if (vertical === "top") {
    firstBaseline = textBox.y + textBox.height - verticalPadding - fontSize;
  } else if (vertical === "bottom") {
    firstBaseline = textBox.y + verticalPadding + blockHeight - lineHeight;
  } else {
    firstBaseline =
      textBox.y +
      (textBox.height + blockHeight) / 2 -
      lineHeight +
      (lineHeight - fontSize) / 2;
  }

  const textColor = argbToRgb(cell.font?.color, rgb(0.08, 0.1, 0.16));
  const needsClip =
    blockHeight > maxHeight + 0.1 ||
    lines.some((line) => lineWidth(font, line, fontSize) > maxWidth + 0.1);
  if (needsClip) {
    page.pushOperators(
      pushGraphicsState(),
      moveTo(textBox.x + padding, textBox.y + verticalPadding),
      lineTo(
        textBox.x + textBox.width - padding,
        textBox.y + verticalPadding
      ),
      lineTo(
        textBox.x + textBox.width - padding,
        textBox.y + textBox.height - verticalPadding
      ),
      lineTo(
        textBox.x + padding,
        textBox.y + textBox.height - verticalPadding
      ),
      closePath(),
      clip(),
      endPath()
    );
  }
  lines.forEach((line, lineIndex) => {
    const width = lineWidth(font, line, fontSize);
    const horizontal = cell.alignment?.horizontal || "left";
    let x = textBox.x + padding;
    if (horizontal === "center" || horizontal === "centerContinuous") {
      x = textBox.x + (textBox.width - width) / 2;
    } else if (horizontal === "right") {
      x = textBox.x + textBox.width - padding - width;
    }
    const y = firstBaseline - lineIndex * lineHeight;
    // 容差放寬到 1pt：壓縮行距後文字可能貼齊儲存格邊緣，超出的部分已由
    // needsClip 剪裁，不應把整行丟棄。
    if (
      y < textBox.y - 1 ||
      y + fontSize > textBox.y + textBox.height + 1
    ) {
      return;
    }
    drawText(page, line, {
      x: Math.max(textBox.x + 0.5, x),
      y,
      size: fontSize,
      font,
      color: textColor,
    });
  });
  if (needsClip) page.pushOperators(popGraphicsState());
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

function expandHeaderFooter(value, worksheet, pageIndex, pageCount, pagination = {}) {
  const now = new Date();
  const configuredFirstPage = Number(worksheet.pageSetup?.firstPageNumber);
  const hasConfiguredFirstPage =
    worksheet.pageSetup?.useFirstPageNumber &&
    Number.isInteger(configuredFirstPage) &&
    configuredFirstPage > 0 &&
    configuredFirstPage < 0xffffffff;
  const documentPageOffset = Math.max(
    0,
    Number(pagination.documentPageOffset) || 0
  );
  const documentPageCount = Math.max(
    pageCount,
    Number(pagination.documentPageCount) || pageCount
  );
  const pageNumber =
    (hasConfiguredFirstPage ? configuredFirstPage : documentPageOffset + 1) +
    pageIndex;
  const replacements = {
    P: String(pageNumber),
    N: String(documentPageCount),
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

function drawHeaderFooterLine(
  page,
  rawValue,
  worksheet,
  fonts,
  layout,
  pageIndex,
  pageCount,
  kind,
  pagination
) {
  if (!rawValue) return;
  const sections = splitHeaderFooterSections(rawValue);
  const font = fonts.unicode;
  const baseSize = 8;
  const y =
    kind === "header"
      ? layout.pageHeight - layout.margins.header - baseSize
      : layout.margins.footer;
  const left = layout.margins.left;
  const right = layout.pageWidth - layout.margins.right;
  const maxWidth = Math.max(24, (right - left) * 0.32);
  for (const [alignment, rawText] of Object.entries(sections)) {
    let value = expandHeaderFooter(
      rawText,
      worksheet,
      pageIndex,
      pageCount,
      pagination
    );
    if (!value) continue;
    value = sanitizeTextForFont(font, value, baseSize);
    const naturalWidth = lineWidth(font, value, baseSize);
    const size = naturalWidth > maxWidth
      ? Math.max(5, baseSize * (maxWidth / naturalWidth))
      : baseSize;
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

function drawPageDecorations(
  page,
  worksheet,
  fonts,
  layout,
  pageIndex,
  pageCount,
  pagination
) {
  if (layout.options?.includeHeaderFooter) {
    drawHeaderFooterLine(
      page,
      sourceHeaderFooterValue(worksheet, "header", pageIndex),
      worksheet,
      fonts,
      layout,
      pageIndex,
      pageCount,
      "header",
      pagination
    );
    drawHeaderFooterLine(
      page,
      sourceHeaderFooterValue(worksheet, "footer", pageIndex),
      worksheet,
      fonts,
      layout,
      pageIndex,
      pageCount,
      "footer",
      pagination
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
      "footer",
      pagination
    );
  }
}

function renderWorksheetPage(
  pdf,
  worksheet,
  layout,
  fonts,
  pageIndex,
  pageCount,
  images = null,
  pagination = null
) {
  const merges = buildMergeMaps(worksheet);
  const page = pdf.addPage();
  page.setSize(layout.pageWidth, layout.pageHeight);
  const cellFrames = [];
  const cellImagePlacements = [];
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
      const mergeRange = merges.masters.get(key);
      const box = calculateCellBox(
        layout,
        rowIndex,
        columnIndex,
        mergeRange
      );
      const textBox = calculateOverflowTextBox(
        worksheet,
        layout,
        rowIndex,
        columnIndex,
        cell,
        box,
        merges,
        images?.cellImages
      );
      drawCell(
        page,
        cell,
        box,
        fonts,
        layout.fontScale || layout.scaleX || layout.scale,
        layout.options,
        textBox
      );
      cellFrames.push({
        border: mergeRange
          ? mergedCellBorder(worksheet, mergeRange, cell.border)
          : cell.border,
        box,
      });
      const cellImage = images?.cellImages?.get(key);
      if (cellImage) cellImagePlacements.push({ image: cellImage, box });
    }
  }
  // 所有填色與文字完成後再繪製框線，避免後畫的相鄰儲存格底色遮掉一半
  // 線寬；細線先畫、粗線後畫，讓表格外框與表頭分隔線保持完整。
  cellFrames
    .sort((a, b) => borderStrength(a.border) - borderStrength(b.border))
    .forEach(({ border, box }) =>
      drawCellFrame(
        page,
        border,
        box,
        layout.fontScale || layout.scaleX || layout.scale,
        layout.options
      )
    );
  cellImagePlacements.forEach(({ image, box }) =>
    drawCellImage(page, image, box)
  );
  drawPageImages(page, worksheet, layout, images);
  drawPageDecorations(
    page,
    worksheet,
    fonts,
    layout,
    pageIndex,
    pageCount,
    pagination || { documentPageOffset: 0, documentPageCount: pageCount }
  );
  return page;
}

async function renderWorksheet(
  pdf,
  worksheet,
  layouts,
  fonts,
  progressState,
  requestId,
  images = null,
  pagination = null
) {
  for (let pageIndex = 0; pageIndex < layouts.length; pageIndex += 1) {
    renderWorksheetPage(
      pdf,
      worksheet,
      layouts[pageIndex],
      fonts,
      pageIndex,
      layouts.length,
      images,
      pagination
    );
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
  const imageItems = worksheet.getImages?.() || [];
  if (imageItems.length) {
    let supportedCount = 0;
    let unsupportedCount = 0;
    for (const item of imageItems) {
      const extension = String(
        workbook?.model?.media?.[item.imageId]?.extension || ""
      ).toLowerCase();
      if (SUPPORTED_IMAGE_EXTENSIONS.has(extension)) supportedCount += 1;
      else unsupportedCount += 1;
    }
    if (supportedCount) {
      issues.push(
        createCompatibilityIssue(
          worksheet,
          "info",
          "images",
          `${supportedCount} 張 PNG/JPEG 圖片將依儲存格錨點轉入 PDF`,
          "依錨定位置與大小繪製，並剪裁至頁面內容區；跨分頁圖片以錨點所在頁為準。"
        )
      );
    }
    if (unsupportedCount) {
      issues.push(
        createCompatibilityIssue(
          worksheet,
          "warning",
          "images-unsupported",
          `${unsupportedCount} 張非 PNG/JPEG 圖片不會轉入 PDF`,
          "僅支援 PNG 與 JPEG，GIF、EMF、WMF 等格式將略過。"
        )
      );
    }
  }

  const cellImageCount = inCellImagesBySheet.get(worksheet.name)?.size || 0;
  if (cellImageCount) {
    issues.push(
      createCompatibilityIssue(
        worksheet,
        "info",
        "cell-images",
        `${cellImageCount} 張儲存格內圖片將轉入 PDF`,
        "Excel 365 的儲存格內圖片會等比縮放置中繪製於所屬儲存格。"
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
    richTextStyled: 0,
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
      if (value?.richText) {
        if (cellStyledRuns(cell)) record("richTextStyled", cell);
        else record("richText", cell);
      }
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
  if (counters.richTextStyled) {
    issues.push(
      createCompatibilityIssue(
        worksheet,
        "info",
        "rich-text-styled",
        `${counters.richTextStyled} 個 Rich Text 儲存格已還原顏色／粗細變化`,
        `${exampleText("richTextStyled")}；同一儲存格內若有不同字級，仍會統一套用儲存格設定的字級。`
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

// ---------------------------------------------------------------------------
// 儲存格內圖片（Excel 365 richValue）
//
// ExcelJS 不認識 richData，這類儲存格會被讀成 #VALUE! 錯誤。這裡直接解開
// xlsx（zip）解析對應鏈：儲存格 vm → xl/metadata.xml（XLRICHVALUE）→
// xl/richData/rdrichvalue.xml（_localImage 結構的 LocalImageIdentifier）→
// richValueRel.xml(.rels) → xl/media/*。解析失敗時靜默略過，不影響一般轉換。
// ---------------------------------------------------------------------------

function unzipEntries(zipBytes, wanted) {
  const entries = fflate.unzipSync(zipBytes, {
    filter: (file) => wanted(file.name),
  });
  return entries;
}

function xmlText(entries, name) {
  const bytes = entries[name];
  return bytes ? new TextDecoder().decode(bytes) : "";
}

function normalizeZipPath(base, target) {
  if (target.startsWith("/")) return target.slice(1);
  const parts = base.split("/").slice(0, -1);
  for (const segment of String(target).split("/")) {
    if (segment === "..") parts.pop();
    else if (segment !== ".") parts.push(segment);
  }
  return parts.join("/");
}

function extractInCellImages(zipBytes) {
  const result = new Map();
  const small = unzipEntries(zipBytes, (name) =>
    [
      "xl/metadata.xml",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/richData/rdrichvalue.xml",
      "xl/richData/rdrichvaluestructure.xml",
      "xl/richData/richValueRel.xml",
      "xl/richData/_rels/richValueRel.xml.rels",
    ].includes(name)
  );
  const metadataXml = xmlText(small, "xl/metadata.xml");
  const richValueXml = xmlText(small, "xl/richData/rdrichvalue.xml");
  if (!metadataXml || !richValueXml) return result;

  // metadata：vm（1-based）→ rich value index
  const metadataTypes = [
    ...metadataXml.matchAll(/<metadataType\b[^>]*name="([^"]+)"/g),
  ].map((m) => m[1]);
  const futureBlock =
    metadataXml.match(
      /<futureMetadata\b[^>]*name="XLRICHVALUE"[^>]*>([\s\S]*?)<\/futureMetadata>/
    )?.[1] || "";
  const rvbIndexes = [...futureBlock.matchAll(/<xlrd:rvb i="(\d+)"/g)].map((m) =>
    Number(m[1])
  );
  const valueBlock =
    metadataXml.match(/<valueMetadata\b[^>]*>([\s\S]*?)<\/valueMetadata>/)?.[1] ||
    "";
  const valueRecords = [...valueBlock.matchAll(/<bk>([\s\S]*?)<\/bk>/g)].map(
    (m) => {
      const rc = m[1].match(/<rc t="(\d+)" v="(\d+)"/);
      return rc ? { type: Number(rc[1]), value: Number(rc[2]) } : null;
    }
  );
  const vmToRichValueIndex = (vm) => {
    const record = valueRecords[vm - 1];
    if (!record || metadataTypes[record.type - 1] !== "XLRICHVALUE") return null;
    const index = rvbIndexes[record.value];
    return Number.isInteger(index) ? index : null;
  };

  // richData：rich value index → media 路徑
  const structureXml = xmlText(small, "xl/richData/rdrichvaluestructure.xml");
  const structures = [
    ...structureXml.matchAll(/<s t="([^"]*)"[^>]*>([\s\S]*?)<\/s>/g),
  ].map((m) => ({
    type: m[1],
    keys: [...m[2].matchAll(/<k n="([^"]+)"/g)].map((k) => k[1]),
  }));
  const richValues = [
    ...richValueXml.matchAll(/<rv s="(\d+)"[^>]*>([\s\S]*?)<\/rv>/g),
  ].map((m) => ({
    structure: Number(m[1]),
    values: [...m[2].matchAll(/<v[^>]*>([^<]*)<\/v>/g)].map((v) => v[1]),
  }));
  const relIds = [
    ...xmlText(small, "xl/richData/richValueRel.xml").matchAll(
      /<rel r:id="([^"]+)"/g
    ),
  ].map((m) => m[1]);
  const relTargets = new Map(
    [
      ...xmlText(small, "xl/richData/_rels/richValueRel.xml.rels").matchAll(
        /Id="([^"]+)"[^>]*Target="([^"]+)"/g
      ),
    ].map((m) => [m[1], m[2]])
  );
  const richValueToMediaPath = (index) => {
    const richValue = richValues[index];
    const structure = structures[richValue?.structure];
    if (!structure || structure.type !== "_localImage") return null;
    const keyIndex = structure.keys.indexOf("_rvRel:LocalImageIdentifier");
    if (keyIndex < 0) return null;
    const relId = relIds[Number(richValue.values[keyIndex])];
    const target = relId && relTargets.get(relId);
    return target
      ? normalizeZipPath("xl/richData/richValueRel.xml", target)
      : null;
  };

  // workbook：sheet 名稱 → worksheet xml 路徑
  const sheetEntries = [
    ...xmlText(small, "xl/workbook.xml").matchAll(
      /<sheet\b[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g
    ),
  ];
  const workbookRels = new Map(
    [
      ...xmlText(small, "xl/_rels/workbook.xml.rels").matchAll(
        /Id="([^"]+)"[^>]*Target="([^"]+)"/g
      ),
    ].map((m) => [m[1], normalizeZipPath("xl/workbook.xml", m[2])])
  );

  // 第二趟：worksheet xml + 會用到的 media
  const sheetPaths = new Set(
    sheetEntries
      .map(([, , relId]) => workbookRels.get(relId))
      .filter((path) => path && path.includes("worksheets/"))
  );
  const large = unzipEntries(
    zipBytes,
    (name) => sheetPaths.has(name) || name.startsWith("xl/media/")
  );

  for (const [, sheetName, relId] of sheetEntries) {
    const sheetXml = xmlText(large, workbookRels.get(relId) || "");
    if (!sheetXml) continue;
    let cellMap = null;
    for (const cellMatch of sheetXml.matchAll(/<c ([^>]*\bvm="\d+"[^>]*?)\/?>/g)) {
      const attrs = cellMatch[1];
      const reference = attrs.match(/\br="([A-Z]+\d+)"/)?.[1];
      const vm = Number(attrs.match(/\bvm="(\d+)"/)?.[1]);
      if (!reference || !vm) continue;
      const richValueIndex = vmToRichValueIndex(vm);
      if (richValueIndex === null) continue;
      const mediaPath = richValueToMediaPath(richValueIndex);
      const bytes = mediaPath && large[mediaPath];
      if (!bytes) continue;
      const extension = mediaPath.split(".").pop().toLowerCase();
      if (!SUPPORTED_IMAGE_EXTENSIONS.has(extension)) continue;
      const address = decodeCellAddress(reference);
      if (!address) continue;
      if (!cellMap) {
        cellMap = new Map();
        result.set(sheetName, cellMap);
      }
      cellMap.set(`${address.row}:${address.column}`, {
        bytes,
        extension,
        mediaPath,
      });
    }
  }
  return result;
}

async function parseWorkbook(message) {
  postProgress(message.requestId, "正在讀取 Excel", message.name || "活頁簿", 8);
  workbookName = message.name || workbookName;
  inCellImagesBySheet = new Map();
  try {
    inCellImagesBySheet = extractInCellImages(new Uint8Array(message.buffer));
  } catch (error) {
    console.warn("[Excel PDF] 儲存格內圖片解析失敗，將略過。", error);
  }
  workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(message.buffer);
  // 儲存格內圖片在 ExcelJS 眼中是 #VALUE! 錯誤；改由圖片繪製，清掉錯誤文字。
  for (const [sheetName, cellMap] of inCellImagesBySheet) {
    const worksheet = workbook.getWorksheet(sheetName);
    if (!worksheet) continue;
    for (const key of cellMap.keys()) {
      const [row, column] = key.split(":").map(Number);
      const cell = worksheet.getCell(row, column);
      if (cell.value?.error) cell.value = null;
    }
  }
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

function getFontBytes() {
  if (!fontBytesPromise) {
    fontBytesPromise = fetch(
      new URL("./vendor/pdf-lib/NotoSansTC-Regular.ttf", self.location.href)
    )
      .then(async (response) => {
        if (!response.ok) throw new Error("中文字型載入失敗。");
        return response.arrayBuffer();
      })
      .catch((error) => {
        // 失敗時清掉快取，避免 rejected promise 讓後續轉換永遠失敗。
        fontBytesPromise = null;
        throw error;
      });
  }
  return fontBytesPromise;
}

// 完整字型的 fontkit 解析結果，做為缺字偵測（hasGlyphForCodePoint）與
// 預覽外框繪製的共同來源。
function getSourceFont() {
  if (!sourceFontPromise) {
    sourceFontPromise = getFontBytes()
      .then((bytes) => fontkit.create(new Uint8Array(bytes)))
      .catch((error) => {
        sourceFontPromise = null;
        throw error;
      });
  }
  return sourceFontPromise;
}

// 以 HarfBuzz WASM 依實際用到的文字裁切子集；失敗時回傳 null 讓呼叫端
// 退回完整內嵌。fontkit 自身的 subset 對大型 Unicode 字型會掉 glyph（CFF 與
// 大型 TTF 皆有案例），因此一律先裁好子集、再以 subset:false 內嵌。
async function subsetFontBytes(bytes, subsetText) {
  if (typeof HBSubset === "undefined" || !HBSubset?.subsetFont) return null;
  try {
    const subsetBytes = await HBSubset.subsetFont(
      new Uint8Array(bytes),
      subsetText,
      {
        wasmUrl: new URL(
          "./vendor/hb-subset/hb-subset.wasm",
          self.location.href
        ).href,
      }
    );
    // 子集必須能被 fontkit 重新解析，否則視為失敗退回完整內嵌。
    fontkit.create(subsetBytes);
    return subsetBytes;
  } catch (error) {
    console.warn("[Excel PDF] 字型子集化失敗，改用完整內嵌。", error);
    return null;
  }
}

async function getPdfFonts(pdf, { outlineUnicode = false, subsetText = "" } = {}) {
  pdf.registerFontkit(fontkit);
  const sourceFont = await getSourceFont();
  const hasGlyph = (codePoint) => sourceFont.hasGlyphForCodePoint(codePoint);
  let unicode;
  if (outlineUnicode) {
    if (!outlineFontPromise) {
      outlineFontPromise = Promise.resolve(sourceFont).then((outlineSource) => ({
        outlineSource,
        pathCache: new Map(),
        hasGlyph,
        widthOfTextAtSize(value, size) {
          const run = outlineSource.layout(String(value || ""));
          const units = run.positions.reduce(
            (sum, position) => sum + position.xAdvance,
            0
          );
          return (units * size) / outlineSource.unitsPerEm;
        },
      }));
    }
    unicode = await outlineFontPromise;
  } else {
    const bytes = await getFontBytes();
    const subsetBytes = subsetText
      ? await subsetFontBytes(bytes, subsetText)
      : null;
    unicode = await pdf.embedFont(subsetBytes || bytes, { subset: false });
    // 缺字偵測一律以「完整字型」為準：子集涵蓋的字元集合是從完整字型
    // 通過 sanitize 的文字收集而來，兩者結果一致。
    unicode.hasGlyph = hasGlyph;
  }
  return {
    unicode,
    ascii: await pdf.embedFont(StandardFonts.Helvetica),
    asciiBold: await pdf.embedFont(StandardFonts.HelveticaBold),
    asciiItalic: await pdf.embedFont(StandardFonts.HelveticaOblique),
    asciiBoldItalic: await pdf.embedFont(StandardFonts.HelveticaBoldOblique),
  };
}

// 走訪所有將輸出的頁面，收集會以中文字型繪製的文字（儲存格、頁首頁尾、
// 頁碼、日期時間），做為子集化的字元來源。□ 與 … 為 sanitize/truncate
// 產生的字元，必須固定保留。
const SUBSET_SAFETY_TEXT = "□…0123456789 第頁，共/：:-－()（）";

function collectSubsetText(jobs) {
  const chunks = [SUBSET_SAFETY_TEXT, workbookName];
  const now = new Date();
  chunks.push(now.toLocaleDateString("zh-TW"));
  chunks.push(now.toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" }));
  for (const job of jobs) {
    const worksheet = job.worksheet;
    chunks.push(String(worksheet.name || ""));
    const headerFooter = worksheet.headerFooter || {};
    for (const key of [
      "oddHeader",
      "oddFooter",
      "evenHeader",
      "evenFooter",
      "firstHeader",
      "firstFooter",
    ]) {
      if (headerFooter[key]) chunks.push(String(headerFooter[key]));
    }
    for (const page of job.pages) {
      for (const row of page.rows) {
        for (const column of page.columns) {
          const value = cellText(worksheet.getCell(row.number, column.number));
          if (value) chunks.push(value);
        }
      }
    }
  }
  return chunks.join("");
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
  const images = await prepareWorksheetImages(pdf, job.worksheet, new Map());
  renderWorksheetPage(
    pdf,
    job.worksheet,
    layout,
    fonts,
    pageIndex,
    job.pages.length,
    images
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
  const fonts = await getPdfFonts(pdf, {
    subsetText: collectSubsetText(layouts),
  });
  setPdfMetadata(pdf);

  const progressState = { completed: 0, total: totalPages };
  const warnings = [];
  const imageEmbedCache = new Map();
  let documentPageOffset = 0;
  for (const item of layouts) {
    warnings.push(
      ...issuesForSheet(item.worksheet.id)
        .filter((issue) => issue.severity !== "info")
        .map((issue) => `${item.worksheet.name}：${issue.message}`)
    );
    const images = await prepareWorksheetImages(
      pdf,
      item.worksheet,
      imageEmbedCache
    );
    await renderWorksheet(
      pdf,
      item.worksheet,
      item.pages,
      fonts,
      progressState,
      message.requestId,
      images,
      {
        documentPageOffset,
        documentPageCount: totalPages,
      }
    );
    documentPageOffset += item.pages.length;
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
