const { test, expect, startCall, waitConnected, safetyCode } = require('./helpers');

test('email invite: link joins an encrypted call with matching safety codes', async ({ server, newDevice }) => {
  const a = await newDevice();
  await a.goto(server.url + '/');
  await a.fill('#invite-to', 'friend@example.com');
  await a.fill('#invite-name', 'Alex');
  await a.fill('#invite-note', 'Free <b>now</b>?');
  await a.click('#invite-send');
  await expect(a.locator('#invite-msg')).toContainText('Invite sent to friend@example.com');

  await expect.poll(() => server.lastInviteLink()).toBe(a.url());
  expect(server.log).toContain('Subject: Alex invited you to a private video call');

  const b = await newDevice();
  await b.goto(server.lastInviteLink());
  await waitConnected(a, b);
  expect(await safetyCode(a)).toMatch(/^\d{4} \d{4} \d{4}$/);
  expect(await safetyCode(a)).toBe(await safetyCode(b));
  await expect(a.locator('#cipher')).toContainText(/DTLS 1\.[23]/);
  await expect(a.locator('#cipher')).toContainText('SRTP');
  await expect.poll(() => b.evaluate(() => document.querySelector('#remote').videoWidth)).toBeGreaterThan(0);
});

test('invite form validates the address', async ({ server, newDevice }) => {
  const a = await newDevice();
  await a.goto(server.url + '/');
  await a.fill('#invite-to', 'not-an-email');
  await a.click('#invite-send');
  await expect(a.locator('#invite-msg')).toHaveText('Enter a valid email address.');
  await expect(a.locator('#call')).toBeHidden();
});

test('a third person is told the call is full without a camera prompt', async ({ server, newDevice }) => {
  const a = await newDevice();
  const b = await newDevice();
  const link = await startCall(a, server);
  await b.goto(link);
  await waitConnected(a, b);

  const c = await newDevice({
    init: () => {
      const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = (...args) => ((window.__cameraRequested = true), orig(...args));
    },
  });
  await c.goto(link);
  await expect(c.locator('#status')).toHaveText('This call already has two people');
  await expect(c.locator('#lobby-msg')).toContainText('Ask the person who invited you for a new link');
  expect(await c.evaluate(() => !!window.__cameraRequested)).toBe(false);
});

test('call survives a server restart and signaling reconnects', async ({ server, newDevice }) => {
  const a = await newDevice();
  const b = await newDevice();
  await b.goto(await startCall(a, server));
  await waitConnected(a, b);
  const code = await safetyCode(a);

  await server.stop();
  const t1 = await b.evaluate(() => document.querySelector('#remote').currentTime);
  await b.waitForTimeout(2000);
  const t2 = await b.evaluate(() => document.querySelector('#remote').currentTime);
  expect(t2).toBeGreaterThan(t1); // media is peer to peer: still flowing with the server down
  expect(await a.evaluate(() => pc.connectionState)).toBe('connected');

  await server.start();
  await expect.poll(async () => (await server.health()).connectedPeers, { timeout: 30_000 }).toBe(2);
  await waitConnected(a, b);
  expect(await safetyCode(a)).toBe(code); // stable device identity: same code after renegotiation
});

test('shows a clear message when the server is unreachable', async ({ server, newDevice }) => {
  const a = await newDevice();
  await a.route('**/api/v1/**', (r) => r.abort());
  await a.goto(server.url + '/');
  await expect(a.locator('#status')).toHaveText('Server unavailable');
  await expect(a.locator('#lobby-msg')).toContainText('Can’t reach the call server');
  await expect(a.locator('#create')).toBeDisabled();
});
