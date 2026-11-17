'use strict';
// Peer-to-peer encrypted video call.
//
// Security layers:
//  1. Media: WebRTC always encrypts media with DTLS-SRTP, peer to peer.
//  2. Signaling: every SDP/ICE message is AES-256-GCM encrypted with a key
//     derived (HKDF) from a 128-bit random secret in the URL fragment. The
//     signaling server can't read or forge offers/answers, so it can't swap in
//     its own DTLS fingerprints (no man-in-the-middle).
//  3. Safety code: a short code derived from both peers' DTLS certificate
//     fingerprints. Comparing it out loud also covers a leaked link.

const $ = (id) => document.getElementById(id);
const te = new TextEncoder();
const td = new TextDecoder();

const b64u = {
  enc: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)),
};
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

const myId = b64u.enc(crypto.getRandomValues(new Uint8Array(12)));
let key, roomId, ws, pc, localStream, config, pendingCandidates = [], statsTimer;
// sendStream holds what we transmit: mic audio + either the raw camera or the effects-processed video.
let sendStream, effects;

function setStatus(text, ok = false) {
  $('status').textContent = text;
  $('status').classList.toggle('ok', ok);
}

// ---------- crypto for signaling ----------

async function deriveKeys(secret) {
  const ikm = await crypto.subtle.importKey('raw', b64u.dec(secret), 'HKDF', false, ['deriveBits', 'deriveKey']);
  const params = (label) => ({ name: 'HKDF', hash: 'SHA-256', salt: te.encode('videoconf v1'), info: te.encode(label) });
  const roomBits = await crypto.subtle.deriveBits(params('room-id'), ikm, 256);
  const k = await crypto.subtle.deriveKey(params('signal-key'), ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { roomId: hex(roomBits), key: k };
}

async function seal(obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const pt = te.encode(JSON.stringify({ from: myId, ts: Date.now(), ...obj }));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, pt);
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv);
  out.set(new Uint8Array(ct), 12);
  return b64u.enc(out);
}

async function open(data) {
  const bytes = b64u.dec(data);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12));
  const msg = JSON.parse(td.decode(pt));
  if (msg.from === myId) throw new Error('reflected message'); // server echoing our own message back
  if (Math.abs(Date.now() - msg.ts) > 5 * 60 * 1000) throw new Error('stale message'); // limit replays
  return msg;
}

async function sendSignal(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'signal', data: await seal(obj) }));
}

// ---------- WebRTC ----------

function newPeerConnection() {
  if (pc) pc.close();
  clearInterval(statsTimer);
  pendingCandidates = [];
  $('security').hidden = true;
  $('remote').srcObject = null;

  pc = new RTCPeerConnection({ iceServers: config.iceServers });
  sendStream.getTracks().forEach((t) => pc.addTrack(t, sendStream));

  pc.onicecandidate = (e) => e.candidate && sendSignal({ candidate: e.candidate.toJSON() });
  pc.ontrack = (e) => ($('remote').srcObject = e.streams[0]);
  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (s === 'connected') {
      setStatus('Connected · encrypted', true);
      showSecurity();
    } else if (s === 'failed') {
      setStatus('Connection failed');
    } else if (s !== 'new') {
      setStatus(s[0].toUpperCase() + s.slice(1));
    }
  };
}

async function makeOffer() {
  newPeerConnection();
  await pc.setLocalDescription(await pc.createOffer());
  await sendSignal({ sdp: pc.localDescription.toJSON() });
}

async function onSignal(msg) {
  if (msg.sdp) {
    if (msg.sdp.type === 'offer') newPeerConnection();
    await pc.setRemoteDescription(msg.sdp);
    for (const c of pendingCandidates) await pc.addIceCandidate(c);
    pendingCandidates = [];
    if (msg.sdp.type === 'offer') {
      await pc.setLocalDescription(await pc.createAnswer());
      await sendSignal({ sdp: pc.localDescription.toJSON() });
    }
  } else if (msg.candidate) {
    if (pc && pc.remoteDescription) await pc.addIceCandidate(msg.candidate);
    else pendingCandidates.push(msg.candidate);
  }
}

// ---------- verification ----------

function fingerprint(sdp) {
  const m = sdp.match(/^a=fingerprint:(\S+ \S+)/m);
  return m ? m[1].toUpperCase() : '';
}

