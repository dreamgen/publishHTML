import { chromium } from "playwright-core";

const BASE = "http://127.0.0.1:8123";
const results = [];
const consoleErrors = [];
let failed = false;

function check(name, condition, detail = "") {
  results.push(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!condition) failed = true;
}

const browser = await chromium.launch({
  executablePath:
    process.env.HOME +
    "/.cache/ms-playwright/chromium_headless_shell-1228/chrome-linux/headless_shell",
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text());
});
page.on("pageerror", (error) => consoleErrors.push(String(error)));

await page.goto(`${BASE}/?testHarness=1`, { waitUntil: "networkidle" });
await page.waitForFunction(() => window.__PDF_WORKSHOP_TEST__);
await page.evaluate(() => window.__PDF_WORKSHOP_TEST__.ready);

// 產生 6 頁測試 PDF（含一頁橫向）並載入
await page.evaluate(async () => {
  const { PDFDocument, rgb } = window.PDFLib;
  const doc = await PDFDocument.create();
  for (let i = 0; i < 6; i += 1) {
    const landscape = i === 3;
    const p = doc.addPage(landscape ? [792, 612] : [612, 792]);
    p.drawText(`Page ${i + 1}`, { x: 60, y: landscape ? 520 : 700, size: 48 });
    p.drawRectangle({
      x: 40,
      y: 40,
      width: 120 + i * 40,
      height: 60,
      color: rgb(0.9, 0.3 + i * 0.1, 0.2),
    });
  }
  const bytes = await doc.save();
  const file = new File([bytes], "smoke.pdf", { type: "application/pdf" });
  const app = window.__PDF_WORKSHOP_TEST__.app;
  await app.loadFiles([file], { replace: true, remember: false });
});
await page.waitForTimeout(600);

const app = () => page.evaluate((fn) => fn, null);

// ---------- 基本狀態 ----------
let state = await page.evaluate(() => {
  const app = window.__PDF_WORKSHOP_TEST__.app;
  return {
    pages: app.pages.length,
    viewMode: app.viewMode,
    singleDisabled: document.querySelector("#viewSingleButton").disabled,
    singlePressed: document
      .querySelector("#viewSingleButton")
      .getAttribute("aria-pressed"),
    canvasW: document.querySelector("#pdfCanvas").width,
  };
});
check("載入 6 頁 PDF", state.pages === 6, `pages=${state.pages}`);
check("預設單頁模式", state.viewMode === "single");
check("模式按鈕啟用且單頁為 active", !state.singleDisabled && state.singlePressed === "true");
check("單頁 canvas 已渲染", state.canvasW > 0, `w=${state.canvasW}`);

