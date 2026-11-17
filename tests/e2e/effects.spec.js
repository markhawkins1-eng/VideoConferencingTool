// The fake camera shows a green test pattern with no person in it, so with a
// virtual background on, the other side should receive just the background.
const { test, expect, startCall, admit, connectedPair, sampleRemote } = require('./helpers');

async function pick(page, selector) {
  await page.click(selector);
  await expect(page.locator(selector)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#effects-msg')).not.toHaveText(/Loading/, { timeout: 30_000 });
}

// The peer's video lags the switch by a variable amount (encoder ramp-up, slow CI
// machines), so poll what the peer actually receives instead of sleeping.
const receives = (page, predicate, message) =>
  expect.poll(async () => predicate(await sampleRemote(page)), { message, timeout: 20_000, intervals: [250] }).toBe(true);

const close = (rgb, target, tol = 25) => rgb.every((v, i) => Math.abs(v - target[i]) <= tol);

test('backgrounds, blur, camera off and uploaded images reach the other person', async ({ server, newDevice }) => {
  const { a, b } = await connectedPair(newDevice, server);
  await receives(b, (f) => f.width > 0 && f.rgb[1] > 120, 'peer sees the green test pattern');
  const plain = await sampleRemote(b);

  await a.click('#effects-toggle');
  await expect(a.locator('#effects-grid .tile')).toHaveCount(8);

  await pick(a, '[data-preset="sunset"]');
  await receives(b, (f) => close(f.rgb, [131, 60, 88]), 'peer sees the sunset background');
  // Self-view shows the processed video too.
  expect(await a.evaluate(() => document.querySelector('#local').paused)).toBe(false);

  await pick(a, '[data-preset="office"]');
  await receives(b, (f) => close(f.rgb, [215, 217, 211]), 'peer sees the office background');

  await pick(a, '[data-effect="privacy"]');
  await receives(b, (f) => f.rgb[1] > 100 && f.sharp < plain.sharp * 0.6, 'peer sees a blurred picture');

  await a.click('#camera');
  await receives(b, (f) => f.rgb.every((v) => v === 0), 'peer sees black with the camera off');
  await a.click('#camera');

  const png = await a.evaluate(() => {
    const k = document.createElement('canvas');
    k.width = 320; k.height = 180;
    const x = k.getContext('2d');
    x.fillStyle = '#1040ff';
    x.fillRect(0, 0, 320, 180);
    return k.toDataURL().split(',')[1];
  });
  await a.setInputFiles('#effects-upload', { name: 'bg.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await expect(a.locator('[data-effect="image"]:not([data-preset])')).toHaveAttribute('aria-pressed', 'true');
  await receives(b, (f) => close(f.rgb, [16, 64, 255], 30), 'peer sees the uploaded image');

  await pick(a, '[data-effect="none"]');
  await receives(b, (f) => f.rgb[1] > 120 && f.sharp > plain.sharp * 0.6, 'peer sees the plain camera again');
});

for (const [name, init] of [
  ['canvas filter missing', () => Object.defineProperty(CanvasRenderingContext2D.prototype, 'filter', { get() {}, set() {}, configurable: true })],
  ['canvas filter ignored', () => Object.defineProperty(CanvasRenderingContext2D.prototype, 'filter', { get() { return 'none'; }, set() {}, configurable: true })],
]) {
  test(`Safari path (${name}): fallback blur still blurs`, async ({ server, newDevice }) => {
    const a = await newDevice({ init });
    const b = await newDevice();
    await b.goto(await startCall(a, server));
    await admit(a);
    await expect(b.locator('#status')).toHaveText(/^Connected/);
    await receives(b, (f) => f.width > 0 && f.rgb[1] > 120, 'peer sees the green test pattern');
    const plain = await sampleRemote(b);
    await a.click('#effects-toggle');
    await pick(a, '[data-effect="privacy"]');
    expect(await a.evaluate(() => effects.hasFilter)).toBe(false);
    await receives(b, (f) => f.rgb[1] > 100 && f.sharp < plain.sharp * 0.6, 'peer sees a blurred picture');
  });
}

test('Edge enhanced security (WebAssembly blocked): explains, privacy blur still works', async ({ server, browser }) => {
  const ctx = await browser.newContext({
    permissions: ['camera', 'microphone'],
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0',
  });
  const a = await ctx.newPage();
  await a.route('**/vendor/tasks-vision/wasm/**', (r) => r.abort());
  await startCall(a, server);
  await a.click('#effects-toggle');
  await a.click('[data-effect="blur"]');
  await expect(a.locator('#effects-msg')).toContainText('Enhanced security');
  await pick(a, '[data-effect="privacy"]');
  expect(await a.evaluate(() => sendStream.getVideoTracks()[0] === effects.outputTrack)).toBe(true);
  await ctx.close();
});

test('browsers that cannot send processed video get a disabled Effects button', async ({ server, newDevice }) => {
  const a = await newDevice({ init: () => delete HTMLCanvasElement.prototype.captureStream });
  await startCall(a, server);
  await expect(a.locator('#effects-toggle')).toBeDisabled();
  await expect(a.locator('#effects-toggle')).toHaveAttribute('title', /can’t send processed video/);
});
