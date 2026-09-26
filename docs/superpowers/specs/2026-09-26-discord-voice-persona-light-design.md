# Discord-Sprachräume mit Persona / Light — Design

Stand: 26.09.2026. Freigegeben im Gespräch (Teil 1 Bausteine, Teil 2 Ablauf). Dieses Dokument ist die Vorlage für den Umsetzungsplan.

## Ziel

Bernd (Agent `main`) soll

1. auf Zuruf (`/vc join`) in Discord-Sprachräume kommen, zuhören und mit Stimme antworten,
2. dem Besitzer in Sprachräume folgen können, an- und abschaltbar,
3. Discord-Sprachnachrichten verschicken können,
4. in Sprachräumen zwischen **Persona** (voll) und **Light** (schnell) umschaltbar sein.

Light gilt nur in Sprachraum-Sitzungen. Geschriebene Discord-Nachrichten laufen immer als Persona.

## Ausgangslage (geprüft am 26.09.2026)

- Drei eigene Dienste sind seit mindestens 02.09. tot, weil ihre Programme fehlen und keine Kopie existiert: `discord-voice-stt` (Node), `nemotron-asr-stream` (Python, Port 8021), `magpie-tts-bridge` (Python, Port 8025). Sie starten in einer Schleife neu und füllen das Syslog (etwa 700 MB pro Tag).
- OpenClaw 2026.9.6 bringt Discord-Sprachräume (`/vc join|leave|status`, `voice.followUsers`, `voice.autoJoin`, Modi `agent-proxy` und `stt-tts`) und Discord-Sprachnachrichten (`message`-Werkzeug, OGG/Opus mit Wellenform) selbst mit. Die eigenen Dienste waren ein früher Nachbau davon.
- `channels.discord.voice` ist eingeschaltet (Realtime über OpenAI `gpt-realtime-2`), aber `plugins.entries.discord.enabled` steht auf `false`. Bernd ist auf Discord derzeit nicht aktiv.
- Der Bot-Token (`channels.discord.accounts.default.token`) ist gültig: Bot „Bernd das Bot“ (`1486657982820253736`), Server „Server von Cyb3rblade“ (`1486678369901744240`), Besitzer `1323072788939935867`. Sprachräume: „Allgemein“ (`1486678370434551811`), „Test“ (`1518159522076823592`).
- Discord steht auf `allowFrom: ["*"]`, `commands.ownerAllowFrom` ist nicht gesetzt.
- NVIDIA-Schlüssel (`/root/.openclaw/.env.nemotron`), per Riva-Konfigurationsabfrage geprüft:
  - Parakeet 1.1B RNNT multilingual (`71203149-d3b7-4460-8231-1be2543a1fca`): Deutsch, offline und streaming.
  - Magpie TTS multilingual (`877104f7-e885-42b9-8de8-f6e4c6303969`): Deutsch, 22 050 Hz, Stimmen `DE-DE.Diego`, `.Jason`, `.Leo`, `.Mia`, `.Pascal`, `.Ray`.
  - Nemotron ASR Streaming (`bb0837de-…`) kann nur `en-US`. Ungeeignet. (Nebenbefund: die laufende Sprachnachrichten-Bridge auf Port 8020 nutzt genau dieses Modell; getrennt zu prüfen, nicht Teil dieses Umbaus.)
- Plugin-Hooks: `before_model_resolve` darf das Modell pro Lauf übersteuern, `before_prompt_build` Kontext weglassen. Thinking lässt sich nicht per Hook, aber per Sitzungs-Override (`thinkingLevel`) setzen. Ein `sessions.patch` mit `model` schreibt die Agent-Konfiguration um und ist deshalb verboten; `thinkingLevel` allein tut das nicht.
- Alle Anthropic-Katalogeinträge tragen `reasoning: true`. Ein Modellwechsel allein schaltet Thinking nicht ab.

## Architektur