// ---------- 底部縮放滑桿（單頁模式） ----------
const beforeSliderCanvasW = await page.evaluate(
  () => document.querySelector("#pdfCanvas").width
);
await page.evaluate(() => {
  const slider = document.querySelector("#zoomSlider");
  slider.value = "150";
  slider.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.waitForTimeout(600);
state = await page.evaluate(() => ({
  zoom: window.__PDF_WORKSHOP_TEST__.app.zoom,
  label: document.querySelector("#zoomSliderValue").textContent,
  toolbarLabel: document.querySelector("#zoomResetButton").textContent,
  canvasW: document.querySelector("#pdfCanvas").width,
  sliderVisible: (() => {
    const rect = document.querySelector("#zoomSlider").getBoundingClientRect();
    return rect.width > 0 && rect.bottom <= innerHeight;
  })(),
}));
check("底部滑桿存在且可見", state.sliderVisible);
const stripHidden = await page.evaluate(
  () => getComputedStyle(document.querySelector(".browse-zoom")).display
);
check("單頁模式隱藏瀏覽縮放列", stripHidden === "none", stripHidden);
check(
  "滑桿拖至 150% 同步縮放",
  state.zoom === 1.5 && state.label === "150%" && state.toolbarLabel === "150%",
  `zoom=${state.zoom} label=${state.label}`
);
check("滑桿縮放後重新渲染", state.canvasW > beforeSliderCanvasW, `${beforeSliderCanvasW}→${state.canvasW}`);
await page.evaluate(() => document.querySelector("#zoomSliderValue").click());
await page.waitForTimeout(500);
state = await page.evaluate(() => ({
  zoom: window.__PDF_WORKSHOP_TEST__.app.zoom,
  slider: document.querySelector("#zoomSlider").value,
}));
check("點百分比重設 100%", state.zoom === 1 && state.slider === "100", `slider=${state.slider}`);

// ---------- 連續模式 ----------
await page.click("#viewContinuousButton");
await page.waitForTimeout(800);
state = await page.evaluate(() => {
  const app = window.__PDF_WORKSHOP_TEST__.app;
  const slots = [...document.querySelectorAll(".preview-slot")];
  const stage = document.querySelector("#pageStage");
  return {
    viewMode: app.viewMode,
    bodyClass: document.body.classList.contains("view-continuous"),
    slotCount: slots.length,
    slotHeights: slots.map((slot) => Math.round(parseFloat(slot.style.height))),
    slotWidths: slots.map((slot) => Math.round(parseFloat(slot.style.width))),
    stageTop: stage.style.top,
    stageAtSlot0:
      Math.abs(stage.offsetTop - slots[0]?.offsetTop) < 2 &&
      Math.abs(stage.offsetLeft - slots[0]?.offsetLeft) < 2,
    saved: localStorage.getItem("pdfEditor-view-mode-v1"),
  };
});
check("切換連續模式", state.viewMode === "continuous" && state.bodyClass);
check("產生 6 個預覽格", state.slotCount === 6, `slots=${state.slotCount}`);
check(
  "橫向頁（第4頁）比例正確",
  state.slotHeights[3] < state.slotWidths[3] &&
    state.slotHeights[0] > state.slotWidths[0],
  `p1=${state.slotWidths[0]}x${state.slotHeights[0]} p4=${state.slotWidths[3]}x${state.slotHeights[3]}`
);
check("舞台對齊第 1 格", state.stageAtSlot0, `top=${state.stageTop}`);
check("模式已持久化", state.saved === "continuous");

// 可視範圍預覽已渲染
await page.waitForTimeout(700);
state = await page.evaluate(() => {
  const slots = [...document.querySelectorAll(".preview-slot")];
  return {
    rendered: slots.filter((s) => s.dataset.previewState === "rendered").length,
    farState: slots[5].dataset.previewState || "",
  };
});
check("可視預覽已渲染", state.rendered >= 1, `rendered=${state.rendered}`);

// ---------- skim：捲到底、停穩換頁 ----------
await page.evaluate(() => {
  const viewer = document.querySelector("#viewerScroll");
  viewer.scrollTo({ top: viewer.scrollHeight, behavior: "auto" });
});
await page.waitForTimeout(120);
const midSkim = await page.evaluate(() =>
  document.querySelector("#documentView").classList.contains("skimming")
);
await page.waitForTimeout(700);
state = await page.evaluate(() => {
  const app = window.__PDF_WORKSHOP_TEST__.app;
  const slots = [...document.querySelectorAll(".preview-slot")];
  const stage = document.querySelector("#pageStage");
  const last = slots[slots.length - 1];
  return {
    skimming: document
      .querySelector("#documentView")
      .classList.contains("skimming"),
    activeIndex: app.pages.findIndex((p) => p.id === app.activePageId),
    status: document.querySelector("#activePageStatus").textContent,
    stageAtLast:
      Math.abs(stage.offsetTop - last.offsetTop) < 2 &&
      Math.abs(stage.offsetLeft - last.offsetLeft) < 2,
  };
});
check("滑動中進入 skimming 狀態", midSkim === true);
check("停穩後解除 skimming", state.skimming === false);
check("停穩換頁到最後一頁", state.activeIndex === 5, `active=${state.activeIndex + 1}`);
check("狀態列顯示第 6 頁", state.status.includes("6"), state.status);
check("舞台移到最後一格", state.stageAtLast);

// ---------- 點預覽格跳頁 ----------
await page.evaluate(() => {
  document.querySelectorAll(".preview-slot")[1].click();
});
await page.waitForTimeout(900);
state = await page.evaluate(() => {
  const app = window.__PDF_WORKSHOP_TEST__.app;
  return { activeIndex: app.pages.findIndex((p) => p.id === app.activePageId) };
});
check("點預覽格跳到第 2 頁", state.activeIndex === 1, `active=${state.activeIndex + 1}`);

// ---------- 縮放重建 ----------
const beforeZoomWidth = await page.evaluate(
  () => parseFloat(document.querySelectorAll(".preview-slot")[0].style.width)
);
await page.click("#zoomInButton");
await page.waitForTimeout(700);
state = await page.evaluate(() => ({
  w: parseFloat(document.querySelectorAll(".preview-slot")[0].style.width),
  stageW: parseFloat(document.querySelector("#pageStage").style.width),
  slotW: parseFloat(
    document.querySelector(
      `.preview-slot[data-page-id="${window.__PDF_WORKSHOP_TEST__.app.activePageId}"]`
    ).style.width
  ),
}));
check("放大後預覽格變寬", state.w > beforeZoomWidth, `${beforeZoomWidth}→${state.w}`);
check("舞台與格寬一致", Math.abs(state.stageW - state.slotW) < 1, `stage=${state.stageW} slot=${state.slotW}`);
await page.click("#zoomResetButton");
await page.waitForTimeout(500);

// ---------- 旋轉重建（旋轉後格子比例互換） ----------
state = await page.evaluate(async () => {
  const app = window.__PDF_WORKSHOP_TEST__.app;
  const before = document.querySelectorAll(".preview-slot")[1].style.width;
  app.selectedPageIds = new Set([app.pages[1].id]);
  app.rotateSelectedPages();
  await new Promise((resolve) => setTimeout(resolve, 700));
  const slot = document.querySelectorAll(".preview-slot")[1];
  return {
    beforeW: parseFloat(before),
    afterW: parseFloat(slot.style.width),
    afterH: parseFloat(slot.style.height),
  };
});
check(
  "旋轉後預覽格轉為橫向",
  state.afterW > state.afterH,
  `after=${Math.round(state.afterW)}x${Math.round(state.afterH)}`
);

// ---------- 瀏覽模式 ----------
await page.click("#viewBrowseButton");
await page.waitForTimeout(900);
state = await page.evaluate(() => {
  const app = window.__PDF_WORKSHOP_TEST__.app;
  const list = document.querySelector("#pageList");
  const cards = [...list.querySelectorAll(".page-card")];
  const firstCanvas = cards[0]?.querySelector("canvas");
  const dimensions = cards.map((card) => {
    const canvasRect = card.querySelector("canvas")?.getBoundingClientRect();
    const wrapRect = card.querySelector(".thumbnail-wrap")?.getBoundingClientRect();
    return {
      canvasW: canvasRect?.width || 0,
      canvasH: canvasRect?.height || 0,
      wrapW: wrapRect?.width || 0,
      wrapH: wrapRect?.height || 0,
    };
  });
  return {
    viewMode: app.viewMode,
    bodyClass: document.body.classList.contains("view-browse"),
    display: getComputedStyle(list).display,
    cardCount: cards.length,
    canvasW: firstCanvas?.width || 0,
    sidebarW: Math.round(
      document.querySelector("#sidebar").getBoundingClientRect().width
    ),
    previewFlowHidden: document.querySelector("#previewFlow").hidden,
    dimensions,
  };
});
check("切換瀏覽模式", state.viewMode === "browse" && state.bodyClass);
check("頁面清單為網格", state.display === "grid");
check("6 張頁卡", state.cardCount === 6);
check("側欄展開至全寬", state.sidebarW >= 1200, `w=${state.sidebarW}`);
check("縮圖高解析（230px）", state.canvasW >= 220, `canvasW=${state.canvasW}`);
check(
  "瀏覽縮圖保留橫／直式比例",
  state.dimensions[0].canvasH > state.dimensions[0].canvasW &&
    state.dimensions[3].canvasW > state.dimensions[3].canvasH &&
    state.dimensions[0].wrapH > state.dimensions[0].wrapW &&
    state.dimensions[3].wrapW > state.dimensions[3].wrapH,
  `portrait=${Math.round(state.dimensions[0].wrapW)}x${Math.round(
    state.dimensions[0].wrapH
  )} landscape=${Math.round(state.dimensions[3].wrapW)}x${Math.round(
    state.dimensions[3].wrapH
  )}`
);

// ---------- 瀏覽模式縮放 ----------
await page.click("#zoomInButton");
await page.click("#zoomInButton");
await page.waitForTimeout(1000);
state = await page.evaluate(() => {
  const app = window.__PDF_WORKSHOP_TEST__.app;
  const list = document.querySelector("#pageList");
  const firstCanvas = list.querySelector(".page-card canvas");
  return {
    browseZoom: app.browseZoom,
    label: document.querySelector("#zoomResetButton").textContent,
    cardVar: list.style.getPropertyValue("--browse-card-width"),
    canvasW: firstCanvas?.width || 0,
    pageZoomUntouched: app.zoom,
    saved: parseFloat(localStorage.getItem("pdfEditor-browse-zoom-v1")),
  };
});
check(
  "瀏覽縮放放大兩級",
  Math.abs(state.browseZoom - 1.3) < 0.001 && state.label === "130%",
  `zoom=${state.browseZoom} label=${state.label}`
);
check("網格卡片寬度變大", state.cardVar === "234px", state.cardVar);
check("縮圖解析度升級（330px）", state.canvasW >= 320, `canvasW=${state.canvasW}`);
check("不影響頁面縮放", state.pageZoomUntouched === 1, `zoom=${state.pageZoomUntouched}`);
check("瀏覽縮放已持久化", Math.abs(state.saved - 1.3) < 0.001, `saved=${state.saved}`);

// ---------- 瀏覽模式底部滑桿 ----------
const sliderState = await page.evaluate(() => {
  const slider = document.querySelector("#zoomSlider");
  const rect = slider.getBoundingClientRect();
  const hit = document.elementFromPoint(
    rect.left + rect.width / 2,
    rect.top + rect.height / 2
  );
  return {
    min: slider.min,
    max: slider.max,
    value: slider.value,
    hitIsSlider: hit === slider,
  };
});
check(
  "瀏覽模式滑桿改為 60–240 範圍且同步",
  sliderState.min === "60" && sliderState.max === "240" && sliderState.value === "130",
  JSON.stringify(sliderState)
);
check("瀏覽模式下滑桿未被覆蓋", sliderState.hitIsSlider);
const stripState = await page.evaluate(() => {
  const strip = document.querySelector(".browse-zoom");
  const slider = document.querySelector("#browseZoomSlider");
  const rect = strip.getBoundingClientRect();
  const centerHit = document.elementFromPoint(
    rect.left + rect.width / 2,
    rect.top + rect.height / 2
  );
  return {
    display: getComputedStyle(strip).display,
    min: slider.min,
    max: slider.max,
    value: slider.value,
    label: document.querySelector("#browseZoomValue").textContent,
    inBottomArea: rect.top > innerHeight * 0.75 && rect.bottom < innerHeight,
    horizontallyCentered: Math.abs(rect.left + rect.width / 2 - innerWidth / 2) < 40,
    notCovered: strip.contains(centerHit),
  };
});
check(
  "瀏覽底部懸浮縮放列顯示且同步",
  stripState.display === "flex" &&
    stripState.min === "60" &&
    stripState.max === "240" &&
    stripState.value === "130" &&
    stripState.label === "130%",
  JSON.stringify(stripState)
);
check(
  "縮放列位於下方置中且未被遮擋",
  stripState.inBottomArea && stripState.horizontallyCentered && stripState.notCovered
);
await page.evaluate(() => {
  const slider = document.querySelector("#browseZoomSlider");
  slider.value = "160";
  slider.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.waitForTimeout(600);
state = await page.evaluate(() => ({
  browseZoom: window.__PDF_WORKSHOP_TEST__.app.browseZoom,
  statusValue: document.querySelector("#zoomSlider").value,
  stripLabel: document.querySelector("#browseZoomValue").textContent,
}));
check(
  "懸浮縮放列拖曳並與狀態列滑桿同步",
  state.browseZoom === 1.6 && state.statusValue === "160" && state.stripLabel === "160%",
  JSON.stringify(state)
);
await page.evaluate(() => {
  const slider = document.querySelector("#zoomSlider");
  slider.value = "200";
  slider.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.waitForTimeout(900);
state = await page.evaluate(() => ({
  browseZoom: window.__PDF_WORKSHOP_TEST__.app.browseZoom,
  cardVar: document
    .querySelector("#pageList")
    .style.getPropertyValue("--browse-card-width"),
  canvasW:
    document.querySelector("#pageList .page-card canvas")?.width || 0,
}));
check(
  "滑桿拖至 200% 更新網格與縮圖",
  state.browseZoom === 2 && state.cardVar === "360px" && state.canvasW >= 420,
  `zoom=${state.browseZoom} var=${state.cardVar} canvasW=${state.canvasW}`
);

await page.click("#zoomResetButton");
await page.waitForTimeout(1000);
state = await page.evaluate(() => {
  const list = document.querySelector("#pageList");
  return {
    label: document.querySelector("#zoomResetButton").textContent,
    cardVar: list.style.getPropertyValue("--browse-card-width"),
    canvasW: list.querySelector(".page-card canvas")?.width || 0,
  };
});
check(
  "瀏覽縮放重設 100%",
  state.label === "100%" && state.cardVar === "180px" && state.canvasW <= 240,
  `label=${state.label} var=${state.cardVar} canvasW=${state.canvasW}`
);

// 低倍率時卡片比縮圖解析度級距窄，仍必須同步縮放寬高，不能只壓寬度。
await page.evaluate(() => {
  const slider = document.querySelector("#zoomSlider");
  slider.value = "60";
  slider.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.waitForTimeout(900);
state = await page.evaluate(() => {
  const cards = [...document.querySelectorAll("#pageList .page-card")];
  return cards.map((card) => {
    const canvas = card.querySelector("canvas").getBoundingClientRect();
    const wrap = card.querySelector(".thumbnail-wrap").getBoundingClientRect();
    return {
      canvasW: canvas.width,
      canvasH: canvas.height,
      wrapW: wrap.width,
      wrapH: wrap.height,
    };
  });
});
check(
  "瀏覽 60% 仍保留橫／直式比例",
  state[0].canvasH > state[0].canvasW &&
    state[3].canvasW > state[3].canvasH &&
    state[0].wrapH > state[0].wrapW &&
    state[3].wrapW > state[3].wrapH,
  `portrait=${Math.round(state[0].wrapW)}x${Math.round(
    state[0].wrapH
  )} landscape=${Math.round(state[3].wrapW)}x${Math.round(state[3].wrapH)}`
);
if (process.env.PDF_EDITOR_VIEW_MODE_SCREENSHOT) {
  await page.screenshot({
    path: process.env.PDF_EDITOR_VIEW_MODE_SCREENSHOT,
    fullPage: false,
  });
}
await page.click("#zoomResetButton");
await page.waitForTimeout(700);

// ---------- 瀏覽模式雙擊回到前一種頁面模式 ----------
await page.evaluate(() => {
  const card = document.querySelectorAll("#pageList .page-card")[2];
  card.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
});
await page.waitForTimeout(900);
state = await page.evaluate(() => {
  const app = window.__PDF_WORKSHOP_TEST__.app;
  return {
    viewMode: app.viewMode,
    activeIndex: app.pages.findIndex((p) => p.id === app.activePageId),
    browseClass: document.body.classList.contains("view-browse"),
  };
});
check(
  "雙擊頁卡回到連續模式並定位",
  state.viewMode === "continuous" && !state.browseClass && state.activeIndex === 2,
  `mode=${state.viewMode} active=${state.activeIndex + 1}`
);

// ---------- 回到單頁模式 ----------
await page.click("#viewSingleButton");
await page.waitForTimeout(600);
state = await page.evaluate(() => {
  const stage = document.querySelector("#pageStage");
  return {
    viewMode: window.__PDF_WORKSHOP_TEST__.app.viewMode,
    stageTop: stage.style.top,
    flowChildren: document.querySelector("#previewFlow").childElementCount,
    flowHidden: document.querySelector("#previewFlow").hidden,
    canvasW: document.querySelector("#pdfCanvas").width,
  };
});
check(
  "回到單頁模式並清理連續模式",
  state.viewMode === "single" &&
    state.stageTop === "" &&
    state.flowChildren === 0 &&
    state.flowHidden,
  JSON.stringify(state)
);
check("單頁重新渲染", state.canvasW > 0);

const realErrors = consoleErrors.filter(
  (text) =>
    !text.includes("favicon") &&
    !text.includes("Failed to load resource") &&
    !text.includes("ServiceWorker") &&
    !text.includes("service worker")
);
check("無 console 錯誤", realErrors.length === 0, realErrors.slice(0, 3).join(" | "));

await browser.close();
console.log(results.join("\n"));
console.log(failed ? "\nSMOKE: FAIL" : "\nSMOKE: ALL PASS");
process.exit(failed ? 1 : 0);
