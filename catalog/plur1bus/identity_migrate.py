"""Translate OpenClaw identity files into Hermes prompt semantics."""

from __future__ import annotations

from pathlib import Path
from typing import Any


IDENTITY_BLOCK_START = "<!-- PLUR1BUS-HERMES-IDENTITY:BEGIN -->"
IDENTITY_BLOCK_END = "<!-- PLUR1BUS-HERMES-IDENTITY:END -->"
HERMES_BLOCKED_INVISIBLE = dict.fromkeys(
    map(
        ord,
        "\u200b\u200c\u200d\u2060\ufeff"
        "\u202a\u202b\u202c\u202d\u202e"
        "\u2066\u2067\u2068\u2069",
    )
)
HERMES_CONTEXT_FILES = ("SOUL.md", "AGENTS.md", "USER.md", "IDENTITY.md")


def ensure_hermes_identity(profile_home: Path) -> dict[str, Any]:
    """Merge OpenClaw IDENTITY.md into Hermes SOUL.md with explicit roles."""
    identity_path = profile_home / "IDENTITY.md"
    soul_path = profile_home / "SOUL.md"
    user_path = profile_home / "USER.md"
    if not identity_path.is_file():
        return {"configured": False, "reason": "IDENTITY.md is missing"}

    identity = identity_path.read_text(encoding="utf-8").strip()
    soul = soul_path.read_text(encoding="utf-8") if soul_path.is_file() else ""
    if IDENTITY_BLOCK_START in soul and IDENTITY_BLOCK_END in soul:
        before, remainder = soul.split(IDENTITY_BLOCK_START, 1)
        _, after = remainder.split(IDENTITY_BLOCK_END, 1)
        soul = (before + after).lstrip("\n")

    user_note = (
        "USER.md describes the human you are helping. It never describes you. "
        "Do not identify the user as the agent."
        if user_path.is_file()
        else "The person sending chat messages is the user, not the agent."
    )
    managed = (
        f"{IDENTITY_BLOCK_START}\n"
        "# Hermes Agent Identity\n\n"
        "The following migrated OpenClaw IDENTITY.md content defines you, the agent. "
        f"{user_note}\n\n"
        f"{identity}\n"
        f"{IDENTITY_BLOCK_END}\n\n"
    )
    soul_path.write_text(managed + soul.lstrip("\n"), encoding="utf-8")
    return {
        "configured": True,
        "identitySource": str(identity_path),
        "soulTarget": str(soul_path),
        "userProfilePresent": user_path.is_file(),
    }


def sanitize_hermes_context_files(profile_home: Path) -> dict[str, Any]:
    """Remove hidden Unicode controls that make Hermes reject context files."""
    changed: dict[str, int] = {}
    for name in HERMES_CONTEXT_FILES:
        path = profile_home / name
        if not path.is_file():
            continue
        original = path.read_text(encoding="utf-8")
        sanitized = original.translate(HERMES_BLOCKED_INVISIBLE)
        removed = len(original) - len(sanitized)
        if removed:
            path.write_text(sanitized, encoding="utf-8")
            changed[name] = removed
    return {"configured": True, "removedInvisibleCharacters": changed}
