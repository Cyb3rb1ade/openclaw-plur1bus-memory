# Discord-Sprachräume mit Persona / Light — Umsetzungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bernd kommt per `/vc join` oder durch Folgen in Discord-Sprachräume, hört mit Parakeet zu, spricht mit Magpie, verschickt Sprachnachrichten, verwaltet den Server, und in Sprachräumen lässt sich zwischen Persona und Light umschalten.

**Architecture:** OpenClaws eingebauter Discord-Sprachmodus `stt-tts` trägt Sprachräume und Sprachnachrichten. Erkennung läuft über die vorhandene Parakeet-Bridge (Port 8000), Sprachausgabe über eine neue OpenAI-kompatible Magpie-Bridge (Port 8025). PLUR1BUS erkennt Sprachzüge an `ctx.messageProvider === "discord-voice"` und schaltet in Light Recall und Zusatzblöcke ab, wechselt pro Lauf auf Haiku und setzt Thinking der Sprachraum-Sitzungen auf `off`.

**Tech Stack:** Python 3.12 (`/root/.openclaw/venv`, `riva.client`, stdlib `http.server`, `unittest`), ffmpeg, Node 24 ESM (PLUR1BUS, `node --test`), OpenClaw 2026.9.6 Plugin-API, systemd-User-Units.

**Spec:** `docs/superpowers/specs/2026-09-26-discord-voice-persona-light-design.md` (Branch `feat/discord-voice-light`, Worktree `/root/plur1bus-dev-voice-light`).

## Global Constraints

- Nie im Release-Checkout `/root/.openclaw/plur1bus-release` entwickeln; PLUR1BUS-Arbeit nur im Worktree `/root/plur1bus-dev-voice-light`.
- Keine Claude-Attribution in Commits, PRs oder Releases.
- Nie `sessions.patch`/`patchSessionEntry` mit `model`; nur `thinkingLevel` und `reasoningLevel`.
- Bridges binden nur an `127.0.0.1`.
- NVIDIA-Funktions-IDs: Magpie multilingual `877104f7-e885-42b9-8de8-f6e4c6303969`; Parakeet `71203149-d3b7-4460-8231-1be2543a1fca`. Endpunkt `grpc.nvcf.nvidia.com:443`.
- Standardstimme `DE-DE.Leo`; erlaubt sind `DE-DE.Diego`, `DE-DE.Jason`, `DE-DE.Leo`, `DE-DE.Mia`, `DE-DE.Pascal`, `DE-DE.Ray`.
- Discord-IDs: Besitzer `1323072788939935867`, Server `1486678369901744240`, Sprachräume `1486678370434551811` („Allgemein“) und `1518159522076823592` („Test“).
- Light-Modell: `providerOverride: "anthropic"`, `modelOverride: "claude-haiku-4-5"`.
- Deutsche Kommentare und Texte wie im übrigen PLUR1BUS-Code; JSDoc für neue Exporte.
- Tests PLUR1BUS: `node --test <datei>`; volle Suite zweigeteilt (`auto-capture-batch.test.js` separat). Tests Bridges: `/root/.openclaw/venv/bin/python -m unittest`.
- Vor jeder Änderung an `/root/.openclaw/openclaw.json`, Units oder Bridge-Dateien eine Sicherung `*.bak-voice-light-<zeit>` anlegen.
- Kein Deploy und kein Gateway-Neustart ohne Freigabe des Nutzers für das Zeitfenster.

## Review Focus

- Ein Sprachzug trifft ein, während die Modus-Datei fehlt oder kaputt ist → muss als `persona` gelten, nie werfen (Task 4).
- Ein Klick auf einen Light-Knopf von jemand anderem als dem Besitzer → nichts ändert sich, Nachricht bleibt (Task 6).
- Ein sehr langer Antworttext (>2 000 Zeichen) an die Magpie-Bridge → muss satzweise synthetisiert und vollständig zurückkommen, nicht abbrechen (Task 1).
- Ein Sprachzug in Persona → Recall und Modell unverändert wie heute; Light darf nur greifen, wenn Modus `light` UND `messageProvider === "discord-voice"` (Task 5).
- `/voice light` in einem Telegram-Chat oder einer Discord-DM → darf nicht umschalten, weil Light nur für Discord-Sprachräume gilt; Antwort mit Hinweis (Task 6).

---

### Task 1: Magpie-Bridge (OpenAI-kompatible Sprachausgabe, Port 8025)

**Files:**
- Create: `/root/.openclaw/tools/nvidia-riva-bridge/magpie_speech_bridge.py`
- Create: `/root/.openclaw/tools/nvidia-riva-bridge/test_magpie_speech_bridge.py`

**Interfaces:**
- Produces: HTTP `POST http://127.0.0.1:8025/v1/audio/speech`, Body `{"model": str, "input": str, "voice": str, "response_format": "opus"|"mp3"|"wav"|"pcm", "speed"?: number}` → Rohaudio (`audio/ogg`, `audio/mpeg`, `audio/wav`, `audio/L16`). `GET /health` → `{"ok": true}`. Fehler: JSON `{"error": {"message", "type"}}` mit 400/502.
- Python-Funktionen für Tests: `split_sentences(text: str, max_chars: int = 400) -> list[str]`, `resolve_voice(requested: str | None) -> str`, `encode_audio(pcm: bytes, sample_rate: int, fmt: str) -> tuple[bytes, str]`, `synthesize_text(text: str, voice: str, synth) -> bytes` (synth = Callable `(text, voice) -> bytes` PCM).

- [ ] **Step 1: Write the failing test**

```python
# /root/.openclaw/tools/nvidia-riva-bridge/test_magpie_speech_bridge.py
import unittest
import magpie_speech_bridge as m


class SplitTests(unittest.TestCase):
    def test_short_text_stays_one_chunk(self):
        self.assertEqual(m.split_sentences("Hallo Christian."), ["Hallo Christian."])

    def test_long_text_splits_on_sentence_ends_and_keeps_everything(self):
        text = " ".join(f"Satz Nummer {i} ist hier." for i in range(200))
        chunks = m.split_sentences(text, max_chars=400)
        self.assertTrue(all(len(c) <= 400 for c in chunks))
        self.assertEqual(" ".join(chunks).split(), text.split())

    def test_overlong_sentence_is_cut_on_words(self):
        word = "Wort "
        chunks = m.split_sentences(word * 300, max_chars=100)
        self.assertTrue(all(len(c) <= 100 for c in chunks))
        self.assertEqual(sum(c.count("Wort") for c in chunks), 300)

    def test_empty_text_yields_nothing(self):
        self.assertEqual(m.split_sentences("   "), [])


class VoiceTests(unittest.TestCase):
    def test_known_voice_passes(self):
        self.assertEqual(m.resolve_voice("DE-DE.Mia"), "Magpie-Multilingual.DE-DE.Mia")

    def test_short_name_maps_to_german_voice(self):
        self.assertEqual(m.resolve_voice("mia"), "Magpie-Multilingual.DE-DE.Mia")

    def test_unknown_or_openai_voice_falls_back_to_default(self):
        self.assertEqual(m.resolve_voice("coral"), f"Magpie-Multilingual.{m.DEFAULT_VOICE}")
        self.assertEqual(m.resolve_voice(None), f"Magpie-Multilingual.{m.DEFAULT_VOICE}")


class SynthesizeTests(unittest.TestCase):
    def test_concatenates_chunks_in_order(self):
        calls = []

        def fake(text, voice):
            calls.append((text, voice))
            return text.encode()[:2]

        text = "Erster Satz. Zweiter Satz."
        pcm = m.synthesize_text(text, "Magpie-Multilingual.DE-DE.Leo", fake, max_chars=12)
        self.assertEqual([c[0] for c in calls], ["Erster Satz.", "Zweiter Satz."])
        self.assertEqual(pcm, b"ErZw")

    def test_encode_pcm_and_wav_without_ffmpeg_errors(self):
        pcm = b"\x00\x00" * 2205
        raw, ctype = m.encode_audio(pcm, 22050, "pcm")
        self.assertEqual((raw, ctype), (pcm, "audio/L16; rate=22050; channels=1"))
        wav, ctype = m.encode_audio(pcm, 22050, "wav")
        self.assertTrue(wav.startswith(b"RIFF"))
        self.assertEqual(ctype, "audio/wav")

    def test_encode_opus_produces_ogg(self):
        ogg, ctype = m.encode_audio(b"\x00\x00" * 22050, 22050, "opus")
        self.assertTrue(ogg.startswith(b"OggS"))
        self.assertEqual(ctype, "audio/ogg")

    def test_unknown_format_is_rejected(self):
        with self.assertRaises(ValueError):
            m.encode_audio(b"\x00\x00", 22050, "flac")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /root/.openclaw/tools/nvidia-riva-bridge && /root/.openclaw/venv/bin/python -m unittest test_magpie_speech_bridge -v`
Expected: FAIL mit `ModuleNotFoundError: No module named 'magpie_speech_bridge'`.

- [ ] **Step 3: Write minimal implementation**

