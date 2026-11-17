const { test, expect, startCall, waitConnected, connectedPair, safetyCode } = require('./helpers');

test('safety code stays the same when the other person reloads and rejoins', async ({ server, newDevice }) => {
  const { a, b, link } = await connectedPair(newDevice, server);
  const code = await safetyCode(a);

  await b.reload();
  await waitConnected(a, b);
  expect(await safetyCode(a)).toBe(code);
  expect(await safetyCode(b)).toBe(code);

  // And on a brand-new call between the same two devices.
  for (const p of [a, b]) {
    await p.click('#hangup'); // reloads the page back to the lobby
    await expect(p.locator('#lobby')).toBeVisible();
    await p.waitForLoadState();
  }
  const link2 = await startCall(a, server);
  expect(link2).not.toBe(link);
  await b.goto(link2);
  await waitConnected(a, b);
  expect(await safetyCode(b)).toBe(code);
});

test('"Codes match" is remembered for the same two devices', async ({ server, newDevice }) => {
  const { a, b } = await connectedPair(newDevice, server);
  await expect(a.locator('#verify-state')).toContainText('Not verified yet');
  await expect(a.locator('#verify-actions')).toBeVisible();

  await a.click('#verify-yes');
  await expect(a.locator('#verify-state')).toContainText('Verified');
  await expect(a.locator('#verify-actions')).toBeHidden();
  // Verification is per device: B hasn't confirmed yet.
  await expect(b.locator('#verify-state')).toContainText('Not verified yet');

  await b.reload();
  await waitConnected(a, b);
  await expect(a.locator('#verify-state')).toContainText('Verified');
});

test('warns when the other device changes on the same link', async ({ server, newDevice }) => {
  const a = await newDevice();
  const b = await newDevice();
  const link = await startCall(a, server);
  await b.goto(link);
  await waitConnected(a, b);
  const first = await safetyCode(a);

  // B leaves; someone on a different device (or an interceptor) joins with the same link.
  await b.context().close();
  const c = await newDevice();
  await c.goto(link);
  await waitConnected(a, c);
  expect(await safetyCode(a)).not.toBe(first);
  await expect(a.locator('#verify-state')).toContainText('different from last time');
  await expect(a.locator('#security')).toHaveClass(/warn/);
});

test('"Codes don’t match" ends the call', async ({ server, newDevice }) => {
  const { a, b } = await connectedPair(newDevice, server);
  a.once('dialog', (d) => d.accept());
  await a.click('#verify-no');
  await expect(a.locator('#lobby')).toBeVisible();
  await expect(b.locator('#status')).toHaveText('The other person left. Waiting…');
});

test('private browsing (no IndexedDB): says so, and the code is still stable within the visit', async ({ server, newDevice }) => {
  const noStorage = () => {
    indexedDB.open = () => { throw new DOMException('blocked', 'SecurityError'); };
  };
  const a = await newDevice({ init: noStorage });
  const b = await newDevice();
  await b.goto(await startCall(a, server));
  await waitConnected(a, b);
  await expect(a.locator('#identity-note')).toBeVisible();
  await expect(b.locator('#identity-note')).toBeHidden();
  const code = await safetyCode(b);

  await b.reload(); // forces renegotiation; A keeps its per-visit certificate
  await waitConnected(a, b);
  expect(await safetyCode(b)).toBe(code);
});
