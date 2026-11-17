"""Room and peer management for point-to-point calls, with host admission.

A room is identified by an opaque ID that browsers derive from the call
secret (HKDF). The server never sees the secret or any key.

Admission ("knock to join"):
  * The first peer in an empty room is admitted at once and acts as host.
  * Later peers wait. A waiting peer may only send one kind of message, a
    `knock`, whose payload is encrypted with the call key. The server forwards it
    to the admitted members unread.
  * An admitted member answers with `admit` or `deny`. The decision is made in
    the host's browser, which can check the knock (it decrypts only for someone
    who really has the link) and recognise devices it has seen before.
  * If the last member leaves, the longest-waiting peer is promoted.

Only admitted members exchange signaling, so nobody can start a connection
without being let in. Capacity counts members and waiting peers together.
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
    async def close(self, code: int = 1000) -> None: ...


class RoomFull(Exception):
    pass


@dataclass
class Room:
    id: str
    created_at: float = field(default_factory=time.time)
    members: dict[str, Peer] = field(default_factory=dict)   # admitted, in join order
    waiting: dict[str, Peer] = field(default_factory=dict)   # knocking, in arrival order

    @property
    def size(self) -> int:
        return len(self.members) + len(self.waiting)


class RoomManager:
    def __init__(self, capacity: int = 2) -> None:
        self.capacity = capacity
        self._rooms: dict[str, Room] = {}
        self._lock = asyncio.Lock()
        self.total_calls = 0
        self.admitted = 0
        self.denied = 0

    @staticmethod
    def valid_id(room_id: str) -> bool:
        return bool(ROOM_ID_RE.match(room_id))

    def info(self, room_id: str) -> dict[str, Any]:
        room = self._rooms.get(room_id)
        n = room.size if room else 0
        return {
            "roomId": room_id,
            "participants": n,
            "capacity": self.capacity,
            "joinable": n < self.capacity,
        }

    def stats(self) -> dict[str, int]:
        return {
            "activeRooms": len(self._rooms),
            "connectedPeers": sum(len(r.members) for r in self._rooms.values()),
            "waitingPeers": sum(len(r.waiting) for r in self._rooms.values()),
            "callsStarted": self.total_calls,
        }

    def is_member(self, room_id: str, peer_id: str) -> bool:
        room = self._rooms.get(room_id)
        return bool(room and peer_id in room.members)

    async def join(self, room_id: str, peer: Peer) -> str:
        """Add a peer: admitted at once if the room is empty, else waiting.
        Returns its peer ID; raises RoomFull if there's no space."""
        async with self._lock:
            room = self._rooms.get(room_id)
            if room is None:
                room = self._rooms[room_id] = Room(room_id)
                self.total_calls += 1
            if room.size >= self.capacity:
                raise RoomFull(room_id)
            peer_id = secrets.token_urlsafe(9)
            if room.members:
                room.waiting[peer_id] = peer
                admitted = False
            else:
                room.members[peer_id] = peer
                admitted = True
        if admitted:
            await peer.send_json({"type": "joined", "peers": 1, "host": True})
        else:
            await peer.send_json({"type": "waiting"})
        return peer_id

    async def knock(self, room_id: str, peer_id: str, data: str) -> None:
        """Forward a waiting peer's encrypted knock to the members."""
        room = self._rooms.get(room_id)
        if not room or peer_id not in room.waiting:
            return
        for member in list(room.members.values()):
            await _safe_send(member, {"type": "knock", "id": peer_id, "data": data})

    async def decide(self, room_id: str, member_id: str, guest_id: str, admit: bool) -> None:
        """A member admits or denies a waiting peer."""
        async with self._lock:
            room = self._rooms.get(room_id)
            if not room or member_id not in room.members or guest_id not in room.waiting:
                return
            guest = room.waiting.pop(guest_id)
            if admit:
                room.members[guest_id] = guest
                self.admitted += 1
                members = [p for pid, p in room.members.items() if pid != guest_id]
                count = len(room.members)
            else:
                self.denied += 1
        if admit:
            await _safe_send(guest, {"type": "joined", "peers": count, "host": False})
            for m in members:
                await _safe_send(m, {"type": "peer-joined"})
        else:
            await _safe_send(guest, {"type": "denied"})
            try:
                await guest.close(code=4403)
            except Exception:
                pass

    async def leave(self, room_id: str, peer_id: str) -> None:
        promoted: Peer | None = None
        async with self._lock:
            room = self._rooms.get(room_id)
            if not room:
                return
            if peer_id in room.waiting:
                del room.waiting[peer_id]
                notify, msg = list(room.members.values()), {"type": "knock-cancelled", "id": peer_id}
            elif peer_id in room.members:
                del room.members[peer_id]
                notify, msg = list(room.members.values()), {"type": "peer-left"}
                if not room.members and room.waiting:
                    # Nobody left to answer: the longest-waiting peer becomes the host.
                    pid, promoted = next(iter(room.waiting.items()))
                    del room.waiting[pid]
                    room.members[pid] = promoted
            else:
                return
            if room.size == 0:
                del self._rooms[room_id]
        for other in notify:
            await _safe_send(other, msg)
        if promoted:
            await _safe_send(promoted, {"type": "joined", "peers": 1, "host": True})

    async def relay(self, room_id: str, sender_id: str, data: str) -> None:
        """Forward an encrypted signaling blob between admitted members only."""
        room = self._rooms.get(room_id)
        if not room or sender_id not in room.members:
            return
        for pid, peer in list(room.members.items()):
            if pid != sender_id:
                await _safe_send(peer, {"type": "signal", "data": data})


async def _safe_send(peer: Peer, data: Any) -> None:
    try:
        await peer.send_json(data)
    except Exception:  # peer disconnecting; its own handler will clean up
        pass