async function showSecurity() {
  const fps = [fingerprint(pc.localDescription.sdp), fingerprint(pc.remoteDescription.sdp)].sort();
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(fps.join('|'))));
  // 48 bits -> 12 decimal digits, shown as 3 groups of 4.
  const n = digest.slice(0, 6).reduce((acc, b) => acc * 256 + b, 0) % 1e12;
  $('sas').textContent = String(n).padStart(12, '0').replace(/(\d{4})(?=\d)/g, '$1 ');
  $('security').hidden = false;

  const update = async () => {
    const stats = await pc.getStats();
    stats.forEach((r) => {
      if (r.type === 'transport' && r.dtlsState === 'connected') {
        $('cipher').textContent = [r.tlsVersion && `DTLS ${{ FEFD: '1.2', FEFC: '1.3' }[r.tlsVersion] || r.tlsVersion}`, r.dtlsCipher, r.srtpCipher]
          .filter(Boolean).join(' · ');
      }
    });
  };
  update();
  statsTimer = setInterval(update, 5000);
}

// ---------- signaling connection ----------

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => ws.send(JSON.stringify({ type: 'join', room: roomId }));
  ws.onmessage = async (e) => {
    const msg = JSON.parse(e.data);
    try {
      if (msg.type === 'joined') {
        setStatus(msg.peers === 1 ? 'Waiting for the other person…' : 'Connecting…');
      } else if (msg.type === 'peer-joined') {
        setStatus('Connecting…');
        await makeOffer(); // the peer already in the room makes the offer
      } else if (msg.type === 'signal') {
        await onSignal(await open(msg.data));
      } else if (msg.type === 'peer-left') {
        setStatus('The other person left. Waiting…');
        newPeerConnection();
      } else if (msg.type === 'full') {
        setStatus('This call already has two people');
      }
    } catch (err) {
      console.warn('Ignored signaling message:', err);
    }
  };
  ws.onclose = () => {
    if (!$('call').hidden && $('status').textContent !== 'This call already has two people') setStatus('Signaling disconnected');
  };
}

// ---------- UI ----------

let secret = null;

async function startCall(s) {
  if (!window.isSecureContext) {
    setStatus('Needs HTTPS (or localhost)');
    return false;
  }
  secret = s;
  ({ roomId, key } = await deriveKeys(secret));
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (err) {
    setStatus('Camera/mic blocked');
    alert('Could not access camera or microphone: ' + err.message);
    return false;
  }
  $('lobby').hidden = true;
  $('call').hidden = false;
  $('call-invite-slot').append($('invite-form'));
  sendStream = new MediaStream(localStream.getTracks());
  effects = new VideoEffects(localStream.getVideoTracks()[0]);
  $('local').srcObject = new MediaStream(localStream.getVideoTracks());
  $('link').value = location.href;
  newPeerConnection();
  connect();
  buildEffectsPanel();
  restoreEffect();
  return true;
}

async function createCall() {
  const s = b64u.enc(crypto.getRandomValues(new Uint8Array(16)));
  history.replaceState(null, '', '#' + s);
  return startCall(s);
}

// ---------- email invites ----------