```python
#!/usr/bin/env python3
"""
magpie_speech_bridge.py — OpenAI-kompatible Sprachausgabe vor NVIDIA Magpie TTS.

POST /v1/audio/speech {model, input, voice, response_format} → Audio.
Der OpenClaw-Anbieter "openai" mit baseUrl http://127.0.0.1:8025/v1 nutzt das
für Discord-Sprachräume (stt-tts) und Discord-Sprachnachrichten. Discord
verlangt response_format "opus" (Ogg/Opus).
"""
from __future__ import annotations

import io
import json
import os
import re
import subprocess
import sys
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable
from urllib.parse import urlparse

BIND = os.getenv("MAGPIE_BIND", "127.0.0.1")
PORT = int(os.getenv("MAGPIE_PORT", "8025"))
SERVER = os.getenv("MAGPIE_SERVER", "grpc.nvcf.nvidia.com:443")
FUNCTION_ID = os.getenv("MAGPIE_FUNCTION_ID", "877104f7-e885-42b9-8de8-f6e4c6303969")
LANGUAGE = os.getenv("MAGPIE_LANGUAGE", "de-DE")
SAMPLE_RATE = int(os.getenv("MAGPIE_SAMPLE_RATE", "22050"))
MAX_CHARS = int(os.getenv("MAGPIE_MAX_CHARS", "400"))
MAX_INPUT = int(os.getenv("MAGPIE_MAX_INPUT", "20000"))
VOICES = ("DE-DE.Diego", "DE-DE.Jason", "DE-DE.Leo", "DE-DE.Mia", "DE-DE.Pascal", "DE-DE.Ray")
DEFAULT_VOICE = os.getenv("MAGPIE_DEFAULT_VOICE", "DE-DE.Leo")
VOICE_PREFIX = "Magpie-Multilingual."

_SENTENCE_END = re.compile(r"(?<=[.!?…])\s+")


def split_sentences(text: str, max_chars: int = MAX_CHARS) -> list[str]:
    """Teilt Text an Satzenden in Stücke von höchstens max_chars Zeichen."""
    text = " ".join(str(text or "").split())
    if not text:
        return []
    chunks: list[str] = []
    current = ""
    for sentence in _SENTENCE_END.split(text):
        pieces = [sentence]
        if len(sentence) > max_chars:
            pieces, word_buf = [], ""
            for word in sentence.split(" "):
                if word_buf and len(word_buf) + 1 + len(word) > max_chars:
                    pieces.append(word_buf)
                    word_buf = word
                else:
                    word_buf = f"{word_buf} {word}".strip()
            if word_buf:
                pieces.append(word_buf)
        for piece in pieces:
            if current and len(current) + 1 + len(piece) > max_chars:
                chunks.append(current)
                current = piece
            else:
                current = f"{current} {piece}".strip()
    if current:
        chunks.append(current)
    return chunks


def resolve_voice(requested: str | None) -> str:
    """Bildet eine angefragte Stimme auf eine deutsche Magpie-Stimme ab."""
    name = str(requested or "").strip()
    if name.startswith(VOICE_PREFIX):
        name = name[len(VOICE_PREFIX):]
    for voice in VOICES:
        if name.lower() in (voice.lower(), voice.split(".")[1].lower()):
            return VOICE_PREFIX + voice
    return VOICE_PREFIX + DEFAULT_VOICE


def synthesize_text(text: str, voice: str, synth: Callable[[str, str], bytes], max_chars: int = MAX_CHARS) -> bytes:
    """Synthetisiert satzweise und fügt das PCM in Reihenfolge zusammen."""
    return b"".join(synth(chunk, voice) for chunk in split_sentences(text, max_chars))


def _wav(pcm: bytes, sample_rate: int) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm)
    return buf.getvalue()


def encode_audio(pcm: bytes, sample_rate: int, fmt: str) -> tuple[bytes, str]:
    """Wandelt 16-bit-Mono-PCM in das angefragte Format."""
    fmt = (fmt or "opus").lower()
    if fmt == "pcm":
        return pcm, f"audio/L16; rate={sample_rate}; channels=1"
    if fmt == "wav":
        return _wav(pcm, sample_rate), "audio/wav"
    if fmt not in ("opus", "mp3"):
        raise ValueError(f"unsupported response_format: {fmt}")
    args = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "s16le", "-ar", str(sample_rate), "-ac", "1", "-i", "pipe:0"]
    if fmt == "opus":
        args += ["-c:a", "libopus", "-b:a", "48k", "-f", "ogg", "pipe:1"]
        ctype = "audio/ogg"
    else:
        args += ["-c:a", "libmp3lame", "-b:a", "96k", "-f", "mp3", "pipe:1"]
        ctype = "audio/mpeg"
    out = subprocess.run(args, input=pcm, capture_output=True, timeout=60, check=True)
    return out.stdout, ctype


def _riva_synth_factory(api_key: str) -> Callable[[str, str], bytes]:
    import riva.client

    auth = riva.client.Auth(
        use_ssl=True,
        uri=SERVER,
        metadata_args=[["function-id", FUNCTION_ID], ["authorization", f"Bearer {api_key}"]],
    )
    service = riva.client.SpeechSynthesisService(auth)

    def synth(text: str, voice: str) -> bytes:
        resp = service.synthesize(
            text,
            voice_name=voice,
            language_code=LANGUAGE,
            encoding=riva.client.AudioEncoding.LINEAR_PCM,
            sample_rate_hz=SAMPLE_RATE,
        )
        return resp.audio

    return synth


class MagpieHandler(BaseHTTPRequestHandler):
    server_version = "magpie-speech-bridge/1.0"

    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error(self, code: int, message: str, kind: str) -> None:
        self._json(code, {"error": {"message": message, "type": kind}})

    def log_message(self, fmt, *args):  # noqa: N802 - stdlib-Signatur
        sys.stderr.write(f"[magpie-speech-bridge] {fmt % args}\n")

    def do_GET(self) -> None:  # noqa: N802
        if urlparse(self.path).path == "/health":
            self._json(200, {"ok": True, "voice": DEFAULT_VOICE})
        else:
            self._error(404, "Not found", "not_found")

    def do_POST(self) -> None:  # noqa: N802
        if urlparse(self.path).path not in ("/v1/audio/speech", "/audio/speech"):
            self._error(404, "Not found", "not_found")
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(min(length, 1_000_000)) or b"{}")
        except (ValueError, json.JSONDecodeError):
            self._error(400, "Expected a JSON body", "invalid_request_error")
            return
        text = str(body.get("input") or "")
        if not text.strip():
            self._error(400, "input is empty", "invalid_request_error")
            return
        if len(text) > MAX_INPUT:
            self._error(400, f"input longer than {MAX_INPUT} characters", "invalid_request_error")
            return
        fmt = str(body.get("response_format") or "opus").lower()
        api_key = os.getenv("NVIDIA_API_KEY", "").strip()
        if not api_key:
            self._error(502, "NVIDIA_API_KEY is not set for the bridge", "server_error")
            return
        try:
            pcm = synthesize_text(text, resolve_voice(body.get("voice")), _riva_synth_factory(api_key))
            audio, ctype = encode_audio(pcm, SAMPLE_RATE, fmt)
        except ValueError as err:
            self._error(400, str(err), "invalid_request_error")
            return
        except Exception as err:  # grpc.RpcError, ffmpeg, Netzwerk
            sys.stderr.write(f"[magpie-speech-bridge] synthesis failed: {err}\n")
            self._error(502, f"Magpie synthesis failed: {str(err)[:300]}", "server_error")
            return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(audio)))
        self.end_headers()
        self.wfile.write(audio)


def main() -> None:
    server = ThreadingHTTPServer((BIND, PORT), MagpieHandler)
    sys.stderr.write(f"[magpie-speech-bridge] listening on {BIND}:{PORT} (function-id={FUNCTION_ID}, voice={DEFAULT_VOICE})\n")
    server.serve_forever()


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /root/.openclaw/tools/nvidia-riva-bridge && /root/.openclaw/venv/bin/python -m unittest test_magpie_speech_bridge -v`
Expected: 11 Tests OK.

- [ ] **Step 5: Live-Probe gegen NVIDIA (einmalig, kein Dienst)**

```bash
cd /root/.openclaw/tools/nvidia-riva-bridge && set -a && . /root/.openclaw/.env.nemotron && set +a && \
MAGPIE_PORT=18025 /root/.openclaw/venv/bin/python magpie_speech_bridge.py & sleep 2; \
curl -s -o /tmp/magpie-probe.ogg -w "%{http_code} %{size_download}\n" -H 'Content-Type: application/json' \
  -d '{"model":"magpie","input":"Hallo Christian, hier spricht Bernd. Das ist ein Test.","voice":"DE-DE.Leo","response_format":"opus"}' \
  http://127.0.0.1:18025/v1/audio/speech; kill %1; ffprobe -v error -show_entries format=duration,format_name /tmp/magpie-probe.ogg
```
Expected: `200 <Bytes>`, `format_name=ogg`, Dauer zwischen 2 und 8 Sekunden.

- [ ] **Step 6: Sicherung (Verzeichnis ist kein Git-Repo)**

```bash
cd /root/.openclaw/tools/nvidia-riva-bridge && cp magpie_speech_bridge.py magpie_speech_bridge.py.bak-voice-light-$(date +%Y%m%d-%H%M%S)
```

### Task 2: Parakeet-Bridge überspringt die Sprechererkennung für Discord-Stücke

