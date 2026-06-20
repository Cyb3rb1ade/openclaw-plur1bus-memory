#!/usr/bin/env python3
"""ASR streaming WebSocket bridge for NVIDIA multilingual Parakeet (port 8021).

Exposes ws://127.0.0.1:8021/stream — accepts s16le 16 kHz mono PCM binary
frames of 640 bytes each (20 ms) and returns streaming JSON transcripts.

Also handles GET /health on the same port via the process_request hook.

Protocol (client → server):
  1. Text JSON: {"type":"config","lang":"de","sample_rate":16000,"frame_bytes":640}
  2. Binary frames: 640 bytes each (s16le, 16 kHz, mono)
  3. Text JSON: {"type":"end"}   — finalise utterance
  4. Text JSON: {"type":"reset"} — discard current buffer

Protocol (server → client):
  {"is_final": false, "transcript": "..."}
  {"is_final": true, "transcript": "...", "confidence": 0.94, "lang": "de",
   "words": [{"word": "hey", "start_ms": 120, "end_ms": 280}]}
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import queue
import signal
import socket
import sys
import time
import uuid
from typing import Any

import grpc
import riva.client
from websockets.asyncio.server import ServerConnection, serve
from websockets.http11 import Request

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

DEFAULT_PORT = int(os.getenv("ASR_STREAM_PORT", "8021"))
DEFAULT_FUNCTION_ID = os.getenv(
    "ASR_STREAM_FUNCTION_ID", "71203149-d3b7-4460-8231-1be2543a1fca"
)
GRPC_SERVER = "grpc.nvcf.nvidia.com:443"
SAMPLE_RATE = 16000
FRAME_BYTES = 640  # 20 ms × 16000 Hz × 2 bytes

VOICE_DEBUG = os.getenv("VOICE_DEBUG", "").lower() in ("1", "true", "yes")

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=logging.DEBUG if VOICE_DEBUG else logging.INFO,
    format="%(message)s",
    stream=sys.stderr,
)
log = logging.getLogger("asr-stream")


def _mask_key(key: str) -> str:
    """Return key=<prefix>**** — never expose the full key."""
    if key.startswith("nvapi-"):
        return "key=nvapi-****"
    return "key=****"


# ---------------------------------------------------------------------------
# Global state
# ---------------------------------------------------------------------------

_start_time: float = time.monotonic()
_active_sessions: dict[str, Any] = {}  # session_id → placeholder

# ---------------------------------------------------------------------------
# gRPC helpers
# ---------------------------------------------------------------------------

_SENTINEL = object()  # signals end-of-audio to the gRPC thread


def _grpc_worker(
    audio_q: queue.Queue,
    result_q: asyncio.Queue,
    loop: asyncio.AbstractEventLoop,
    lang: str,
    api_key: str,
    function_id: str,
    session_id: str,
) -> None:
    """Blocking thread: reads PCM chunks from audio_q, streams to NVIDIA gRPC,
    pushes JSON-serialisable result dicts into result_q (via asyncio loop)."""

    def _push(item: dict | None) -> None:
        """Thread-safe push to the asyncio queue."""
        loop.call_soon_threadsafe(result_q.put_nowait, item)

    try:
        auth = riva.client.Auth(
            use_ssl=True,
            uri=GRPC_SERVER,
            metadata_args=[
                ["function-id", function_id],
                ["authorization", f"Bearer {api_key}"],
            ],
            options=[
                ("grpc.max_receive_message_length", 50 * 1024 * 1024),
                ("grpc.max_send_message_length", 50 * 1024 * 1024),
            ],
        )
        asr = riva.client.ASRService(auth)

        config = riva.client.StreamingRecognitionConfig(
            config=riva.client.RecognitionConfig(
                language_code=lang,
                max_alternatives=1,
                enable_automatic_punctuation=True,
                audio_channel_count=1,
                sample_rate_hertz=SAMPLE_RATE,
                encoding=riva.client.AudioEncoding.LINEAR_PCM,
            ),
            interim_results=True,  # we want both interim and final
        )

        def _audio_chunks():
            """Generator: yields PCM bytes from the thread-safe queue until sentinel."""
            while True:
                chunk = audio_q.get()
                if chunk is _SENTINEL:
                    return
                yield chunk

        responses = asr.streaming_response_generator(
            audio_chunks=_audio_chunks(),
            streaming_config=config,
        )

        for resp in responses:
            for result in resp.results:
                alt = result.alternatives[0] if result.alternatives else None
                transcript = alt.transcript if alt else ""
                confidence = float(alt.confidence) if (alt and alt.confidence is not None) else None
                is_final = bool(result.is_final)

                words: list[dict] | None = None
                if is_final and alt and hasattr(alt, "words") and alt.words:
                    words = [
                        {
                            "word": w.word,
                            "start_ms": int(w.start_time.total_seconds() * 1000)
                            if hasattr(w, "start_time") and w.start_time is not None
                            else None,
                            "end_ms": int(w.end_time.total_seconds() * 1000)
                            if hasattr(w, "end_time") and w.end_time is not None
                            else None,
                        }
                        for w in alt.words
                    ]

                msg: dict = {"is_final": is_final, "transcript": transcript}
                if is_final:
                    if confidence is not None:
                        msg["confidence"] = round(confidence, 4)
                    msg["lang"] = lang
                    if words:
                        msg["words"] = words
                    n = len(transcript)
                    c_str = f"{confidence:.2f}" if confidence is not None else "n/a"
                    log.info(
                        f"[asr-stream] Final: session={session_id} "
                        f"transcript_chars={n} confidence={c_str}"
                    )
                    if VOICE_DEBUG:
                        log.debug(
                            f"[asr-stream] DEBUG transcript: {transcript!r}"
                        )

                _push(msg)

    except grpc.RpcError as exc:
        err_msg = exc.details() if callable(getattr(exc, "details", None)) else str(exc)
        log.error(f"[asr-stream] gRPC error session={session_id}: {err_msg}")
        _push({"error": err_msg})
    except Exception as exc:
        log.error(f"[asr-stream] Worker error session={session_id}: {exc}")
        _push({"error": str(exc)})
    finally:
        # Signal the async side that the stream is done
        _push(None)


# ---------------------------------------------------------------------------
# WebSocket connection handler
# ---------------------------------------------------------------------------

async def handle_connection(websocket: ServerConnection) -> None:
    session_id = str(uuid.uuid4())[:8]
    remote = websocket.remote_address
    log.info(f"[asr-stream] Connected: client={remote} session={session_id}")
    _active_sessions[session_id] = True

    api_key = os.getenv("NVIDIA_API_KEY", "")
    function_id = DEFAULT_FUNCTION_ID
    loop = asyncio.get_running_loop()

    frames_received = 0
    grpc_task: asyncio.Task | None = None
    audio_q: queue.Queue | None = None
    result_q: asyncio.Queue | None = None

    try:
        # ------------------------------------------------------------------
        # Phase 1: wait for config message
        # ------------------------------------------------------------------
        config_msg = await websocket.recv()
        if not isinstance(config_msg, str):
            await websocket.close(1002, "Expected JSON config as first message")
            return

        cfg = json.loads(config_msg)
        if cfg.get("type") != "config":
            await websocket.close(1002, "First message must be type=config")
            return

        lang = cfg.get("lang", "en-US")
        sample_rate = cfg.get("sample_rate", SAMPLE_RATE)
        frame_bytes = cfg.get("frame_bytes", FRAME_BYTES)
        log.info(
            f"[asr-stream] Config: lang={lang} sample_rate={sample_rate} "
            f"frame_bytes={frame_bytes}"
        )

        # ------------------------------------------------------------------
        # Phase 2: start gRPC worker
        # ------------------------------------------------------------------
        audio_q = queue.Queue(maxsize=500)
        result_q = asyncio.Queue()

        grpc_task = loop.run_in_executor(
            None,
            _grpc_worker,
            audio_q,
            result_q,
            loop,
            lang,
            api_key,
            function_id,
            session_id,
        )

        # ------------------------------------------------------------------
        # Phase 3: main loop — interleave recv and result forwarding
        # ------------------------------------------------------------------
        async def forward_results() -> None:
            """Drain result_q and forward to websocket until None sentinel."""
            while True:
                item = await result_q.get()
                if item is None:
                    return  # gRPC worker done
                await websocket.send(json.dumps(item))

        forward_task = asyncio.create_task(forward_results())

        try:
            async for raw in websocket:
                if isinstance(raw, bytes):
                    # Binary PCM frame
                    frames_received += 1
                    audio_q.put(raw)
                elif isinstance(raw, str):
                    try:
                        ctrl = json.loads(raw)
                    except json.JSONDecodeError:
                        log.warning(
                            f"[asr-stream] Invalid JSON from session={session_id}, ignoring"
                        )
                        continue

                    msg_type = ctrl.get("type")
                    if msg_type == "end":
                        # Signal gRPC worker to finish the current utterance
                        audio_q.put(_SENTINEL)
                        # Wait for all results to be forwarded
                        await forward_task
                        # Re-create queues for next utterance
                        audio_q = queue.Queue()
                        result_q = asyncio.Queue()
                        grpc_task = loop.run_in_executor(
                            None,
                            _grpc_worker,
                            audio_q,
                            result_q,
                            loop,
                            lang,
                            api_key,
                            function_id,
                            session_id,
                        )
                        forward_task = asyncio.create_task(forward_results())

                    elif msg_type == "reset":
                        log.info(
                            f"[asr-stream] Reset: session={session_id}"
                        )
                        # Drain the audio queue and tell worker to stop
                        while not audio_q.empty():
                            try:
                                audio_q.get_nowait()
                            except queue.Empty:
                                break
                        audio_q.put(_SENTINEL)
                        # Cancel the forward task and discard results
                        forward_task.cancel()
                        try:
                            await forward_task
                        except asyncio.CancelledError:
                            pass
                        # Wait for the old worker to finish
                        try:
                            await asyncio.wait_for(grpc_task, timeout=5)
                        except (asyncio.TimeoutError, Exception):
                            pass
                        # Re-create for next utterance
                        audio_q = queue.Queue()
                        result_q = asyncio.Queue()
                        grpc_task = loop.run_in_executor(
                            None,
                            _grpc_worker,
                            audio_q,
                            result_q,
                            loop,
                            lang,
                            api_key,
                            function_id,
                            session_id,
                        )
                        forward_task = asyncio.create_task(forward_results())

                    elif msg_type == "config":
                        # Re-configure lang mid-session
                        lang = ctrl.get("lang", lang)
                        log.info(
                            f"[asr-stream] Reconfigured: lang={lang} session={session_id}"
                        )

        finally:
            # Client disconnected — stop gRPC worker
            if audio_q is not None:
                audio_q.put(_SENTINEL)
            forward_task.cancel()
            try:
                await forward_task
            except asyncio.CancelledError:
                pass
            if grpc_task is not None:
                try:
                    await asyncio.wait_for(grpc_task, timeout=5)
                except (asyncio.TimeoutError, Exception):
                    pass

    except Exception as exc:
        log.error(f"[asr-stream] Unhandled error session={session_id}: {exc}")
    finally:
        _active_sessions.pop(session_id, None)
        log.info(
            f"[asr-stream] Disconnected: session={session_id} "
            f"frames_received={frames_received}"
        )


# ---------------------------------------------------------------------------
# HTTP /health handler (shared port via process_request)
# ---------------------------------------------------------------------------

def process_request(
    connection: ServerConnection, request: Request
) -> Any | None:
    """Handle plain HTTP requests on the WebSocket port.

    Return a Response to short-circuit the WS handshake, or None to
    continue with the normal WS upgrade.
    """
    path = request.path.split("?", 1)[0]  # strip query string
    if path == "/health":
        uptime = time.monotonic() - _start_time
        body = json.dumps(
            {
                "status": "ok",
                "uptime_s": round(uptime, 2),
                "active_sessions": len(_active_sessions),
            },
            ensure_ascii=False,
        ).encode("utf-8")
        from websockets.http11 import Headers, Response

        headers = Headers(
            [
                ("Content-Type", "application/json; charset=utf-8"),
                ("Content-Length", str(len(body))),
            ]
        )
        return Response(200, "OK", headers, body)
    # Not /health — allow normal WS upgrade (return None)
    return None


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

async def _main() -> None:
    port = DEFAULT_PORT
    api_key = os.getenv("NVIDIA_API_KEY", "")
    if not api_key:
        log.warning("[asr-stream] NVIDIA_API_KEY is not set — gRPC calls will fail")
    else:
        log.info(f"[asr-stream] Starting with {_mask_key(api_key)} function-id={DEFAULT_FUNCTION_ID}")

    # Port-conflict check
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        probe.bind(("127.0.0.1", port))
    except OSError as exc:
        log.error(f"[asr-stream] Port {port} already in use: {exc}")
        sys.exit(1)
    finally:
        probe.close()

    stop_event = asyncio.Event()

    def _handle_sigterm(*_: Any) -> None:
        log.info("[asr-stream] SIGTERM received — shutting down")
        stop_event.set()

    loop = asyncio.get_running_loop()
    loop.add_signal_handler(signal.SIGTERM, _handle_sigterm)
    loop.add_signal_handler(signal.SIGINT, _handle_sigterm)

    async with serve(
        handle_connection,
        "127.0.0.1",
        port,
        process_request=process_request,
        max_size=65536,  # max WS frame size (64 KB)
    ) as server:
        log.info(
            f"[asr-stream] Listening on ws://127.0.0.1:{port}/stream  "
            f"GET /health also available"
        )
        await stop_event.wait()
        log.info("[asr-stream] Closing server")

    log.info("[asr-stream] Server stopped")


def main() -> None:
    asyncio.run(_main())


if __name__ == "__main__":
    main()
