// 頁面切換時的清理（取消訂閱、停止計時器）
let unmount = null;
export function setUnmount(fn) { unmount = fn; }
export function runUnmount() { if (unmount) { const f = unmount; unmount = null; f(); } }
