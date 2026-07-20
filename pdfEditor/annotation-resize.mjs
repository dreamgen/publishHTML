const HANDLE_DIRECTIONS = Object.freeze({
  nw: { x: -1, y: -1 },
  ne: { x: 1, y: -1 },
  se: { x: 1, y: 1 },
  sw: { x: -1, y: 1 },
});

export function resizeRectFromHandle({
  bounds,
  handle,
  pointer,
  minWidth = 20,
  minHeight = 20,
  lockAspect = false,
}) {
  const direction = HANDLE_DIRECTIONS[handle];
  if (!direction) return { ...bounds };

  const anchorX = direction.x < 0 ? bounds.left + bounds.width : bounds.left;
  const anchorY = direction.y < 0 ? bounds.top + bounds.height : bounds.top;
  let width = Math.max(minWidth, (pointer.x - anchorX) * direction.x);
  let height = Math.max(minHeight, (pointer.y - anchorY) * direction.y);

  if (lockAspect && bounds.width > 0 && bounds.height > 0) {
    const scaleX = width / bounds.width;
    const scaleY = height / bounds.height;
    let scale =
      Math.abs(scaleX - 1) >= Math.abs(scaleY - 1) ? scaleX : scaleY;
    scale = Math.max(
      minWidth / bounds.width,
      minHeight / bounds.height,
      scale
    );
    width = bounds.width * scale;
    height = bounds.height * scale;
  }

  return {
    left: direction.x < 0 ? anchorX - width : anchorX,
    top: direction.y < 0 ? anchorY - height : anchorY,
    width,
    height,
  };
}

export function transformPointBetweenRects(point, fromBounds, toBounds) {
  const relativeX = fromBounds.width
    ? (point.x - fromBounds.left) / fromBounds.width
    : 0.5;
  const relativeY = fromBounds.height
    ? (point.y - fromBounds.top) / fromBounds.height
    : 0.5;
  return {
    x: toBounds.left + relativeX * toBounds.width,
    y: toBounds.top + relativeY * toBounds.height,
  };
}
