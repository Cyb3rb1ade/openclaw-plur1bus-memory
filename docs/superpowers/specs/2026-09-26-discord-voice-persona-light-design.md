# Discord-Sprachräume mit Persona / Light — Design

Stand: 26.09.2026. Freigegeben im Gespräch (Teil 1 Bausteine, Teil 2 Ablauf). Dieses Dokument ist die Vorlage für den Umsetzungsplan.

## Ziel

Bernd (Agent `main`) soll

1. auf Zuruf (`/vc join`) in Discord-Sprachräume kommen, zuhören und mit Stimme antworten,
2. dem Besitzer in Sprachräume folgen können, an- und abschaltbar,
3. Discord-Sprachnachrichten verschicken können,
4. in Sprachräumen zwischen **Persona** (voll) und **Light** (schnell) umschaltbar sein,
5. den gesamten Discord-Server verwalten können: Kanäle, Rollen, Mitglieder, Moderation, Events, Emojis, Präsenz.

Light gilt nur in Sprachraum-Sitzungen. Geschriebene Discord-Nachrichten laufen immer als Persona.

## Ausgangslage (geprüft am 26.09.2026)

- Drei eigene Dienste sind seit mindestens 02.09. tot, weil ihre Programme fehlen und keine Kopie existiert: `discord-voice-stt` (Node), `nemotron-asr-stream` (Python, Port 8021), `magpie-tts-bridge` (Python, Port 8025). Sie starten in einer Schleife neu und füllen das Syslog (etwa 700 MB pro Tag).
- OpenClaw 2026.9.6 bringt Discord-Sprachräume (`/vc join|leave|status`, `voice.followUsers`, `voice.autoJoin`, Modi `agent-proxy` und `stt-tts`) und Discord-Sprachnachrichten (`message`-Werkzeug, OGG/Opus mit Wellenform) selbst mit. Die eigenen Dienste waren ein früher Nachbau davon.
- `channels.discord.voice` ist eingeschaltet (Realtime über OpenAI `gpt-realtime-2`), aber `plugins.entries.discord.enabled` steht auf `false`. Bernd ist auf Discord derzeit nicht aktiv.
- Der Bot-Token (`channels.discord.accounts.default.token`) ist gültig: Bot „Bernd das Bot“ (`1486657982820253736`), Server „Server von Cyb3rblade“ (`1486678369901744240`), Besitzer `1323072788939935867`. Sprachräume: „Allgemein“ (`1486678370434551811`), „Test“ (`1518159522076823592`).
- Discord steht auf `allowFrom: ["*"]`, `commands.ownerAllowFrom` ist nicht gesetzt.
- Der Bot hat auf dem Server die Rolle „Bernd das Bot“ mit **Administrator**-Recht (Kanäle, Server, Rollen, Kick, Ban, Timeout, Nachrichten, Webhooks, Events, Verbinden, Sprechen).
- OpenClaw-Aktionsgruppen (`channels.discord.actions.*`) ab Werk: an sind reactions, messages, threads, pins, polls, search, memberInfo, roleInfo, channelInfo, channels, voiceStatus, events, stickers, emojiUploads, stickerUploads, permissions; **aus** sind roles, moderation, presence.
- NVIDIA-Schlüssel (`/root/.openclaw/.env.nemotron`), per Riva-Konfigurationsabfrage geprüft:
  - Parakeet 1.1B RNNT multilingual (`71203149-d3b7-4460-8231-1be2543a1fca`): Deutsch, offline und streaming.
  - Magpie TTS multilingual (`877104f7-e885-42b9-8de8-f6e4c6303969`): Deutsch, 22 050 Hz, Stimmen `DE-DE.Diego`, `.Jason`, `.Leo`, `.Mia`, `.Pascal`, `.Ray`.
  - Nemotron ASR Streaming (`bb0837de-…`) kann nur `en-US`. Ungeeignet.
