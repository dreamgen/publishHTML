import { pathToFileURL } from "node:url";

const playwright = await import("playwright-core").catch(async (error) => {
  const fallback = process.env.PDF_EDITOR_PLAYWRIGHT_CORE_PATH;
  if (!fallback) throw error;
  return import(pathToFileURL(fallback).href);
});
const { chromium } = playwright;

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
    process.env.PLAYWRIGHT_CHROMIUM_PATH ||
    (process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : process.env.HOME +
        "/.cache/ms-playwright/chromium_headless_shell-1228/chrome-linux/headless_shell"),
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

state = await page.evaluate(() => {
  const actions = [...document.querySelectorAll(".selection-bar .selection-action")];
  return {
    labels: actions.map((item) => item.querySelector("span")?.textContent || ""),
    allHaveTips: actions.every((item) => item.title.length >= 8),
    allSingleLine: actions.every(
      (item) => item.getBoundingClientRect().height <= 32
    ),
    iconCount: actions.filter((item) => item.querySelector("svg, input")).length,
  };
});
check(
  "頁面操作列使用圖示、兩字短標籤與完整提示",
  state.labels.join("|") === "全選|範圍|群組|擷取" &&
    state.allHaveTips &&
    state.allSingleLine &&
    state.iconCount === 4,
  JSON.stringify(state)
);

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
    groupRows: document.querySelectorAll("#pageList .page-group-row").length,
    groupCardsVisible: [...document.querySelectorAll("#pageList .page-group .page-card")]
      .every((card) => {
        const rect = card.getBoundingClientRect();
        return rect.width > 80 && rect.height > 80;
      }),
    verticalGroupTitle:
      getComputedStyle(
        document.querySelector("#pageList .page-group-title strong")
      ).writingMode === "vertical-rl",
    coloredGroupFrame:
      parseFloat(
        getComputedStyle(document.querySelector("#pageList .page-group-row"))
          .borderTopWidth
      ) >= 2,
  };
});
check("切換瀏覽模式", state.viewMode === "browse" && state.bodyClass);
check("頁面清單為網格", state.display === "grid");
check("6 張頁卡", state.cardCount === 6);
check("側欄展開至全寬", state.sidebarW >= 1200, `w=${state.sidebarW}`);
check("縮圖高解析（230px）", state.canvasW >= 220, `canvasW=${state.canvasW}`);
check(
  "瀏覽群組顯示彩色橫向分列與垂直標題",
  state.groupRows >= 1 &&
    state.groupCardsVisible &&
    state.verticalGroupTitle &&
    state.coloredGroupFrame,
  JSON.stringify(state)
);
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
state = await page.evaluate(async () => {
  const app = window.__PDF_WORKSHOP_TEST__.app;
  const groupId = app.pages[0].groupId;
  app.togglePageGroupCollapsed(groupId);
  await new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))
  );
  const collapsedGroup = document.querySelector(
    `.page-group[data-group-id="${groupId}"]`
  );
  const listRect = document.querySelector("#pageList").getBoundingClientRect();
  const groupRect = collapsedGroup.getBoundingClientRect();
  const deckThumbs = [
    ...collapsedGroup.querySelectorAll(".page-group-collapsed-thumb"),
  ];
  const deckLefts = deckThumbs.map(
    (item) => Math.round(item.getBoundingClientRect().left)
  );
  const metaRect = collapsedGroup
    .querySelector(".page-group-collapsed-meta")
    .getBoundingClientRect();
  const deckRect = collapsedGroup
    .querySelector(".page-group-collapsed-deck")
    .getBoundingClientRect();
  const deckLayoutVariants = [5, 17, 33].map((sourceCount) => {
    const cards = Array.from({ length: sourceCount }, (_, index) => {
      const card = document.createElement("article");
      card.dataset.pageId = `layout-${sourceCount}-${index}`;
      const wrap = document.createElement("div");
      wrap.className = "thumbnail-wrap loaded";
      const canvas = document.createElement("canvas");
      const landscape = index % 2 === 1;
      canvas.width = landscape ? 792 : 612;
      canvas.height = landscape ? 612 : 792;
      wrap.append(canvas);
      card.append(wrap);
      return card;
    });
    const preview = app.createCollapsedGroupPreview(
      `layout-${sourceCount}`,
      cards
    );
    Object.assign(preview.style, {
      position: "fixed",
      left: "0",
      top: "0",
      width: "260px",
      height: "360px",
      visibility: "hidden",
    });
    document.body.append(preview);
    const testDeck = preview.querySelector(".page-group-collapsed-deck");
    const testDeckRect = testDeck.getBoundingClientRect();
    const thumbs = [...preview.querySelectorAll(".page-group-collapsed-thumb")];
    const measurements = thumbs.map((thumb) => {
      const thumbRect = thumb.getBoundingClientRect();
      const canvas = thumb.querySelector("canvas");
      const canvasRect = canvas?.getBoundingClientRect();
      return {
        left: thumbRect.left,
        right: thumbRect.right,
        height: thumbRect.height,
        ratio: canvasRect ? canvasRect.width / canvasRect.height : 0,
        sourceRatio: canvas ? canvas.width / canvas.height : 0,
      };
    });
    const result = {
      count: measurements.length,
      expectedCount: sourceCount === 5 ? 3 : sourceCount === 17 ? 4 : 5,
      startsAtLeft:
        Math.abs((measurements[0]?.left || 0) - testDeckRect.left) <= 1,
      fillsHeight: measurements.every(
        (item) => Math.abs(item.height - testDeckRect.height) <= 1
      ),
      preservesRatio: measurements.every(
        (item) => Math.abs(item.ratio - item.sourceRatio) < 0.01
      ),
      increasesLeft: measurements.every(
        (item, index) => index === 0 || item.left > measurements[index - 1].left
      ),
      clipsRight:
        getComputedStyle(testDeck).overflow === "hidden" &&
        measurements.some((item) => item.right > testDeckRect.right + 1),
    };
    preview.remove();
    return result;
  });
  const collapsed = {
    classApplied: collapsedGroup.classList.contains("collapsed"),
    rowCount: collapsedGroup.querySelectorAll(".page-group-row").length,
    visibleCards: collapsedGroup.querySelectorAll(".page-card").length,
    inlineGridCard: groupRect.width < listRect.width / 2,
    verticalMenu:
      getComputedStyle(
        collapsedGroup.querySelector(".page-group-header")
      ).flexDirection === "column",
    previewCount: deckThumbs.length,
    horizontalDeck: deckLefts.every(
      (left, index) => index === 0 || left > deckLefts[index - 1]
    ),
    nameAboveDeck:
      metaRect.bottom <= deckRect.top + 1 &&
      collapsedGroup.querySelector(".page-group-collapsed-meta strong")
        .textContent === "smoke.pdf" &&
      collapsedGroup.querySelector(".page-group-collapsed-meta span")
        .textContent === "6 頁",
    expandedState:
      collapsedGroup
        .querySelector(".group-collapse-button")
        .getAttribute("aria-expanded") === "false",
    deckLayoutVariants,
  };
  app.togglePageGroupCollapsed(groupId);
  await new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))
  );
  collapsed.expandedCards = document.querySelectorAll(
    `.page-group[data-group-id="${groupId}"] .page-card`
  ).length;
  return collapsed;
});
check(
  "瀏覽群組可收合為單頁大小的橫向疊頁卡並再次展開",
  state.classApplied &&
    state.rowCount === 1 &&
    state.visibleCards === 0 &&
    state.inlineGridCard &&
    state.verticalMenu &&
    state.previewCount === 3 &&
    state.horizontalDeck &&
    state.nameAboveDeck &&
    state.expandedState &&
    state.expandedCards === 6,
  JSON.stringify(state)
);
check(
  "收合群組的 3～5 張預覽皆滿高、等比例、靠左排列並裁切右側",
  state.deckLayoutVariants.every(
    (variant) =>
      variant.count === variant.expectedCount &&
      variant.startsAtLeft &&
      variant.fillsHeight &&
      variant.preservesRatio &&
      variant.increasesLeft &&
      variant.clipsRight
  ),
  JSON.stringify(state.deckLayoutVariants)
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

// ---------- 批次移動與頁面群組 ----------
state = await page.evaluate(() => {
  const app = window.__PDF_WORKSHOP_TEST__.app;
  return {
    groupIds: [...new Set(app.pages.map((item) => item.groupId))],
    groupCount: document.querySelectorAll("#pageList .page-group").length,
    groupedCards:
      document.querySelector("#pageList .page-group-pages")?.children.length || 0,
  };
});
check(
  "同一匯入檔案預設為一個群組",
  state.groupIds.length === 1 && state.groupCount === 1 && state.groupedCards === 6,
  JSON.stringify(state)
);

state = await page.evaluate(() => {
  const app = window.__PDF_WORKSHOP_TEST__.app;
  let group = document.querySelector("#pageList .page-group");
  const collapseIcon = [
    ...group.querySelectorAll(".group-collapse-button path"),
  ].map((path) => path.getAttribute("d"));
  group.querySelector(".group-collapse-button").click();
  group = document.querySelector("#pageList .page-group");
  const expandIcon = [
    ...group.querySelectorAll(".group-collapse-button path"),
  ].map((path) => path.getAttribute("d"));
  const collapsed =
    group.classList.contains("collapsed") &&
    !group.querySelector(".page-group-pages") &&
    !!group.querySelector(".page-group-collapsed-preview") &&
    group
      .querySelector(".group-collapse-button")
      .getAttribute("aria-expanded") === "false";
  const horizontalToolbar =
    getComputedStyle(group.querySelector(".page-group-header")).flexDirection ===
      "row" &&
    getComputedStyle(group.querySelector(".page-group-actions")).flexDirection ===
      "row";
  const controlsRemain =
    !!group.querySelector(".group-rename-button") &&
    !!group.querySelector(".group-ungroup-button") &&
    group.querySelectorAll(".mini-button").length >= 4;
  app.selectedPageIds = new Set([app.pages.at(-1).id, "outside-selection"]);
  app.refreshSidebarSelection();
  group.querySelector(".page-group-collapsed-preview").click();
  const collapsedBlockSingleSelect =
    app.selectedPageIds.size === 6 &&
    app.pages.every((item) => app.selectedPageIds.has(item.id)) &&
    group.classList.contains("selected");
  group.querySelector(".group-collapse-button").click();
  group = document.querySelector("#pageList .page-group");
  app.selectedPageIds = new Set([app.pages.at(-1).id]);
  app.refreshSidebarSelection();
  group.querySelector(".page-group-header").click();
  const expandedBlockDoesNotSelect =
    !group.querySelector(".page-group-collapsed-preview") &&
    app.selectedPageIds.size === 1 &&
    app.selectedPageIds.has(app.pages.at(-1).id);
  app.setViewMode("continuous");
  let continuousGroup = document.querySelector("#pageList .page-group");
  continuousGroup.querySelector(".group-collapse-button").click();
  continuousGroup = document.querySelector("#pageList .page-group");
  const continuousUsesCollapsedCard =
    !!continuousGroup.querySelector(".page-group-collapsed-preview") &&
    continuousGroup.querySelectorAll(".page-group-collapsed-thumb").length === 3 &&
    getComputedStyle(
      continuousGroup.querySelector(".page-group-header")
    ).flexDirection === "row";
  continuousGroup.querySelector(".group-collapse-button").click();
  app.setViewMode("single");
  return {
    collapsed,
    horizontalToolbar,
    controlsRemain,
    collapsedBlockSingleSelect,
    expandedBlockDoesNotSelect,
    continuousUsesCollapsedCard,
    inwardOutwardIcons:
      collapseIcon.join("|") === "m5 7 5 5-5 5|m19 7-5 5 5 5" &&
      expandIcon.join("|") === "m10 7-5 5 5 5|m14 7 5 5-5 5",
    expanded:
      !group.classList.contains("collapsed") &&
      getComputedStyle(group.querySelector(".page-group-pages")).display !==
        "none",
  };
});
check(
  "一般側欄群組可收合且保留整組操作",
  state.collapsed &&
    state.horizontalToolbar &&
    state.controlsRemain &&
    state.collapsedBlockSingleSelect &&
    state.expandedBlockDoesNotSelect &&
    state.continuousUsesCollapsedCard &&
    state.inwardOutwardIcons &&
    state.expanded,
  JSON.stringify(state)
);

state = await page.evaluate(() => {
  const app = window.__PDF_WORKSHOP_TEST__.app;
  document.querySelector(".group-rename-button").click();
  const dialog = document.querySelector("#groupNameDialog");
  const input = document.querySelector("#groupNameInput");
  const opened = dialog.open && input.value === "smoke.pdf";
  input.value = "測試章節群組";
  dialog
    .querySelector("form")
    .requestSubmit(document.querySelector("#groupNameAcceptButton"));
  const groupId = app.pages[0].groupId;
  const renamed =
    app.pages
      .filter((item) => item.groupId === groupId)
      .every((item) => item.groupName === "測試章節群組") &&
    document.querySelector(".page-group-title strong").textContent ===
      "測試章節群組";
  app.undo();
  const undoName = app.getPageGroupLabel(groupId);
  app.redo();
  const redoName = app.getPageGroupLabel(groupId);
  app.undo();
  return { opened, renamed, undoName, redoName };
});
check(
  "群組名稱可修改並支援復原與重做",
  state.opened &&
    state.renamed &&
    state.undoName === "smoke.pdf" &&
    state.redoName === "測試章節群組",
  JSON.stringify(state)
);

state = await page.evaluate(async () => {
  const app = window.__PDF_WORKSHOP_TEST__.app;
  const doc = await window.PDFLib.PDFDocument.create();
  doc.addPage([612, 792]);
  doc.addPage([612, 792]);
  const bytes = await doc.save();
  await app.loadFiles(
    [new File([bytes], "第二份測試.pdf", { type: "application/pdf" })],
    { replace: false, remember: false }
  );
  const imported = {
    sourceCount: app.sources.size,
    groupIds: [...new Set(app.pages.map((item) => item.groupId))],
    groupHeaders: document.querySelectorAll("#pageList .page-group").length,
  };
  const [firstGroupId, secondGroupId] = imported.groupIds;
  app.setViewMode("browse");
  await new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))
  );
  const browseGroups = [...document.querySelectorAll("#pageList .page-group")];
  imported.browseGroupRows = document.querySelectorAll(
    "#pageList .page-group-row"
  ).length;
  imported.browseVisibleCards = [
    ...document.querySelectorAll("#pageList .page-group .page-card"),
  ].filter((card) => card.getBoundingClientRect().width > 80).length;
  imported.browseGroupColors = new Set(
    browseGroups.map((group) => group.dataset.groupColor)
  ).size;
  for (const groupId of imported.groupIds) {
    app.togglePageGroupCollapsed(groupId);
  }
  await new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))
  );
  const collapsedGroups = [
    ...document.querySelectorAll("#pageList .page-group.collapsed"),
  ];
  const collapsedRects = collapsedGroups.map((group) =>
    group.getBoundingClientRect()
  );
  imported.collapsedGroupsInline =
    collapsedGroups.length === 2 &&
    Math.abs(collapsedRects[0].top - collapsedRects[1].top) <= 2 &&
    collapsedRects[0].right <= collapsedRects[1].left + 2 &&
    collapsedGroups.every(
      (group) =>
        group.querySelectorAll(".page-group-collapsed-thumb").length >= 3
    );
  const collapsedDragTransfer = new DataTransfer();
  collapsedGroups[0].dispatchEvent(
    new DragEvent("dragstart", {
      bubbles: true,
      dataTransfer: collapsedDragTransfer,
    })
  );
  const collapsedTargetRect = collapsedGroups[1].getBoundingClientRect();
  collapsedGroups[1].dispatchEvent(
    new DragEvent("dragover", {
      bubbles: true,
      cancelable: true,
      clientX: collapsedTargetRect.right - 1,
      clientY: collapsedTargetRect.top + collapsedTargetRect.height / 2,
      dataTransfer: collapsedDragTransfer,
    })
  );
  collapsedGroups[1].dispatchEvent(
    new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      clientX: collapsedTargetRect.right - 1,
      clientY: collapsedTargetRect.top + collapsedTargetRect.height / 2,
      dataTransfer: collapsedDragTransfer,
    })
  );
  collapsedGroups[0].dispatchEvent(
    new DragEvent("dragend", {
      bubbles: true,
      dataTransfer: collapsedDragTransfer,
    })
  );
  imported.collapsedGroupDragMoved =
    app.pages[0].groupId === secondGroupId &&
    app.pages.at(-1).groupId === firstGroupId;
  app.undo();
  for (const groupId of imported.groupIds) {
    app.togglePageGroupCollapsed(groupId);
  }
  await new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))
  );
  app.setViewMode("single");
  app.selectedPageIds = new Set();
  app.updateUI();
  app.refreshSidebarSelection();
  const importedGroupCheckboxes = [
    ...document.querySelectorAll(".group-select-checkbox"),
  ];
  importedGroupCheckboxes[0].click();
  importedGroupCheckboxes[1].click();
  imported.checkboxSupportsMultipleGroups =
    app.selectedPageIds.size === app.pages.length &&
    importedGroupCheckboxes.every((item) => item.checked);
  importedGroupCheckboxes[0].click();
  importedGroupCheckboxes[1].click();
  const sourceHeader = document.querySelector(
    `.page-group[data-group-id="${firstGroupId}"] .page-group-header`
  );
  const targetHeader = document.querySelector(
    `.page-group[data-group-id="${secondGroupId}"] .page-group-header`
  );
  const dataTransfer = new DataTransfer();
  sourceHeader.dispatchEvent(
    new DragEvent("dragstart", { bubbles: true, dataTransfer })
  );
  const rect = targetHeader.getBoundingClientRect();
  targetHeader.dispatchEvent(
    new DragEvent("dragover", {
      bubbles: true,
      cancelable: true,
      clientY: rect.bottom - 1,
      dataTransfer,
    })
  );
  targetHeader.dispatchEvent(
    new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      clientY: rect.bottom - 1,
      dataTransfer,
    })
  );
  sourceHeader.dispatchEvent(
    new DragEvent("dragend", { bubbles: true, dataTransfer })
  );
  imported.groupDragMoved =
    app.pages[0].groupId === secondGroupId &&
    app.pages.at(-1).groupId === firstGroupId &&
    [...app.selectedPageIds].length === 6;
  app.undo();
  app.undo();
  return imported;
});
check(
  "多個匯入檔案會建立多個預設群組",
  state.sourceCount === 2 && state.groupIds.length === 2 && state.groupHeaders === 2,
  JSON.stringify(state)
);
check(
  "多個瀏覽群組分列可見且使用不同顏色",
  state.browseGroupRows >= 2 &&
    state.browseVisibleCards === 8 &&
    state.browseGroupColors === 2,
  JSON.stringify(state)
);
check(
  "多個收合群組以單一卡片連續排列且各顯示至少三張疊頁",
  state.collapsedGroupsInline && state.collapsedGroupDragMoved,
  JSON.stringify(state)
);
check(
  "群組核取方塊可累加選取多個群組",
  state.checkboxSupportsMultipleGroups,
  JSON.stringify(state)
);
check("群組標題列可拖曳整組排序", state.groupDragMoved, JSON.stringify(state));