**Files:**
- Modify: `/root/.openclaw/tools/nvidia-riva-bridge/parakeet_stt_bridge.py` (Zeilen um `raw_diarize = _get_form_value(form, "diarize")`, derzeit 528–529)
- Create: `/root/.openclaw/tools/nvidia-riva-bridge/test_parakeet_segment_diarize.py`

**Interfaces:**
- Produces: `resolve_diarize(raw_diarize: str | None, filename: str | None, default: bool) -> bool` in `parakeet_stt_bridge.py`.

- [ ] **Step 1: Sicherung anlegen**

```bash
cd /root/.openclaw/tools/nvidia-riva-bridge && cp parakeet_stt_bridge.py parakeet_stt_bridge.py.bak-voice-light-$(date +%Y%m%d-%H%M%S)
```

- [ ] **Step 2: Write the failing test**

```python
# /root/.openclaw/tools/nvidia-riva-bridge/test_parakeet_segment_diarize.py
import unittest
import parakeet_stt_bridge as p


class ResolveDiarizeTests(unittest.TestCase):
    def test_discord_segment_skips_diarization_by_default(self):
        self.assertFalse(p.resolve_diarize(None, "segment.wav", True))

    def test_explicit_field_wins_for_segment(self):
        self.assertTrue(p.resolve_diarize("1", "segment.wav", True))

    def test_other_files_keep_the_default(self):
        self.assertTrue(p.resolve_diarize(None, "voice-note.ogg", True))
        self.assertFalse(p.resolve_diarize(None, "voice-note.ogg", False))
        self.assertTrue(p.resolve_diarize(None, None, True))


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd /root/.openclaw/tools/nvidia-riva-bridge && /root/.openclaw/venv/bin/python -m unittest test_parakeet_segment_diarize -v`
Expected: FAIL mit `AttributeError: module 'parakeet_stt_bridge' has no attribute 'resolve_diarize'`.

- [ ] **Step 4: Implement**

Neue Funktion direkt nach `_parse_bool` einfügen:

```python
# Der Discord-Sprachmodus (stt-tts) schickt jedes Sprecherstück als
# "segment.wav". Es gehört genau einem Sprecher; die Sprechererkennung kostet
# dort nur Zeit. Ein ausdrückliches diarize-Feld gewinnt weiterhin.
DISCORD_SEGMENT_FILENAME = "segment.wav"


def resolve_diarize(raw_diarize: str | None, filename: str | None, default: bool) -> bool:
    if raw_diarize is not None:
        return _parse_bool(raw_diarize)
    if (filename or "").strip().lower() == DISCORD_SEGMENT_FILENAME:
        return False
    return default
```

Und im Handler die bisherigen zwei Zeilen

```python
        raw_diarize = _get_form_value(form, "diarize")
        diarize = _parse_bool(raw_diarize) if raw_diarize is not None else DIARIZE_DEFAULT
```

ersetzen durch

```python
        raw_diarize = _get_form_value(form, "diarize")
        upload = form["file"] if "file" in form else None
        upload_name = getattr(upload, "filename", None) if upload is not None else None
        diarize = resolve_diarize(raw_diarize, upload_name, DIARIZE_DEFAULT)
```

- [ ] **Step 5: Run tests**

Run: `cd /root/.openclaw/tools/nvidia-riva-bridge && /root/.openclaw/venv/bin/python -m unittest test_parakeet_segment_diarize -v && /root/.openclaw/venv/bin/python -c "import parakeet_stt_bridge"`
Expected: 3 Tests OK, Import ohne Fehler.

- [ ] **Step 6: Bridge neu starten und prüfen**

```bash
systemctl --user restart parakeet-stt-bridge && sleep 3 && systemctl --user is-active parakeet-stt-bridge && curl -s http://127.0.0.1:8000/health
```
Expected: `active` und eine Health-Antwort. (Die Bridge ist unabhängig vom Gateway; Neustart unterbricht nur eine laufende Sprachnachricht-Erkennung.)

### Task 3: systemd-Units: Magpie-Bridge an, tote Dienste aus

**Files:**
- Modify: `/root/.config/systemd/user/magpie-tts-bridge.service`
- Rename: `/root/.config/systemd/user/nemotron-asr-stream.service` → `…service.disabled`
- Rename: `/root/.config/systemd/user/discord-voice-stt.service` → `…service.disabled`

**Interfaces:**
- Consumes: `magpie_speech_bridge.py` aus Task 1.
- Produces: laufender Dienst `magpie-tts-bridge` auf `127.0.0.1:8025`.

- [ ] **Step 1: Sicherungen**

```bash
cd /root/.config/systemd/user && for u in magpie-tts-bridge nemotron-asr-stream discord-voice-stt; do cp $u.service $u.service.bak-voice-light-$(date +%Y%m%d-%H%M%S); done
```

- [ ] **Step 2: Unit neu schreiben**

```ini
# /root/.config/systemd/user/magpie-tts-bridge.service
[Unit]
Description=NVIDIA Magpie TTS bridge (OpenAI /v1/audio/speech, port 8025)
After=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory=/root/.openclaw/tools/nvidia-riva-bridge
EnvironmentFile=/root/.openclaw/.env.nemotron
Environment=MAGPIE_PORT=8025
Environment=MAGPIE_FUNCTION_ID=877104f7-e885-42b9-8de8-f6e4c6303969
Environment=MAGPIE_DEFAULT_VOICE=DE-DE.Leo
ExecStart=/root/.openclaw/venv/bin/python /root/.openclaw/tools/nvidia-riva-bridge/magpie_speech_bridge.py
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
```

- [ ] **Step 3: Tote Dienste stilllegen, Magpie starten**

```bash
systemctl --user disable --now discord-voice-stt nemotron-asr-stream; \
cd /root/.config/systemd/user && mv discord-voice-stt.service discord-voice-stt.service.disabled && mv nemotron-asr-stream.service nemotron-asr-stream.service.disabled; \
systemctl --user daemon-reload && systemctl --user reset-failed && systemctl --user enable --now magpie-tts-bridge && sleep 3 && \
systemctl --user is-active magpie-tts-bridge && curl -s http://127.0.0.1:8025/health
```
Expected: `active`, `{"ok": true, "voice": "DE-DE.Leo"}`.

- [ ] **Step 4: Live-Test und Syslog-Ruhe**

```bash
curl -s -o /tmp/magpie-live.ogg -w "%{http_code}\n" -H 'Content-Type: application/json' -d '{"input":"Bernd ist bereit.","voice":"DE-DE.Leo","response_format":"opus"}' http://127.0.0.1:8025/v1/audio/speech; \
sleep 60; grep -cE "discord-voice-stt|nemotron-asr-stream|magpie-tts-bridge.service: (Failed|Main process exited)" <(journalctl --user --since "-1min" --no-pager)
```
Expected: `200`, Zähler `0`.

### Task 4: PLUR1BUS — Modus-Speicher und Erkennung von Sprachzügen

**Files:**
- Create: `lib/voice-mode.js`
- Create: `tests/voice-mode.test.js`
- Modify: `scripts/lib/deploy-integrity.mjs` (DEPLOY_FILES: `"lib/voice-mode.js"` neben `"lib/critical-buttons.js"`)

**Interfaces:**
- Produces:
  - `VOICE_MODES = ["persona", "light"]`
  - `voiceModeFile(baseDbPath: string, agentId: string) -> string`
  - `readVoiceMode(baseDbPath: string, agentId: string) -> "persona"|"light"` (nie werfend)
  - `writeVoiceMode(baseDbPath: string, agentId: string, mode: "persona"|"light", meta?: {by?: string}) -> {mode, changedAt}`
  - `isDiscordVoiceTurn(ctx: object) -> boolean`
  - `isLightVoiceTurn(ctx: object, baseDbPath: string) -> boolean`
  - `voiceSessionKeys(agentId: string, config: object) -> string[]` (aus `channels.discord.voice.allowedChannels`)
  - `LIGHT_VOICE_GUIDANCE: string`
  - `LIGHT_MODEL = {providerOverride: "anthropic", modelOverride: "claude-haiku-4-5"}`

- [ ] **Step 1: Write the failing test**

