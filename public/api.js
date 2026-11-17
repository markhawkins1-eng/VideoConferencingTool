'use strict';
// Client for the VideoConf Python service (server/videoconf). Every call the
// page makes to the server goes through here. See docs/ARCHITECTURE.md for the API.
//
// Note what is never sent: the call secret (except in an emailed invite the
// user explicitly asks the server to send), encryption keys, and media.

const VideoConfApi = (() => {
  const BASE = '/api/v1';

  class ApiError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status; // 0 = server unreachable
    }
  }

  async function request(path, { method = 'GET', body } = {}) {
    let res;
    try {
      res = await fetch(BASE + path, {
        method,
        cache: 'no-store',
        headers: body ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ApiError('Can’t reach the call server.', 0);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, res.status);
    return data;
  }

  return {
    ApiError,
    /** { apiVersion, emailEnabled, roomCapacity } */
    getConfig: () => request('/config'),
    /** { iceServers: RTCIceServer[], ttl: seconds|null }. TURN credentials are short-lived. */
    getIceServers: () => request('/ice-servers'),
    /** { roomId, participants, capacity, joinable } */
    getRoom: (roomId) => request(`/rooms/${roomId}`),
    /** invite: { to, fromName, note, secret } */
    sendInvite: (invite) => request('/invites', { method: 'POST', body: invite }),
    /** WebSocket that relays end-to-end encrypted signaling for one room. */
    openSignaling(roomId) {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      return new WebSocket(`${proto}://${location.host}${BASE}/rooms/${roomId}/ws`);
    },
  };
})();

window.VideoConfApi = VideoConfApi;
