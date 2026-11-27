"""Versioned, opt-in embedding preprocessing. Stored text is independent."""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any
from unicodedata import category

from .validation import ValidationError


RAW = "raw"
ENVELOPE = "hermes-envelope-v1"
ENVELOPE_NO_SPEAKER = "hermes-envelope-v1-nospeaker"
CLEAN_V1 = "clean-v1"
CLEAN_V1_NO_SPEAKER = "clean-v1-nospeaker"

_TIMESTAMP = re.compile(
    r"^\s*\[\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?"
    r"(?:Z|[+-]\d{2}:?\d{2}|\s+[A-Z]{2,5})?\]\s*"
)
_TRANSCRIPT = re.compile(
    r"^\s*\[(?:audio transcript|voice transcript|transkript)[^\]\n]{0,160}\]:?\s*", re.I
)
_TRANSPORT_METADATA = re.compile(
    r"^(?:Conversation info|Sender) \(untrusted metadata\):[ \t]*\n"
    r"```(?:json)?[^\n]*\n[\s\S]*?\n```[ \t]*(?:\n|$)", re.I | re.M
)
_SPEAKER = re.compile(r"^[A-ZÄÖÜ][\w. -]{0,30}:[ \t]+")
_V1_TIMESTAMP = re.compile(
    r"^\s*\[(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\.?,?\s+)?\d{4}-\d{2}-\d{2}[ T]"
    r"\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|\s*[A-Z]{2,5}(?:[+-]\d{1,2}(?::?\d{2})?)?|"
    r"\s*[+-]\d{1,2}(?::?\d{2})?)?\]\s*"
)
_V1_METADATA = re.compile(r"^[^\n]{1,80}\(untrusted metadata\):[ \t]*\n```[^\n]*\n[\s\S]*?\n```[ \t]*(?:\n|$)", re.M)
_V1_AUDIO = re.compile(r"^\s*\[(?:audio transcript|voice transcript|transkript)[^\]\n]*\]:?[ \t]*", re.I)
_AUDIO_HEADER = re.compile(r"^[ \t]*\[(?:Audio|Voice)\][ \t]*$", re.I | re.M)
_MEDIA_HEADER = re.compile(r"^[ \t]*\[(?:Audio|Voice|Image|Video|Document|File|Attachment)\][ \t]*$", re.I | re.M)
_MEDIA_LABEL = re.compile(r"^[ \t]*(?:User text|Transcript):[ \t]*$", re.I | re.M)
_V1_ENVELOPES = (
    _V1_TIMESTAMP,
    _V1_METADATA,
    re.compile(r"^[ \t]*\[(?:User schickte\b|media attached\b|Audio attachment could not be analyzed|"
               r"attachment could not be read)[^\]\n]*\][ \t]*$", re.I | re.M),
    re.compile(r"^[ \t]*\[(?=[^\]\n]{0,160}\bid:)(?:Telegram|Discord|WhatsApp|Signal|Slack|iMessage|Matrix)"
               r"\b[^\]\n]{0,160}\](?!\()[ \t]*", re.M),
    re.compile(r"^[ \t]*\[visible (?:thinking|redacted_thinking|reasoning|toolCall|tool_use|toolUse|"
               r"functionCall|function_call|server_tool_use)\b[^\]\n]*\][ \t]*$", re.I | re.M),
    re.compile(r"<think>[\s\S]*?</think>", re.I),
)
_ROLE = re.compile(r"^\s*(?:User|Assistant|Human|AI):[ \t]*", re.I)
_TRANSCRIPT_NAME = re.compile(r"^\s*([^\s:]{1,31}(?: [^\s:]{1,31})?):[ \t]+")
_TALK_MODE = re.compile(
    r"^\s*Talk Mode active\. Reply in a concise, spoken tone\.?"
    r"(?:[ \t]*\n?[ \t]*You may optionally prefix the response with JSON \(first line\) to set ElevenLabs voice[^\n]*)?"
    r"(?:[ \t]*\n?[ \t]*Assistant speech interrupted at \d+(?:\.\d+)?s\.?)?\s*", re.I,
)
_STAGE_WORDS = (
    r"räuspert sich|räuspern|lacht|lachen|lachend|lautes lachen|kichert|kichern|seufzt|seufzen|hustet|husten|"
    r"niest|schnieft|schmunzelt|stöhnt|gähnt|atmet(?: tief)?(?: ein| aus| durch)?|kurze pause|pause|stille|"
    r"unverständlich|musik|hintergrundgeräusche?|geräusche?|laughs|laughter|laughing|chuckles|sighs|coughs|"
    r"clears throat|inaudible|music|silence|background noise|applause|crosstalk"
)
_STAGE_BODY = r"[ \t]*(?:" + _STAGE_WORDS + r")[ \t]*[.!]?[ \t]*"
_STAGE_SQUARE = re.compile(r"(?<!\w)\[" + _STAGE_BODY + r"\](?!\()", re.I)
_STAGE_ROUND = re.compile(r"(?<!\w)\(" + _STAGE_BODY + r"\)", re.I)
_FILLER = re.compile(
    r"""(?<![^\s,;!?…()\[\]„“”"'«»])(?:äähm|ähem|ähm|ähh|öhm|ehm|hmm|mhm|uhm|umm|erm|äh|öh|hm|uh)"""
    r"""(?=$|[\s,;!?…)\]„“”"'«»]|[.:\-](?:\s|$)|\.{2,})(?![ \t]*&)[ \t]*[,.…!?]*""", re.I,
)
_INLINE_SPACE = re.compile(r"[ \t]{2,}")
_BEFORE_PUNCTUATION = re.compile(r"[ \t]+([,.!?;:])")
_BLANK_LINES = re.compile(r"\n{3,}")
_LEADING_PUNCTUATION = re.compile(r"^[,;:\s]+")