- Eine Parakeet-Bridge existiert bereits und läuft: `parakeet-stt-bridge.service`, Port 8000, `de-DE`, OpenAI-kompatibel, Sprechererkennung per Standard an (`PARAKEET_DIARIZE_DEFAULT=1`). `tools.media.audio` zeigt auf sie, Sprachnachrichten werden damit erkannt.
- Nachgeprüft im Host-Code (Bericht 26.09.): Der `stt-tts`-Modus nimmt die Spracherkennung **nur** aus `tools.media.audio`, es gibt keinen eigenen Endpunkt pro Sprachraum. Er schickt `segment.wav` (48 kHz, Stereo, PCM) mit `model`, optional `language`/`prompt`, ohne `diarize`, und liest `{text}`.
- Sprachausgabe: `voice.tts` wird über das oberste `tts` gelegt. Der OpenAI-Anbieter ruft `POST {baseUrl}/audio/speech` mit `{model, input, voice, response_format, speed?, instructions?}`, verlangt für Discord `response_format: "opus"` (Ogg/Opus) und braucht einen nicht leeren `apiKey`, auch bei lokaler Adresse. Schlägt die Sprachausgabe fehl, steht nur ein Log-Eintrag da; es wird **kein** Text gepostet.
- Im `stt-tts`-Modus wird nur die **Endantwort** gesprochen; ein Satz vor einem Werkzeugaufruf fällt weg. Ist `reasoningLevel` an, würden Denk-Texte mitgesprochen.
- Sprachzüge tragen im Hook-Kontext `messageProvider: "discord-voice"`; der Sitzungsschlüssel ist `agent:main:discord:channel:<Sprachraum-ID>`. `before_dispatch` feuert für Sprachzüge nicht, wohl aber für Textnachrichten im Chat des Sprachraums (`conversationId: "channel:<Sprachraum-ID>"`). Ein Ereignis für Beitreten oder Verlassen gibt es für Plugins nicht.
- Thinking pro Sitzung: `api.runtime.agent.session.patchSessionEntry({agentId, sessionKey, update})` mit `thinkingLevel`. `before_model_resolve` liefert `providerOverride` und `modelOverride` getrennt.
- Discord-Knöpfe: `registerInteractiveHandler({channel: "discord", …})` wird vom Host bedient; gesendet über `loadAdapter("discord").sendPayload` mit `payload.interactive` (Block `buttons`, `action: {type: "callback", value}`). Knöpfe gelten 30 Minuten und je einmal.
- `commands.ownerAllowFrom` ersetzt für Sprachräume `allowFrom`; Einträge `discord:user:<id>` werden verworfen, `discord:<id>` gilt.
- Plugin-Hooks: `before_model_resolve` darf das Modell pro Lauf übersteuern, `before_prompt_build` Kontext weglassen. Thinking lässt sich nicht per Hook, aber per Sitzungs-Override (`thinkingLevel`) setzen. Ein `sessions.patch` mit `model` schreibt die Agent-Konfiguration um und ist deshalb verboten; `thinkingLevel` allein tut das nicht.
- Alle Anthropic-Katalogeinträge tragen `reasoning: true`. Ein Modellwechsel allein schaltet Thinking nicht ab.

## Architektur

```
Discord-Sprachraum
  │  Audio (Opus)
  ▼
OpenClaw discord voice, mode stt-tts ──► tools.media.audio ──► [Parakeet-Bridge :8000, vorhanden] ──► NVIDIA Parakeet (de-DE)
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
  - Sprachausgabe über das oberste `tts`: Anbieter `openai`, `baseUrl` `http://127.0.0.1:8025/v1`, `apiKey` `local`, `voice` `DE-DE.Leo`, `responseFormat` `opus`. Gilt für Sprachräume und Sprachnachrichten.
  - `allowedChannels`: beide Sprachräume.
- `commands.ownerAllowFrom` bekommt `discord:1323072788939935867`, damit Sprachzüge und `/vc` den Besitzer eindeutig kennen.
- `allowFrom: ["*"]` wird im Zuge dessen auf den Besitzer eingeengt, sofern nichts anderes davon abhängt (vor dem Umstellen prüfen, wer auf dem Server schreibt).
- Die genauen Schlüssel werden beim Bauen gegen das Schema von 2026.9.6 geprüft (`openclaw config` mit Trockenlauf).

