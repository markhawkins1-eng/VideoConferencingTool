"""Room and peer management for point-to-point calls.

A room is identified by an opaque ID that browsers derive from the call
secret (HKDF). The server never sees the secret or any key. It only admits
up to `capacity` peers per room and relays their already-encrypted signaling
messages to each other.
"""

from __future__ import annotations

import asyncio
import re
import secrets
import time
from dataclasses import dataclass, field
from typing import Any, Protocol

ROOM_ID_RE = re.compile(r"^[0-9a-f]{64}$")


class Peer(Protocol):
    async def send_json(self, data: Any) -> None: ...


class RoomFull(Exception):
    pass


@dataclass
class Room:
    id: str
    created_at: float = field(default_factory=time.time)
    peers: dict[str, Peer] = field(default_factory=dict)


class RoomManager:
    def __init__(self, capacity: int = 2) -> None:
        self.capacity = capacity
        self._rooms: dict[str, Room] = {}
        self._lock = asyncio.Lock()
        self.total_calls = 0

    @staticmethod
    def valid_id(room_id: str) -> bool:
        return bool(ROOM_ID_RE.match(room_id))

    def info(self, room_id: str) -> dict[str, Any]:
        room = self._rooms.get(room_id)
        n = len(room.peers) if room else 0
        return {
            "roomId": room_id,
            "participants": n,
            "capacity": self.capacity,
            "joinable": n < self.capacity,
        }

    def stats(self) -> dict[str, int]:
        return {
            "activeRooms": len(self._rooms),
            "connectedPeers": sum(len(r.peers) for r in self._rooms.values()),
            "callsStarted": self.total_calls,
        }

    async def join(self, room_id: str, peer: Peer) -> str:
        """Add a peer. Returns its peer ID; raises RoomFull if no space."""
        async with self._lock:
            room = self._rooms.get(room_id)
            if room is None:
                room = self._rooms[room_id] = Room(room_id)
                self.total_calls += 1
            if len(room.peers) >= self.capacity:
                if not room.peers:
                    del self._rooms[room_id]
                raise RoomFull(room_id)
            peer_id = secrets.token_urlsafe(9)
            others = list(room.peers.values())
            room.peers[peer_id] = peer
            count = len(room.peers)
        await peer.send_json({"type": "joined", "peers": count})
        for other in others:
            await _safe_send(other, {"type": "peer-joined"})
        return peer_id

    async def leave(self, room_id: str, peer_id: str) -> None:
        async with self._lock:
            room = self._rooms.get(room_id)
            if not room or peer_id not in room.peers:
                return
            del room.peers[peer_id]
            others = list(room.peers.values())
            if not room.peers:
                del self._rooms[room_id]
        for other in others:
            await _safe_send(other, {"type": "peer-left"})

    async def relay(self, room_id: str, sender_id: str, data: str) -> None:
        """Forward an encrypted signaling blob to the other peer(s), unread."""
        room = self._rooms.get(room_id)
        if not room:
            return
        for pid, peer in list(room.peers.items()):
            if pid != sender_id:
                await _safe_send(peer, {"type": "signal", "data": data})


async def _safe_send(peer: Peer, data: Any) -> None:
    try:
        await peer.send_json(data)
    except Exception:  # peer disconnecting; its own handler will clean up
        pass
