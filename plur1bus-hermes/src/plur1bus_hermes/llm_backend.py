"""OpenAI-compatible internal LLM backend with oMLX defaults."""

from __future__ import annotations

import json
import logging
import urllib.error
import urllib.request
from typing import Any, Callable


# Native names keep their validation/logging semantics; only the cache key is
# mapped to the corresponding upstream deterministic transformation purpose.
_CACHE_PURPOSES = {"skill-workshop-mining": "skill-extraction", "episode-extraction": "episode-analysis"}


class InternalLlmBackend:
    """Execute explicitly configured internal JSON transformations."""

    def __init__(
        self,
        config: dict[str, Any],
        agent_id: str,
        *,
        opener: Callable[..., Any] = urllib.request.urlopen,
        cache: Any = None,
    ) -> None:
        self.config = dict(config.get("llm") or {})
        self.agent_id = agent_id
        self.opener = opener
        self.cache = cache

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
        # apply. The result cache distinguishes omission from explicit zero.
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
        cache_request = {
            "purpose": _CACHE_PURPOSES.get(purpose, purpose), "scopeId": self.agent_id,
            "endpoint": request.full_url, "credential": api_key,
            "model": payload.get("model"), "messages": payload.get("messages"),
            "maxTokens": payload.get("max_tokens"),
            "temperature": payload.get("temperature"), "jsonMode": True,
            "headers": headers, "payload": payload,
        }
        compute = lambda: self._request_json(request, timeout, purpose)
        result = self.cache.get_or_compute_sync(cache_request, compute) if self.cache is not None else {
            "text": compute()[0],
        }
        try:
            value = json.loads(result["text"])
            if not isinstance(value, dict):
                raise ValueError("cached result is not an object")
            if purpose == "query-refinement" and (
                not isinstance(value.get("query"), str) or not 1 <= len(value["query"].strip()) <= 2048
            ):
                raise ValueError("cached query is invalid")
        except (TypeError, ValueError, KeyError) as error:
            if not result.get("cached"):
                raise RuntimeError("internal LLM returned invalid JSON") from error
            logging.getLogger(__name__).warning("Invalid cached LLM object bypassed")
            text, usage = compute()
            value = json.loads(text)
            try:
                self.cache.put(cache_request, text, usage)
            except Exception as cache_error:
                logging.getLogger(__name__).warning("LLM cache repair bypassed: %s", type(cache_error).__name__)
        if not isinstance(value, dict):
            raise RuntimeError("internal LLM JSON result must be an object")
        return value

    def _request_json(self, request: Any, timeout: float, purpose: str) -> tuple[str, dict[str, Any]]:
        """Validate the live result before it can enter the exact cache."""
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
        if purpose == "query-refinement":
            query = value.get("query")
            if not isinstance(query, str) or not 1 <= len(query.strip()) <= 2048:
                raise RuntimeError("internal LLM returned invalid query refinement")
        return content, dict(body.get("usage") or {})
