// Signaling, email-invite and static file server for VideoConf.
//
// This server never sees media, and never sees signaling content in the clear:
// clients encrypt every SDP/ICE message with a key derived from a secret that
// lives only in the URL fragment (#...), which browsers never send to servers.
// The server only learns an opaque room ID and relays ciphertext between the
// (at most two) peers in that room.
//
// Exception: if a user chooses "Send invite" (server-side email), the secret
// passes through this server once so it can be put into the email. The
// on-screen safety code still exposes any interception. "Use my email app"
// keeps the secret off the server entirely.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 8443;
const PUBLIC_DIR = path.join(__dirname, 'public');

// Optional TURN relay for peers behind symmetric NAT. TURN relays only
// DTLS-SRTP ciphertext, so it cannot see the media either.
const iceServers = [{ urls: process.env.STUN_URL || 'stun:stun.l.google.com:19302' }];
if (process.env.TURN_URL) {
  iceServers.push({
    urls: process.env.TURN_URL,
    username: process.env.TURN_USERNAME,
    credential: process.env.TURN_CREDENTIAL,
  });
}

// ---------- email invites ----------
//
// SMTP_HOST set      -> invites are sent through that SMTP server.
// MAIL_LOG=1 (dev)   -> invites are printed to the console instead of sent.
// neither            -> server-side sending is off; the page falls back to
//                       opening the user's own email app (mailto:).
let mailer = null;
if (process.env.SMTP_HOST || process.env.MAIL_LOG === '1') {
  const nodemailer = require('nodemailer');
  mailer = process.env.SMTP_HOST
    ? nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT) || 587,
        secure: Number(process.env.SMTP_PORT) === 465,
        requireTLS: Number(process.env.SMTP_PORT) !== 465,
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
      })
    : nodemailer.createTransport({ jsonTransport: true });
}
const MAIL_FROM = process.env.MAIL_FROM || 'Private Call <no-reply@localhost>';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const EMAIL_RE = /^[^\s@<>"',;]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/;
const SECRET_RE = /^[A-Za-z0-9_-]{22}$/;

// Simple per-IP limit so the endpoint can't be used as a spam relay.
const INVITES_PER_WINDOW = Number(process.env.INVITE_LIMIT) || 5;
const WINDOW_MS = 15 * 60 * 1000;
const inviteLog = new Map(); // ip -> [timestamps]
function allowInvite(ip) {
  const now = Date.now();
  const recent = (inviteLog.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= INVITES_PER_WINDOW) return false;
  recent.push(now);
  inviteLog.set(ip, recent);
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, ts] of inviteLog) if (ts.every((t) => now - t >= WINDOW_MS)) inviteLog.delete(ip);
}, WINDOW_MS).unref();

const escapeHtml = (s) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const clean = (s, max) => (typeof s === 'string' ? s.replace(/[\r\n\t]+/g, ' ').trim().slice(0, max) : '');

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...SECURITY_HEADERS });
  res.end(JSON.stringify(body));
}

