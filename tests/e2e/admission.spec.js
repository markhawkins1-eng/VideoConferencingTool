// "Knock to join": the person already in a call decides who else gets in.
const { test, expect, startCall, admit, waitConnected, connectedPair, safetyCode } = require('./helpers');

test('a newcomer waits, and the prompt shows the safety code they will get', async ({ server, newDevice }) => {
  const a = await newDevice();
  const b = await newDevice();
  await b.goto(await startCall(a, server));
  await expect(b.locator('#status')).toHaveText('Waiting to be let in…');
  await expect(a.locator('#status')).toHaveText('Someone wants to join');
  const promised = await a.locator('#knock-code').innerText();
  expect(promised).toMatch(/^\d{4} \d{4} \d{4}$/);

  // Nothing connects before the host decides.
  await b.waitForTimeout(1000);
  expect(await b.evaluate(() => document.querySelector('#remote').videoWidth)).toBe(0);
  expect((await server.health()).waitingPeers).toBe(1);

  await a.click('#knock-admit');
  await waitConnected(a, b);
  expect(await safetyCode(a)).toBe(promised);
  expect(await safetyCode(b)).toBe(promised);
});

test('denied newcomers are sent back to the start page and do not retry', async ({ server, newDevice }) => {
  const a = await newDevice();
  const b = await newDevice();
  await b.goto(await startCall(a, server));
  await expect(a.locator('#knock')).toBeVisible();
  await a.click('#knock-deny');
  await expect(b.locator('#lobby')).toBeVisible();
  await expect(b.locator('#lobby-msg')).toContainText('didn’t let you in');
  await expect(a.locator('#knock')).toBeHidden();
  await b.waitForTimeout(2500); // reconnect backoff would have fired by now
  const h = await server.health();
  expect([h.connectedPeers, h.waitingPeers]).toEqual([1, 0]);
});

test('the prompt disappears if the newcomer gives up', async ({ server, newDevice }) => {
  const a = await newDevice();
  const b = await newDevice();
  await b.goto(await startCall(a, server));
  await expect(a.locator('#knock')).toBeVisible();
  await b.context().close();
  await expect(a.locator('#knock')).toBeHidden();
  await expect(a.locator('#status')).toHaveText('Waiting for the other person…');
});

test('a verified device is let in without asking, even on a new link', async ({ server, newDevice }) => {
  const { a, b } = await connectedPair(newDevice, server);
  await a.click('#verify-yes');
  for (const p of [a, b]) {
    await p.click('#hangup');
    await expect(p.locator('#lobby')).toBeVisible();
    await p.waitForLoadState();
  }
  await b.goto(await startCall(a, server));
  await waitConnected(a, b);
  await expect(a.locator('#knock')).toBeHidden();
  await expect(a.locator('#verify-state')).toContainText('Verified');
});

test('a knock that was not encrypted with the call key is refused automatically', async ({ server, newDevice }) => {
  const a = await newDevice();
  const link = await startCall(a, server);
  const roomId = await a.evaluate(() => roomId);
  // A client that knows the room ID (e.g. a malicious server or a leaked ID) but not the secret.
  const ws = new WebSocket(`ws://localhost:${server.port}/api/v1/rooms/${roomId}/ws`);
  const got = [];
  ws.onmessage = (e) => got.push(JSON.parse(e.data).type);
  await new Promise((r) => (ws.onopen = r));
  await expect.poll(() => got).toContain('waiting');
  ws.send(JSON.stringify({ type: 'knock', data: 'bm90LWVuY3J5cHRlZA' }));
  await expect.poll(() => got).toContain('denied');
  await expect(a.locator('#knock')).toBeHidden();
  ws.close();
});
