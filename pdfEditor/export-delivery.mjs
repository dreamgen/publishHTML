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
    (requestedMode === "share" || mobile || standalone)
  ) {
    return "file-share";
  }
  if (requestedMode === "share") return "share-unsupported";
  if (ios && standalone) return "ios-standalone-unsupported";
  if (mobile && standalone) return "standalone-unsupported";
  return "blob-download";
}