### Baustein 2: Parakeet-Bridge (vorhanden, Port 8000)

- Keine neue Bridge. Die vorhandene `parakeet_stt_bridge.py` bleibt der Erkennungsweg für Sprachnachrichten und Sprachräume.
- Eine kleine Änderung: Für Anfragen mit dem Dateinamen `segment.wav` (so benennt der Discord-Sprachmodus seine Stücke) wird die Sprechererkennung übersprungen, weil jedes Stück schon genau einem Sprecher gehört und die Erkennung nur Zeit kostet. Ein ausdrückliches `diarize`-Feld gewinnt weiterhin.
- Die tote Unit `nemotron-asr-stream.service` wird deaktiviert (Baustein 7).

### Baustein 3: Magpie-Bridge (Port 8025)

- Neues Python-Programm `magpie_speech_bridge.py`, Unit `magpie-tts-bridge.service` wird darauf umgestellt.
- OpenAI-kompatibel: `POST /v1/audio/speech` mit `{"input", "voice", "response_format"}`. `voice` wird auf eine Magpie-Stimme abgebildet (Standard `DE-DE.Leo`, frei wählbar per Umgebungsvariable). Formate `opus`, `mp3`, `wav`, `pcm`; Umwandlung per ffmpeg.
- Lange Texte werden satzweise synthetisiert und zusammengefügt (Riva-Grenze pro Anfrage).
- Nur auf `127.0.0.1`.

### Baustein 4: Persona / Light (PLUR1BUS)

- Neuer Modus-Speicher je Agent, Werte `persona` (Standard) und `light`, persistiert unter `<baseDbPath>/.plur1bus-voice-mode/<agentId>.json` (atomar geschrieben). Der Modus bleibt, bis er umgeschaltet wird.
- Erkennung eines Sprachzugs an `ctx.messageProvider === "discord-voice"`, gekapselt in `isDiscordVoiceTurn(ctx)`.
- Nur wenn beides zutrifft (Sprachraum-Sitzung und Modus `light`):
  - Auto-Recall und alle Zusatzblöcke im Prompt entfallen (Recall-Prelude, Semantic Lens, Reactivation, Persona-Voice-Direktive, zeitlicher Kontext). Umsetzung als ein früher Ausstieg in den bestehenden Prompt-Hooks.
  - `before_model_resolve` liefert `{providerOverride: "anthropic", modelOverride: "claude-haiku-4-5"}`.
  - Eine kurze feste Anweisung: bei Fragen, die Erinnerungen brauchen, `memory_recall` nutzen und kurz antworten. (Eine gesprochene Ansage vorher ist im `stt-tts`-Modus nicht möglich, weil nur die Endantwort gesprochen wird.)
- Das Speichern (`agent_end`-Capture) läuft in beiden Modi unverändert.
- Beim Umschalten setzt PLUR1BUS über `patchSessionEntry` den `thinkingLevel` der Sprachraum-Sitzungen (`agent:main:discord:channel:<id>` für jeden Raum aus `voice.allowedChannels`) auf `off` (Light) bzw. entfernt ihn (Persona). Außerdem immer `reasoningLevel: "off"` in diesen Sitzungen, damit keine Denk-Texte gesprochen werden. Nie `model`.

### Baustein 5: Umschalten

- Textbefehl `/voice light` und `/voice full` in Discord. Umsetzung über denselben Weg wie die zitierten Critical-Antworten (Hook `before_dispatch`), weil `registerCommand` im Host nicht live ankommt.
- Textbefehl `/voice` ohne Argument schickt eine Knopfnachricht „Persona“ / „Light“ in den Chat des Sprachraums (bzw. in den Kanal, in dem der Befehl kam). Klick über `registerInteractiveHandler({channel: "discord", namespace: "plurv"})`. Nach dem Klick zeigt die Nachricht den aktiven Modus mit frischen Knöpfen.
- Nur der Besitzer darf umschalten (Allowlist-Prüfung des Hosts plus Abgleich mit `commands.ownerAllowFrom`).
- Ein automatisches Senden der Knöpfe beim Betreten entfällt, weil Plugins kein Beitritts-Ereignis sehen.

