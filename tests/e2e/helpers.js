// Shared fixtures for browser tests: a real Python server per test, and
// "devices" (separate browser contexts, so each has its own storage and
// therefore its own security identity, like two different computers).
const { test: base, expect } = require('@playwright/test');
const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const PYTHON = process.env.PYTHON || path.join(ROOT, '.venv', 'bin', 'python');

class PyServer {
  constructor(port, env = {}) {
    this.port = port;
    this.env = env;
    this.url = `http://localhost:${port}`;
    this.log = '';
    this.proc = null;
  }

  async start() {
    this.proc = spawn(PYTHON, ['-m', 'videoconf'], {
      cwd: path.join(ROOT, 'server'),
      env: { ...process.env, PORT: String(this.port), HOST: '127.0.0.1', MAIL_LOG: '1', ...this.env },
    });
    const onData = (d) => (this.log += d.toString());
    this.proc.stdout.on('data', onData);
    this.proc.stderr.on('data', onData);
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        if ((await fetch(this.url + '/healthz')).ok) return;
      } catch {}
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error('Python server did not start:\n' + this.log);
  }

  async stop() {
    if (!this.proc || this.proc.exitCode !== null) return;
    const exited = new Promise((r) => this.proc.once('exit', r));
    this.proc.kill('SIGTERM');
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    if (this.proc.exitCode === null) this.proc.kill('SIGKILL');
  }

  async health() {
    return (await fetch(this.url + '/healthz')).json();
  }

  /** The most recent invite link printed by MAIL_LOG. */
  lastInviteLink() {
    const links = [...this.log.matchAll(/https?:\/\/[^\s"<]+\/#[A-Za-z0-9_-]{22}/g)];
    return links.length ? links[links.length - 1][0] : null;
  }
}

const test = base.extend({
  serverEnv: [{}, { option: true }],
  server: async ({ serverEnv }, use, testInfo) => {
    const s = new PyServer(8600 + testInfo.parallelIndex * 10 + (testInfo.retry % 10), serverEnv);
    await s.start();
    await use(s);
    await s.stop();
  },
  // newDevice() -> a fresh browser context + page with camera/mic allowed.
  newDevice: async ({ browser }, use) => {
    const contexts = [];
    await use(async ({ init } = {}) => {
      const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] });
      contexts.push(ctx);
      if (init) await ctx.addInitScript(init);
      const page = await ctx.newPage();
      page.on('pageerror', (e) => console.log('pageerror:', e.message));
      return page;
    });
    for (const c of contexts) await c.close();
  },
});

async function startCall(page, server) {
  await page.goto(server.url + '/');
  await page.click('#create');
  await expect(page.locator('#call')).toBeVisible();
  return page.inputValue('#link');
}

async function waitConnected(...pages) {
  for (const p of pages) await expect(p.locator('#status')).toHaveText(/^Connected/);
}

/** The host lets in the person knocking (a device it hasn't seen on this link). */
async function admit(host) {
  await expect(host.locator('#knock')).toBeVisible();
  await host.click('#knock-admit');
  await expect(host.locator('#knock')).toBeHidden();
}

/** Two devices in a connected call. */
async function connectedPair(newDevice, server) {
  const a = await newDevice();
  const b = await newDevice();
  const link = await startCall(a, server);
  await b.goto(link);
  await admit(a);
  await waitConnected(a, b);
  return { a, b, link };
}

const safetyCode = (p) => p.locator('#sas').innerText();

/** Average colour and sharpness of the remote video as a page receives it. */
function sampleRemote(page) {
  return page.evaluate(() => {
    const v = document.querySelector('#remote');
    const k = document.createElement('canvas');
    k.width = 160; k.height = 90;
    const x = k.getContext('2d');
    x.drawImage(v, 0, 0, 160, 90);
    const d = x.getImageData(0, 0, 160, 90).data;
    let r = 0, g = 0, b = 0, sharp = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
    for (let y = 0; y < 90; y++) for (let i = 0; i < 159; i++) {
      const o = (y * 160 + i) * 4;
      sharp += Math.abs(d[o + 1] - d[o + 5]);
    }
    const n = d.length / 4;
    return { rgb: [r / n, g / n, b / n].map(Math.round), sharp: sharp / (90 * 159), width: v.videoWidth };
  });
}

module.exports = { test, expect, PyServer, startCall, admit, waitConnected, connectedPair, safetyCode, sampleRemote };
