"""ICE server list for browsers, including short-lived TURN credentials.

With TURN_SECRET set, credentials follow the TURN REST API scheme used by
coturn's `use-auth-secret`: username = "<expiry>:<random>", password =
base64(HMAC-SHA1(secret, username)). They expire on their own, so the
long-term TURN secret never reaches browsers. TURN only relays DTLS-SRTP
ciphertext; it can't see or hear the call.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import time
from typing import Any

from .config import Settings


def turn_rest_credentials(secret: str, ttl: int, now: float | None = None) -> tuple[str, str]:
    expiry = int((now if now is not None else time.time()) + ttl)
    username = f"{expiry}:{secrets.token_hex(8)}"
    digest = hmac.new(secret.encode(), username.encode(), hashlib.sha1).digest()
    return username, base64.b64encode(digest).decode()


def ice_servers(settings: Settings, now: float | None = None) -> dict[str, Any]:
    servers: list[dict[str, Any]] = []
    if settings.stun_urls:
        servers.append({"urls": settings.stun_urls})
    ttl = None
    if settings.turn_urls:
        if settings.turn_secret:
            username, credential = turn_rest_credentials(settings.turn_secret, settings.turn_ttl, now)
            ttl = settings.turn_ttl
            servers.append({"urls": settings.turn_urls, "username": username, "credential": credential})
        elif settings.turn_username:
            servers.append({
                "urls": settings.turn_urls,
                "username": settings.turn_username,
                "credential": settings.turn_credential or "",
            })
    return {"iceServers": servers, "ttl": ttl, "iceTransportPolicy": settings.ice_transport_policy}
