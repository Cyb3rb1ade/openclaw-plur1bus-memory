---
name: telegram-tts-toggle
description: "Toggle TTS (Text-to-Speech) für Telegram Bot-Antworten. Stimmen: Edge TTS, ElevenLabs (el-otto, el-ben, el-mark, el-susi, el-lea, el-ava), lokal Piper als Fallback. Commands: /sabbel on, /sabbel off, /sabbel sprecher, /sabbel status. Defaults mit Eleven v4: Bernd=Felix, Bernhardine=Lucy Fennek, Heisenberg=Simon, jeweils für alle unterstützten Sprachen."
---

# Telegram TTS Toggle

Konvertiert Bot-Antworten mit ElevenLabs `eleven_v4` in mehrsprachige Telegram-Sprachnachrichten.

## Features

- ✅ **On/Off Toggle** - TTS per Agent ein/ausschalten
- ✅ **Interaktive Stimmen-Auswahl** - Klickbare Buttons in Telegram
- ✅ **Nur der Antworttext** wird vorgelesen
- ✅ **ElevenLabs primär** - Eine feste Stimme je Agent für alle unterstützten Sprachen
- ✅ **Piper für alte Edge-Stimmen** - Bei ElevenLabs-Fehler bleibt die Textantwort erhalten
- ✅ **Auto-Send** - Sprachnachrichten werden automatisch gesendet

## Verfügbare Stimmen

Primär werden ElevenLabs-Stimmen mit `eleven_v4` genutzt:
- `main` -> `Felix - Ironic and Funny` (`el:uM8iMoqaSe1eDaJiWfxf`)
- `bernhardine` -> `Lucy Fennek - Friendly and Open` (`el:KXxZd16DiBqt82nbarJx`)
- `heisenberg` -> `Simon - Relatable and Normal` (`el:K5ZVtkkBnuPY6YqXs70E`)

Lokale Piper-Stimmen unten sind Fallback oder optionale manuelle Auswahl:

| Stimme | Typ | Qualität | Größe |
|--------|-----|----------|-------|
| **thorsten** | Männlich | High | 127 MB |
| **miro** | Männlich | High | 79 MB |
| **dii** | Neutral | High | 79 MB |
| **glados** | Synthetisch/Roboter | High | 127 MB |

## ElevenLabs-Stimmen (Cloud, Abo)

Die persönlichen Standardstimmen stehen oben. Die folgenden Aliase bleiben als manuelle Auswahl verfügbar.

| Alias | Stimme | Beschreibung (laut ElevenLabs) |
|-------|--------|--------------------------------|
| `el-otto` | Otto, männlich | ruhig, normal, Erzählstimme |
| `el-ben` | Ben, männlich | locker, jung, Gespräch |
| `el-mark` | Mark, männlich | lebhaft, Gespräch |
| `el-susi` | Susi, weiblich | selbstbewusst, Gespräch |
| `el-lea` | Lea, weiblich | klar, Erzählstimme |
| `el-ava` | Ava, weiblich | jung, freundlich |

- Jede andere Stimme aus der ElevenLabs-Bibliothek: `el:<voice_id>`. Suchen: `/root/.openclaw/tools/elevenlabs-tts.py search <begriff> [male|female]`.
- Modell für alle ElevenLabs-Stimmen: Standard `eleven_v4`. Anzeigen: `elevenlabs-tts.py models`, wechseln: `elevenlabs-tts.py set-model <id>` (z. B. `eleven_v3`, `eleven_flash_v2_5`). Nur auf ausdrücklichen Wunsch wechseln.
- Kontingent: 40 000 Zeichen im Monat, Abfrage `elevenlabs-tts.py quota`. Je Antwort werden höchstens 2000 Zeichen vorgelesen.
- Fällt ElevenLabs aus, wird kein Ersatzsprecher verwendet. Die Textantwort bleibt erhalten; der Fehler erscheint auf stderr. Piper bleibt nur für manuell gewählte alte Edge-Stimmen verfügbar.