```js
// tests/voice-mode.test.js
// Persona/Light für Discord-Sprachräume: Modus-Speicher und Erkennung (7.17.0).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { test } from "node:test";
import {
  isDiscordVoiceTurn,
  isLightVoiceTurn,
  readVoiceMode,
  voiceModeFile,
  voiceSessionKeys,
  writeVoiceMode,
} from "../lib/voice-mode.js";

function tempBase(t) {
  const dir = mkdtempSync(join(tmpdir(), "plur1bus-voice-mode-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("defaults to persona without a file and with a broken file", (t) => {
  const base = tempBase(t);
  assert.equal(readVoiceMode(base, "main"), "persona");
  mkdirSync(dirname(voiceModeFile(base, "main")), { recursive: true });
  writeFileSync(voiceModeFile(base, "main"), "{kaputt");
  assert.equal(readVoiceMode(base, "main"), "persona");
  writeFileSync(voiceModeFile(base, "main"), JSON.stringify({ mode: "turbo" }));
  assert.equal(readVoiceMode(base, "main"), "persona");
});

test("writes and reads light and persona per agent", (t) => {
  const base = tempBase(t);
  const written = writeVoiceMode(base, "main", "light", { by: "discord:1323072788939935867" });
  assert.equal(written.mode, "light");
  assert.equal(readVoiceMode(base, "main"), "light");
  assert.equal(readVoiceMode(base, "bernhardine"), "persona", "modes are per agent");
  writeVoiceMode(base, "main", "persona");
  assert.equal(readVoiceMode(base, "main"), "persona");
  assert.throws(() => writeVoiceMode(base, "main", "turbo"), /mode/);
  assert.throws(() => writeVoiceMode(base, "../x", "light"), /agent/i);
});

test("recognises Discord voice turns only by the discord-voice provider", () => {
  assert.equal(isDiscordVoiceTurn({ messageProvider: "discord-voice" }), true);
  assert.equal(isDiscordVoiceTurn({ messageProvider: "discord" }), false);
  assert.equal(isDiscordVoiceTurn({ messageProvider: "telegram" }), false);
  assert.equal(isDiscordVoiceTurn(undefined), false);
});

test("light applies only to a voice turn while the agent's mode is light", (t) => {
  const base = tempBase(t);
  const voice = { agentId: "main", messageProvider: "discord-voice" };
  assert.equal(isLightVoiceTurn(voice, base), false);
  writeVoiceMode(base, "main", "light");
  assert.equal(isLightVoiceTurn(voice, base), true);
  assert.equal(isLightVoiceTurn({ ...voice, messageProvider: "discord" }, base), false);
  assert.equal(isLightVoiceTurn({ ...voice, agentId: "bernhardine" }, base), false);
});

test("derives the voice session keys from the allowed voice channels", () => {
  const config = { channels: { discord: { voice: { allowedChannels: [
    { guildId: "1486678369901744240", channelId: "1486678370434551811" },
    { guildId: "1486678369901744240", channelId: "1518159522076823592" },
  ] } } } };
  assert.deepEqual(voiceSessionKeys("main", config), [
    "agent:main:discord:channel:1486678370434551811",
    "agent:main:discord:channel:1518159522076823592",
  ]);
  assert.deepEqual(voiceSessionKeys("main", {}), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /root/plur1bus-dev-voice-light && node --test tests/voice-mode.test.js`
Expected: FAIL mit `Cannot find module '../lib/voice-mode.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// lib/voice-mode.js
/**
 * lib/voice-mode.js — Persona/Light für Discord-Sprachräume (7.17.0).
 *
 * Der Modus gilt je Agent und nur für Sprachzüge (messageProvider
 * "discord-voice"). Light lässt Auto-Recall und alle Zusatzblöcke weg, nimmt
 * pro Lauf ein schnelles Modell und setzt Thinking der Sprachraum-Sitzungen
 * auf off. Speichern (agent_end) läuft in beiden Modi weiter.
 */
import { join } from "node:path";
import { readJsonSafe, writeJsonAtomic } from "./atomic-file.js";
import { safeAgentId } from "./sql-safety.js";

export const VOICE_MODES = Object.freeze(["persona", "light"]);

export const LIGHT_MODEL = Object.freeze({ providerOverride: "anthropic", modelOverride: "claude-haiku-4-5" });

export const LIGHT_VOICE_GUIDANCE = [
  "<voice-light-mode>",
  "Du sprichst gerade in einem Discord-Sprachraum im Light-Modus: antworte kurz, gesprochen und ohne Listen oder Markdown.",
  "Es ist kein Gedächtnis vorgeladen. Wenn die Frage Erinnerungen braucht, nutze memory_recall und antworte danach knapp.",
  "</voice-light-mode>",
].join("\n");

/**
 * Pfad der Modus-Datei eines Agenten.
 * @param {string} baseDbPath
 * @param {string} agentId
 * @returns {string}
 */
export function voiceModeFile(baseDbPath, agentId) {
  return join(baseDbPath, ".plur1bus-voice-mode", `${safeAgentId(agentId)}.json`);
}

/**
 * Liest den Modus; fehlend, kaputt oder unbekannt gilt als "persona".
 * @param {string} baseDbPath
 * @param {string} agentId
 * @returns {"persona"|"light"}
 */
export function readVoiceMode(baseDbPath, agentId) {
  try {
    const data = readJsonSafe(voiceModeFile(baseDbPath, agentId), {});
    return data?.mode === "light" ? "light" : "persona";
  } catch {
    return "persona";
  }
}

/**
 * Schreibt den Modus atomar.
 * @param {string} baseDbPath
 * @param {string} agentId
 * @param {"persona"|"light"} mode
 * @param {{by?: string}} [meta]
 * @returns {{mode: string, changedAt: string}}
 */
export function writeVoiceMode(baseDbPath, agentId, mode, meta = {}) {
  if (!VOICE_MODES.includes(mode)) throw new Error(`invalid voice mode: ${mode}`);
  const record = { mode, changedAt: new Date().toISOString(), ...(meta.by ? { by: String(meta.by) } : {}) };
  writeJsonAtomic(voiceModeFile(baseDbPath, agentId), record);
  return record;
}

/**
 * Stammt der Lauf aus einem Discord-Sprachraum?
 * @param {object} ctx - Hook-Kontext
 * @returns {boolean}
 */
export function isDiscordVoiceTurn(ctx) {
  return ctx?.messageProvider === "discord-voice";
}

/**
 * Sprachzug eines Agenten im Light-Modus?
 * @param {object} ctx - Hook-Kontext mit agentId und messageProvider
 * @param {string} baseDbPath
 * @returns {boolean}
 */
export function isLightVoiceTurn(ctx, baseDbPath) {
  if (!isDiscordVoiceTurn(ctx)) return false;
  const agentId = ctx?.agentId || "main";
  try {
    return readVoiceMode(baseDbPath, agentId) === "light";
  } catch {
    return false;
  }
}

/**
 * Sitzungsschlüssel der erlaubten Sprachräume (Host-Format
 * agent:<agent>:discord:channel:<Sprachraum-ID>).
 * @param {string} agentId
 * @param {object} config - OpenClaw-Konfiguration
 * @returns {string[]}
 */
export function voiceSessionKeys(agentId, config) {
  const channels = config?.channels?.discord?.voice?.allowedChannels;
  if (!Array.isArray(channels)) return [];
  return channels
    .map((entry) => String(entry?.channelId || "").trim())
    .filter((id) => /^\d{5,25}$/.test(id))
    .map((id) => `agent:${agentId}:discord:channel:${id}`);
}
```

Hinweis für die Umsetzung: `readJsonSafe`/`writeJsonAtomic` liegen in `lib/atomic-file.js`, `safeAgentId` in `lib/sql-safety.js` (so importiert auch `lib/setup/feature-cron-plugin-runtime.js`).

- [ ] **Step 4: Run tests**

Run: `node --test tests/voice-mode.test.js`
Expected: 5 Tests grün.

- [ ] **Step 5: DEPLOY_FILES ergänzen und prüfen**

In `scripts/lib/deploy-integrity.mjs` nach `"lib/critical-button-delivery.js",` einfügen:

```js
  // 7.17.0: Persona/Light für Discord-Sprachräume.
  "lib/voice-mode.js",
```

Run: `node --test tests/deploy-integrity.test.js tests/deploy-manifest-covers-shipped-scripts.test.js`
Expected: grün.

- [ ] **Step 6: Commit**

```bash
git add lib/voice-mode.js tests/voice-mode.test.js scripts/lib/deploy-integrity.mjs
git commit -m "feat(voice): Modus-Speicher Persona/Light und Erkennung von Discord-Sprachzügen"
```

### Task 5: PLUR1BUS — Light in den Prompt-Hooks und pro Lauf Haiku

**Files:**
- Modify: `index.js` — Import-Block (bei den anderen `./lib/`-Importen), Haupt-Hook `before_prompt_build` (beginnt `api.on("before_prompt_build", async (event, ctx) => {` mit `const background = isBackgroundTurn(event, ctx);`), Neben-Hook im `else if (neoEnabled || schicht15Enabled || gcEnabled)`-Zweig, neue Registrierung `before_model_resolve` direkt nach dem Haupt-Hook-Block.
- Create: `tests/voice-light-hooks.test.js`

**Interfaces:**
- Consumes: `isLightVoiceTurn`, `LIGHT_VOICE_GUIDANCE`, `LIGHT_MODEL` aus Task 4.
- Produces: Hook-Verhalten: Light-Sprachzug → `before_prompt_build` liefert genau `{ prependContext: LIGHT_VOICE_GUIDANCE }`; `before_model_resolve` liefert `LIGHT_MODEL`; sonst unverändert bzw. `undefined`.

- [ ] **Step 1: Write the failing test**