```
Discord-Sprachraum
  │  Audio (Opus)
  ▼
OpenClaw discord voice, mode stt-tts ──► tools.media.audio ──► [Parakeet-Bridge :8021] ──► NVIDIA Parakeet (de-DE)
  │  Transkript als Nutzerzug in der Sprachraum-Sitzung
  ▼
Agent main ──(PLUR1BUS: Persona oder Light)──► Antworttext
  │
  ▼
voice.tts (OpenAI-kompatibel) ──► [Magpie-Bridge :8025] ──► NVIDIA Magpie (DE-DE.<Stimme>) ──► Wiedergabe im Raum

Sprachnachricht: message-Werkzeug ──► tts (OpenAI-kompatibel) ──► [Magpie-Bridge :8025] ──► OGG/Opus mit Wellenform
```

### Baustein 1: Discord und Sprachmodus (Host-Konfiguration)

- `plugins.entries.discord.enabled: true`.
- `channels.discord.voice`:
  - `mode: "stt-tts"` statt Realtime; der `realtime`-Block bleibt stehen, wird aber nicht genutzt.
  - `followUsers: ["discord:1323072788939935867"]`, `followUsersEnabled: false` als Start.
  - `tts`: Anbieter `openai` mit `baseUrl` auf die Magpie-Bridge.
  - `allowedChannels`: beide Sprachräume.
- `commands.ownerAllowFrom` bekommt `discord:1323072788939935867`, damit Sprachzüge und `/vc` den Besitzer eindeutig kennen.
- `allowFrom: ["*"]` wird im Zuge dessen auf den Besitzer eingeengt, sofern nichts anderes davon abhängt (vor dem Umstellen prüfen, wer auf dem Server schreibt).
- Die genauen Schlüssel werden beim Bauen gegen das Schema von 2026.9.6 geprüft (`openclaw config` mit Trockenlauf).

### Baustein 2: Parakeet-Bridge (Port 8021)

- Neues Python-Programm `/root/.openclaw/tools/nvidia-riva-bridge/parakeet_transcribe_bridge.py`, Unit `nemotron-asr-stream.service` wird darauf umgestellt und umbenannt in `parakeet-transcribe-bridge.service`.
- OpenAI-kompatibel: `POST /v1/audio/transcriptions` (multipart, Feld `file`, `model` ignoriert), Antwort `{"text": "..."}`. `GET /health`.
- Audio per ffmpeg nach 16 kHz mono PCM, Riva offline-Erkennung gegen Parakeet mit `de-DE`, Zeichensetzung an.
- Nur auf `127.0.0.1`.

### Baustein 3: Magpie-Bridge (Port 8025)

- Neues Python-Programm `magpie_speech_bridge.py`, Unit `magpie-tts-bridge.service` wird darauf umgestellt.
- OpenAI-kompatibel: `POST /v1/audio/speech` mit `{"input", "voice", "response_format"}`. `voice` wird auf eine Magpie-Stimme abgebildet (Standard `DE-DE.Leo`, frei wählbar per Umgebungsvariable). Formate `opus`, `mp3`, `wav`, `pcm`; Umwandlung per ffmpeg.
- Lange Texte werden satzweise synthetisiert und zusammengefügt (Riva-Grenze pro Anfrage).
- Nur auf `127.0.0.1`.

### Baustein 4: Persona / Light (PLUR1BUS)

- Neuer Modus-Speicher je Agent, Werte `persona` (Standard) und `light`, persistiert unter `<baseDbPath>/.plur1bus-voice-mode/<agentId>.json` (atomar geschrieben). Der Modus bleibt, bis er umgeschaltet wird.
- Erkennung einer Sprachraum-Sitzung am Sitzungsschlüssel bzw. am Kanal-Kontext, den der Host für Discord-Sprachzüge setzt (beim Bauen am echten Schlüssel ablesen und im Code als eine Funktion `isDiscordVoiceSession()` kapseln).
- Nur wenn beides zutrifft (Sprachraum-Sitzung und Modus `light`):
  - Auto-Recall und alle Zusatzblöcke im Prompt entfallen (Recall-Prelude, Semantic Lens, Reactivation, Persona-Voice-Direktive, zeitlicher Kontext). Umsetzung als ein früher Ausstieg in den bestehenden Prompt-Hooks.
  - `before_model_resolve` liefert `anthropic/claude-haiku-4-5`.
  - Eine kurze feste Anweisung: bei Fragen, die Erinnerungen brauchen, zuerst „Moment, ich denke kurz nach“ sagen und dann `memory_recall` nutzen.
