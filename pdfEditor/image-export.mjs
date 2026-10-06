// Bound canvas allocation for mobile browsers while preserving aspect ratio.
export function getImageRenderScale(width, height, dpi) {
  if (![width, height, dpi].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error("頁面尺寸或解析度無效");
  }
  return Math.min(dpi / 72, 8192 / Math.max(width, height),
    Math.sqrt(12_000_000 / (width * height)));
}
