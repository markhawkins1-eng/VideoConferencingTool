'use strict';
// Stable device identity for the safety code.
//
// WebRTC normally creates a fresh DTLS certificate for every RTCPeerConnection,
// so the safety code (a hash of both certificate fingerprints) would change on
// every reconnect and people would learn to ignore it. Instead, each browser
// generates one ECDSA certificate, keeps it in IndexedDB (the private key is
// non-extractable, so it never leaves the browser's crypto layer), and reuses it.
// The same two devices then always see the same code, and verifying once is
// enough. A changed code is flagged as a warning.

const DeviceIdentity = (() => {
  const DB = 'videoconf';
  const STORE = 'identity';
  const CERT_KEY = 'dtls-certificate';
  const LIFETIME_MS = 300 * 24 * 3600 * 1000; // browsers cap certificate lifetime (~1 year)
  const RENEW_BEFORE_MS = 7 * 24 * 3600 * 1000;
  const MAX_VERIFIED = 500;

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function tx(db, mode, fn) {
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req.result);
      t.onerror = t.onabort = () => reject(t.error);
    });
  }

  async function load() {
    let db = null;
    try {
      db = await openDb();
      const saved = await tx(db, 'readonly', (s) => s.get(CERT_KEY));
      if (saved && saved.expires - Date.now() > RENEW_BEFORE_MS) return { certificate: saved, persistent: true };
    } catch {
      db = null; // private browsing or storage blocked: fall back to a per-visit certificate
    }
    const certificate = await RTCPeerConnection.generateCertificate({
      name: 'ECDSA',
      namedCurve: 'P-256',
      expires: LIFETIME_MS,
    });
    let persistent = false;
    if (db) {
      try {
        await tx(db, 'readwrite', (s) => s.put(certificate, CERT_KEY));
        persistent = true;
      } catch {}
    }
    return { certificate, persistent };
  }

  let loading = null;

  // ----- verification memory (fingerprints are public values; no secrets here) -----

  const ls = {
    get(k) { try { return localStorage.getItem('videoconf.' + k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem('videoconf.' + k, v); } catch {} },
  };

  function verifiedList() {
    try { return JSON.parse(ls.get('verified-codes') || '[]'); } catch { return []; }
  }

  return {
    /** Resolves to { certificate: RTCCertificate, persistent: boolean }. Loaded once per page. */
    get() {
      if (!loading) {
        loading = load().catch((err) => {
          console.warn('Could not create a device certificate; using per-connection ones.', err);
          return { certificate: null, persistent: false };
        });
      }
      return loading;
    },

    /** codeId: hex SHA-256 of both fingerprints (the full value behind the 12-digit code). */
    isVerified(codeId) {
      return verifiedList().includes(codeId);
    },

    markVerified(codeId) {
      const list = verifiedList().filter((c) => c !== codeId);
      list.push(codeId);
      ls.set('verified-codes', JSON.stringify(list.slice(-MAX_VERIFIED)));
    },

    /** The fingerprint of the last device connected on this call link, if any. */
    lastPeer(roomId) {
      return ls.get('peer.' + roomId.slice(0, 32));
    },

    /**
     * Record the peer's fingerprint for this call link. Returns the fingerprint
     * seen last time if it was different, else null.
     */
    notePeer(roomId, peerFingerprint) {
      const key = 'peer.' + roomId.slice(0, 32);
      const previous = ls.get(key);
      ls.set(key, peerFingerprint);
      return previous && previous !== peerFingerprint ? previous : null;
    },
  };
})();

window.DeviceIdentity = DeviceIdentity;
