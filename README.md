# VideoConf

One-to-one, end-to-end encrypted video calls in the browser, with email invites and on-device video effects.

- **Python service** (`server/`, FastAPI): manages connections, meaning rooms, admission, signaling relay,
  STUN/TURN credentials and email invites.
- **Web client** (`public/`): the UI, WebRTC media and all encryption. Keys never leave the browsers, so the
  server can't see or hear calls.

Design, call flow, encryption model and API reference: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

## Run

Requires Python 3.11+ and Node.js. Node only downloads the browser-side effects library; no Node server runs.

```bash
python3 -m venv .venv
.venv/bin/pip install -r server/requirements.txt
npm install
cd server && MAIL_LOG=1 ../.venv/bin/python -m videoconf   # http://localhost:8443, invites printed to console
```

Camera access needs HTTPS (or `localhost`). For real use, serve over TLS and configure SMTP and TURN:

```bash
cd server
TLS_CERT=cert.pem TLS_KEY=key.pem PORT=443 \
PUBLIC_URL=https://call.example.com \
SMTP_HOST=smtp.example.com SMTP_USER=apikey SMTP_PASS=... \
MAIL_FROM="Private Call <invites@example.com>" \
TURN_URLS=turn:turn.example.com:3478 TURN_SECRET=... \
../.venv/bin/python -m videoconf
```

### Tests

```bash
.venv/bin/pip install -r server/requirements-dev.txt
cd server && ../.venv/bin/python -m pytest
```

## Using it

1. Enter the other person's email (plus your name and a short note if you like).
2. Click **Send invite**. The call starts, and they get an email with a **Join the call** button.
   Or click **Use my email app** to open a pre-filled draft in your own mail program.
3. When they join, read the safety code on screen to each other. If it matches, the call is private.

You can also invite someone after the call starts (**Invite someone** below the controls), or skip email with
**Start without inviting** and copy the link.

## Video effects

Click **Effects** during a call:

- **Blur** / **Strong blur**: blurs everything behind you.
- **Privacy blur**: blurs the whole picture, you included. Useful when you want to be present without being seen clearly.
- **Virtual backgrounds**: Soft gradient, Sunset, Night sky or Office, drawn in the browser with no image downloads.
- **Upload image**: use your own photo as a background. It's resized and kept only in your browser,
  never uploaded. Remove it with the × on its tile.

Your choice is remembered for the next call. Turning the camera off sends black, not your background.

How it works: [MediaPipe](https://ai.google.dev/edge/mediapipe) selfie segmentation (`@mediapipe/tasks-vision`, pinned, plus
`models/selfie_segmenter.tflite`, both Apache-2.0) finds you in each frame. A canvas combines you with the
blurred or replacement background, and that canvas becomes the outgoing video track, swapped in with
`replaceTrack` without reconnecting. The library and model are served from this server, not a CDN, and
everything runs on the device. The model runs on the CPU at 256×144, roughly 10–30 ms per frame. On
slow devices frames are dropped rather than freezing the page.

### Browser support

| Browser | Effects |
|---|---|
| Chrome, Microsoft Edge (current versions) | Everything, with the browser's built-in blur. |
| Safari 16.4+ (macOS, iPhone, iPad) | Everything. Safari has no canvas blur filter, so a smooth multi-step scaling blur is used instead. |
| Firefox | Everything, with the built-in blur. |

Cross-browser details handled in `public/effects.js`:
- **Blur:** the code checks whether canvas filters actually work, not just whether they exist, because some
  Safari versions expose `ctx.filter` and ignore it. If they don't, it falls back to the scaling blur.
- **Hidden video:** the processing video and canvas stay attached to the page (invisible), with
  `playsinline` set, because Safari can stop decoding or capturing elements that aren't in the page. If iOS
  pauses the hidden video, it's resumed.
- **Rotation:** a change in camera resolution or orientation, such as rotating a phone or iPad, is picked up
  mid-call.
- **Edge enhanced security:** that mode can block WebAssembly. If background detection can't load, the
  page says so (with the Edge setting to change) and **Privacy blur** keeps working, since it doesn't need it.
- **No effects support:** browsers that can't send processed video get a disabled **Effects** button
  instead of an error. The legacy pre-Chromium Edge is not supported.

## How it's secured

| Layer | Who does it | Protection |
|---|---|---|
| Media | Browsers | WebRTC DTLS-SRTP, sent directly between the two browsers. TURN, if used, relays only ciphertext. |
| Signaling | Browsers encrypt; Python relays | AES-256-GCM with a key derived (HKDF) from a 128-bit secret in the link's `#fragment`. The server sees only an opaque room ID and ciphertext. |
| Verification | Users | A 12-digit safety code from both DTLS fingerprints. Matching codes mean no one is intercepting. |
| Admission | Python | Two people per call. Guests learn a call is full before being asked for their camera. |

**Email trade-off:** with **Send invite**, the call link passes through the server once so it can be emailed.
**Use my email app** keeps it off the server completely. Either way, compare the safety code.

More detail, including server hardening, is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Config (environment variables)

| Variable | Purpose |
|---|---|
| `HOST`, `PORT` | Listen address. Default `0.0.0.0:8443` |
| `TLS_CERT`, `TLS_KEY` | PEM files for HTTPS |
| `PUBLIC_URL` | Base URL for invite links and allowed WebSocket origin behind a proxy |
| `TRUST_PROXY=1` | Trust `X-Forwarded-*` headers for client IP and scheme |
| `STUN_URLS` | Comma-separated. Default Google STUN |
| `TURN_URLS` | Comma-separated TURN URLs, such as `turn:turn.example.com:3478,turns:turn.example.com:5349` |
| `TURN_SECRET` | coturn `static-auth-secret`, used to issue short-lived credentials (recommended) |
| `TURN_USERNAME`, `TURN_CREDENTIAL` | Fixed TURN credentials, used instead of `TURN_SECRET` |
| `TURN_TTL` | TURN credential lifetime in seconds. Default 6 hours |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | Outgoing mail. Port 465 uses implicit TLS; others require STARTTLS |
| `MAIL_FROM` | Sender, such as `Private Call <invites@example.com>` |
| `MAIL_LOG=1` | Development: print invites instead of sending them |
| `INVITE_LIMIT` | Invites per IP per 15 minutes. Default 5 |

If neither `SMTP_HOST` nor `MAIL_LOG` is set, **Send invite** is hidden and only **Use my email app** is offered.

## Limits

- Anyone who has the link can join while a spot is free. Check the safety code.
- The endpoints are trusted. Encryption doesn't help against malware on either device.
- Rooms and rate limits are kept in memory. Running more than one server instance needs sticky routing or a
  shared store (see the architecture doc).
