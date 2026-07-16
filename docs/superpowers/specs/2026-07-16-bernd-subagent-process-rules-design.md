# Bernd Subagent-Prozess-Regeln (Ansatz A)

**Datum:** 2026-07-16 · **Anlass:** Session 3e4c0dac (ITOM-Recherche)

## Problem
1. Phantom-Aktion: Researcher angekündigt, aber nicht gespawnt (26 min verloren)
2. Truncation: langes Recherche-Ergebnis in Telegram abgeschnitten, kein Datei-Fallback
3. Recovery-Fehlversuche (`message action=read` existiert nicht) + zweiter Researcher als Doppelarbeit
4. (Ausgeklammert: Cron-Rauschen in Main-Session — Ansatz C, nicht beauftragt)

## Lösung (nur Prompt-Regeln, kein Code/Patch)
Drei neue Regel-Blöcke in `/root/.openclaw/workspace/AGENTS.md` (Abschnitt Recherche-Subagents):

1. **Spawn-Regel:** Aktion ankündigen = Tool-Call im selben Turn; Prüfung vor jedem `sessions_yield`.
2. **Datei-first (Pflicht):** Jeder Recherche-Spawn verlangt `workspace/subagent-recherche-<thema>.md`; an Christian Zusammenfassung (~3000 Zeichen) + Datei-Attachment.
3. **Recovery-Playbook:** Datei senden → sonst `sessions_history` in Datei sichern → nie zweiten Researcher spawnen; `message action=read` existiert nicht.

## Verifikation
- Blöcke in AGENTS.md vorhanden, protect-canonical-docs.sh übernimmt gewachsene Datei als Snapshot (kein Revert).
- Erfolgskriterium im Betrieb: keine angekündigten-aber-nicht-gestarteten Spawns, keine verlorenen Recherche-Inhalte mehr.

## Nachtrag 2026-07-16 (Reaction-Ziel-Off-by-one)

Beobachtung: Bernd reagiert bei "Reaction + Post" auf die vorherige statt der aktuellen Nachricht.
Ermittlung: OpenClaw liefert die aktuelle message_id sehr wohl im Live-Prompt ("Conversation info"-Block);
strip-inbound-meta entfernt ihn nur aus gespeicherten Sessions/Trajectories (deshalb in Logs unsichtbar).
Kein Upstream-Bug → geplanter Patch (A) und Upstream-Issue (C) entfallen.
Fix: Verhaltensregel in AGENTS.md — Reactions immer auf die aktuelle message_id aus Conversation info,
IDs nie raten/hochzählen/wiederverwenden.