## Commands

```bash
/sabbel on         # TTS aktivieren
/sabbel off        # TTS deaktivieren
/sabbel status     # Aktuellen Status anzeigen
/sabbel sprecher   # Interaktive Stimmen-Auswahl (mit Buttons!)
/sabbel test       # Test-Sprachnachricht senden
/sabbel <name>     # Direktwahl: el-otto / el-ben / el-mark / el-susi / el-lea / el-ava / edge-seraphina / edge-florian / edge-killia / miro / dii / thorsten / glados
```

## Verwendung

### Aktivieren
```
/sabbel on
```

### Stimme wählen - Interaktiv
```
/sabbel sprecher
```
→ Bot zeigt **Auswahl-Buttons** für jede Stimme
→ **Klick** auf gewünschte Stimme
→ Fertig!

### Stimme wählen - Direkt
```
/sabbel miro       # Direkt zu Miro wechseln
/sabbel glados     # Direkt zu GLaDOS wechseln
```

### Deaktivieren
```
/sabbel off
```

## Interaktive Stimmen-Auswahl

Wenn du `/sabbel sprecher` sendest, zeigt der Bot Telegram Inline Buttons:

```
🎤 Wähle deine Stimme:

[🎙️ Thorsten (Standard)]  [🎙️ Miro]
[🤖 GLaDOS (Roboter)]      [📢 Dii]
[✨ Otto]  [✨ Ben]  [✨ Mark]
[✨ Susi]  [✨ Lea]  [✨ Ava]

Aktuelle Stimme: el:K5ZVtkkBnuPY6YqXs70E ✅
```

## Technische Details

### Was vorgelesen wird

Nur der finale Antworttext wird in Audio umgewandelt.

### Audio-Format

- **Format:** WAV (wird zu OGG für Telegram konvertiert)
- **Sample Rate:** 22050 Hz
- **Bitrate:** 64 kbps
- **Generierung:** ~1.0 RTF (fast Echtzeit)

### State Management

Status wird **zentral** gespeichert in:
```
~/.openclaw/settings/tts-toggle/{agent-id}.json
```

**Jeder Agent hat seinen eigenen State:**
- `main.json` - Bernd (main Agent)
- `bernhardine.json` - Bernhardine Agent

Das bedeutet: **Bernd und Bernhardine können unterschiedliche Stimmen und TTS-Status haben!**

Beispiel:
```json
{
  "enabled": true,
  "voice": "el:K5ZVtkkBnuPY6YqXs70E",
  "lastUsed": "2026-02-11T20:00:00Z"
}
```

## Installation

**Dependencies:**
- sherpa-onnx runtime (bereits installiert ✅)
- Deutsche Piper-Modelle (bereits installiert ✅)
- ffmpeg (für OGG-Konvertierung)

## Agent-Cheat-Sheet (Befehls-Implementierung)

Wenn User `/sabbel <command>` sendet:

| Command | Bash |
|---------|------|
| `/sabbel on` | `tts-manager.sh enable main` → "✅ TTS aktiviert!" |
| `/sabbel off` | `tts-manager.sh disable main` → "✅ TTS deaktiviert." |
| `/sabbel <stimme>` | `tts-manager.sh set-voice main <stimme>` → "✅ Stimme: {name}" |
| `/sabbel list` | `tts-manager.sh list-voices` → Liste ausgeben |
| `/sabbel status` | `tts-manager.sh status heisenberg` |

Pfad: `/root/.openclaw/workspace-heisenberg/skills/telegram-tts-toggle/bin/tts-manager.sh`

`/sabbel status` liefert die echte aktive Stimme, Engine (`elevenlabs`, `edge-tts` oder `piper`) und den lokalen Fallback. Stimme niemals raten.

### Auto-TTS nach jeder Telegram-Antwort

