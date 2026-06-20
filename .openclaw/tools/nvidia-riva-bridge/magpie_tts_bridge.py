#!/usr/bin/env python3
"""MAGPIE TTS HTTP bridge for Discord voice (port 8025).

Exposes POST /v1/audio/speech — accepts JSON {"input": "<text>"}
and returns raw s16le 48 kHz stereo PCM bytes suitable for Discord.

Audio pipeline:
  MAGPIE gRPC → s16le ~22050 Hz mono → ffmpeg resample → s16le 48000 Hz stereo
"""

from __future__ import annotations

import json
import logging
import os
import signal
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import urlparse

import grpc
import riva.client

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

DEFAULT_PORT = int(os.getenv("MAGPIE_PORT", "8025"))
DEFAULT_BIND = os.getenv("MAGPIE_BIND", "127.0.0.1")
DEFAULT_SERVER = "grpc.nvcf.nvidia.com:443"
DEFAULT_FUNCTION_ID = os.getenv(
    "MAGPIE_FUNCTION_ID", "877104f7-e885-42b9-8de8-f6e4c6303969"
)
FALLBACK_NATIVE_RATE = 22050
MAX_INPUT_CHARS = 400

VOICE_DEBUG = os.getenv("VOICE_DEBUG", "").lower() in ("1", "true", "yes")

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=logging.DEBUG if VOICE_DEBUG else logging.INFO,
    format="%(message)s",
    stream=sys.stderr,
)
log = logging.getLogger("magpie-tts")


def _mask_key(key: str) -> str:
    """Return key=<prefix>**** — never expose the full key."""
    if key.startswith("nvapi-"):
        return "key=nvapi-****"
    return "key=****"


# ---------------------------------------------------------------------------
# Global counters (thread-safe)
# ---------------------------------------------------------------------------

_start_time: float = time.monotonic()
_requests_total: int = 0
_requests_active: int = 0
_counter_lock = threading.Lock()

_server: ThreadingHTTPServer | None = None


# ---------------------------------------------------------------------------
# TTS + audio pipeline
# ---------------------------------------------------------------------------


def _synthesize_pcm(text: str, voice: str | None, language: str | None, api_key: str) -> bytes:
    """Call MAGPIE TTS via gRPC, resample to 48 kHz stereo, return raw PCM bytes."""

    auth = riva.client.Auth(
        use_ssl=True,
        uri=DEFAULT_SERVER,
        metadata_args=[
            ["function-id", DEFAULT_FUNCTION_ID],
            ["authorization", f"Bearer {api_key}"],
        ],
        options=[
            ("grpc.max_receive_message_length", 50 * 1024 * 1024),
            ("grpc.max_send_message_length", 50 * 1024 * 1024),
        ],
    )
    tts = riva.client.SpeechSynthesisService(auth)

    lang = language or "en-US"
    # Request native rate; we'll detect actual rate from first response
    native_rate = FALLBACK_NATIVE_RATE

    # Use synthesize_online (streaming) — prefer it per spec
    log.info(f"[magpie-tts] synthesize chars={len(text)} lang={lang} voice={voice!r}")
    if VOICE_DEBUG:
        log.debug(f"[magpie-tts] DEBUG input text: {text!r}")

    raw_chunks: list[bytes] = []
    detected_rate: int | None = None

    responses = tts.synthesize_online(
        text=text,
        voice_name=voice,
        language_code=lang,
        encoding=riva.client.AudioEncoding.LINEAR_PCM,
        sample_rate_hz=native_rate,
    )

    for resp in responses:
        if resp.audio:
            raw_chunks.append(resp.audio)
        # Try to detect native rate from the first response that has meta
        if detected_rate is None and hasattr(resp, "meta") and resp.meta is not None:
            # SynthesizeSpeechResponseMetadata doesn't carry sample_rate_hertz,
            # but the request echo is in meta.text; rate comes from the grpc
            # audio_config if present. We use a safe fallback approach:
            # detect via the actual frame count ratio later if needed.
            pass

    raw_pcm = b"".join(raw_chunks)

    if not raw_pcm:
        raise RuntimeError("MAGPIE TTS returned empty audio")

    log.info(f"[magpie-tts] raw_pcm bytes={len(raw_pcm)} native_rate={native_rate}")

    # Resample from native (mono, s16le) → 48 kHz stereo (s16le)
    ffmpeg_cmd = [
        "ffmpeg", "-y",
        "-f", "s16le", "-ar", str(native_rate), "-ac", "1",
        "-i", "pipe:0",
        "-f", "s16le", "-ar", "48000", "-ac", "2",
        "pipe:1",
    ]

    result = subprocess.run(
        ffmpeg_cmd,
        input=raw_pcm,
        capture_output=True,
    )

    if result.returncode != 0:
        stderr_snippet = result.stderr.decode(errors="replace")[:300]
        raise RuntimeError(f"ffmpeg resampling failed (rc={result.returncode}): {stderr_snippet}")

    pcm_48k = result.stdout
    log.info(f"[magpie-tts] resampled bytes={len(pcm_48k)} (48000 Hz stereo)")
    return pcm_48k


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------


