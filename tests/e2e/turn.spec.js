// Runs a real coturn server and checks that, with ICE_TRANSPORT_POLICY=relay,
// calls connect only through TURN using the short-lived credentials the Python
// server issues, and that a wrong shared secret is rejected.
const { test: base, expect, startCall, waitConnected, safetyCode } = require('./helpers');
const { spawn, execFileSync } = require('child_process');

const SECRET = 'test-turn-secret-' + Math.random().toString(36).slice(2);

function hasCoturn() {
  try {
    execFileSync('turnserver', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const test = base.extend({
  turnPort: async ({}, use, testInfo) => use(34780 + testInfo.parallelIndex * 10),
  coturn: async ({ turnPort }, use) => {
    // Test-only settings: loopback peers are allowed because both browsers run on
    // this machine. Production config (deploy/coturn/turnserver.conf) blocks them.
    const proc = spawn('turnserver', [
      '-n', '--listening-ip=127.0.0.1', `--listening-port=${turnPort}`,
      `--min-port=${turnPort + 100}`, `--max-port=${turnPort + 199}`,
      '--use-auth-secret', `--static-auth-secret=${SECRET}`, '--realm=videoconf.test',
      '--fingerprint', '--no-cli', '--no-tls', '--no-dtls', '--allow-loopback-peers',
      '--no-multicast-peers', '--log-file=stdout', '--simple-log',
    ]);
    let log = '';
    proc.stdout.on('data', (d) => (log += d));
    proc.stderr.on('data', (d) => (log += d));
    await new Promise((r) => setTimeout(r, 800));
    if (proc.exitCode !== null) throw new Error('coturn failed to start:\n' + log);
    await use({ log: () => log });
    proc.kill('SIGTERM');
  },
});

test.skip(!hasCoturn(), 'coturn (turnserver) is not installed');

const relayEnv = (port, secret) => ({
  TURN_URLS: `turn:127.0.0.1:${port}?transport=udp,turn:127.0.0.1:${port}?transport=tcp`,
  TURN_SECRET: secret,
  TURN_TTL: '600',
  STUN_URLS: 'none',
  ICE_TRANSPORT_POLICY: 'relay',
});

async function selectedCandidateTypes(page) {
  return page.evaluate(async () => {
    const stats = await pc.getStats();
    let pair;
    stats.forEach((r) => {
      if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId);
    });
    if (!pair) stats.forEach((r) => { if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r; });
    return { local: stats.get(pair.localCandidateId).candidateType, remote: stats.get(pair.remoteCandidateId).candidateType };
  });
}

test.describe('relay-only through coturn', () => {

  test('media flows through TURN with server-issued credentials', async ({ server, coturn, turnPort, newDevice }) => {
    await server.stop();
    server.env = relayEnv(turnPort, SECRET);
    await server.start();

    const ice = await (await fetch(server.url + '/api/v1/ice-servers')).json();
    expect(ice.iceTransportPolicy).toBe('relay');
    expect(ice.iceServers).toHaveLength(1); // TURN only, no STUN
    expect(ice.iceServers[0].username).toMatch(/^\d+:[0-9a-f]+$/);
    expect(JSON.stringify(ice)).not.toContain(SECRET);

    const a = await newDevice();
    const b = await newDevice();
    await b.goto(await startCall(a, server));
    await waitConnected(a, b);
    expect(await safetyCode(a)).toBe(await safetyCode(b));
    expect(await selectedCandidateTypes(a)).toEqual({ local: 'relay', remote: 'relay' });
    expect(await selectedCandidateTypes(b)).toEqual({ local: 'relay', remote: 'relay' });
    // No host or server-reflexive candidates were offered: IP addresses stay private.
    const types = await a.evaluate(async () => {
      const s = new Set();
      (await pc.getStats()).forEach((r) => r.type === 'local-candidate' && s.add(r.candidateType));
      return [...s];
    });
    expect(types).toEqual(['relay']);
    await expect.poll(() => b.evaluate(() => document.querySelector('#remote').videoWidth)).toBeGreaterThan(0);
  });

  test('a wrong TURN secret means no connection (credentials are really checked)', async ({ server, coturn, turnPort, newDevice }) => {
    await server.stop();
    server.env = relayEnv(turnPort, 'wrong-secret');
    await server.start();

    const a = await newDevice();
    const b = await newDevice();
    await b.goto(await startCall(a, server));
    await expect(a.locator('#status')).toHaveText(/Connecting|Connection failed/);
    await a.waitForTimeout(6000);
    await expect(a.locator('#status')).not.toHaveText(/^Connected/);
    expect(coturn.log()).toMatch(/401|Unauthorized|check_stun_auth/i);
  });
});