**Schritt 1 — exec Tool-Call ausführen** (den Befehl selbst NICHT als Text schreiben, nur ausführen):
```bash
/root/.openclaw/workspace-heisenberg/skills/telegram-tts-toggle/bin/tts-auto.sh heisenberg "ANTWORT_TEXT"
```

**Schritt 2 — MEDIA-Direktive in den Antworttext schreiben** (das hier IST Text, der ausgegeben werden muss):

Wenn Output mit `OK:` beginnt → diese zwei Zeilen als **letzten sichtbaren Text der Antwort** ausgeben — buchstäblich.
```
MEDIA:/tmp/openclaw/tts-response-heisenberg.ogg
[[audio_as_voice]]
```

⚠️ **NIEMALS `tts-reply.sh`, `tts-generate.sh` direkt oder eigene ffmpeg-Befehle verwenden.**
⚠️ **NIEMALS eigene Pfade erfinden — immer den OK:-Output von tts-auto.sh verwenden.**

⛔ Kein `OK:` im Output → TTS fehlgeschlagen → nichts anhängen
⛔ TTS deaktiviert → gar nichts tun

## Deutsche Trigger-Phrasen

- "Sabbel aktivieren" / "Sprachausgabe einschalten"
- "Sabbel ausschalten" / "Keine Sprachnachrichten mehr"
- "Sprecher wählen" / "Zeig mir die Stimmen"
- "Sabbel mit Miro" / "Verwende GLaDOS"
- "Sabbel mit Otto" / "Nimm Susi" → `set-voice <agent> el-otto` bzw. `el-susi`

## Workspace-Isolation

⚠️ **Wichtig:** Jeder Workspace hat eigene TTS-Einstellungen!
- `workspace` (main/default) → Eigene Konfiguration
- `workspace-bernhardine` → Eigene Konfiguration

## Limitierungen

- **Nur Telegram:** TTS funktioniert nur für Telegram-Nachrichten
- **Text-Only:** Keine Bilder/Dateien/Code-Blöcke in Audio
- **Max. Länge:** Antworten > 2000 Zeichen werden gekürzt
- **Performance:** ~1s Generierungszeit pro 1s Audio

## Troubleshooting

### TTS generiert nichts
```bash
# Check sherpa-onnx runtime
ls /root/.openclaw/tools/sherpa-onnx-tts/runtime/bin/sherpa-onnx-offline-tts

# Check models
ls /root/.openclaw/tools/sherpa-onnx-tts/models/
```

### Audio kommt nicht an
```bash
# Check ffmpeg
which ffmpeg

# Check Telegram connection
openclaw doctor | grep Telegram
```

---

**Version:** 1.0.1
**Author:** Custom Skill für OpenClaw
**Lizenz:** MIT


## Shared speech preparation

Continue calling `tts-auto.sh <agent-id> "<final response>"`; Bernhardine uses one `tts-bilingual.sh bernhardine "<German>" "<Polish>"` invocation for separate language files. Always pass the exact agent ID. These wrappers preserve the configured speaker, model, toggles, and `OK:` / `OK_DE:` / `OK_PL:` contracts.

The ElevenLabs path prepares final visible words once, capped at 2,000 Unicode code points including the ellipsis. Do not add provider tags or bracketed stage directions to the response. Raw directives cause a text-only result. Do not clip or add punctuation after preparation, and do not invoke the provider directly.

`emotion.jev` controls outgoing expression: disabled sends neutral canonical speech without Jev; shadow assesses but sends neutral speech; active applies validated compatible delivery tags. Persona and current mood remain subordinate to the actual meaning. The adapter uses only the exact private run context provided by the host. Missing, stale or invalid context uses final-text-only planning. It never guesses another run or updates mood. Bilingual versions share one combined plan and the same selected ElevenLabs speaker; one successful language file may still be sent if the other fails. Provider/conversion failure never changes the speaker.