state = await page.evaluate(() => {
  const app = window.__PDF_WORKSHOP_TEST__.app;
  app.selectedPageIds = new Set();
  app.updateUI();
  app.refreshSidebarSelection();
  const group = document.querySelector("#pageList .page-group");
  const checkbox = group.querySelector(".group-select-checkbox");
  const groupPageCount = group.querySelectorAll(".page-card").length;
  const initiallyUnchecked = !checkbox.checked && !checkbox.indeterminate;
  checkbox.click();
  const selectedAll =
    checkbox.checked && app.selectedPageIds.size === groupPageCount;
  checkbox.click();
  const clearedAll = !checkbox.checked && app.selectedPageIds.size === 0;
  app.selectedPageIds.add(app.pages[0].id);
  app.updateUI();
  app.refreshSidebarSelection();
  return {
    initiallyUnchecked,
    selectedAll,
    clearedAll,
    partial: checkbox.indeterminate && !checkbox.checked,
  };
});
check(
  "群組核取方塊支援全選、取消與半選狀態",
    state.initiallyUnchecked &&
    state.selectedAll &&
    state.clearedAll &&
    state.partial,
  JSON.stringify(state)
);

const dragBatch = await page.evaluate(() => {
  const app = window.__PDF_WORKSHOP_TEST__.app;
  const ids = app.pages.slice(1, 3).map((item) => item.id);
  app.selectedPageIds = new Set(ids);
  app.updateUI();
  app.refreshSidebarSelection();
  return { ids, targetId: app.pages.at(-1).id };
});
await page.evaluate(({ ids, targetId }) => {
  const source = document.querySelector(`.page-card[data-page-id="${ids[0]}"]`);
  const target = document.querySelector(`.page-card[data-page-id="${targetId}"]`);
  const dataTransfer = new DataTransfer();
  source.dispatchEvent(
    new DragEvent("dragstart", { bubbles: true, dataTransfer })
  );
  const rect = target.getBoundingClientRect();
  target.dispatchEvent(
    new DragEvent("dragover", {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.bottom - 2,
      dataTransfer,
    })
  );
  target.dispatchEvent(
    new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.bottom - 2,
      dataTransfer,
    })
  );
  source.dispatchEvent(
    new DragEvent("dragend", { bubbles: true, dataTransfer })
  );
  source.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}, dragBatch);
