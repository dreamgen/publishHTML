export function detectExportEnvironment({
  navigatorLike = globalThis.navigator,
  standalone = false,
} = {}) {
  const userAgent = String(navigatorLike?.userAgent || "");
  const platform = String(navigatorLike?.platform || "");
  const touchPoints = Number(navigatorLike?.maxTouchPoints || 0);
  const ios =
    /iPhone|iPad|iPod/i.test(userAgent) ||
    (platform === "MacIntel" && touchPoints > 1);
  const android = /Android/i.test(userAgent);
  const mobile =
    navigatorLike?.userAgentData?.mobile === true || ios || android;

  return {
    android,
    ios,
    mobile,
    standalone: Boolean(standalone),
  };
}

export function chooseExportDelivery({
  requestedMode = "download",
  hasFileHandle = false,
  canShareFile = false,
  environment = {},
} = {}) {
  const { ios = false, mobile = false, standalone = false } = environment;

  if (requestedMode === "download" && hasFileHandle) return "file-picker";
  if (
    canShareFile &&
    (requestedMode === "share" || mobile)
  ) {
    return "file-share";
  }
  if (requestedMode === "share") return "share-unsupported";
  if (ios && standalone) return "ios-standalone-unsupported";
  if (mobile && standalone) return "standalone-unsupported";
  return "blob-download";
}

// Safari/macOS 的 Web Share 在同時提供文字與檔案時，「拷貝」可能產生
// 兩個相同的檔案項目。PDF 分享只傳遞單一 File；檔名已足以作為標題。
export function buildPdfFileShareData(file) {
  return { files: [file] };
}
