const assert = require('node:assert/strict');
const test = require('node:test');

test('ordinary pages retain requested resolution', async () => {
  const { getImageRenderScale } = await import('../image-export.mjs');
  for (const dpi of [72, 150, 300]) {
    assert.equal(getImageRenderScale(595, 842, dpi), dpi / 72);
  }
});

test('large and panoramic pages are bounded without changing aspect ratio', async () => {
  const { getImageRenderScale } = await import('../image-export.mjs');
  for (const [width, height] of [[10000, 10000], [100000, 100], [100, 100000]]) {
    const scale = getImageRenderScale(width, height, 300);
    assert.ok(Math.max(width, height) * scale <= 8192);
    assert.ok(width * height * scale * scale <= 12000001);
    assert.ok(scale > 0 && scale < 300 / 72);
  }
});

test('invalid page dimensions and resolution fail before canvas allocation', async () => {
  const { getImageRenderScale } = await import('../image-export.mjs');
  for (const input of [[0, 100, 72], [100, -1, 72], [Infinity, 100, 72], [100, 100, NaN]]) {
    assert.throws(() => getImageRenderScale(...input));
  }
});
