"""Reviewed retrieval settings and staged migration for native operator surfaces."""
from __future__ import annotations

import hashlib
import json
import math
import re
import shutil
import tempfile
from pathlib import Path
from urllib.parse import urlsplit

from .generation import _atomic_json, _reject_symlink_components
from .runtime_lease import exclusive_generation_lease
from .writer_lock import writer_lock
from .validation import ValidationError

EMBEDDING_PROVIDERS = ["local-onnx", "local-transformers", "openai-compatible", "omlx"]
RERANKER_PROVIDERS = ["local-transformers", "openai-compatible", "cohere", "omlx", "disabled"]
FIELDS = {"provider", "model", "dimensions", "baseUrl", "apiKeyEnv", "modelDir", "cacheDir",
          "revision", "queryPrefix", "passagePrefix", "license", "licenseAccepted", "localFilesOnly"}


def public_config(config: dict) -> dict:
    """Expose editable nonsecret fields only; never return credential-bearing URLs."""
    result = {key: value for key, value in config.items() if key in FIELDS}
    url = str(result.get("baseUrl") or "")
    if url:
        parts = urlsplit(url)
        if parts.username or parts.password or parts.query or parts.fragment:
            result.pop("baseUrl", None)
    return result


def validate_target(kind: str, value: dict) -> dict:
    """Validate an explicit vector space or reranker without network/model loading."""
    if kind not in {"embedding", "reranker"} or not isinstance(value, dict) or set(value) - FIELDS:
        raise ValidationError("invalid retrieval fields")
    result = dict(value)
    choices = EMBEDDING_PROVIDERS if kind == "embedding" else RERANKER_PROVIDERS
    if result.get("provider") not in choices:
        raise ValidationError("unsupported retrieval provider")
    for key, item in result.items():
        if key in {"licenseAccepted", "localFilesOnly"}:
            if type(item) is not bool:
                raise ValidationError("invalid retrieval flag")
        elif key == "dimensions":
            if type(item) is not int or not 1 <= item <= 8192:
                raise ValidationError("dimensions must be between 1 and 8192")
        elif not isinstance(item, str) or len(item) > 2048 or any(ord(c) < 32 for c in item):
            raise ValidationError("invalid retrieval text")
    if result["provider"] != "disabled" and not str(result.get("model") or "").strip():
        raise ValidationError("model is required")
    if kind == "embedding" and "dimensions" not in result:
        raise ValidationError("dimensions are required")
    if result.get("apiKeyEnv") and not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,127}", result["apiKeyEnv"]):
        raise ValidationError("use an environment variable name, not an API key")
    if result.get("baseUrl"):
        url = urlsplit(result["baseUrl"])
        if (url.scheme not in {"http", "https"} or not url.hostname or url.username or url.password
                or url.query or url.fragment or (url.scheme == "http" and url.hostname not in {"localhost", "127.0.0.1", "::1"})):
            raise ValidationError("use HTTPS or a loopback URL without credentials or query")
    if result["provider"] == "openai-compatible" and not result.get("baseUrl"):
        raise ValidationError("an explicit endpoint is required")
    if kind == "embedding":
        from .runtime import validate_native_embedding_config
        validate_native_embedding_config(result)
    return result


def config_path(view) -> Path:
    """Resolve only the server-owned profile's configuration, never a request path."""
    home = Path(view.hermes_home).absolute()
    path = home / "plugins" / "plur1bus" / "config.json"
    nested = home / "profiles" / view.profile / "plugins" / "plur1bus" / "config.json"
    _reject_symlink_components(home, nested, message="unsafe profile config")
    if view.profile != "default" and (home / "profiles" / view.profile).is_dir():
        path = nested
    _reject_symlink_components(home, path, message="unsafe profile config")
    return path


def context_revision(view) -> str:
    """Pin the effective config, disk config and exact partition for review."""
    path = config_path(view)
    raw = path.read_bytes() if path.exists() else b""
    value = [str(view.hermes_home), view.profile, view.agent_id, str(view._writer_route.path),
             view.scope_binding.as_dict(), view.config, hashlib.sha256(raw).hexdigest()]
    return hashlib.sha256(json.dumps(value, sort_keys=True, default=str).encode()).hexdigest()


def save_reranker(view, target: dict, revision: str) -> dict:
    """Back up and atomically save one profile override while all runtimes are stopped."""
    with exclusive_generation_lease(view.data_dir), writer_lock(view.data_dir):
        if context_revision(view) != revision:
            raise ValidationError("configuration changed; review again")
        if target["provider"] != "disabled":
            from .runtime import RerankerBackend
            # The public rerank method deliberately fails open; settings must
            # instead fail closed when this explicit synthetic smoke test fails.
            ranked = RerankerBackend(target, view.hermes_home)._rerank_with(target, "test", [{"content": "test"}])
            if not ranked or not math.isfinite(float(ranked[0].get("rerankScore", float("nan")))):
                raise ValidationError("reranker smoke test returned no finite score")
        path = config_path(view)
        had_config = path.exists()
        original = json.loads(path.read_text()) if had_config else {}
        if not isinstance(original, dict):
            raise ValidationError("invalid profile config")
        path.parent.mkdir(parents=True, exist_ok=True)
        if had_config:
            backup = path.with_name("config.before-reranker-" + revision[:16] + ".json")
            _reject_symlink_components(Path(view.hermes_home), backup, message="unsafe backup")
            if not backup.exists():
                _atomic_json(backup, original)
        # Keep the effective vector space when opting out of central routing.
        updated = {**original, "embedding": view.config["embedding"], "reranker": target,
                   "retrieval": {**original.get("retrieval", {}), "mode": "plur1bus"}}
        _atomic_json(path, updated)
        return {"saved": True, "restartRequired": True, "backup": had_config}


def stage_embedding(view, target: dict, plan: dict, progress, *, revision: str | None = None) -> dict:
    """Snapshot the source, re-embed into a separate table, then verify all metadata."""
    from .reembed_staged import apply_staged_reembed, _validate_plan
    from .generation import _validate_complete
    config = {**view.config, "embedding": target}
    with exclusive_generation_lease(view.data_dir), writer_lock(view.data_dir):
        if revision is not None and context_revision(view) != revision:
            raise ValidationError("configuration changed; review again")
        source, _ = _validate_plan(plan, view.data_dir, view.agent_id, config, None)
        backup_root = Path(view.data_dir).resolve() / "state" / view.agent_id / "retrieval-backups"
        _reject_symlink_components(Path(view.data_dir).resolve(), backup_root, message="unsafe backup path")
        backup_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        # A fresh complete copy precedes any staging writes. Failed copies are
        # retained for inspection and are never represented as complete backups.
        for item in source.rglob("*"):
            if item.is_symlink():
                raise ValidationError("source backup contains a symlink")
        backup = Path(tempfile.mkdtemp(prefix=plan["planId"] + "-", dir=backup_root))
        shutil.copytree(source, backup / "database")
        _atomic_json(backup / "snapshot.json", {"plan": plan, "complete": True})
        while True:
            result = apply_staged_reembed(plan, view.data_dir, view.agent_id, config, batch_size=100)
            progress({"cursor": result["cursor"], "cards": result["cards"]})
            if result["completion"] == "staged":
                break
        _validate_complete(plan, view.data_dir, view.agent_id, config, None)
        return {"validated": True, "active": False, "cards": result["cards"], "backup": True}
