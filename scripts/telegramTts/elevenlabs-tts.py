#!/usr/bin/env python3
"""Sprachausgabe ueber ElevenLabs (nur TTS; STT bleibt bei der Parakeet-Bridge).

    elevenlabs-tts.py say TEXT [--voice el-otto|el:<voice_id>] [--model ID] [--out datei.mp3|.wav|.ogg]
    elevenlabs-tts.py voices                 Stimmenkatalog (Aliase fuer /sabbel)
    elevenlabs-tts.py voice-ok STIMME        Exit 0, wenn Alias oder el:<id> gueltig aussieht
    elevenlabs-tts.py models                 Modelle mit Deutsch, live von der API
    elevenlabs-tts.py set-model ID           Standardmodell dauerhaft setzen
    elevenlabs-tts.py search BEGRIFF [male|female]   deutsche Bibliotheksstimmen suchen
    elevenlabs-tts.py quota                  verbrauchte Zeichen im Abrechnungszeitraum

Schluessel: ELEVENLABS_API_KEY oder /root/.openclaw/secrets/elevenlabs-api-key
(Starter-Abo, 40 000 Zeichen im Monat). Library-Stimmen gehen mit diesem Abo
direkt per voice_id, sie muessen nicht ins Konto uebernommen werden.

Fehler gehen nach stderr mit Exit 1; bei ElevenLabs bleibt die Textantwort erhalten.
Nur Standardbibliothek, laeuft mit dem System-python3.
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

API = "https://api.elevenlabs.io"
KEY_FILE = "/root/.openclaw/secrets/elevenlabs-api-key"
SETTINGS = "/root/.openclaw/settings/elevenlabs.json"
# Mehrsprachiges Modell mit konsistenter Stimme bei Sprachwechseln.
DEFAULT_MODEL = "eleven_v4"
# Starter-Abo hat 40 000 Zeichen im Monat — lange Antworten wuerden das schnell aufbrauchen
MAX_CHARS = int(os.getenv("ELEVENLABS_MAX_CHARS", "2000"))

# Die beliebtesten deutschen Library-Stimmen nach Nutzung im letzten Jahr
# (Stand 14.10.26, je drei maennlich/weiblich). Ausgelassen: "Niander Wallace"
# (Filmfigur) und "Carola" (Live-Moderation aktiv). Beschreibung = API-Label.
VOICES = {
    "el-otto": ("FTNCalFNG5bRnkkaP5Ug", "Otto", "maennlich", "Casual and Normal, Erzaehlstimme"),
    "el-ben": ("aTTiK3YzK3dXETpuDE2h", "Ben", "maennlich", "Effortless and Casual, jung, Gespraech"),
    "el-mark": ("fzqS9sNPYJhLlhsfDm0l", "Mark", "maennlich", "Interesting and Fun, Gespraech"),
    "el-susi": ("v3V1d2rk6528UrLKRuy8", "Susi", "weiblich", "Effortless and Confident, Gespraech"),
    "el-lea": ("7eVMgwCnXydb3CikjV7a", "Lea", "weiblich", "Clear and Feminine, Erzaehlstimme"),
    "el-ava": ("AnvlJBAqSLDzEevYr9Ap", "Ava", "weiblich", "Youthful, Authentic and Friendly, jung"),
}
KNOWN_MODELS = {
    "eleven_v4", "eleven_v4_turbo", "eleven_v3", "eleven_v3_conversational",
    "eleven_multilingual_v2", "eleven_flash_v2_5", "eleven_turbo_v2_5",
}


def _key() -> str:
    key = os.getenv("ELEVENLABS_API_KEY", "").strip()
    if not key:
        try:
            with open(KEY_FILE, encoding="utf-8") as fh:
                key = fh.read().strip()
        except OSError as err:
            sys.exit(f"ElevenLabs-Schluessel fehlt ({KEY_FILE}): {err}")
    return key


def _request(path: str, body: dict | None = None) -> bytes:
    req = urllib.request.Request(
        API + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"xi-api-key": _key(), "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            return resp.read()
    except urllib.error.HTTPError as err:
        sys.exit(f"ElevenLabs HTTP {err.code}")
    except (urllib.error.URLError, TimeoutError) as err:
        sys.exit("ElevenLabs nicht erreichbar")


def _model() -> str:
    env = os.getenv("ELEVENLABS_MODEL", "").strip()
    if env:
        return env
    try:
        with open(SETTINGS, encoding="utf-8") as fh:
            return json.load(fh).get("model") or DEFAULT_MODEL
    except (OSError, ValueError):
        return DEFAULT_MODEL


def _voice_id(voice: str) -> str:
    voice = voice.strip()
    if voice.startswith("el:") and len(voice) > 10:
        return voice[3:]
    if voice in VOICES:
        return VOICES[voice][0]
    sys.exit(f"Unbekannte ElevenLabs-Stimme '{voice}'. Aliase: {', '.join(VOICES)}; "
             "beliebige Library-Stimme als el:<voice_id>.")


def say(text: str, voice: str, model: str, out: str, prepared: bool = False) -> None:
    text = text if prepared else text.strip()
    if not text:
        sys.exit("Kein Text.")
    if not prepared and len(text) > MAX_CHARS:
        text = text[:MAX_CHARS].rsplit(" ", 1)[0] + " …"
    audio = _request(
        f"/v1/text-to-speech/{_voice_id(voice)}?output_format=mp3_44100_128",
        {"text": text, "model_id": model},
    )
    if len(audio) < 512:
        sys.exit(f"ElevenLabs lieferte nur {len(audio)} Bytes.")
    if out.endswith(".mp3"):
        with open(out, "wb") as fh:
            fh.write(audio)
    else:
        with tempfile.NamedTemporaryFile(suffix=".mp3") as tmp:
            tmp.write(audio)
            tmp.flush()
            codec = ["-c:a", "libopus", "-b:a", "64k"] if out.endswith((".ogg", ".opus")) else []
            res = subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", tmp.name, *codec, out],
                                 capture_output=True, text=True)
            if res.returncode != 0:
                sys.exit("ffmpeg conversion failed")
    if not os.path.isfile(out) or os.path.getsize(out) == 0:
        sys.exit("Audio output missing or empty")
    print(f"{out} ({len(text)} Zeichen, {voice}, {model})")


# Prepared text never passes through the legacy truncation path. Tags are closed
# metadata insertions: removing them must reproduce every canonical code point.
PREPARED_TAGS = {"neutral", "warm", "serious", "firm", "happy", "soft", "thoughtful",
                 "playful", "excited", "sad", "whispering", "shouting", "laughs",
                 "chuckles", "sighs", "gasps"}

def say_prepared(payload: dict, voice: str, model: str, out: str) -> None:
    if not isinstance(payload, dict) or payload.get("version") != 1:
        raise ValueError("invalid prepared version")
    text, speech = payload.get("text"), payload.get("speech")
    if not isinstance(text, str) or not isinstance(speech, str) or not text.strip() or len(text) > 2000:
        raise ValueError("invalid canonical text")
    if re.search(r"[\[\]]", re.sub(r"\[\d+\]", "", text)):
        raise ValueError("raw directions")
    # Walk insertions, leaving numeric citations as spoken canonical text.
    cursor, remaining, tags = 0, [], 0
    for match in re.finditer(r"\[([^\[\]]+)\]", speech):
        remaining.append(speech[cursor:match.start()])
        if match.group(1) in PREPARED_TAGS:
            tags += 1
        elif match.group(1).isdigit():
            remaining.append(match.group(0))
        else:
            raise ValueError("unknown speech tag")
        cursor = match.end()
    remaining.append(speech[cursor:])
    if tags > 64 or "".join(remaining) != text:
        raise ValueError("speech changes canonical words")
    say(speech, voice, model, out, prepared=True)


def voices() -> None:
    print("--- ElevenLabs (Cloud, Abo: 40 000 Zeichen/Monat) ---")
    for alias, (_vid, name, gender, desc) in VOICES.items():
        print(f"  {alias:15s} - {gender:9s} {name}: {desc}")
    print("  el:<voice_id>   - jede andere Library-Stimme (Suche: elevenlabs-tts.py search <begriff>)")
    print(f"  Modell: {_model()} (aendern: elevenlabs-tts.py set-model <id>)")


def models() -> None:
    data = json.loads(_request("/v1/models"))
    current = _model()
    for m in data:
        langs = {lang.get("language_id") for lang in m.get("languages", [])}
        if m.get("can_do_text_to_speech") and "de" in langs:
            mark = "  <- aktuell" if m["model_id"] == current else ""
            print(f"  {m['model_id']:26s} {m.get('name')}, max {m.get('maximum_text_length_per_request')} Zeichen{mark}")


def set_model(model: str) -> None:
    if model not in KNOWN_MODELS:
        sys.exit(f"Unbekanntes Modell '{model}'. Erlaubt: {', '.join(sorted(KNOWN_MODELS))}")
    os.makedirs(os.path.dirname(SETTINGS), exist_ok=True)
    with open(SETTINGS, "w", encoding="utf-8") as fh:
        json.dump({"model": model}, fh)
    print(f"Standardmodell: {model}")


def search(term: str, gender: str | None) -> None:
    from urllib.parse import urlencode
    q = {"page_size": 15, "language": "de", "search": term, "sort": "usage_character_count_1y"}
    if gender:
        q["gender"] = gender
    data = json.loads(_request("/v1/shared-voices?" + urlencode(q)))
    for v in data.get("voices", []):
        print(f"  el:{v['voice_id']}  {v['name'][:45]:45s} {v.get('gender')}, {v.get('age')}, {v.get('use_case')}")


def quota() -> None:
    d = json.loads(_request("/v1/user/subscription"))
    print(f"{d.get('tier')}: {d.get('character_count')} von {d.get('character_limit')} Zeichen verbraucht")


def main() -> None:
    args = sys.argv[1:]
    if not args:
        sys.exit(__doc__)
    cmd = args.pop(0)
    if cmd == "say-prepared":
        if len(args) != 4 or args[0] != "--voice" or args[2] != "--out":
            sys.exit("Invalid prepared options")
        try:
            raw = sys.stdin.read(32769)
            if len(raw) > 32768:
                raise ValueError("prepared payload too large")
            say_prepared(json.loads(raw), args[1], _model(), args[3])
        except (ValueError, TypeError):
            sys.exit("Invalid prepared speech")
    elif cmd == "say" and args:
        text, voice, model, out = args.pop(0), "el-otto", _model(), "/tmp/openclaw/elevenlabs.mp3"
        while args:
            flag = args.pop(0)
            if not args:
                sys.exit(f"Wert fehlt fuer {flag}")
            val = args.pop(0)
            if flag == "--voice":
                voice = val
            elif flag == "--model":
                model = val
            elif flag == "--out":
                out = val
            else:
                sys.exit(f"Unbekannte Option {flag}")
        say(text, voice, model, out)
    elif cmd == "voices":
        voices()
    elif cmd == "voice-ok" and len(args) == 1:
        v = args[0]
        sys.exit(0 if v in VOICES or (v.startswith("el:") and len(v) > 10) else 1)
    elif cmd == "models":
        models()
    elif cmd == "set-model" and len(args) == 1:
        set_model(args[0])
    elif cmd == "search" and args:
        search(args[0], args[1] if len(args) > 1 else None)
    elif cmd == "quota":
        quota()
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
