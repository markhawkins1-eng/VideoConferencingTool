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
  localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));

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
  $('local').srcObject = localStream;
  $('link').value = location.href;
  newPeerConnection();
  connect();
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
  btn.textContent = track.enabled ? onLabel : offLabel;
  btn.setAttribute('aria-pressed', String(!track.enabled));
}
$('mute').onclick = () => toggleTrack('audio', $('mute'), 'Mute', 'Unmute');
$('camera').onclick = () => toggleTrack('video', $('camera'), 'Camera off', 'Camera on');

$('hangup').onclick = () => {
  ws && ws.close();
  pc && pc.close();
  localStream && localStream.getTracks().forEach((t) => t.stop());
  clearInterval(statsTimer);
  history.replaceState(null, '', location.pathname);
  location.reload();
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
