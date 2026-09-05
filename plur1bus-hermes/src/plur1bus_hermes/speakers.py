"""Persistent speaker mappings and deterministic message segmentation."""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any


class SpeakerMappingStore:
    """Store workspace-local aliases without changing captured message text."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)

    def mappings(self) -> dict[str, str]:
        if not self.path.is_file():
            return {}
        try:
            value = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, TypeError, ValueError):
            return {}
        return {
            str(key).strip().lower(): str(target).strip()
            for key, target in dict(value.get("mappings") or {}).items()
            if str(key).strip() and str(target).strip()
        }

    def set_mapping(self, alias: str, person: str) -> dict[str, str]:
        clean_alias = str(alias or "").strip()
        clean_person = str(person or "").strip()
        if not clean_alias or len(clean_alias) > 100:
            raise ValueError("speaker alias must contain 1-100 characters")
        if not clean_person or len(clean_person) > 200:
            raise ValueError("speaker identity must contain 1-200 characters")
        mappings = self.mappings()
        mappings[clean_alias.lower()] = clean_person
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(self.path.suffix + ".tmp")
        temporary.write_text(
            json.dumps({"version": 1, "mappings": mappings}, ensure_ascii=False, indent=2)
            + "\n",
            encoding="utf-8",
        )
        os.replace(temporary, self.path)
        return mappings

    def segment(self, text: str) -> list[dict[str, Any]]:
        mappings = self.mappings()
        segments = []
        for line in str(text or "").splitlines():
            match = re.match(r"^\s*([\wäöüß .'-]{1,100}):\s+(.+)$", line, re.I)
            if not match:
                continue
            alias = match.group(1).strip()
            segments.append({
                "speakerLabel": alias,
                "speakerId": mappings.get(alias.lower()),
                "text": match.group(2).strip(),
                "mapped": alias.lower() in mappings,
            })
        return segments