await page.waitForTimeout(500);
state = await page.evaluate(() => {
  const app = window.__PDF_WORKSHOP_TEST__.app;
  return {
    tail: app.pages.slice(-2).map((item) => item.id),
    selected: [...app.selectedPageIds],
    sameGroup:
      app.pages.at(-2).groupId &&
      app.pages.at(-2).groupId === app.pages.at(-1).groupId,
  };
});
check(
  "拖曳已勾選頁面會整批移動",
  state.tail.join("|") === dragBatch.ids.join("|") &&
    state.selected.join("|") === dragBatch.ids.join("|") &&
    state.sameGroup,
  JSON.stringify(state)
);

state = await page.evaluate(() => {
  const app = window.__PDF_WORKSHOP_TEST__.app;
  const selected = [app.pages[1].id, app.pages[3].id];
  app.selectedPageIds = new Set(selected);
  app.groupSelectedPages();
  const indices = selected.map((id) => app.pages.findIndex((item) => item.id === id));
  const groupIds = selected.map(
    (id) => app.pages.find((item) => item.id === id)?.groupId
  );
  return {
    selected,
    indices,
    sameGroup: groupIds[0] && groupIds[0] === groupIds[1],
    groupCount: document.querySelectorAll("#pageList .page-group").length,
  };
});
check(
  "非連續多頁可建立連續群組",
  state.sameGroup && state.indices[1] === state.indices[0] + 1,
  JSON.stringify(state)
);

