"""Email invitations to join a call."""

from __future__ import annotations

import asyncio
import html
import logging
import re
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr, parseaddr

from .config import Settings

log = logging.getLogger("videoconf.invites")

EMAIL_RE = re.compile(r"^[^\s@<>\"',;]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$")
SECRET_RE = re.compile(r"^[A-Za-z0-9_-]{22}$")


def one_line(s: str, max_len: int) -> str:
    return re.sub(r"[\r\n\t]+", " ", s or "").strip()[:max_len]


def build_invite(settings: Settings, *, to: str, link: str, from_name: str, note: str) -> EmailMessage:
    who = from_name or "Someone"
    text = (
        f"{who} is inviting you to a private video call.\n\n"
        + (f'"{note}"\n\n' if note else "")
        + f"Join here: {link}\n\n"
        "The call is end-to-end encrypted and peer to peer. When you connect, read the safety code "
        "on your screen to each other; if it matches, the call is private.\n\n"
        "Only one person can join with this link. If you weren't expecting this, you can ignore it."
    )
    e = html.escape
    body_html = (
        f"<p>{e(who)} is inviting you to a private video call.</p>"
        + (f'<blockquote style="margin:0 0 16px;padding-left:12px;border-left:3px solid #ccc">{e(note)}</blockquote>' if note else "")
        + f'<p><a href="{e(link)}" style="display:inline-block;padding:10px 18px;background:#2457d6;color:#fff;'
        f'border-radius:8px;text-decoration:none">Join the call</a></p>'
        f'<p style="color:#555;font-size:14px">Or paste this link into your browser:<br>{e(link)}</p>'
        '<p style="color:#555;font-size:14px">The call is end-to-end encrypted and peer to peer. When you connect, '
        "read the safety code on your screen to each other. If it matches, the call is private.</p>"
    )
    msg = EmailMessage()
    name, addr = parseaddr(settings.mail_from)
    msg["From"] = formataddr((name, addr))
    msg["To"] = to
    msg["Subject"] = f"{who} invited you to a private video call"
    msg.set_content(text)
    msg.add_alternative(body_html, subtype="html")
    return msg


class Mailer:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    @property
    def enabled(self) -> bool:
        return self.settings.email_enabled

    async def send(self, msg: EmailMessage) -> None:
        if self.settings.smtp_host:
            await asyncio.to_thread(self._send_smtp, msg)
        elif self.settings.mail_log:
            print("[MAIL_LOG] invite email:\n" + msg.as_string(), flush=True)
        else:
            raise RuntimeError("email not configured")

    def _send_smtp(self, msg: EmailMessage) -> None:
        s = self.settings
        ctx = ssl.create_default_context()
        if s.smtp_port == 465:
            client: smtplib.SMTP = smtplib.SMTP_SSL(s.smtp_host, s.smtp_port, context=ctx, timeout=20)
        else:
            client = smtplib.SMTP(s.smtp_host, s.smtp_port, timeout=20)
        with client:
            if s.smtp_port != 465:
                client.starttls(context=ctx)  # refuse to send credentials or links in clear text
            if s.smtp_user:
                client.login(s.smtp_user, s.smtp_pass or "")
            client.send_message(msg)
