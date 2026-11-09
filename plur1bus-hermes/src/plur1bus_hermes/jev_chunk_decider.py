"""Bounded TypeSafe Jev decisions for explicitly enabled automatic capture."""
import json
import logging
import math
from urllib.request import Request, urlopen

from .credentials import profile_secret

DEFAULT_KEY = "TYPESAFE_API_KEY"
QUESTION = {
    "type": "choice",
    "instructions": "Is this message one coherent unit that should be kept together (e.g. a recipe, instructions, one explanation or argument), or a collection of independent statements or requests that each make sense on their own?",
    "criteria": {
        "coherent": "One topic or one connected piece: parts depend on each other and lose meaning when separated (recipe with ingredients and steps, how-to, single explanation).",
        "independent": "Several unrelated statements, facts or requests that each make sense alone.",
        "mixed": "Partly connected, partly independent.",
    },
}


def storage_for_answer(answer, minimum=0.85):
    """Uncertain, absent or invalid answers retain the whole and its parts."""
    if not isinstance(answer, dict) or isinstance(answer.get("confidence"), bool):
        return "both"
    try:
        confidence = float(answer.get("confidence"))
    except (TypeError, ValueError):
        return "both"
    if not math.isfinite(confidence) or confidence < minimum:
        return "both"
    return {"coherent": "whole", "independent": "parts"}.get(answer.get("choice"), "both")


def _credentials(config, home=None):
    options = config.get("captureChunkingJev")
    options = options if isinstance(options, dict) else {}
    explicit = options.get("apiKeyEnv")
    explicit = explicit.strip() if isinstance(explicit, str) else ""
    name = explicit or DEFAULT_KEY
    return options, profile_secret(name, home or config.get("hermesHome")).strip(), name


def credential_status(config, *, hermes_home=None):
    """Report the selected credential source without disclosing names or values."""
    _, key, name = _credentials(config, hermes_home)
    editable = name == DEFAULT_KEY
    return {"configured": bool(key), "source": "default_environment" if editable else "configured_environment",
            "editable": editable}


def decide_storage(text, config):
    """Call the upstream fixed endpoint; log no message, secret or response."""
    options, key, _ = _credentials(config)
    if not key or not text.strip():
        return "both"
    timeout = options.get("timeoutMs", 5000)
    timeout = timeout if type(timeout) in (int, float) and math.isfinite(timeout) and timeout > 0 else 5000
    minimum = options.get("minConfidence", 0.85)
    minimum = minimum if type(minimum) in (int, float) and math.isfinite(minimum) else 0.85
    data = json.dumps({"model": options.get("model") or "jev-latest", "state": text[:60000],
                       "questions": {"structure": QUESTION}}).encode()
    request = Request("https://api.typesafe.ai/v1/systemone", data=data,
                      headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
    try:
        with urlopen(request, timeout=timeout / 1000) as response:
            body = json.loads(response.read(1024 * 1024))
        return storage_for_answer(body.get("answers", {}).get("structure"), minimum)
    except Exception as error:
        logging.getLogger(__name__).warning("Jev decision failed: %s; retaining whole and parts", type(error).__name__)
        return "both"