state = await page.evaluate((selected) => {
  const app = window.__PDF_WORKSHOP_TEST__.app;
  const targetId = app.pages.at(-1).id;
  app.selectedPageIds = new Set(selected);
  app.reorderPages(selected, targetId, "after");
  return {
    tail: app.pages.slice(-2).map((item) => item.id),
    selected: [...app.selectedPageIds],
  };
}, state.selected);
check(
  "勾選多頁可一起移到新位置",
  state.tail.join("|") === state.selected.join("|") && state.selected.length === 2,
  JSON.stringify(state)
);

state = await page.evaluate(() => {
  const app = window.__PDF_WORKSHOP_TEST__.app;
  const customGroup = app.pages.find((item) => item.groupName)?.groupId;
  const groupPages = app.pages.filter((item) => item.groupId === customGroup);
  const movedId = groupPages[0].id;
  const targetId = app.pages.find((item) => item.groupId !== customGroup).id;
  app.reorderPages([movedId], targetId, "before");
  return {
    movedGroupId: app.pages.find((item) => item.id === movedId)?.groupId,
    leftoverGroupId: app.pages.find((item) => item.id === groupPages[1].id)?.groupId,
  };
});
check(
  "群組頁面可單獨拖出且單頁殘留自動解除",
  !state.movedGroupId && !state.leftoverGroupId,
  JSON.stringify(state)
);

state = await page.evaluate(() => {
  const app = window.__PDF_WORKSHOP_TEST__.app;
  const selected = app.pages.slice(-2).map((item) => item.id);
  app.selectedPageIds = new Set(selected);
  app.groupSelectedPages();
  const groupId = app.pages.find((item) => item.id === selected[0]).groupId;
  const before = app.getPageBlocks().findIndex((block) => block.id === groupId);
  app.movePageGroup(groupId, -1);
  const after = app.getPageBlocks().findIndex((block) => block.id === groupId);
  app.ungroupPages(groupId);
  return {
    before,
    after,
    ungrouped: selected.every(
      (id) => !app.pages.find((item) => item.id === id)?.groupId
    ),
    groupHeaderCount: document.querySelectorAll("#pageList .page-group").length,
  };
});
check(
  "群組可用按鈕移動並解除",
  state.after === state.before - 1 && state.ungrouped,
  JSON.stringify(state)
);

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
