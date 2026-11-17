"""Settings, read once from environment variables."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


def _env(name: str, default: str | None = None) -> str | None:
    value = os.environ.get(name)
    return value if value not in (None, "") else default


def _list(name: str, default: str = "") -> list[str]:
    return [v.strip() for v in (_env(name, default) or "").split(",") if v.strip()]


@dataclass(frozen=True)
class Settings:
    host: str = "0.0.0.0"
    port: int = 8443
    tls_cert: str | None = None
    tls_key: str | None = None
    # Base URL used in invite links and for WebSocket origin checks behind a proxy.
    public_url: str = ""
    trust_proxy: bool = False

    room_capacity: int = 2
    max_signal_bytes: int = 64 * 1024

    # ICE: STUN for address discovery, TURN to relay when a direct path fails.
    stun_urls: list[str] = field(default_factory=lambda: ["stun:stun.l.google.com:19302"])
    turn_urls: list[str] = field(default_factory=list)
    turn_secret: str | None = None      # coturn "use-auth-secret": short-lived credentials
    turn_username: str | None = None    # or fixed credentials
    turn_credential: str | None = None
    turn_ttl: int = 6 * 3600
    # "relay": browsers send media only through TURN, so neither side learns the
    # other's IP address. Needs a TURN server. "all" (default) prefers direct paths.
    ice_transport_policy: str = "all"

    smtp_host: str | None = None
    smtp_port: int = 587
    smtp_user: str | None = None
    smtp_pass: str | None = None
    mail_from: str = "Private Call <no-reply@localhost>"
    mail_log: bool = False              # development: print invites instead of sending

    invite_limit: int = 5
    invite_window: int = 15 * 60

    # Abuse protection (per client IP).
    ws_per_ip: int = 20                 # concurrent signaling connections
    ws_connects_per_minute: int = 60
    room_checks_per_minute: int = 120

    # Prometheus metrics at /metrics, only when a token is set (Authorization: Bearer <token>).
    metrics_token: str | None = None

    public_dir: Path = REPO_ROOT / "public"
    models_dir: Path = REPO_ROOT / "models"
    node_modules_dir: Path = REPO_ROOT / "node_modules"

    def __post_init__(self) -> None:
        if self.ice_transport_policy not in ("all", "relay"):
            raise ValueError("ICE_TRANSPORT_POLICY must be 'all' or 'relay'")
        if self.ice_transport_policy == "relay" and not self.turn_urls:
            raise ValueError("ICE_TRANSPORT_POLICY=relay needs TURN_URLS (and TURN_SECRET or TURN_USERNAME)")

    @property
    def email_enabled(self) -> bool:
        return bool(self.smtp_host) or self.mail_log

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            host=_env("HOST", "0.0.0.0"),
            port=int(_env("PORT", "8443")),
            tls_cert=_env("TLS_CERT"),
            tls_key=_env("TLS_KEY"),
            public_url=(_env("PUBLIC_URL", "") or "").rstrip("/"),
            trust_proxy=_env("TRUST_PROXY") == "1",
            # STUN_URLS=none disables STUN (e.g. relay-only deployments).
            stun_urls=[] if _env("STUN_URLS") == "none"
            else _list("STUN_URLS", _env("STUN_URL", "stun:stun.l.google.com:19302")),
            turn_urls=_list("TURN_URLS", _env("TURN_URL", "")),
            turn_secret=_env("TURN_SECRET"),
            turn_username=_env("TURN_USERNAME"),
            turn_credential=_env("TURN_CREDENTIAL"),
            turn_ttl=int(_env("TURN_TTL", str(6 * 3600))),
            ice_transport_policy=_env("ICE_TRANSPORT_POLICY", "all"),
            smtp_host=_env("SMTP_HOST"),
            smtp_port=int(_env("SMTP_PORT", "587")),
            smtp_user=_env("SMTP_USER"),
            smtp_pass=_env("SMTP_PASS"),
            mail_from=_env("MAIL_FROM", "Private Call <no-reply@localhost>"),
            mail_log=_env("MAIL_LOG") == "1",
            invite_limit=int(_env("INVITE_LIMIT", "5")),
            ws_per_ip=int(_env("WS_PER_IP", "20")),
            ws_connects_per_minute=int(_env("WS_CONNECTS_PER_MINUTE", "60")),
            room_checks_per_minute=int(_env("ROOM_CHECKS_PER_MINUTE", "120")),
            metrics_token=_env("METRICS_TOKEN"),
        )
