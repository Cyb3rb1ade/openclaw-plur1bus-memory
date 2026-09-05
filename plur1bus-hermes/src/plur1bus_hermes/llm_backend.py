"""OpenAI-compatible internal LLM backend with oMLX defaults."""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any, Callable


class InternalLlmBackend:
    """Execute explicitly configured internal JSON transformations."""

    def __init__(
        self,
        config: dict[str, Any],
        agent_id: str,
        *,
        opener: Callable[..., Any] = urllib.request.urlopen,
    ) -> None:
        self.config = dict(config.get("llm") or {})
        self.agent_id = agent_id
        self.opener = opener

    def available(self) -> bool:
        return bool(self.config.get("model"))

    def complete_json(
        self,
        purpose: str,
        system: str,
        user: str,
    ) -> dict[str, Any]:
        if not self.available():
            raise RuntimeError("internal LLM model is not configured")
        provider = str(self.config.get("provider") or "omlx").lower()
        base_url = str(self.config.get("baseUrl") or "").rstrip("/")
        if not base_url and provider == "omlx":
            base_url = "http://127.0.0.1:8000/v1"
        if not base_url:
            raise RuntimeError("internal LLM baseUrl is not configured")
        payload = {
            "model": str(self.config["model"]),
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "max_tokens": 300,
            "response_format": {"type": "json_object"},
        }
        # No hardcoded temperature: every complete_json() call hits this raw
        # endpoint directly (there is no host-mediated "native" route to fall
        # back on here), and some coding-tuned endpoints — Kimi's among them —
        # allow exactly one temperature per thinking mode and answer HTTP 400
        # for anything else. Omitting the field lets the provider default
        # apply. The result cache normalises a missing temperature to 0 for
        # its own key (llm_cache.py), so this does not weaken cache scoping.
        # A deployment that wants a pinned temperature sets it via
        # requestExtra below.
        #
        # requestExtra also carries server-specific fields, e.g. suppressing
        # chain-of-thought on a reasoning model — a model that spends its
        # budget thinking first blows the timeout below before emitting any
        # JSON. Callers cannot reach this payload, so the escape hatch has to
        # come from configuration.
        extra = self.config.get("requestExtra")
        if isinstance(extra, dict):
            payload.update(extra)
        headers = {"Content-Type": "application/json"}
        api_key = str(self.config.get("apiKey") or "")
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        request = urllib.request.Request(
            base_url + "/chat/completions",
            data=json.dumps(payload).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        timeout = max(0.1, min(float(self.config.get("timeoutSeconds") or 4), 30))
        try:
            with self.opener(request, timeout=timeout) as response:
                body = json.loads(response.read().decode("utf-8"))
        except (OSError, urllib.error.URLError, ValueError) as error:
            raise RuntimeError(
                f"internal LLM {purpose} failed: {type(error).__name__}"
            ) from error
        content = body["choices"][0]["message"]["content"]
        try:
            value = json.loads(content)
        except (TypeError, ValueError) as error:
            raise RuntimeError("internal LLM returned invalid JSON") from error
        if not isinstance(value, dict):
            raise RuntimeError("internal LLM JSON result must be an object")
        return value
