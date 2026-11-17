import base64
import email
import email.policy
import hashlib
import hmac
import time

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from videoconf.app import create_app
from videoconf.config import Settings
from videoconf.ice import turn_rest_credentials
from videoconf.ratelimit import SlidingWindowLimiter

ROOM = "a" * 64
SECRET = "A" * 22


def make_client(**overrides) -> TestClient:
    return TestClient(create_app(Settings(**overrides)))


@pytest.fixture
def client():
    return make_client(mail_log=True)


# ---------- config, health, headers ----------

def test_config_and_health(client):
    cfg = client.get("/api/v1/config").json()
    assert cfg == {"apiVersion": 1, "emailEnabled": True, "roomCapacity": 2}
    assert client.get("/healthz").json()["status"] == "ok"


def test_email_disabled_by_default():
    c = make_client()
    assert c.get("/api/v1/config").json()["emailEnabled"] is False
    r = c.post("/api/v1/invites", json={"to": "x@example.com", "secret": SECRET})
    assert r.status_code == 503


def test_security_headers_on_pages_and_api(client):
    for path in ("/", "/api/v1/config"):
        h = client.get(path).headers
        assert "wasm-unsafe-eval" in h["content-security-policy"]
        assert h["x-content-type-options"] == "nosniff"
    assert client.get("/api/v1/config").headers["cache-control"] == "no-store"


def test_static_and_vendor_files(client):
    assert "Private Call" in client.get("/").text
    assert client.get("/api.js").status_code == 200
    r = client.get("/models/selfie_segmenter.tflite")
    assert r.status_code == 200 and len(r.content) > 100_000
    r = client.get("/vendor/tasks-vision/wasm/vision_wasm_internal.wasm")
    assert r.status_code == 200 and r.headers["content-type"] == "application/wasm"


def test_no_path_traversal(client):
    assert client.get("/../server/videoconf/app.py").status_code == 404
    assert client.get("/vendor/tasks-vision/package.json").status_code == 404
    assert client.get("/%2e%2e/package.json").status_code == 404


# ---------- ICE / TURN ----------

def test_ice_servers_stun_only(client):
    body = client.get("/api/v1/ice-servers").json()
    assert body == {"iceServers": [{"urls": ["stun:stun.l.google.com:19302"]}], "ttl": None,
                    "iceTransportPolicy": "all"}


def test_stun_can_be_disabled(monkeypatch):
    monkeypatch.setenv("STUN_URLS", "none")
    assert Settings.from_env().stun_urls == []


def test_relay_only_policy():
    c = make_client(turn_urls=["turn:t.example.com:3478"], turn_secret="x", ice_transport_policy="relay")
    assert c.get("/api/v1/ice-servers").json()["iceTransportPolicy"] == "relay"
    with pytest.raises(ValueError):
        Settings(ice_transport_policy="relay")  # relay without TURN would never connect
    with pytest.raises(ValueError):
        Settings(ice_transport_policy="sometimes")


def test_turn_rest_credentials_verify_like_coturn():
    c = make_client(turn_urls=["turn:turn.example.com:3478"], turn_secret="s3cret", turn_ttl=600)
    body = c.get("/api/v1/ice-servers").json()
    turn = body["iceServers"][1]
    expiry, _ = turn["username"].split(":")
    assert 590 <= int(expiry) - time.time() <= 610
    expected = base64.b64encode(hmac.new(b"s3cret", turn["username"].encode(), hashlib.sha1).digest()).decode()
    assert turn["credential"] == expected
    assert body["ttl"] == 600
    assert "s3cret" not in str(body)


def test_turn_credentials_unique():
    a, _ = turn_rest_credentials("k", 60)
    b, _ = turn_rest_credentials("k", 60)
    assert a != b


# ---------- rooms and signaling ----------

def test_room_status(client):
    assert client.get(f"/api/v1/rooms/{ROOM}").json() == {
        "roomId": ROOM, "participants": 0, "capacity": 2, "joinable": True}
    assert client.get("/api/v1/rooms/not-a-room").status_code == 400


