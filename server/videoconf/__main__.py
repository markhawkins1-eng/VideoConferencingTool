"""Run the server: python -m videoconf (from the server/ directory)."""

import uvicorn

from .app import create_app
from .config import Settings


def main() -> None:
    settings = Settings.from_env()
    scheme = "https" if settings.tls_cert else "http"
    print(f"VideoConf listening on {scheme}://localhost:{settings.port}", flush=True)
    uvicorn.run(
        create_app(settings),
        host=settings.host,
        port=settings.port,
        ssl_certfile=settings.tls_cert,
        ssl_keyfile=settings.tls_key,
        ws_max_size=settings.max_signal_bytes,
        ws_ping_interval=20,
        ws_ping_timeout=20,
        proxy_headers=settings.trust_proxy,
        forwarded_allow_ips="*" if settings.trust_proxy else None,
        log_level="info",
    )


if __name__ == "__main__":
    main()
