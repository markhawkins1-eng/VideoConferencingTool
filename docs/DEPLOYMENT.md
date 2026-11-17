# Deploying VideoConf

The production stack in `deploy/` runs on one Linux server with Docker:

| Service | Image | Role |
|---|---|---|
| `app` | built from `Dockerfile` | Python service and web client. Not exposed directly. |
| `caddy` | `caddy:2.8.4` | HTTPS with automatic Let's Encrypt certificates; proxies HTTPS and WebSockets to `app` |
| `coturn` | `coturn/coturn:4.6.2` | STUN and TURN relay, with short-lived credentials issued by `app` |

Why TURN matters: without it, roughly 1 in 10 calls fail on corporate, hotel and mobile networks that block
direct peer-to-peer traffic. TURN only forwards DTLS-SRTP ciphertext, so it can't see or hear calls.

## 1. Server and DNS

- A Linux VM with a public IPv4 address and Docker with the Compose plugin. 1 vCPU and 1 GB RAM is plenty
  for the app. TURN bandwidth is the main cost: about 3 Mbit/s per relayed call, each way.
- A DNS `A` record such as `call.example.com` pointing at the server.

## 2. Firewall

| Port | Protocol | Used by |
|---|---|---|
| 80 | TCP | Caddy (Let's Encrypt challenge, redirect to HTTPS) |
| 443 | TCP + UDP | Caddy (HTTPS, HTTP/3) |
| 3478 | UDP + TCP | coturn (STUN/TURN) |
| 5349 | TCP | coturn (TURN over TLS, for networks that only allow TLS) |
| 49160–49200 | UDP | coturn relay ports (`min-port`/`max-port` in `deploy/coturn/turnserver.conf`) |

Port 8443 (the app) must **not** be open: only Caddy reaches it.

## 3. Configure and start

```bash
cd deploy
cp .env.example .env
openssl rand -hex 32          # paste into TURN_SECRET in .env
# set DOMAIN, PUBLIC_IP and the SMTP settings in .env
docker compose up -d --build
```

The first start takes a minute while Caddy obtains the certificate. coturn reads that certificate at
startup, so restart it once the certificate exists, and after each renewal (every ~60 days) for `turns:`
on port 5349:

```bash
docker compose restart coturn
```

A weekly cron job running that command is enough. Plain `turn:` on port 3478 works without it.

## 4. Check it

```bash
curl https://call.example.com/healthz
curl https://call.example.com/api/v1/ice-servers   # STUN + TURN with short-lived credentials
```

Then start a call between two different networks, for example laptop Wi-Fi and a phone on mobile data. For
an end-to-end TURN check, set `ICE_TRANSPORT_POLICY=relay` in `.env`, run `docker compose up -d`, and make a
call: it can then only connect through coturn.

## Email deliverability (SPF, DKIM, DMARC)

Invites sent from a domain without email authentication usually land in spam, or are rejected outright by
Gmail and Outlook. Send through a mail provider such as Postmark, Amazon SES, SendGrid, Mailgun or Google
Workspace, verify your sending domain there, and add the DNS records it gives you. They look like this for
`MAIL_FROM=Private Call <invites@example.com>`:

| Type | Name | Value (example; use your provider's) | Purpose |
|---|---|---|---|
| TXT | `example.com` | `v=spf1 include:amazonses.com ~all` | **SPF:** which servers may send as your domain. Use one SPF record per domain and merge `include:`s. |
| TXT or CNAME | `<selector>._domainkey.example.com` | provided by your mail service | **DKIM:** cryptographic signature on each message |
| TXT | `_dmarc.example.com` | `v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com; adkim=s; aspf=s` | **DMARC:** what receivers do when SPF or DKIM fail, plus reports. Start with `p=none` for a week, then tighten. |

Check with your provider's verification page, or send an invite to a Gmail address and choose *Show
original*: SPF, DKIM and DMARC should all say `PASS`.

## Monitoring

Set `METRICS_TOKEN` in `.env` to a random value (`openssl rand -hex 32`) to enable `/metrics` for Prometheus:

```yaml
scrape_configs:
  - job_name: videoconf
    scheme: https
    metrics_path: /metrics
    authorization: { credentials: <METRICS_TOKEN> }
    static_configs: [{ targets: ["call.example.com"] }]
```

Useful alerts: `videoconf_rejections_total{reason="ws_per_ip"}` or `{reason="ws_connect_rate"}` rising
(someone hammering the server), and `videoconf_invites_total{result="failed"}` above zero (SMTP problems).
`/healthz` is suitable for an uptime checker.

## Relay-only mode (hide IP addresses)

By default browsers connect directly when they can, which is fastest. With `ICE_TRANSPORT_POLICY=relay`,
all media goes through your TURN server, and **neither person learns the other's IP address**. The cost is
more TURN bandwidth and slightly higher latency.

## Security notes

- **TURN credentials** are generated per request by the app: `HMAC-SHA1(TURN_SECRET, "<expiry>:<random>")`,
  valid for `TURN_TTL` (default 6 hours). Browsers never see `TURN_SECRET`. A wrong secret is rejected, and
  this is covered by `tests/e2e/turn.spec.js`.
- **TURN can't reach your internal network:** `turnserver.conf` refuses to relay to private, loopback and
  link-local ranges (`denied-peer-ip`). Without that, a TURN server can be abused to reach internal
  services. It was tested to return `403 Forbidden IP` for `127.0.0.1`.
- **Abuse limits:** per-user and total TURN session quotas, and a ~3 Mbit/s per-session bandwidth cap.
- **App container:** runs as a non-root user with a read-only filesystem, all Linux capabilities dropped,
  and `no-new-privileges`.
- **TLS:** Caddy serves HTTPS with HSTS; coturn TLS is limited to TLS 1.2+ with AEAD ciphers.

## Updating

```bash
git pull
cd deploy && docker compose up -d --build
```

Calls in progress keep their media during an app restart (it's peer to peer). Browsers reconnect to the
signaling service automatically.

## Without Docker

Run the app with `python -m videoconf` behind any TLS reverse proxy that supports WebSockets, such as nginx,
with `PUBLIC_URL` and `TRUST_PROXY=1` set. Install coturn from your OS packages using
`deploy/coturn/turnserver.conf`, passing `static-auth-secret`, `realm`, `external-ip`, `cert` and `pkey` as
in `docker-compose.yml`.