```js
// tests/voice-light-hooks.test.js
// Light lässt Recall und Zusatzblöcke weg und nimmt pro Lauf Haiku — nur für
// Discord-Sprachzüge im Light-Modus (7.17.0).
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { LIGHT_MODEL, LIGHT_VOICE_GUIDANCE, writeVoiceMode } from "../lib/voice-mode.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const routingCapability = Object.freeze({
  parseAgentSessionKey(value) {
    const match = /^agent:([^:]+):(.+)$/.exec(value);
    return match ? { agentId: match[1], rest: match[2] } : null;
  },
  parseThreadSessionSuffix(value) { return { baseSessionKey: value, threadId: "" }; },
  normalizeOptionalAccountId(value) { return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined; },
  normalizeMessageChannel(value) { return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined; },
});

async function register(t, overrides = {}) {
  const baseDbPath = makeTempDir("plur1bus-voice-light-");
  t.after(() => rmSync(baseDbPath, { recursive: true, force: true }));
  const handlers = new Map();
  const api = {
    pluginConfig: {
      baseDbPath,
      embedding: { provider: "local-transformers", local: { dimensions: 384 } },
      autoCapture: false,
      autoRecall: true,
      neo: { enabled: false },
      obsidianBridge: { enabled: false },
      featureCronSetup: { auto: false },
      gc: { enabled: false },
      ...overrides,
    },
    logger: { debug() {}, error() {}, info() {}, warn() {} },
    runtime: { agent: { async resolveAgentWorkspaceDir() { return baseDbPath; } } },
    resolvePath: (v) => v,
    registerCommand() {}, registerTool() {}, registerService() {},
    on(name, fn) { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(fn); },
  };
  const mod = await import(`../index.js?voice-light=${Date.now()}-${Math.random()}`);
  mod.default.register(api, { importRouting: async () => routingCapability });
  return { baseDbPath, handlers };
}

const voiceCtx = { agentId: "main", messageProvider: "discord-voice", sessionKey: "agent:main:discord:channel:1518159522076823592" };

test("a light voice turn gets only the light guidance and no recall", async (t) => {
  const { baseDbPath, handlers } = await register(t);
  writeVoiceMode(baseDbPath, "main", "light");
  const recall = handlers.get("before_prompt_build").at(-1);
  const result = await recall({ prompt: "Was habe ich gestern gegessen?", messages: [] }, voiceCtx);
  assert.deepEqual(result, { prependContext: LIGHT_VOICE_GUIDANCE });
});

test("a persona voice turn and a light text turn keep the normal hook path", async (t) => {
  const { baseDbPath, handlers } = await register(t);
  const recall = handlers.get("before_prompt_build").at(-1);
  const persona = await recall({ prompt: "Hallo", messages: [] }, voiceCtx);
  assert.notDeepEqual(persona, { prependContext: LIGHT_VOICE_GUIDANCE });
  writeVoiceMode(baseDbPath, "main", "light");
  const text = await recall({ prompt: "Hallo", messages: [] }, { ...voiceCtx, messageProvider: "discord" });
  assert.notDeepEqual(text, { prependContext: LIGHT_VOICE_GUIDANCE });
});

test("before_model_resolve switches to Haiku only for light voice turns", async (t) => {
  const { baseDbPath, handlers } = await register(t);
  const resolve = handlers.get("before_model_resolve")?.at(-1);
  assert.equal(typeof resolve, "function", "the plugin registers before_model_resolve");
  assert.equal(await resolve({ prompt: "x" }, voiceCtx), undefined, "persona keeps the agent model");
  writeVoiceMode(baseDbPath, "main", "light");
  assert.deepEqual(await resolve({ prompt: "x" }, voiceCtx), LIGHT_MODEL);
  assert.equal(await resolve({ prompt: "x" }, { ...voiceCtx, messageProvider: "telegram" }), undefined);
});

test("with auto-recall off the maintenance hook also stays quiet for light voice turns", async (t) => {
  const { baseDbPath, handlers } = await register(t, { autoRecall: false, neo: { enabled: true } });
  writeVoiceMode(baseDbPath, "main", "light");
  const hook = handlers.get("before_prompt_build").at(-1);
  assert.deepEqual(await hook({ prompt: "x", messages: [] }, voiceCtx), { prependContext: LIGHT_VOICE_GUIDANCE });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/voice-light-hooks.test.js`
Expected: FAIL (erster Test liefert die normale Recall-Antwort; dritter: `before_model_resolve` fehlt).

- [ ] **Step 3: Implement**

Import in `index.js` bei den `./lib/`-Importen:

```js
import { isLightVoiceTurn, LIGHT_MODEL, LIGHT_VOICE_GUIDANCE } from "./lib/voice-mode.js";
```

Haupt-Hook: direkt nach der Zeile
`if (ctx?.workspaceDir && !automaticWorkspacePolicyDecision(event, ctx).allowed) return undefined;`
einfügen:

```js
        // 7.17.0: Light in Discord-Sprachräumen — kein Recall, keine
        // Zusatzblöcke, nur die kurze Sprach-Anweisung. Capture bleibt.
        if (isLightVoiceTurn(ctx, baseDbPath)) return { prependContext: LIGHT_VOICE_GUIDANCE };
```

Neben-Hook (Zweig `else if (neoEnabled || schicht15Enabled || gcEnabled)`): direkt nach
`if (!automaticWorkspacePolicyDecision(_event, ctx).allowed) return undefined;`
einfügen:

```js
        if (isLightVoiceTurn(ctx, baseDbPath)) return { prependContext: LIGHT_VOICE_GUIDANCE };
```

Neue Registrierung unmittelbar nach dem Ende des `if (cfg.autoRecall !== false) { … } else if (…) { … }`-Blocks (also außerhalb beider Zweige, damit sie immer gilt):

```js
    // 7.17.0: Light-Sprachzüge laufen pro Lauf auf Haiku. Nie per
    // sessions.patch mit model — das schriebe die Agent-Konfiguration um.
    if (typeof api.on === "function") {
      api.on("before_model_resolve", async (_event, ctx) => {
        try {
          return isLightVoiceTurn(ctx, baseDbPath) ? { ...LIGHT_MODEL } : undefined;
        } catch (error) {
          api.logger?.warn?.(`memory-lancedb-namespaced: voice light model override failed: ${error?.message || error}`);
          return undefined;
        }
      });
    }
```

- [ ] **Step 4: Run tests**

Run: `node --test tests/voice-light-hooks.test.js tests/voice-mode.test.js tests/auto-recall-decision-trace.test.js tests/runtime-config-contract.test.js`
Expected: alle grün.

- [ ] **Step 5: Commit**

```bash
git add index.js tests/voice-light-hooks.test.js
git commit -m "feat(voice): Light lässt Recall weg und nimmt pro Lauf Haiku"
```

### Task 6: PLUR1BUS — Umschalten per `/voice` und Knöpfen

**Files:**
- Create: `lib/voice-mode-switch.js`
- Create: `tests/voice-mode-switch.test.js`
- Modify: `index.js` — neuer Block direkt nach dem Critical-Hook-Block (`for (const hookName of ["before_dispatch", "before_agent_reply"]) { … api.on(hookName, answerQuotedCriticalReply) … }`), eigener `if`-Block
- Modify: `scripts/lib/deploy-integrity.mjs` (DEPLOY_FILES `"lib/voice-mode-switch.js"`)

**Interfaces:**
- Consumes: `readVoiceMode`, `writeVoiceMode`, `voiceSessionKeys` aus Task 4.
- Produces:
  - `VOICE_BUTTON_NAMESPACE = "plurv"`
  - `parseVoiceCommand(body: string) -> {action: "menu"|"light"|"persona"|"status"} | null`
  - `parseVoiceButtonPayload(payload: string) -> {mode: "light"|"persona", agentId: string} | null`
  - `buildVoiceModeMessage(agentId: string, mode: "light"|"persona") -> {text: string, interactive: object}`
  - `isOwnerSender(senderId: string, config: object) -> boolean`
  - `applyVoiceMode({baseDbPath, agentId, mode, config, patchSessionEntry, by}) -> Promise<{mode, patched: number, failed: number}>`

- [ ] **Step 1: Write the failing test**

