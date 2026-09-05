"""Short-lived identity-bound confirmations for mutating gateway commands."""

from __future__ import annotations

import hashlib
import secrets
import time
from dataclasses import dataclass
from typing import Any


@dataclass
class Confirmation:
    fingerprint: str
    user_id: str
    chat_id: str
    expires_at: float


class ConfirmationStore:
    """Issue and consume one-time nonces bound to command and sender identity."""

    def __init__(self, ttl_seconds: int = 300) -> None:
        self.ttl_seconds = max(30, min(int(ttl_seconds), 900))
        self._items: dict[str, Confirmation] = {}

    @staticmethod
    def fingerprint(command: str, arguments: list[str]) -> str:
        material = "\0".join([command, *arguments])
        return hashlib.sha256(material.encode("utf-8")).hexdigest()

    def issue(
        self,
        command: str,
        arguments: list[str],
        identity: Any,
        *,
        now: float | None = None,
    ) -> str:
        nonce = secrets.token_urlsafe(18)
        current = float(now if now is not None else time.time())
        self._items[nonce] = Confirmation(
            fingerprint=self.fingerprint(command, arguments),
            user_id=str(identity.user_id),
            chat_id=str(identity.chat_id),
            expires_at=current + self.ttl_seconds,
        )
        return nonce

    def consume(
        self,
        nonce: str,
        command: str,
        arguments: list[str],
        identity: Any,
        *,
        now: float | None = None,
    ) -> bool:
        current = float(now if now is not None else time.time())
        confirmation = self._items.pop(str(nonce), None)
        if confirmation is None or confirmation.expires_at < current:
            return False
        return bool(
            confirmation.fingerprint == self.fingerprint(command, arguments)
            and confirmation.user_id == str(identity.user_id)
            and confirmation.chat_id == str(identity.chat_id)
        )