function readJson(req, limit = 8 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

async function handleInvite(req, res) {
  if (!mailer) return json(res, 503, { error: 'Email sending is not configured on this server.' });
  // Same-origin JSON only (blocks cross-site form posts).
  if (!(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'Expected JSON' });
  const origin = req.headers.origin;
  if (origin && new URL(origin).host !== req.headers.host) return json(res, 403, { error: 'Bad origin' });

  const ip =
    process.env.TRUST_PROXY === '1'
      ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress
      : req.socket.remoteAddress;
  if (!allowInvite(ip)) return json(res, 429, { error: 'Too many invites. Try again in a few minutes.' });

  let body;
  try {
    body = await readJson(req);
  } catch {
    return json(res, 400, { error: 'Bad request' });
  }
  const to = clean(body.to, 254);
  const fromName = clean(body.fromName, 60);
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : '';
  if (!EMAIL_RE.test(to)) return json(res, 400, { error: 'That email address doesn’t look right.' });
  if (typeof body.secret !== 'string' || !SECRET_RE.test(body.secret)) return json(res, 400, { error: 'Bad call link' });

  // Build the link ourselves so the endpoint can't be used to mail arbitrary URLs.
  const base = PUBLIC_URL || `${server instanceof https.Server ? 'https' : 'http'}://${req.headers.host}`;
  const link = `${base}/#${body.secret}`;
  const who = fromName || 'Someone';

  const text =
    `${who} is inviting you to a private video call.\n\n` +
    (note ? `"${note}"\n\n` : '') +
    `Join here: ${link}\n\n` +
    `The call is end-to-end encrypted and peer to peer. When you connect, read the safety code ` +
    `on your screen to each other; if it matches, the call is private.\n\n` +
    `Only one person can join with this link. If you weren't expecting this, you can ignore it.`;
  const html =
    `<p>${escapeHtml(who)} is inviting you to a private video call.</p>` +
    (note ? `<blockquote style="margin:0 0 16px;padding-left:12px;border-left:3px solid #ccc">${escapeHtml(note)}</blockquote>` : '') +
    `<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 18px;background:#2457d6;color:#fff;border-radius:8px;text-decoration:none">Join the call</a></p>` +
    `<p style="color:#555;font-size:14px">Or paste this link into your browser:<br>${escapeHtml(link)}</p>` +
    `<p style="color:#555;font-size:14px">The call is end-to-end encrypted and peer to peer. When you connect, read the safety code on your screen to each other. If it matches, the call is private.</p>`;

  try {
    const info = await mailer.sendMail({
      from: MAIL_FROM,
      to,
      subject: `${who} invited you to a private video call`,
      text,
      html,
    });
    if (info.message) console.log('[MAIL_LOG] invite email:\n' + info.message);
    // Don't log addresses or links in production.
    json(res, 200, { ok: true });
  } catch (err) {
    console.error('Invite email failed:', err.message);
    json(res, 502, { error: 'Couldn’t send the email. Try “Use my email app” instead.' });
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.tflite': 'application/octet-stream',
};

// Background effects run entirely in the browser with MediaPipe. Its code and
// model are served from this origin (no third-party CDN), and only these exact
// files are exposed.
const TASKS_VISION = path.join(__dirname, 'node_modules', '@mediapipe', 'tasks-vision');
const VENDOR_FILES = {
  '/vendor/tasks-vision/vision_bundle.mjs': path.join(TASKS_VISION, 'vision_bundle.mjs'),
  '/models/selfie_segmenter.tflite': path.join(__dirname, 'models', 'selfie_segmenter.tflite'),
};
for (const f of ['vision_wasm_internal', 'vision_wasm_nosimd_internal', 'vision_wasm_module_internal']) {
  for (const ext of ['.js', '.wasm']) {
    VENDOR_FILES[`/vendor/tasks-vision/wasm/${f}${ext}`] = path.join(TASKS_VISION, 'wasm', f + ext);
  }
}

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; connect-src 'self' ws: wss:; media-src 'self' blob:; " +
    "img-src 'self' data: blob:; style-src 'self'; script-src 'self' 'wasm-unsafe-eval'; " +
    "worker-src 'self' blob:; child-src 'self' blob:; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Permissions-Policy': 'camera=(self), microphone=(self)',
};

function handleHttp(req, res) {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/config.json') {
    return json(res, 200, { iceServers, emailEnabled: !!mailer });
  }
  if (url.pathname === '/api/invite') {
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
    return handleInvite(req, res);
  }
  const vendor = VENDOR_FILES[url.pathname];
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = vendor || path.join(PUBLIC_DIR, path.normalize(rel));
  if (!vendor && !file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      ...(vendor ? { 'Cache-Control': 'public, max-age=86400' } : {}),
      ...SECURITY_HEADERS,
    });
    res.end(data);
  });
}

const server =
  process.env.TLS_CERT && process.env.TLS_KEY
    ? https.createServer(
        { cert: fs.readFileSync(process.env.TLS_CERT), key: fs.readFileSync(process.env.TLS_KEY) },
        handleHttp,
      )
    : http.createServer(handleHttp);

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
const rooms = new Map(); // roomId -> Set<ws>

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

wss.on('connection', (ws) => {
  let room = null;
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return ws.close(1003, 'bad json');
    }

    if (msg.type === 'join' && !room) {
      if (typeof msg.room !== 'string' || !/^[0-9a-f]{64}$/.test(msg.room)) {
        return ws.close(1008, 'bad room');
      }
      const peers = rooms.get(msg.room) || new Set();
      if (peers.size >= 2) {
        send(ws, { type: 'full' });
        return ws.close(1000, 'room full');
      }
      room = msg.room;
      peers.add(ws);
      rooms.set(room, peers);
      send(ws, { type: 'joined', peers: peers.size });
      for (const p of peers) if (p !== ws) send(p, { type: 'peer-joined' });
      return;
    }

    // Opaque encrypted blob: relay to the other peer verbatim.
    if (msg.type === 'signal' && room && typeof msg.data === 'string') {
      for (const p of rooms.get(room) || []) if (p !== ws) send(p, { type: 'signal', data: msg.data });
    }
  });

  ws.on('close', () => {
    if (!room) return;
    const peers = rooms.get(room);
    if (!peers) return;
    peers.delete(ws);
    for (const p of peers) send(p, { type: 'peer-left' });
    if (peers.size === 0) rooms.delete(room);
  });
});

// Drop dead connections so rooms free up.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) ws.terminate();
    else {
      ws.isAlive = false;
      ws.ping();
    }
  }
}, 30000).unref();

server.listen(PORT, () => {
  const scheme = server instanceof https.Server ? 'https' : 'http';
  console.log(`VideoConf listening on ${scheme}://localhost:${PORT}`);
});
