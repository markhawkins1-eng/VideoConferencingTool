"""VideoConf API server (FastAPI).

Responsibilities:
  * Connection management: rooms, admission (max 2 peers), signaling relay,
    ICE/TURN credentials, room status.
  * Invitations by email.
  * Serving the web client and its on-device effects assets.

Deliberately NOT responsibilities: generating, storing or seeing encryption
keys or media. Keys are created in each browser; the server relays only
ciphertext. See docs/ARCHITECTURE.md.
"""

from __future__ import annotations

import hmac
import json
import logging
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .config import Settings
from .ice import ice_servers
from .invites import EMAIL_RE, SECRET_RE, Mailer, build_invite, one_line
from .metrics import ConnectionCounter, Metrics
from .ratelimit import SlidingWindowLimiter
from .rooms import RoomFull, RoomManager

log = logging.getLogger("videoconf")

API = "/api/v1"

SECURITY_HEADERS = {
    "Content-Security-Policy": (
        "default-src 'self'; connect-src 'self' ws: wss:; media-src 'self' blob:; "
        "img-src 'self' data: blob:; style-src 'self'; script-src 'self' 'wasm-unsafe-eval'; "
        "worker-src 'self' blob:; child-src 'self' blob:; frame-ancestors 'none'"
    ),
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Permissions-Policy": "camera=(self), microphone=(self)",
}