const EMAIL_RE = /^[^\s@<>"',;]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/;

function inviteMsg(text, kind = '') {
  $('invite-msg').textContent = text;
  $('invite-msg').className = 'hint ' + kind;
}

function readInvite() {
  const to = $('invite-to').value.trim();
  if (!EMAIL_RE.test(to)) {
    inviteMsg('Enter a valid email address.', 'error');
    $('invite-to').focus();
    return null;
  }
  return { to, fromName: $('invite-name').value.trim(), note: $('invite-note').value.trim() };
}

// Make sure a call exists before inviting (lobby case), then return its link.
async function ensureCall() {
  if (secret) return true;
  return createCall();
}

function afterInvite(to) {
  inviteMsg(`Invite sent to ${to}. Keep this tab open; they’ll appear when they join.`, 'ok');
  $('invite-to').value = '';
  $('invite-panel').open = true;
}

$('invite-form').onsubmit = async (e) => {
  e.preventDefault();
  const inv = readInvite();
  if (!inv) return;
  if (!config.emailEnabled) {
    inviteMsg('This server can’t send email. Use “Use my email app” instead.', 'error');
    return;
  }
  if (!(await ensureCall())) return;
  $('invite-send').disabled = true;
  inviteMsg('Sending…');
  try {
    const res = await fetch('/api/invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...inv, secret }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Failed (${res.status})`);
    afterInvite(inv.to);
  } catch (err) {
    inviteMsg(err.message, 'error');
  } finally {
    $('invite-send').disabled = false;
  }
};

// Opens the user's own mail client. The link never touches our server.
$('invite-mailto').onclick = async () => {
  const inv = readInvite();
  if (!inv) return;
  if (!(await ensureCall())) return;
  const who = inv.fromName || 'I';
  const subject = `${inv.fromName || 'Someone'} invited you to a private video call`;
  const body =
    `${who === 'I' ? 'I’d' : who + ' would'} like you to join a private video call.\n\n` +
    (inv.note ? `${inv.note}\n\n` : '') +
    `Join here: ${location.href}\n\n` +
    `It’s end-to-end encrypted and peer to peer. When we connect, we’ll read the safety code on our screens to each other.`;
  const a = document.createElement('a');
  a.href = `mailto:${encodeURIComponent(inv.to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  a.click();
  inviteMsg(`Opened your email app with an invite to ${inv.to}. Send it from there.`, 'ok');
  $('invite-panel').open = true;
};

$('create').onclick = createCall;

$('copy').onclick = async () => {
  await navigator.clipboard.writeText($('link').value);
  $('copy').textContent = 'Copied';
  setTimeout(() => ($('copy').textContent = 'Copy link'), 1500);
};

function toggleTrack(kind, btn, onLabel, offLabel) {
  const track = localStream.getTracks().find((t) => t.kind === kind);
  track.enabled = !track.enabled;
  // Also blank the processed video so a virtual background isn't sent with the camera off.
  if (kind === 'video' && effects && effects.outputTrack) effects.outputTrack.enabled = track.enabled;
  btn.textContent = track.enabled ? onLabel : offLabel;
  btn.setAttribute('aria-pressed', String(!track.enabled));
}
$('mute').onclick = () => toggleTrack('audio', $('mute'), 'Mute', 'Unmute');
$('camera').onclick = () => toggleTrack('video', $('camera'), 'Camera off', 'Camera on');

$('hangup').onclick = () => {
  ws && ws.close();
  pc && pc.close();
  localStream && localStream.getTracks().forEach((t) => t.stop());
  effects && effects.stop();
  clearInterval(statsTimer);
  history.replaceState(null, '', location.pathname);
  location.reload();
};

// ---------- video effects ----------

const store = {
  get(k) { try { return localStorage.getItem('videoconf.' + k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem('videoconf.' + k) : localStorage.setItem('videoconf.' + k, v); } catch {} },
};

let customBg = null;   // canvas holding the user's uploaded background (local only)
let effectSeq = 0;     // ignore results of superseded effect switches

function effectsMsg(text, kind = '') {
  $('effects-msg').textContent = text;
  $('effects-msg').className = 'hint ' + kind;
}

async function applyEffect(choice) {
  const seq = ++effectSeq;
  const effect = { type: choice.type };
  if (choice.type === 'image') {
    effect.image = choice.preset ? renderEffectPreset(choice.preset) : customBg;
    if (!effect.image) return;
  }
  markSelected(choice);
  effectsMsg(VideoEffects.needsSegmentation(effect.type) && !effects.segmenter ? 'Loading background effects…' : '');
  let track;
  try {
    track = await effects.setEffect(effect);
  } catch (err) {
    console.warn('Effect failed:', err);
    if (seq === effectSeq) {
      effectsMsg(
        'Background blur and backgrounds couldn’t start in this browser. Privacy blur still works. ' +
          (/Edg\//.test(navigator.userAgent)
            ? 'In Microsoft Edge, turning off “Enhanced security” for this site usually fixes this.'
            : 'Try updating your browser.'),
        'error',
      );
      markSelected({ type: 'none' });
    }
    return;
  }
  if (seq !== effectSeq) return;
  effectsMsg('');

  const camera = localStream.getVideoTracks()[0];
  track.enabled = camera.enabled;
  const old = sendStream.getVideoTracks()[0];
  if (old !== track) {
    sendStream.removeTrack(old);
    sendStream.addTrack(track);
    const sender = pc && pc.getSenders().find((s) => s.track && s.track.kind === 'video');
    if (sender) await sender.replaceTrack(track); // no renegotiation needed
    $('local').srcObject = new MediaStream([track]);
    $('local').play().catch(() => {}); // swapping srcObject can leave it paused
  }
  store.set('effect', JSON.stringify({ type: choice.type, preset: choice.preset }));
}

function markSelected(choice) {
  for (const b of document.querySelectorAll('#effects-grid [data-effect]')) {
    const on = b.dataset.effect === choice.type && (b.dataset.preset || '') === (choice.preset || '');
    b.setAttribute('aria-pressed', String(on));
  }
}

function tile({ label, type, preset, thumb, cls }) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'tile ' + (cls || '');
  b.dataset.effect = type;
  if (preset) b.dataset.preset = preset;
  b.setAttribute('aria-pressed', 'false');
  b.title = label;
  if (thumb) {
    const img = document.createElement('img');
    img.alt = '';
    img.src = thumb;
    b.append(img);
  }
  const span = document.createElement('span');
  span.textContent = label;
  b.append(span);
  b.onclick = () => applyEffect({ type, preset });
  return b;
}

function buildEffectsPanel() {
  const reason = VideoEffects.unsupportedReason();
  if (reason) {
    $('effects-toggle').disabled = true;
    $('effects-toggle').title = 'Effects unavailable: ' + reason;
    return;
  }
  const grid = $('effects-grid');
  if (grid.childElementCount) return;
  grid.append(
    tile({ label: 'None', type: 'none', cls: 'icon-none' }),
    tile({ label: 'Blur', type: 'blur', cls: 'icon-blur' }),
    tile({ label: 'Strong blur', type: 'blur-strong', cls: 'icon-blur-strong' }),
    tile({ label: 'Privacy blur', type: 'privacy', cls: 'icon-privacy' }),
    ...VideoEffects.presets().map((p) =>
      tile({ label: p.label, type: 'image', preset: p.id, thumb: VideoEffects.presetThumbnail(p.id).toDataURL() })),
  );
  const saved = store.get('custom-bg');
  if (saved) loadCustomBg(saved, false);
}

function addCustomTile(dataUrl) {
  const old = document.querySelector('#effects-grid [data-effect="image"]:not([data-preset])');
  if (old) old.remove();
  const t = tile({ label: 'Your image', type: 'image', thumb: dataUrl });
  const rm = document.createElement('span');
  rm.className = 'tile-remove';
  rm.textContent = '×';
  rm.title = 'Remove your image';
  rm.setAttribute('role', 'button');
  rm.onclick = (e) => {
    e.stopPropagation();
    customBg = null;
    store.set('custom-bg', null);
    if (t.getAttribute('aria-pressed') === 'true') applyEffect({ type: 'none' });
    t.remove();
  };
  t.append(rm);
  $('effects-grid').append(t);
}

function loadCustomBg(dataUrl, apply) {
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    c.getContext('2d').drawImage(img, 0, 0);
    customBg = c;
    addCustomTile(dataUrl);
    if (apply) applyEffect({ type: 'image' });
  };
  img.src = dataUrl;
}

// Uploaded images are resized in the browser and kept only on this device.
$('effects-upload').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (!file.type.startsWith('image/')) return effectsMsg('Please choose an image file.', 'error');
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1280 / bmp.width, 720 / bmp.height);
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const dataUrl = c.toDataURL('image/jpeg', 0.85);
    store.set('custom-bg', dataUrl);
    loadCustomBg(dataUrl, true);
  } catch {
    effectsMsg('Couldn’t read that image.', 'error');
  }
};

function restoreEffect() {
  if (VideoEffects.unsupportedReason()) return;
  let saved;
  try { saved = JSON.parse(store.get('effect') || 'null'); } catch {}
  if (!saved || saved.type === 'none') return markSelected({ type: 'none' });
  if (saved.type === 'image' && !saved.preset) {
    // Custom image loads asynchronously; apply once it's ready.
    const dataUrl = store.get('custom-bg');
    if (dataUrl) return loadCustomBg(dataUrl, true);
    return markSelected({ type: 'none' });
  }
  applyEffect(saved);
}

$('effects-toggle').onclick = () => {
  const panel = $('effects-panel');
  panel.hidden = !panel.hidden;
  $('effects-toggle').setAttribute('aria-expanded', String(!panel.hidden));
};

// ---------- boot ----------

(async () => {
  config = await (await fetch('/config.json')).json();
  if (!config.emailEnabled) {
    $('invite-send').hidden = true;
    $('invite-mailto').classList.add('primary');
  }
  const fromUrl = location.hash.slice(1);
  if (/^[A-Za-z0-9_-]{22}$/.test(fromUrl)) {
    startCall(fromUrl);
  } else {
    $('lobby-invite-slot').append($('invite-form'));
  }
})();