def configured_text_mode(config: Mapping[str, Any]) -> str:
    """Leave all old profiles raw until explicitly opted in."""
    embedding = config.get("embedding")
    options = embedding.get("cleanText") if isinstance(embedding, Mapping) else None
    if options is True:
        return ENVELOPE
    if isinstance(options, Mapping) and options.get("enabled") is True:
        keep_speaker = options.get("stripSpeaker") is not True
        if options.get("mode") == CLEAN_V1:
            return CLEAN_V1 if keep_speaker else CLEAN_V1_NO_SPEAKER
        return ENVELOPE if keep_speaker else ENVELOPE_NO_SPEAKER
    return RAW


def _remove_filler(match: re.Match[str]) -> str:
    text, start = match.string, match.start()
    cursor = start - 1
    while cursor >= 0 and text[cursor] in " \t":
        cursor -= 1
    if cursor >= 0 and category(text[cursor]).startswith("N"):
        return match[0]
    if category(match[0][0]) == "Lu":
        while cursor >= 0 and text[cursor].isspace():
            cursor -= 1
        if cursor >= 0 and category(text[cursor])[0] in "LN":
            return match[0]
    return " "


def _clean_v1(text: str, *, strip_speaker: bool, envelopes_only: bool = False) -> str:
    """Apply the portable PLUR1BUS clean-v1 rules without changing stored text."""
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    cleaned = normalized
    for pattern in _V1_ENVELOPES:
        cleaned = pattern.sub("", cleaned)
    role = _ROLE.match(cleaned)
    role_end = role.end() if role else 0
    without_talk = _TALK_MODE.sub("", cleaned[role_end:])
    if without_talk != cleaned[role_end:]:
        cleaned = cleaned[:role_end] + without_talk if without_talk.strip() else ""
    audio_header = _AUDIO_HEADER.search(cleaned) is not None
    cleaned, media_count = _MEDIA_HEADER.subn("", cleaned)
    if media_count:
        cleaned = _MEDIA_LABEL.sub("", cleaned)
    audio = _V1_AUDIO.match(cleaned)
    if audio:
        cleaned = cleaned[audio.end():].strip()
        if len(cleaned) >= 2 and cleaned.startswith('"') and cleaned.endswith('"'):
            cleaned = cleaned[1:-1]
    if not envelopes_only:
        cleaned = _STAGE_SQUARE.sub(" ", cleaned)
        if audio or audio_header:
            cleaned = _STAGE_ROUND.sub(" ", cleaned)
        cleaned = _FILLER.sub(_remove_filler, cleaned)
    if strip_speaker:
        role = _ROLE.match(cleaned)
        if role:
            cleaned = cleaned[role.end():]
        elif audio and (speaker := _TRANSCRIPT_NAME.match(cleaned)):
            words = speaker[1].split(" ")
            if all(category(word[0]) == "Lu" and all(character in ".-" or category(character).startswith("L")
                                                     for character in word[1:]) for word in words):
                cleaned = cleaned[speaker.end():]
    if cleaned == normalized:
        return text
    lines = (_BEFORE_PUNCTUATION.sub(r"\1", _INLINE_SPACE.sub(" ", line)).strip() for line in cleaned.split("\n"))
    return _LEADING_PUNCTUATION.sub("", _BLANK_LINES.sub("\n\n", "\n".join(lines))).strip()


def prepare_embedding_text(text: str, mode: object) -> tuple[str, str]:
    """Return the versioned model input and fall back to raw if cleanup is empty.

    Absent modes predate this feature. An explicit mode from a different
    implementation must not silently produce different vectors.
    """
    if mode in (None, "", RAW):
        return text, RAW
    if mode in (CLEAN_V1, CLEAN_V1_NO_SPEAKER):
        cleaned = _clean_v1(text, strip_speaker=mode == CLEAN_V1_NO_SPEAKER)
        return (cleaned, str(mode)) if cleaned.strip() else (text, RAW)
    if mode not in (ENVELOPE, ENVELOPE_NO_SPEAKER):
        raise ValidationError("unsupported stored embedding text mode")
    cleaned = _TRANSPORT_METADATA.sub("", text.replace("\r\n", "\n").replace("\r", "\n"))
    cleaned = _TRANSCRIPT.sub("", _TIMESTAMP.sub("", cleaned)).strip()
    if mode == ENVELOPE_NO_SPEAKER:
        cleaned = _SPEAKER.sub("", cleaned).strip()
    return (cleaned, str(mode)) if cleaned else (text, RAW)


def prepare_embedding_query(text: str, mode: object) -> str:
    """Keep words in user queries, stripping only the configured transport wrappers."""
    if mode in (CLEAN_V1, CLEAN_V1_NO_SPEAKER):
        cleaned = _clean_v1(text, strip_speaker=mode == CLEAN_V1_NO_SPEAKER, envelopes_only=True)
        return cleaned if cleaned.strip() else text
    return prepare_embedding_text(text, mode)[0]
