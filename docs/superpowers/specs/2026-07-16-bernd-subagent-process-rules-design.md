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