```js
// tests/voice-mode-switch.test.js
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  applyVoiceMode,
  buildVoiceModeMessage,
  isOwnerSender,
  parseVoiceButtonPayload,
  parseVoiceCommand,
} from "../lib/voice-mode-switch.js";
import { readVoiceMode } from "../lib/voice-mode.js";

const config = {
  commands: { ownerAllowFrom: ["discord:1323072788939935867"] },
  channels: { discord: { voice: { allowedChannels: [
    { guildId: "1486678369901744240", channelId: "1486678370434551811" },
    { guildId: "1486678369901744240", channelId: "1518159522076823592" },
  ] } } },
};

test("parses /voice commands and ignores other text", () => {
  assert.deepEqual(parseVoiceCommand("/voice"), { action: "menu" });
  assert.deepEqual(parseVoiceCommand("/voice light"), { action: "light" });
  assert.deepEqual(parseVoiceCommand("/voice Full"), { action: "persona" });
  assert.deepEqual(parseVoiceCommand("/voice persona"), { action: "persona" });
  assert.deepEqual(parseVoiceCommand("/voice status"), { action: "status" });
  assert.equal(parseVoiceCommand("/voice turbo"), null);
  assert.equal(parseVoiceCommand("voice light"), null);
  assert.equal(parseVoiceCommand("/vc join"), null);
});

test("parses button payloads", () => {
  assert.deepEqual(parseVoiceButtonPayload("light:main"), { mode: "light", agentId: "main" });
  assert.deepEqual(parseVoiceButtonPayload("persona:main"), { mode: "persona", agentId: "main" });
  for (const bad of ["", "turbo:main", "light", "light:../x", "light:main:extra"]) {
    assert.equal(parseVoiceButtonPayload(bad), null, bad);
  }
});

test("the mode message marks the active mode and offers both buttons", () => {
  const msg = buildVoiceModeMessage("main", "light");
  assert.match(msg.text, /Light/);
  const buttons = msg.interactive.blocks[0].buttons;
  assert.deepEqual(buttons.map((b) => b.action.value), ["plurv:persona:main", "plurv:light:main"]);
  assert.equal(msg.interactive.blocks[0].type, "buttons");
});

test("only the configured Discord owner may switch", () => {
  assert.equal(isOwnerSender("1323072788939935867", config), true);
  assert.equal(isOwnerSender("discord:1323072788939935867", config), true);
  assert.equal(isOwnerSender("999", config), false);
  assert.equal(isOwnerSender("1323072788939935867", {}), false, "no owner configured → nobody");
});

test("applying light stores the mode and sets thinking off in every voice session, never the model", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "plur1bus-voice-switch-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const patches = [];
  const patchSessionEntry = async ({ agentId, sessionKey, update }) => {
    const next = update({ thinkingLevel: "high", model: "keep" });
    patches.push({ agentId, sessionKey, next });
    return next;
  };
  const out = await applyVoiceMode({ baseDbPath: base, agentId: "main", mode: "light", config, patchSessionEntry, by: "discord:1323072788939935867" });
  assert.deepEqual(out, { mode: "light", patched: 2, failed: 0 });
  assert.equal(readVoiceMode(base, "main"), "light");
  assert.deepEqual(patches.map((p) => p.sessionKey), [
    "agent:main:discord:channel:1486678370434551811",
    "agent:main:discord:channel:1518159522076823592",
  ]);
  for (const p of patches) {
    assert.equal(p.next.thinkingLevel, "off");
    assert.equal(p.next.reasoningLevel, "off");
    assert.equal(p.next.model, "keep", "the model is never touched");
  }

  patches.length = 0;
  await applyVoiceMode({ baseDbPath: base, agentId: "main", mode: "persona", config, patchSessionEntry });
  assert.equal(readVoiceMode(base, "main"), "persona");
  for (const p of patches) {
    assert.equal("thinkingLevel" in p.next, false, "persona removes the thinking override");
    assert.equal(p.next.reasoningLevel, "off", "reasoning stays off in voice rooms");
  }
});

test("a failing session patch is counted, the mode is still stored", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "plur1bus-voice-switch-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const out = await applyVoiceMode({
    baseDbPath: base, agentId: "main", mode: "light", config,
    patchSessionEntry: async () => { throw new Error("locked"); },
  });
  assert.deepEqual(out, { mode: "light", patched: 0, failed: 2 });
  assert.equal(readVoiceMode(base, "main"), "light");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/voice-mode-switch.test.js`
Expected: FAIL mit `Cannot find module '../lib/voice-mode-switch.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// lib/voice-mode-switch.js
/**
 * lib/voice-mode-switch.js — Umschalten Persona/Light per /voice und Knöpfen (7.17.0).
 * Reine Funktionen plus applyVoiceMode mit injiziertem Sitzungs-Patch.
 */
import { voiceSessionKeys, writeVoiceMode } from "./voice-mode.js";

export const VOICE_BUTTON_NAMESPACE = "plurv";
const AGENT_RE = /^[A-Za-z0-9_-]{1,32}$/;
const COMMAND_RE = /^\/voice(?:\s+(\S+))?\s*$/i;
const ACTIONS = Object.freeze({ light: "light", full: "persona", persona: "persona", status: "status" });

/**
 * @param {string} body - Nachrichtentext
 * @returns {{action: "menu"|"light"|"persona"|"status"}|null}
 */
export function parseVoiceCommand(body) {
  const match = COMMAND_RE.exec(String(body || "").trim());
  if (!match) return null;
  if (!match[1]) return { action: "menu" };
  const action = ACTIONS[match[1].toLowerCase()];
  return action ? { action } : null;
}

/**
 * @param {string} payload - Teil nach "plurv:"
 * @returns {{mode: "light"|"persona", agentId: string}|null}
 */
export function parseVoiceButtonPayload(payload) {
  const parts = String(payload || "").split(":");
  if (parts.length !== 2 || !["light", "persona"].includes(parts[0]) || !AGENT_RE.test(parts[1])) return null;
  return { mode: parts[0], agentId: parts[1] };
}

/**
 * Nachricht mit aktivem Modus und beiden Knöpfen.
 * @param {string} agentId
 * @param {"light"|"persona"} mode
 * @returns {{text: string, interactive: object}}
 */
export function buildVoiceModeMessage(agentId, mode) {
  const text = mode === "light"
    ? "🎙️ Sprachräume: **Light** — schnell, ohne vorgeladenes Gedächtnis, Thinking aus."
    : "🎙️ Sprachräume: **Persona** — volles Gedächtnis und Thinking.";
  return {
    text,
    interactive: {
      blocks: [{
        type: "buttons",
        buttons: [
          { label: mode === "persona" ? "✅ Persona" : "Persona", style: "primary", action: { type: "callback", value: `${VOICE_BUTTON_NAMESPACE}:persona:${agentId}` } },
          { label: mode === "light" ? "✅ Light" : "Light", style: "success", action: { type: "callback", value: `${VOICE_BUTTON_NAMESPACE}:light:${agentId}` } },
        ],
      }],
    },
  };
}

/**
 * Ist der Absender der konfigurierte Discord-Besitzer (commands.ownerAllowFrom)?
 * @param {string} senderId
 * @param {object} config
 * @returns {boolean}
 */
export function isOwnerSender(senderId, config) {
  const id = String(senderId || "").replace(/^discord:/, "").trim();
  if (!id) return false;
  const owners = Array.isArray(config?.commands?.ownerAllowFrom) ? config.commands.ownerAllowFrom : [];
  return owners.some((entry) => {
    const raw = String(entry).trim();
    if (raw.startsWith("discord:user:")) return false;
    return raw.replace(/^discord:/, "") === id;
  });
}

/**
 * Speichert den Modus und setzt Thinking/Reasoning der Sprachraum-Sitzungen.
 * Nie das Modell.
 * @param {{baseDbPath: string, agentId: string, mode: "light"|"persona", config: object, patchSessionEntry: Function, by?: string}} params
 * @returns {Promise<{mode: string, patched: number, failed: number}>}
 */
export async function applyVoiceMode({ baseDbPath, agentId, mode, config, patchSessionEntry, by }) {
  writeVoiceMode(baseDbPath, agentId, mode, { by });
  let patched = 0;
  let failed = 0;
  for (const sessionKey of voiceSessionKeys(agentId, config)) {
    try {
      await patchSessionEntry({
        agentId,
        sessionKey,
        update: (current) => {
          const next = { ...(current || {}), reasoningLevel: "off" };
          if (mode === "light") next.thinkingLevel = "off";
          else delete next.thinkingLevel;
          return next;
        },
      });
      patched += 1;
    } catch {
      failed += 1;
    }
  }
  return { mode, patched, failed };
}
```

- [ ] **Step 4: Run tests**

Run: `node --test tests/voice-mode-switch.test.js`
Expected: 6 Tests grün.

- [ ] **Step 5: Wire into index.js**

Import ergänzen:

```js
import {
  applyVoiceMode,
  buildVoiceModeMessage,
  isOwnerSender,
  parseVoiceButtonPayload,
  parseVoiceCommand,
  VOICE_BUTTON_NAMESPACE,
} from "./lib/voice-mode-switch.js";
import { readVoiceMode } from "./lib/voice-mode.js";
```

(`readVoiceMode` zum bestehenden `./lib/voice-mode.js`-Import aus Task 5 hinzufügen statt doppelt zu importieren.)

Neuer Block direkt nach dem `for (const hookName of ["before_dispatch", "before_agent_reply"]) { … }` des Critical-Blocks, aber außerhalb von dessen `if (cfg.criticalPush?.enabled !== false)`:

