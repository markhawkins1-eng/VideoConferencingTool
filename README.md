# VideoConf

One-to-one, end-to-end encrypted video calls in the browser, with email invites.

## Run

```bash
cd VideoConferencingTool
npm install
MAIL_LOG=1 npm start      # http://localhost:8443 — invite emails are printed to the console
```

Camera access needs HTTPS (or `localhost`). For real use, serve over TLS and configure SMTP:

```bash
TLS_CERT=cert.pem TLS_KEY=key.pem PORT=443 \
PUBLIC_URL=https://call.example.com \
SMTP_HOST=smtp.example.com SMTP_PORT=587 SMTP_USER=apikey SMTP_PASS=... \
MAIL_FROM="Private Call <invites@example.com>" \
npm start
```

## Using it

1. Enter the other person's email (plus your name and a short note if you like).
2. Click **Send invite**. The call starts, and they get an email with a **Join the call** button.
   Or click **Use my email app** to open a pre-filled draft in your own mail program.
3. When they join, read the safety code on screen to each other. If it matches, the call is private.

You can also invite someone after the call starts (**Invite someone** below the controls), or skip email with
**Start without inviting** and copy the link.

## How it's secured

| Layer | Protection |
|---|---|
| Media | WebRTC DTLS-SRTP, sent directly between the two browsers. |
| Signaling | Every SDP/ICE message is AES-256-GCM encrypted with a key derived (HKDF) from a 128-bit secret in the link's `#fragment`. Browsers never send the fragment, so the server sees only an opaque room ID and ciphertext. |
| Verification | A 12-digit safety code hashed from both DTLS certificate fingerprints. Matching codes mean nobody is intercepting. |
| Room | Two people at most. A third person is turned away. |

**Email trade-off:** with **Send invite**, the call link passes through this server once so it can be
emailed, and it also sits in both mailboxes. A compromised server or mailbox could try to join or intercept,
and the safety code is what catches that. **Use my email app** keeps the link off this server completely.

Invite endpoint hardening: same-origin JSON only, the server builds the link itself (only the secret is
accepted, so it can't be used to email arbitrary URLs), one recipient per request, HTML-escaped content,
and a per-IP limit (default 5 invites per 15 minutes).

## Config (env vars)

| Variable | Purpose |
|---|---|
| `PORT` | Default `8443` |
| `TLS_CERT`, `TLS_KEY` | PEM files for HTTPS |
| `PUBLIC_URL` | Base URL used in invite links. Set it in production; otherwise the request's `Host` header is used. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | Outgoing mail server. Port 465 uses implicit TLS; others require STARTTLS. |
| `MAIL_FROM` | Sender, e.g. `Private Call <invites@example.com>` |
| `MAIL_LOG=1` | Development: print invite emails to the console instead of sending them |
| `INVITE_LIMIT` | Invites per IP per 15 minutes (default 5) |
| `TRUST_PROXY=1` | Use `X-Forwarded-For` for rate limiting when behind a reverse proxy |
| `STUN_URL` | Default Google STUN |
| `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL` | Optional TURN relay for strict NATs. It relays only encrypted packets. |

If neither `SMTP_HOST` nor `MAIL_LOG` is set, **Send invite** is hidden and only **Use my email app** is offered.

## Limits

- Anyone who has the link can join while a spot is free. Check the safety code.
- The endpoints are trusted. Encryption doesn't help against malware on either device.
- Invite rate limits are kept in memory, so they reset when the server restarts.