def test_two_peers_relay_and_third_is_refused(client):
    with client.websocket_connect(f"/api/v1/rooms/{ROOM}/ws") as a:
        assert a.receive_json() == {"type": "joined", "peers": 1}
        with client.websocket_connect(f"/api/v1/rooms/{ROOM}/ws") as b:
            assert b.receive_json() == {"type": "joined", "peers": 2}
            assert a.receive_json() == {"type": "peer-joined"}
            assert client.get(f"/api/v1/rooms/{ROOM}").json()["joinable"] is False

            a.send_json({"type": "signal", "data": "ciphertext-1"})
            assert b.receive_json() == {"type": "signal", "data": "ciphertext-1"}
            b.send_json({"type": "signal", "data": "ciphertext-2"})
            assert a.receive_json() == {"type": "signal", "data": "ciphertext-2"}

            with client.websocket_connect(f"/api/v1/rooms/{ROOM}/ws") as c:
                assert c.receive_json() == {"type": "full"}
                with pytest.raises(WebSocketDisconnect) as exc:
                    c.receive_json()
                assert exc.value.code == 4409
        assert a.receive_json() == {"type": "peer-left"}
    assert client.get("/healthz").json()["activeRooms"] == 0


def test_signal_not_echoed_and_junk_ignored(client):
    with client.websocket_connect(f"/api/v1/rooms/{ROOM}/ws") as a, \
         client.websocket_connect(f"/api/v1/rooms/{ROOM}/ws") as b:
        a.receive_json(); a.receive_json(); b.receive_json()
        a.send_json({"type": "join", "room": "x"})        # unknown type: ignored
        a.send_json({"type": "signal", "data": {"x": 1}})  # non-string data: ignored
        a.send_json({"type": "signal", "data": "ok"})
        assert b.receive_json() == {"type": "signal", "data": "ok"}


def test_ws_rejects_bad_room_and_foreign_origin(client):
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/api/v1/rooms/xyz/ws") as ws:
            ws.receive_json()
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(f"/api/v1/rooms/{ROOM}/ws", headers={"origin": "https://evil.example"}) as ws:
            ws.receive_json()
    with client.websocket_connect(f"/api/v1/rooms/{ROOM}/ws", headers={"origin": "http://testserver"}) as ws:
        assert ws.receive_json()["type"] == "joined"


# ---------- invites ----------

def test_invite_sent_with_server_built_link(client, capsys):
    r = client.post("/api/v1/invites", json={
        "to": "friend@example.com", "fromName": "Alex", "note": "Free <b>now</b>?", "secret": SECRET})
    assert r.status_code == 202 and r.json() == {"status": "sent"}
    raw = capsys.readouterr().out.split("\n", 1)[1]
    msg = email.message_from_string(raw, policy=email.policy.default)
    assert msg["To"] == "friend@example.com"
    assert msg["Subject"] == "Alex invited you to a private video call"
    text = msg.get_body(("plain",)).get_content()
    html = msg.get_body(("html",)).get_content()
    assert f"Join here: http://testserver/#{SECRET}" in text
    assert "&lt;b&gt;now&lt;/b&gt;" in html and "<b>now" not in html


def test_invite_uses_public_url():
    c = make_client(mail_log=True, public_url="https://call.example.com")
    assert c.post("/api/v1/invites", json={"to": "f@example.com", "secret": SECRET}).status_code == 202


@pytest.mark.parametrize("payload,status", [
    ({"to": "not-an-email", "secret": SECRET}, 400),
    ({"to": "a@example.com", "secret": "../../evil"}, 400),
    ({"to": "a@example.com\nBcc: x@example.com", "secret": SECRET}, 400),
    ({"secret": SECRET}, 400),
])
def test_invite_validation(client, payload, status):
    assert client.post("/api/v1/invites", json=payload).status_code == status


def test_invite_requires_json_and_same_origin(client):
    r = client.post("/api/v1/invites", content='{"to":"a@example.com","secret":"%s"}' % SECRET,
                    headers={"content-type": "text/plain"})
    assert r.status_code in (400, 415)
    r = client.post("/api/v1/invites", json={"to": "a@example.com", "secret": SECRET},
                    headers={"origin": "https://evil.example"})
    assert r.status_code == 403


def test_invite_rate_limit():
    c = make_client(mail_log=True, invite_limit=2)
    body = {"to": "a@example.com", "secret": SECRET}
    assert [c.post("/api/v1/invites", json=body).status_code for _ in range(3)] == [202, 202, 429]


def test_limiter_window():
    lim = SlidingWindowLimiter(1, 10)
    assert lim.allow("ip", now=0) and not lim.allow("ip", now=5) and lim.allow("ip", now=10)