- Das Speichern (`agent_end`-Capture) läuft in beiden Modi unverändert.
- Beim Umschalten setzt PLUR1BUS den `thinkingLevel` der Sprachraum-Sitzung auf `off` (Light) bzw. entfernt den Override (Persona, `null`). Nie `model` per `sessions.patch`.

### Baustein 5: Umschalten

- Textbefehl `/voice light` und `/voice full` in Discord. Umsetzung über denselben Weg wie die zitierten Critical-Antworten (Hook `before_dispatch`), weil `registerCommand` im Host nicht live ankommt.
- Knopfnachricht „Persona“ / „Light“ im Textkanal des Sprachraums, gesendet beim Betreten (manuell oder durch Folgen). Klick über `registerInteractiveHandler` mit eigenem Namespace (`plurv`), analog zum Critical Push. Nach dem Klick zeigt die Nachricht den aktiven Modus.
- Nur der Besitzer darf umschalten (Allowlist-Prüfung des Hosts plus Abgleich mit `commands.ownerAllowFrom`).
- Offene Machbarkeitsfrage: ob PLUR1BUS ein „Raum betreten“-Ereignis sieht. Falls nicht, sendet `/voice` ohne Argument die Knopfnachricht, und `/vc join` bleibt ohne automatische Knöpfe.

### Baustein 6: Aufräumen

- `discord-voice-stt.service` wird deaktiviert und gestoppt. Die Unit-Datei bleibt als `.disabled` liegen.
- Beide Bridge-Units bekommen `StartLimitIntervalSec=300`, `StartLimitBurst=5` und `RestartSec=10`, damit ein künftiger Ausfall nicht wieder das Syslog flutet.

## Fehlerfälle

| Fall | Verhalten |
|---|---|
| Parakeet-Bridge nicht erreichbar | Sprachzug entfällt, Fehler im Log; Bridge startet begrenzt neu. |
| Magpie-Bridge nicht erreichbar | Antwort geht als Text in den Kanal (Verhalten des Hosts beim TTS-Fehler, beim Bauen bestätigen). |
| NVIDIA-Kontingent erschöpft / Schlüssel ungültig | Bridge antwortet mit HTTP 502 und klarer Meldung, keine Schleife. |
| Modellwechsel für Light schlägt fehl | Standardmodell mit Thinking `off`; langsamer, aber funktionsfähig. |
| Umschalt-Klick von fremder Person | Wird ignoriert, Nachricht bleibt unverändert. |
| Ansage vor Werkzeugaufruf wird im `stt-tts`-Modus nicht ausgesprochen | Kurze Pause statt Ansage; die Anweisung bleibt harmlos im Prompt. |

## Tests

- Bridges: Unit-Tests mit gemocktem Riva-Client (Format, Satzaufteilung, Fehler-Mapping) und je ein Livetest mit einem echten deutschen Satz hin und zurück.
- PLUR1BUS: Modus-Speicher (atomar, Standard `persona`), Weglassen von Recall und Modellwechsel nur bei Sprachraum-Sitzung plus Light, Capture läuft weiter, Umschalten per Befehl und Knopf, Berechtigung, `thinkingLevel`-Patch ohne `model`.
- Livetest mit dem Besitzer: `/vc join` in „Test“, ein Satz in Persona, Umschalten auf Light, derselbe Satz, Antwortzeit vergleichen; Folgen an/aus; eine Sprachnachricht; Probehören der sechs Stimmen.

## Nicht Teil dieses Umbaus

- Realtime-Modus über OpenAI (bleibt konfiguriert, ungenutzt).
- Die Sprachnachrichten-Bridge auf Port 8020 und ihr englisches Modell.
- Light für geschriebene Discord-Nachrichten oder andere Kanäle.
