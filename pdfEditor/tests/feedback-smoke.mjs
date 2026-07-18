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
let submittedBody = "";

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
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(String(error)));
await page.route(
  "https://docs.google.com/forms/d/e/test-form/formResponse",
  async (route, request) => {
    submittedBody = request.postData() || "";
    await route.fulfill({ status: 204, body: "" });
  }
);

await page.goto(`${BASE}/?testHarness=1`, { waitUntil: "networkidle" });
await page.waitForFunction(() => window.__PDF_WORKSHOP_TEST__);
await page.evaluate(() => window.__PDF_WORKSHOP_TEST__.ready);
const serviceWorkerVersion = await page.evaluate(() =>
  window.__PDF_WORKSHOP_TEST__.app.refreshFeedbackServiceWorkerVersion()
);
check(
  "可讀取目前 Service Worker 版號",
  /^v\d+$/.test(serviceWorkerVersion),
  serviceWorkerVersion
);

await page.click("#feedbackButton");
let state = await page.evaluate(() => ({
  open: document.querySelector("#feedbackDialog").open,
  environment: document.querySelector("#feedbackEnvironment").value,
  configWarning: !document.querySelector("#feedbackConfigWarning").hidden,
  submitDisabled: document.querySelector("#feedbackSubmitButton").disabled,
  diagnosticsChecked: document.querySelector("#feedbackIncludeDiagnostics").checked,
}));
check("回報按鈕開啟站內彈窗", state.open);
check(
  "自動帶入版本、裝置、瀏覽器與 PWA 狀態",
  /PDF 工坊版本：/.test(state.environment) &&
    /Service Worker 版本：v\d+/.test(state.environment) &&
    /裝置：/.test(state.environment) &&
    /瀏覽器：/.test(state.environment) &&
    /PWA 狀態：/.test(state.environment)
);
check(
  "已設定 Google 表單時允許送出",
  !state.configWarning && !state.submitDisabled
);
check(
  "診斷紀錄預設不附加",
  !state.diagnosticsChecked
);
await page.click("#feedbackCancelButton");

state = await page.evaluate(() => {
  const app = window.__PDF_WORKSHOP_TEST__.app;
  app.feedbackInviteShownAt = 0;
  app.handleGlobalFeedbackError(new Error("Smoke unexpected error"), "smoke-test");
  return {
    visible: !document.querySelector("#errorReportInvite").hidden,
    message: document.querySelector("#errorReportInviteMessage").textContent,
  };
});
check(
  "全域錯誤會主動邀請回報",
  state.visible && state.message.includes("Smoke unexpected error")
);
await page.click("#errorReportInviteButton");
state = await page.evaluate(() => ({
  open: document.querySelector("#feedbackDialog").open,
  title: document.querySelector("#feedbackTitle").value,
  diagnosticsChecked: document.querySelector("#feedbackIncludeDiagnostics").checked,
  diagnostics: document.querySelector("#feedbackDiagnostics").value,
}));
check(
  "錯誤邀請會預填標題並勾選診斷",
  state.open &&
    state.title.includes("未預期錯誤") &&
    state.diagnosticsChecked &&
    state.diagnostics.includes("Smoke unexpected error") &&
    state.diagnostics.includes('"serviceWorkerVersion":"v')
);
await page.click("#feedbackCancelButton");

await page.evaluate(() => {
  const app = window.__PDF_WORKSHOP_TEST__.app;
  app.feedbackConfig = {
    enabled: true,
    formResponseUrl: "https://docs.google.com/forms/d/e/test-form/formResponse",
    entries: {
      category: "entry.1",
      title: "entry.2",
      description: "entry.3",
      contact: "entry.4",
      environment: "entry.5",
      diagnostics: "entry.6",
    },
  };
});
await page.click("#feedbackButton");
await page.fill("#feedbackTitle", "測試回報");
await page.fill("#feedbackDescription", "重現步驟與實際結果");
await page.fill("#feedbackContact", "qa@example.com");
await page.check("#feedbackIncludeDiagnostics");

await page.click("#feedbackSubmitButton");
await page.waitForFunction(() =>
  document.querySelector("#feedbackSubmitStatus").textContent.includes("已送出")
);
const fields = Object.fromEntries(new URLSearchParams(submittedBody));
check(
  "以 POST 直送 Google formResponse",
  fields["entry.1"] === "使用問題回報" &&
    fields["entry.2"] === "測試回報" &&
    fields["entry.3"] === "重現步驟與實際結果" &&
    fields["entry.4"] === "qa@example.com" &&
    fields.submit === "Submit"
);
check(
  "送出內容包含環境與選擇性診斷",
  fields["entry.5"]?.includes("PWA 狀態：") &&
    fields["entry.5"]?.includes("Service Worker 版本：v") &&
    fields["entry.6"]?.includes('"serviceWorkerVersion":"v') &&
    fields["entry.6"]?.includes('"pageCount":0')
);

await page.waitForTimeout(600);
check("測試期間沒有未預期 console error", consoleErrors.length === 0, consoleErrors.join(" | "));

console.log(results.join("\n"));
await browser.close();
if (failed) process.exit(1);