```js
        // 7.17.0: /voice [light|full|status] in Discord und Knöpfe plurv:<mode>:<agent>.
        if (typeof api.on === "function") {
          const patchVoiceSession = (params) => {
            const patch = runtimeIfUsable(api)?.agent?.session?.patchSessionEntry;
            if (typeof patch !== "function") throw new Error("session patch unavailable");
            return patch({ ...params, preserveActivity: true });
          };
          const answerVoiceCommand = async (event, context) => {
            try {
              const command = parseVoiceCommand(typeof event?.body === "string" ? event.body : event?.content);
              if (!command) return undefined;
              const channel = String(context?.channelId || event?.channel || "");
              if (channel !== "discord") {
                return { handled: true, text: "Persona/Light gilt nur für Discord-Sprachräume.", reply: { text: "Persona/Light gilt nur für Discord-Sprachräume." } };
              }
              const sessionKey = String(context?.sessionKey || event?.sessionKey || "");
              const agentId = /^agent:([^:]+):/.exec(sessionKey)?.[1] || "main";
              const senderId = String(context?.senderId ?? event?.senderId ?? "");
              if (!isOwnerSender(senderId, api.config)) {
                return { handled: true, text: "Nur der Besitzer darf den Sprachmodus umschalten.", reply: { text: "Nur der Besitzer darf den Sprachmodus umschalten." } };
              }
              let mode = readVoiceMode(baseDbPath, agentId);
              if (command.action === "light" || command.action === "persona") {
                const out = await applyVoiceMode({ baseDbPath, agentId, mode: command.action, config: api.config, patchSessionEntry: patchVoiceSession, by: `discord:${senderId}` });
                mode = out.mode;
                api.logger?.info?.(`plur1bus voice[${agentId}]: mode=${mode} patched=${out.patched} failed=${out.failed}`);
              }
              const message = buildVoiceModeMessage(agentId, mode);
              return { handled: true, text: message.text, reply: { text: message.text, interactive: message.interactive } };
            } catch (error) {
              api.logger?.warn?.(`memory-lancedb-namespaced: /voice failed: ${error?.message || error}`);
              return undefined;
            }
          };
          try {
            api.on("before_dispatch", answerVoiceCommand);
          } catch (error) {
            api.logger?.warn?.(`memory-lancedb-namespaced: could not listen for /voice: ${error?.message || error}`);
          }
          if (typeof api.registerInteractiveHandler === "function") {
            try {
              api.registerInteractiveHandler({
                channel: "discord",
                namespace: VOICE_BUTTON_NAMESPACE,
                handler: async (ctx) => {
                  const decision = parseVoiceButtonPayload(ctx?.interaction?.payload);
                  if (!decision) return { handled: false };
                  if (ctx.auth?.isAuthorizedSender !== true || !isOwnerSender(ctx.senderId, api.config)) return { handled: true };
                  try {
                    const out = await applyVoiceMode({ baseDbPath, agentId: decision.agentId, mode: decision.mode, config: api.config, patchSessionEntry: patchVoiceSession, by: `discord:${ctx.senderId}` });
                    api.logger?.info?.(`plur1bus voice[${decision.agentId}]: button mode=${out.mode} patched=${out.patched} failed=${out.failed}`);
                    const message = buildVoiceModeMessage(decision.agentId, out.mode);
                    await ctx.respond.editMessage({ text: message.text, interactive: message.interactive });
                  } catch (error) {
                    api.logger?.warn?.(`memory-lancedb-namespaced: voice button failed: ${error?.message || error}`);
                  }
                  return { handled: true };
                },
              });
            } catch (error) {
              api.logger?.warn?.(`memory-lancedb-namespaced: could not register voice buttons: ${error?.message || error}`);
            }
          }
        }
```

Vor dem Einbau die genaue Signatur von `ctx.respond.editMessage` und `ctx.senderId` im Discord-Handlerkontext prüfen: `sed -n 1,60p /root/openclaw-release-96/extensions/discord/src/interactive-dispatch.ts`. Weicht der Name des Absenderfelds ab (z. B. `ctx.userId`), im Handler und im Test entsprechend verwenden. Weicht die `editMessage`-Signatur ab (z. B. `{content, components}`), dort die dokumentierte Form nutzen und im Test spiegeln.

- [ ] **Step 6: Integrationstest für Hook und Knopf**

An `tests/voice-mode-switch.test.js` anhängen:

```js
test("the /voice hook and the plurv button switch the mode for the owner only", async (t) => {
  const { rmSync: rm } = await import("node:fs");
  const { makeTempDir } = await import("./helpers/temp-dir.js");
  const baseDbPath = makeTempDir("plur1bus-voice-hook-");
  t.after(() => rm(baseDbPath, { recursive: true, force: true }));
  const hooks = [];
  const interactive = [];
  const patched = [];
  const api = {
    pluginConfig: { baseDbPath, embedding: { provider: "local-transformers", local: { dimensions: 384 } }, autoCapture: false, autoRecall: false, neo: { enabled: false }, obsidianBridge: { enabled: false }, featureCronSetup: { auto: false }, gc: { enabled: false } },
    config,
    logger: { debug() {}, error() {}, info() {}, warn() {} },
    runtime: { agent: { async resolveAgentWorkspaceDir() { return baseDbPath; }, session: { async patchSessionEntry(p) { patched.push(p.sessionKey); return p.update({}); } } } },
    resolvePath: (v) => v,
    registerCommand() {}, registerTool() {}, registerService() {},
    on(name, fn) { hooks.push({ name, fn }); },
    registerInteractiveHandler(r) { interactive.push(r); },
  };
  const mod = await import(`../index.js?voice-switch=${Date.now()}`);
  mod.default.register(api, { importRouting: async () => ({
    parseAgentSessionKey(v) { const m = /^agent:([^:]+):(.+)$/.exec(v); return m ? { agentId: m[1], rest: m[2] } : null; },
    parseThreadSessionSuffix(v) { return { baseSessionKey: v, threadId: "" }; },
    normalizeOptionalAccountId(v) { return v || undefined; },
    normalizeMessageChannel(v) { return v || undefined; },
  }) });
  const dispatchHooks = hooks.filter((h) => h.name === "before_dispatch").map((h) => h.fn);
  const run = async (event, context) => {
    for (const fn of dispatchHooks) {
      const out = await fn(event, context);
      if (out?.handled) return out;
    }
    return undefined;
  };
  const context = { channelId: "discord", senderId: "1323072788939935867", conversationId: "channel:1518159522076823592", sessionKey: "agent:main:discord:channel:1518159522076823592" };

  const light = await run({ body: "/voice light", isGroup: true }, context);
  assert.match(light.text, /Light/);
  assert.equal(light.reply.interactive.blocks[0].type, "buttons");
  assert.equal(readVoiceMode(baseDbPath, "main"), "light");
  assert.equal(patched.length, 2);

  const stranger = await run({ body: "/voice full" }, { ...context, senderId: "42" });
  assert.match(stranger.text, /Nur der Besitzer/);
  assert.equal(readVoiceMode(baseDbPath, "main"), "light");

  const telegram = await run({ body: "/voice full" }, { ...context, channelId: "telegram" });
  assert.match(telegram.text, /nur für Discord/);

  assert.equal(await run({ body: "Hallo Bernd" }, context), undefined);

  const button = interactive.find((r) => r.channel === "discord" && r.namespace === "plurv");
  const edits = [];
  const tap = (senderId, authorized = true) => button.handler({
    senderId,
    auth: { isAuthorizedSender: authorized },
    interaction: { payload: "persona:main" },
    respond: { editMessage: async (p) => edits.push(p) },
  });
  await tap("42");
  assert.equal(readVoiceMode(baseDbPath, "main"), "light", "stranger tap changes nothing");
  await tap("1323072788939935867");
  assert.equal(readVoiceMode(baseDbPath, "main"), "persona");
  assert.match(edits.at(-1).text, /Persona/);
});
```

Run: `node --test tests/voice-mode-switch.test.js tests/critical-review-command.test.js`
Expected: alle grün (der Critical-Test beweist, dass der neue `before_dispatch`-Hook den Zitat-Hook nicht stört).

- [ ] **Step 7: DEPLOY_FILES und Commit**

In `scripts/lib/deploy-integrity.mjs` nach `"lib/voice-mode.js",` einfügen: `"lib/voice-mode-switch.js",`

```bash
node --test tests/deploy-integrity.test.js
git add lib/voice-mode-switch.js tests/voice-mode-switch.test.js index.js scripts/lib/deploy-integrity.mjs
git commit -m "feat(voice): /voice und Knöpfe schalten Persona/Light, nur für den Besitzer"
```

### Task 7: PLUR1BUS 7.17.0 — Version, Doku, volle Suite

**Files:**
- Modify: `package.json`, `openclaw.plugin.json`, `package-lock.json` (Version 7.16.11 → 7.17.0), `tests/release-750-compat.test.js` (`EXPECTED_VERSION`), `CHANGELOG.md`, `docs/configuration.md`

- [ ] **Step 1: Version heben**

```bash
cd /root/plur1bus-dev-voice-light && sed -i 's/"version": "7.16.11"/"version": "7.17.0"/' package.json openclaw.plugin.json && \
sed -i '0,/"version": "7.16.11"/s//"version": "7.17.0"/;0,/"version": "7.16.11"/s//"version": "7.17.0"/' package-lock.json && \
sed -i 's/7\.16\.11/7.17.0/' tests/release-750-compat.test.js && grep -h '"version"' package.json openclaw.plugin.json
```
Expected: zweimal `"version": "7.17.0",`.

- [ ] **Step 2: CHANGELOG (oberhalb von `## [7.16.11]`)**

```markdown
## [7.17.0] — 2026-09-26

### Hinzugefügt

- **Persona und Light in Discord-Sprachräumen.** `/voice light` und `/voice full`
  (oder `/voice` für eine Nachricht mit Knöpfen) schalten je Agent um. Light gilt
  nur für Sprachzüge (`messageProvider: "discord-voice"`): kein Auto-Recall und
  keine Zusatzblöcke, pro Lauf `anthropic/claude-haiku-4-5`, Thinking der
  Sprachraum-Sitzungen aus. Das Speichern ins Gedächtnis läuft weiter, und
  `memory_recall` bleibt nutzbar. Nur der Besitzer aus
  `commands.ownerAllowFrom` darf umschalten. In Sprachraum-Sitzungen bleibt
  `reasoningLevel` aus, damit keine Denk-Texte gesprochen werden.
```

- [ ] **Step 3: docs/configuration.md** — unter dem Critical-Push-Absatz ergänzen:

```markdown
**Discord-Sprachräume: Persona/Light (seit 7.17.0).** Der Modus steht je Agent in
`<baseDbPath>/.plur1bus-voice-mode/<agent>.json` (Standard `persona`). `/voice`,
`/voice light`, `/voice full`, `/voice status` im Discord-Text schalten um oder
zeigen den Stand mit Knöpfen. Umschalten setzt über den Host `thinkingLevel` der
Sitzungen `agent:<agent>:discord:channel:<id>` für jeden Raum aus
`channels.discord.voice.allowedChannels`; das Modell der Sitzung wird nie
gepatcht, Light wechselt es pro Lauf über `before_model_resolve`.
```

- [ ] **Step 4: Volle Suite**

```bash
cd /root/plur1bus-dev-voice-light && node --test $(ls tests/*.test.js | grep -v auto-capture-batch) test/*.test.js > /tmp/voice-suite-1.log 2>&1; echo "exit $?"; \
timeout 120 node --test tests/auto-capture-batch.test.js > /tmp/voice-suite-2.log 2>&1; echo "exit $?"; \
grep -E "^ℹ (tests|pass|fail)" /tmp/voice-suite-1.log /tmp/voice-suite-2.log; grep -E "^✖ " /tmp/voice-suite-1.log | sort -u
```
Expected: einzige bekannte Rote ist `Local Inference resolves patched adm-zip…` (Symlink-Artefakt des Dev-Worktrees). Jeder andere rote Test ist zu beheben.

- [ ] **Step 5: Commit und Tag**

```bash
git add package.json openclaw.plugin.json package-lock.json tests/release-750-compat.test.js CHANGELOG.md docs/configuration.md
git commit -m "7.17.0: Persona/Light für Discord-Sprachräume"
git tag -a v7.17.0 -m "7.17.0: Persona/Light für Discord-Sprachräume"
```

### Task 8: Host-Konfiguration, AGENTS.md-Regel, Deploy und Livetests

**Files:**
- Modify: `/root/.openclaw/openclaw.json` (per `openclaw config set` / `config patch`, mit Sicherung)
- Modify: `/root/.openclaw/workspace/AGENTS.md` (Abschnitt „Discord-Server verwalten“)
- Deploy: PLUR1BUS 7.17.0 über den bekannten Weg (Tag → Pins → Release-Checkout → `npm pack` → `plugins install` → sofort Neustart)

**Interfaces:**
- Consumes: Magpie-Bridge (Task 1/3), Parakeet-Anpassung (Task 2), PLUR1BUS 7.17.0 (Task 4–7).

- [ ] **Step 1: Deploy-Fenster beim Nutzer erfragen.** Kein Weiterarbeiten ohne ausdrückliches Ja für den Neustart.

- [ ] **Step 2: Sicherung der Konfiguration**

```bash
cp /root/.openclaw/openclaw.json /root/.openclaw/openclaw.json.bak-voice-light-$(date +%Y%m%d-%H%M%S)
```

- [ ] **Step 3: Wer schreibt heute auf dem Server?** Vor dem Einengen von `allowFrom` die Absender der letzten 30 Tage prüfen:

```bash
T=$(jq -r '.channels.discord.accounts.default.token' /root/.openclaw/openclaw.json); \
for c in 1486678370434551810 1486680789675540521; do curl -s -H "Authorization: Bot $T" "https://discord.com/api/v10/channels/$c/messages?limit=100" | jq -r '.[] | .author.id + " " + .author.username' ; done | sort | uniq -c
```
Expected: nur der Besitzer und der Bot. Sind weitere Menschen dabei, den Nutzer fragen, bevor `allowFrom` eingeengt wird.

- [ ] **Step 4: Konfiguration setzen (Trockenlauf zuerst, falls der CLI `--dry-run` anbietet)**

Diese Werte setzen (je `openclaw config set <pfad> '<json>' --json`; bei Arrays ersetzt `config patch` die ganze Liste, das ist hier gewollt):

```jsonc
{
  "plugins.entries.discord.enabled": true,
  "channels.discord.allowFrom": ["1323072788939935867"],
  "commands.ownerAllowFrom": ["discord:1323072788939935867"],
  "channels.discord.actions": { "roles": true, "moderation": true, "presence": true },
  "channels.discord.voice.mode": "stt-tts",
  "channels.discord.voice.followUsers": ["discord:1323072788939935867"],
  "channels.discord.voice.followUsersEnabled": false,
  "channels.discord.voice.allowedChannels": [
    { "guildId": "1486678369901744240", "channelId": "1486678370434551811" },
    { "guildId": "1486678369901744240", "channelId": "1518159522076823592" }
  ],
  "tts": {
    "provider": "openai",
    "providers": { "openai": { "baseUrl": "http://127.0.0.1:8025/v1", "apiKey": "local", "model": "magpie-multilingual", "voice": "DE-DE.Leo", "responseFormat": "opus" } }
  }
}
```

Prüfen: `openclaw config get tts` und `openclaw config get channels.discord.voice` zeigen die Werte; `tools.media.audio.baseUrl` bleibt `http://127.0.0.1:8000/v1`.

Hinweis: Setzt `tts` die Sprachausgabe für alle Kanäle? Ja, nur wenn `tts.auto`/`tts.enabled` es einschalten; beide nicht setzen, damit Telegram-Antworten wie bisher Text bleiben. Sprachräume und das `message`-Werkzeug nutzen `tts` direkt.

- [ ] **Step 5: AGENTS.md-Regel** — in `/root/.openclaw/workspace/AGENTS.md` vor `## Office-Dateien lesen — MarkItDown` (Sicherung vorher):

```markdown
## 🎙️ Discord-Server und Sprachräume

- Du verwaltest den Discord-Server „Server von Cyb3rblade“ (guildId `1486678369901744240`) über das `message`-Werkzeug mit `channel: "discord"`: Kanäle, Rollen, Mitglieder, Moderation, Events, Emojis, Präsenz.
- Vor unumkehrbaren Aktionen (Kanal oder Rolle löschen, Ban, Kick) einmal bei Christian nachfragen. Anlegen, Umbenennen, Rechte setzen und Timeout ohne Rückfrage.
- Sprachnachricht an Discord: `message` mit Audio-Anhang aus `tts`, ohne Text im selben Payload.
- Folgen in Sprachräume an/aus: `openclaw config set channels.discord.voice.followUsersEnabled true|false --json`, dann kurz bestätigen.
```

- [ ] **Step 6: PLUR1BUS 7.17.0 deployen** (Fenster aus Step 1)

```bash
cd /root/plur1bus-dev-voice-light && GH_CONFIG_DIR=/root/.config/gh git push -q origin feat/discord-voice-light v7.17.0
sed -i '98s/PLUR1BUS_PINNED_VERSION="7.16.11"/PLUR1BUS_PINNED_VERSION="7.17.0"/' /root/.openclaw/scripts/update-openclaw.sh
sed -i '2674s/PLUR1BUS_PINNED_EXPECTED="7.16.11"/PLUR1BUS_PINNED_EXPECTED="7.17.0"/' /root/.openclaw/patches/apply-media-patch.sh
cd /root/.openclaw/plur1bus-release && git status --short && git fetch -q origin --tags && git checkout -q --detach v7.17.0 && npm pack --pack-destination /tmp
timeout 300 openclaw plugins install --force --accept-capabilities /tmp/cyb3rb1ade-plur1bus-memory-7.17.0.tgz; systemctl --user restart openclaw-gateway
```
Danach: Version `7.17.0` in `/root/.openclaw/extensions/memory-lancedb-namespaced/package.json`, Dateien identisch mit dem Release, 74 aktive Crons, keiner mit `host-dispatch-unavailable`.

- [ ] **Step 7: Livetests mit dem Nutzer**

1. Discord verbunden: im Log `discord` bereit, `/vc status` antwortet.
2. `/vc join channel:1518159522076823592` im Kanal „Test“, ein Satz auf Deutsch → Bernd antwortet hörbar mit Leo. Zeit bis zur Antwort notieren.
3. `/voice light` im Chat von „Test“ → Nachricht mit Knöpfen, Log `plur1bus voice[main]: mode=light patched=2 failed=0`. Denselben Satz sprechen → Antwortzeit notieren; im Log des Laufs `claude-haiku-4-5`.
4. Knopf „Persona“ → Nachricht aktualisiert sich, Log `button mode=persona`.
5. Folgen: `followUsersEnabled` auf `true`, Nutzer wechselt zwischen „Allgemein“ und „Test“ → Bot folgt; wieder `false`.
6. Sprachnachricht: Bernd aus Telegram bitten, eine kurze Sprachnachricht in `#test` zu schicken → Wellenform sichtbar, abspielbar.
7. Stimmen probehören: je ein Satz mit Diego, Jason, Leo, Mia, Pascal, Ray als Sprachnachricht; Nutzer wählt; Wahl in `tts.providers.openai.voice` und `MAGPIE_DEFAULT_VOICE`.
8. Serververwaltung: Bernd legt `#bernd-test` und Rolle `bernd-test` an und löscht beide wieder (mit Rückfrage beim Löschen); setzt Präsenz. Moderation nur Freigabe prüfen: `openclaw config get channels.discord.actions`.

- [ ] **Step 8: Veröffentlichen** (GitHub-Release, GitHub Packages, ClawHub) wie bei 7.16.11, dann Gedächtnisnotizen aktualisieren.
