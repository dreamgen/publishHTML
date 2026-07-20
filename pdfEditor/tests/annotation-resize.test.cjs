const assert = require("node:assert/strict");
const test = require("node:test");
const { pathToFileURL } = require("node:url");
const { resolve } = require("node:path");

const moduleUrl = pathToFileURL(
  resolve(__dirname, "../annotation-resize.mjs")
).href;

test("south-east handle grows a freeform rectangle", async () => {
  const { resizeRectFromHandle } = await import(moduleUrl);
  assert.deepEqual(
    resizeRectFromHandle({
      bounds: { left: 10, top: 20, width: 100, height: 50 },
      handle: "se",
      pointer: { x: 160, y: 100 },
    }),
    { left: 10, top: 20, width: 150, height: 80 }
  );
});

test("north-west handle keeps its opposite corner fixed", async () => {
  const { resizeRectFromHandle } = await import(moduleUrl);
  assert.deepEqual(
    resizeRectFromHandle({
      bounds: { left: 20, top: 30, width: 80, height: 60 },
      handle: "nw",
      pointer: { x: 5, y: 10 },
    }),
    { left: 5, top: 10, width: 95, height: 80 }
  );
});

test("image resize preserves its aspect ratio", async () => {
  const { resizeRectFromHandle } = await import(moduleUrl);
  const resized = resizeRectFromHandle({
    bounds: { left: 0, top: 0, width: 120, height: 60 },
    handle: "se",
    pointer: { x: 180, y: 70 },
    lockAspect: true,
  });
  assert.equal(resized.width / resized.height, 2);
  assert.deepEqual(resized, { left: 0, top: 0, width: 180, height: 90 });
});

test("points are mapped proportionally into the resized bounds", async () => {
  const { transformPointBetweenRects } = await import(moduleUrl);
  assert.deepEqual(
    transformPointBetweenRects(
      { x: 50, y: 25 },
      { left: 0, top: 0, width: 100, height: 50 },
      { left: 10, top: 20, width: 200, height: 100 }
    ),
    { x: 110, y: 70 }
  );
});