class MagpieTTSHandler(BaseHTTPRequestHandler):
    server_version = "magpie-tts-bridge/1.0"

    def _send_json(self, code: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_pcm(self, pcm: bytes) -> None:
        self.send_response(200)
        self.send_header(
            "Content-Type",
            "audio/pcm; rate=48000; bits=16; channels=2; encoding=signed-integer; endian=little",
        )
        self.send_header("Content-Length", str(len(pcm)))
        self.end_headers()
        self.wfile.write(pcm)

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/health":
            with _counter_lock:
                total = _requests_total
                active = _requests_active
            uptime = time.monotonic() - _start_time
            self._send_json(200, {
                "status": "ok",
                "uptime_s": round(uptime, 2),
                "requests_total": total,
                "requests_active": active,
            })
            return
        self._send_json(404, {"error": "Not found"})

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if path != "/v1/audio/speech":
            self._send_json(404, {"error": "Not found"})
            return

        # Read request body
        content_length = self.headers.get("Content-Length")
        try:
            length_int = int(content_length) if content_length else 0
        except ValueError:
            length_int = 0

        MAX_BODY = 64 * 1024  # 64 KB is more than enough for text
        raw_body = self.rfile.read(min(length_int, MAX_BODY) if length_int > 0 else MAX_BODY)

        try:
            payload = json.loads(raw_body.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            self._send_json(400, {"error": f"Invalid JSON: {exc}"})
            return

        text = payload.get("input", "")
        if not text or not isinstance(text, str):
            self._send_json(400, {"error": "Missing or invalid 'input' field"})
            return

        if len(text) > MAX_INPUT_CHARS:
            self._send_json(400, {
                "error": f"Input too long: {len(text)} chars (max {MAX_INPUT_CHARS})"
            })
            return

        voice: str | None = payload.get("voice") or None
        language: str | None = payload.get("language") or None

        # API key check
        api_key = os.getenv("NVIDIA_API_KEY", "").strip()
        if not api_key:
            self._send_json(503, {"error": "Bridge not ready: NVIDIA_API_KEY not configured"})
            return

        # Track counters
        with _counter_lock:
            global _requests_total, _requests_active
            _requests_total += 1
            _requests_active += 1

        try:
            pcm = _synthesize_pcm(text, voice, language, api_key)
            self._send_pcm(pcm)
        except grpc.RpcError as exc:
            try:
                details = exc.details()
            except Exception:
                details = str(exc)
            log.error(f"[magpie-tts] gRPC error: {details}")
            self._send_json(500, {"error": str(details)})
        except subprocess.CalledProcessError as exc:
            snippet = (exc.stderr or b"").decode(errors="replace")[:200]
            log.error(f"[magpie-tts] ffmpeg error: {snippet}")
            self._send_json(500, {"error": f"ffmpeg error: {snippet}"})
        except Exception as exc:
            log.error(f"[magpie-tts] Unexpected error: {exc}")
            self._send_json(500, {"error": str(exc)})
        finally:
            with _counter_lock:
                _requests_active -= 1

    def log_message(self, format: str, *args: Any) -> None:
        sys.stderr.write("[magpie-tts] " + format % args + "\n")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main() -> None:
    global _server

    api_key = os.getenv("NVIDIA_API_KEY", "").strip()
    if not api_key:
        log.warning("[magpie-tts] NVIDIA_API_KEY is not set — requests will return 503")
    else:
        log.info(
            f"[magpie-tts] Starting with {_mask_key(api_key)} "
            f"function-id={DEFAULT_FUNCTION_ID}"
        )

    # Port conflict check
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        probe.bind((DEFAULT_BIND, DEFAULT_PORT))
    except OSError as exc:
        log.error(f"[magpie-tts] Port {DEFAULT_PORT} already in use: {exc}")
        sys.exit(1)
    finally:
        probe.close()

    _server = ThreadingHTTPServer((DEFAULT_BIND, DEFAULT_PORT), MagpieTTSHandler)
    _server.daemon_threads = True

    def _handle_sigterm(*_: Any) -> None:
        log.info("[magpie-tts] SIGTERM received — shutting down")
        threading.Thread(target=_server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, _handle_sigterm)
    signal.signal(signal.SIGINT, _handle_sigterm)

    log.info(
        f"[magpie-tts] Listening on http://{DEFAULT_BIND}:{DEFAULT_PORT} "
        f"(server={DEFAULT_SERVER})"
    )
    _server.serve_forever()
    log.info("[magpie-tts] Server stopped")


if __name__ == "__main__":
    main()
