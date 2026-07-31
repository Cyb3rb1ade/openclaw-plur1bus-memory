"""Strict parsing helpers for canonical PLUR1BUS command grammars."""

from __future__ import annotations

import re


def parse_correction(arguments: list[str]) -> tuple[str, str] | None:
    """Parse ID replacement or documented old-text separator grammar."""
    if len(arguments) < 2:
        return None
    joined = " ".join(arguments).strip()
    match = re.match(r"^(.+?)\s+(?:zu|→|->)\s+(.+)$", joined, re.I | re.S)
    if match:
        return match.group(1).strip(), match.group(2).strip()
    return arguments[0], " ".join(arguments[1:]).strip()