class InviteIn(BaseModel):
    to: str = Field(max_length=254)
    fromName: str = Field(default="", max_length=200)
    note: str = Field(default="", max_length=2000)
    secret: str = Field(max_length=64)


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse({"error": message}, status_code=status)


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    app = FastAPI(
        title="VideoConf API",
        version="1.0.0",
        docs_url=None,
        redoc_url=None,
        openapi_url=f"{API}/openapi.json",
    )
    rooms = RoomManager(settings.room_capacity)
    mailer = Mailer(settings)
    invite_limiter = SlidingWindowLimiter(settings.invite_limit, settings.invite_window)
    ws_connect_limiter = SlidingWindowLimiter(settings.ws_connects_per_minute, 60)
    room_check_limiter = SlidingWindowLimiter(settings.room_checks_per_minute, 60)
    ws_open = ConnectionCounter(settings.ws_per_ip)
    metrics = Metrics()
    metrics.gauge("videoconf_active_rooms", "Rooms with at least one peer", lambda: rooms.stats()["activeRooms"])
    metrics.gauge("videoconf_connected_peers", "Admitted peers", lambda: rooms.stats()["connectedPeers"])
    metrics.gauge("videoconf_waiting_peers", "Peers waiting to be let in", lambda: rooms.stats()["waitingPeers"])
    metrics.gauge("videoconf_calls_started_total", "Rooms created since start", lambda: rooms.total_calls)
    metrics.gauge("videoconf_admissions_total", "Peers let in by a host", lambda: rooms.admitted)
    metrics.gauge("videoconf_denials_total", "Peers turned away by a host", lambda: rooms.denied)
    app.state.settings, app.state.rooms, app.state.mailer, app.state.metrics = settings, rooms, mailer, metrics

    def rejected(reason: str) -> None:
        metrics.inc("videoconf_rejections_total", "Requests refused, by reason", reason=reason)

    def client_ip(request: Request | WebSocket) -> str:
        if settings.trust_proxy:
            fwd = request.headers.get("x-forwarded-for", "").split(",")[0].strip()
            if fwd:
                return fwd
        return request.client.host if request.client else "unknown"

    def same_origin(request: Request | WebSocket) -> bool:
        origin = request.headers.get("origin")
        if not origin:
            return True  # non-browser client; browsers always send Origin here
        o = urlsplit(origin).netloc
        allowed = {request.headers.get("host", "")}
        if settings.public_url:
            allowed.add(urlsplit(settings.public_url).netloc)
        return o in allowed

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        response.headers.update(SECURITY_HEADERS)
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.exception_handler(RequestValidationError)
    async def bad_request(_request: Request, _exc: RequestValidationError):
        return _error(400, "Bad request")

    # ---------- service endpoints ----------

    @app.get("/healthz", tags=["ops"])
    async def health():
        return {"status": "ok", **rooms.stats()}

    @app.get("/metrics", include_in_schema=False)
    async def prometheus(request: Request):
        token = settings.metrics_token
        given = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
        if not token or not hmac.compare_digest(given.encode(), token.encode()):
            return _error(404, "Not found")
        return PlainTextResponse(metrics.render(), media_type="text/plain; version=0.0.4")

    @app.get(f"{API}/config", tags=["client"])
    async def config():
        """Static client configuration and feature flags."""
        return {
            "apiVersion": 1,
            "emailEnabled": mailer.enabled,
            "roomCapacity": settings.room_capacity,
        }

    @app.get(f"{API}/ice-servers", tags=["connections"])
    async def get_ice_servers():
        """STUN/TURN servers for RTCPeerConnection. TURN credentials are short-lived."""
        return ice_servers(settings)

    @app.get(f"{API}/rooms/{{room_id}}", tags=["connections"])
    async def room_status(room_id: str, request: Request):
        """Whether a call can be joined. Lets the page say 'full' before asking for the camera."""
        if not rooms.valid_id(room_id):
            return _error(400, "Bad room id")
        if not room_check_limiter.allow(client_ip(request)):
            rejected("room_check_rate")
            return _error(429, "Too many requests. Try again shortly.")
        return rooms.info(room_id)

    @app.post(f"{API}/invites", status_code=202, tags=["invites"])
    async def send_invite(invite: InviteIn, request: Request):
        if not mailer.enabled:
            return _error(503, "Email sending is not configured on this server.")
        if not request.headers.get("content-type", "").startswith("application/json"):
            return _error(415, "Expected JSON")
        if not same_origin(request):
            return _error(403, "Bad origin")
        if not invite_limiter.allow(client_ip(request)):
            rejected("invite_rate")
            return _error(429, "Too many invites. Try again in a few minutes.")
        to = one_line(invite.to, 254)
        if not EMAIL_RE.match(to):
            return _error(400, "That email address doesn’t look right.")
        if not SECRET_RE.match(invite.secret):
            return _error(400, "Bad call link")
        # Build the link here so this endpoint can't be used to email arbitrary URLs.
        base = settings.public_url or str(request.base_url).rstrip("/")
        msg = build_invite(
            settings,
            to=to,
            link=f"{base}/#{invite.secret}",
            from_name=one_line(invite.fromName, 60),
            note=invite.note.strip()[:500],
        )
        try:
            await mailer.send(msg)
        except Exception as exc:  # don't leak SMTP details to clients
            log.error("invite failed: %s", exc)
            metrics.inc("videoconf_invites_total", "Invite emails, by result", result="failed")
            return _error(502, "Couldn’t send the email. Try “Use my email app” instead.")
        metrics.inc("videoconf_invites_total", "Invite emails, by result", result="sent")
        return {"status": "sent"}

    # ---------- signaling ----------

    @app.websocket(f"{API}/rooms/{{room_id}}/ws")
    async def signaling(ws: WebSocket, room_id: str):
        """Join a room, wait to be let in if someone is already there, and relay
        end-to-end encrypted signaling messages.

        Server -> client: joined{peers,host} | waiting | knock{id,data} | knock-cancelled{id}
                          | denied | peer-joined | peer-left | signal{data} | full
        Client -> server: signal{data} (members) | knock{data} (waiting) | admit{id} | deny{id} (members)
        All `data` values are AES-GCM ciphertext made in the browser; never decrypted here.
        """
        if not rooms.valid_id(room_id) or not same_origin(ws):
            rejected("bad_request")
            await ws.close(code=1008)
            return
        ip = client_ip(ws)
        if not ws_connect_limiter.allow(ip):
            rejected("ws_connect_rate")
            await ws.close(code=1013)
            return
        if not ws_open.acquire(ip):
            rejected("ws_per_ip")
            await ws.close(code=1013)
            return
        peer_id = None
        try:
            await ws.accept()
            try:
                peer_id = await rooms.join(room_id, ws)
            except RoomFull:
                rejected("room_full")
                await ws.send_json({"type": "full"})
                await ws.close(code=4409)
                return
            log.info("join room=%s peer=%s", room_id[:8], peer_id)
            while True:
                raw = await ws.receive_text()
                if len(raw) > settings.max_signal_bytes:
                    await ws.close(code=1009)
                    break
                try:
                    msg = json.loads(raw)
                except ValueError:
                    await ws.close(code=1003)
                    break
                if not isinstance(msg, dict):
                    continue
                kind, data = msg.get("type"), msg.get("data")
                if kind == "signal" and isinstance(data, str):
                    await rooms.relay(room_id, peer_id, data)
                elif kind == "knock" and isinstance(data, str):
                    await rooms.knock(room_id, peer_id, data)
                elif kind in ("admit", "deny") and isinstance(msg.get("id"), str):
                    log.info("%s room=%s guest=%s", kind, room_id[:8], msg["id"])
                    await rooms.decide(room_id, peer_id, msg["id"], admit=kind == "admit")
        except (WebSocketDisconnect, RuntimeError):  # RuntimeError: we closed it (e.g. denied)
            pass
        finally:
            ws_open.release(ip)
            if peer_id:
                await rooms.leave(room_id, peer_id)

    # ---------- web client and effects assets ----------

    vendor_files: dict[str, Path] = {
        "/models/selfie_segmenter.tflite": settings.models_dir / "selfie_segmenter.tflite",
    }
    tv = settings.node_modules_dir / "@mediapipe" / "tasks-vision"
    vendor_files["/vendor/tasks-vision/vision_bundle.mjs"] = tv / "vision_bundle.mjs"
    for name in ("vision_wasm_internal", "vision_wasm_nosimd_internal", "vision_wasm_module_internal"):
        for ext in (".js", ".wasm"):
            vendor_files[f"/vendor/tasks-vision/wasm/{name}{ext}"] = tv / "wasm" / f"{name}{ext}"
    media_types = {".mjs": "text/javascript", ".js": "text/javascript", ".wasm": "application/wasm",
                   ".tflite": "application/octet-stream"}

    def vendor_route(path: Path):
        async def serve():
            if not path.is_file():
                return _error(404, "Asset missing; run `npm install` in the project root.")
            return FileResponse(path, media_type=media_types[path.suffix],
                                headers={"Cache-Control": "public, max-age=86400"})
        return serve

    for url, path in vendor_files.items():
        app.add_api_route(url, vendor_route(path), methods=["GET"], include_in_schema=False)

    app.mount("/", StaticFiles(directory=settings.public_dir, html=True), name="web")
    return app
