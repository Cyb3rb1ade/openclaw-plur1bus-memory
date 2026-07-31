"""Bounded workspace source index for Hermes agents."""

from __future__ import annotations

import hashlib
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


_LANGUAGES = {
    ".py": "python",
    ".js": "javascript",
    ".jsx": "javascript",
    ".ts": "typescript",
    ".tsx": "typescript",
}
_EXCLUDED_DIRS = {
    ".git", ".hg", ".svn", "__pycache__", "node_modules", "dist", "build",
    ".venv", "venv",
}
_SYMBOL_PATTERNS = (
    re.compile(r"^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)", re.M),
    re.compile(r"^\s*class\s+([A-Za-z_]\w*)", re.M),
    re.compile(r"\b(?:function|class)\s+([A-Za-z_$][\w$]*)", re.M),
    re.compile(
        r"\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(",
        re.M,
    ),
)


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def rebuild_code_index(
    workspace_dir: Path,
    *,
    max_files: int = 5_000,
    max_file_bytes: int = 1_048_576,
) -> dict[str, Any]:
    """Index source paths and symbols without following symlinks."""
    workspace = Path(workspace_dir).resolve()
    entries = []
    for root, directories, files in os.walk(workspace, followlinks=False):
        directories[:] = [
            directory
            for directory in directories
            if directory not in _EXCLUDED_DIRS
            and not (Path(root) / directory).is_symlink()
        ]
        for filename in files:
            if len(entries) >= max_files:
                break
            path = Path(root) / filename
            language = _LANGUAGES.get(path.suffix.lower())
            if not language or path.is_symlink():
                continue
            stat = path.stat()
            if stat.st_size > max_file_bytes:
                continue
            try:
                content = path.read_text(encoding="utf-8")
            except (OSError, UnicodeError):
                continue
            symbols = []
            for pattern in _SYMBOL_PATTERNS:
                symbols.extend(pattern.findall(content))
            entries.append({
                "path": str(path.relative_to(workspace)),
                "language": language,
                "symbols": sorted(set(symbols))[:500],
                "sha256": hashlib.sha256(content.encode("utf-8")).hexdigest(),
                "size": stat.st_size,
            })
        if len(entries) >= max_files:
            break
    index = {
        "version": 1,
        "generatedAt": _utcnow(),
        "workspace": str(workspace),
        "files": entries,
        "fileCount": len(entries),
        "truncated": len(entries) >= max_files,
    }
    destination = workspace / ".plur1bus" / "code-index.json"
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(".json.tmp")
    temporary.write_text(
        json.dumps(index, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, destination)
    return index


def query_code_index(workspace_dir: Path, query: str, limit: int = 20) -> list[dict[str, Any]]:
    """Query indexed paths and symbols with deterministic token matching."""
    path = Path(workspace_dir) / ".plur1bus" / "code-index.json"
    if not path.is_file():
        return []
    index = json.loads(path.read_text(encoding="utf-8"))
    tokens = {
        token.lower()
        for token in re.findall(r"[A-Za-z0-9_$.-]+", str(query or ""))
        if token
    }
    ranked = []
    for entry in index.get("files", []):
        haystack = " ".join(
            [str(entry.get("path") or ""), *entry.get("symbols", [])]
        ).lower()
        score = sum(1 for token in tokens if token in haystack)
        if score:
            ranked.append((score, entry))
    ranked.sort(key=lambda item: (-item[0], str(item[1].get("path") or "")))
    return [entry for _, entry in ranked[:limit]]