### Baustein 6: Serververwaltung

- `channels.discord.actions`: `roles: true`, `moderation: true`, `presence: true`. Die übrigen Gruppen sind ab Werk an und bleiben es.
- Weil Bernd damit Kanäle löschen, Rollen vergeben und Mitglieder bannen kann, wird `channels.discord.allowFrom` auf den Besitzer (`1323072788939935867`) eingeengt und `commands.ownerAllowFrom` gesetzt (Baustein 1). Sonst könnte jede Person, die auf dem Server schreibt, Bernd zu diesen Aktionen bringen.
- In Bernds `AGENTS.md` eine kurze Regel: vor unumkehrbaren Aktionen (Kanal oder Rolle löschen, Ban, Kick) einmal nachfragen; Anlegen, Umbenennen, Rechte setzen, Timeout ohne Rückfrage.
- Die Aktionen stehen Bernd in jeder Sitzung zur Verfügung, also auch aus Telegram heraus (`message`-Werkzeug mit `channel: "discord"` und `guildId`).

### Baustein 7: Aufräumen

- `discord-voice-stt.service` wird deaktiviert und gestoppt. Die Unit-Datei bleibt als `.disabled` liegen.
- Beide Bridge-Units bekommen `StartLimitIntervalSec=300`, `StartLimitBurst=5` und `RestartSec=10`, damit ein künftiger Ausfall nicht wieder das Syslog flutet.

## Fehlerfälle

| Fall | Verhalten |
|---|---|
| Parakeet-Bridge nicht erreichbar | Sprachzug entfällt, Fehler im Log; Bridge startet begrenzt neu. |
| Magpie-Bridge nicht erreichbar | Bernd bleibt im Raum stumm, der Host schreibt `discord voice: TTS failed` ins Log. Kein Text-Ersatz (so gebaut im Host). |
| NVIDIA-Kontingent erschöpft / Schlüssel ungültig | Bridge antwortet mit HTTP 502 und klarer Meldung, keine Schleife. |
| Modellwechsel für Light schlägt fehl | Standardmodell mit Thinking `off`; langsamer, aber funktionsfähig. |
| Umschalt-Klick von fremder Person | Wird ignoriert, Nachricht bleibt unverändert. |
| Gedächtnis-Nachschlagen in Light | Kurze Pause bis zur Antwort; eine Ansage vorher ist im `stt-tts`-Modus nicht möglich. |

## Tests

- Magpie-Bridge: `unittest`-Tests (kein pytest in der venv) mit gemocktem Riva-Aufruf (Formate, Satzaufteilung, Fehler-Mapping) und ein Livetest mit einem echten deutschen Satz. Parakeet-Bridge: ein Test, dass `segment.wav` ohne Sprechererkennung läuft.
- PLUR1BUS: Modus-Speicher (atomar, Standard `persona`), Weglassen von Recall und Modellwechsel nur bei Sprachraum-Sitzung plus Light, Capture läuft weiter, Umschalten per Befehl und Knopf, Berechtigung, `thinkingLevel`-Patch ohne `model`.
- Serververwaltung: nach dem Umstellen je eine harmlose Aktion pro Gruppe als Livetest (Testkanal anlegen und wieder löschen, Testrolle anlegen und wieder löschen, Präsenz setzen); Moderation nur als Trockenprüfung der Freigabe, nicht an echten Mitgliedern.
- Livetest mit dem Besitzer: `/vc join` in „Test“, ein Satz in Persona, Umschalten auf Light, derselbe Satz, Antwortzeit vergleichen; Folgen an/aus; eine Sprachnachricht; Probehören der sechs Stimmen.

## Nicht Teil dieses Umbaus

- Realtime-Modus über OpenAI (bleibt konfiguriert, ungenutzt).
- Die Sprachnachrichten-Bridge auf Port 8020 und ihr englisches Modell.
- Light für geschriebene Discord-Nachrichten oder andere Kanäle.
- Weitere Discord-Server; die Konfiguration betrifft nur „Server von Cyb3rblade“.
