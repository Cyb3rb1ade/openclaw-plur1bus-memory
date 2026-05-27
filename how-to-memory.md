# How-To: PLUR1BUS Memory

Stand: 2026-05-27<br>
Version: `4.2.17`<br>
Branch: `main`

PLUR1BUS ist ein OpenClaw-Plugin fuer persistentes, agent-getrenntes Memory.
Es laeuft als additives Augment: `memory-core` bleibt der OpenClaw-Memory-Slot,
PLUR1BUS liefert LanceDB-Recall, Auto-Capture, Curation, Reranking und die
optionale Obsidian-Review-Oberflaeche.

## Installation

Normaler Weg fuer externe Nutzer:

```bash
openclaw plugins install clawhub:@cyb3rb1ade/plur1bus-memory --force
openclaw gateway restart
```

`--force` ersetzt nur das Plugin-Paket. Bestehende Daten bleiben erhalten:

- LanceDB: `{OPENCLAW_HOME}/memory/lancedb-namespaced/`
- Embeddings und gespeicherte Memory-Rows
- Provider-/Model-Konfiguration in `openclaw.json`
- Cohere-Reranker-Konfiguration
- Obsidian-Vault-Dateien und ReviewBundles

Der Repo-Installer folgt derselben Regel. `--update-plugin-only` aktualisiert
Plugin-Dateien und Registry-Eintraege, ohne Workspace-Konfiguration oder
Memory-Datenbank zu ueberschreiben.

## Konfiguration

PLUR1BUS wird unter `plugins.entries.memory-lancedb-namespaced.config`
konfiguriert. Minimal:

```json
{
  "plugins": {
    "entries": {
      "memory-lancedb-namespaced": {
        "enabled": true,
        "config": {
          "baseDbPath": "~/.openclaw/memory/lancedb-namespaced",
          "embedding": {
            "provider": "openai",
            "model": "text-embedding-3-large"
          },
          "reranker": {
            "provider": "cohere",
            "model": "rerank-v3.5"
          }
        }
      }
    }
  }
}
```

Provider sind absichtlich vom Chat-Modell getrennt. OpenClaw kann zum Beispiel
Kimi als Chat-Modell verwenden, waehrend PLUR1BUS OpenAI-kompatible Embeddings
und Cohere-Reranking nutzt.

## Tools

- `memory_store`: speichert eine gepruefte Erinnerung.
- `memory_recall`: sucht semantisch im aktuellen Agent-/Workspace-Memory.
- `memory_search`: kompatibler Alias fuer denselben Recall-Pfad.
- `memory_forget`: tombstoned oder loescht eine Erinnerung explizit.
- `knowledge_update`: aktualisiert kuratierte Workspace-Wahrheit.

Auto-Capture und Auto-Recall laufen ueber OpenClaw-Hooks. Manuelle Tools
bleiben auch dann nutzbar, wenn Auto-Capture oder Auto-Recall deaktiviert sind.

## Agent- und Workspace-Trennung

Jeder Agent schreibt in seinen eigenen LanceDB-Namespace. Sichtbarkeit wird
ueber `agentId`, `storedBy`, `workspaceKey` und `scope` entschieden:

- `agent_private`: Standard fuer agent-spezifische Erinnerungen.
- `workspace_shared`: nur nach Promotion oder expliziter Freigabe.
- `global_user`: nur nach expliziter globaler Policy.

Obsidian-Importe sind zusaetzlich workspace-gebunden. Ein ReviewBundle aus einem
fremden Agenten-Workspace darf nicht in die aktuelle Agent-DB schreiben.

## Obsidian Review Flow

Obsidian ist optional und keine zweite Memory-Datenbank. Es zeigt Vorschlaege,
Dashboards und ReviewBundles. Normale Bedienung:

```text
/plur1bus_morning
/plur1bus_review
/plur1bus_review approve low-risk
/plur1bus_review apply
```

Wichtig:

- Morning/evening/review/approve sind Preview-Schritte.
- Approval markiert Items nur als genehmigt.
- Nur `apply` schreibt genehmigte Memory-Kandidaten in LanceDB.
- `System Health` in Review-Ausgaben ist auto-managed Vault-Hygiene und keine
  Memory-Freigabe.
- Bundle-IDs sind in Telegram-Antworten optional. Ohne ID nutzt show/explain/
  approve/reject das neueste pending Bundle; apply nutzt das neueste approved
  Bundle.

Details stehen in [`HOW-TO-OBSIDIAN.md`](HOW-TO-OBSIDIAN.md).

## Betrieb und Pruefung

Nach Installation:

```bash
openclaw plugins inspect memory-lancedb-namespaced
openclaw plugins doctor
openclaw gateway health
```

Bei Memory-Fragen zuerst unterscheiden:

- Plugin live? `openclaw plugins inspect memory-lancedb-namespaced`
- Daten vorhanden? `memory_recall` im Agenten-Kontext testen.
- Provider ok? `node scripts/memory-doctor.mjs provider-check`
- Obsidian unklar? `/plur1bus_review explain`

## Weiterfuehrend

- [`how-to-memory-perfect.md`](how-to-memory-perfect.md): Detailarchitektur und
  Betrieb.
- [`HOW-TO-OBSIDIAN.md`](HOW-TO-OBSIDIAN.md): ReviewBundles, System Health,
  Agent-Grenzen und Apply-Sicherheit.
- [`HOW-TO-UPDATE.md`](HOW-TO-UPDATE.md): OpenClaw-Update-Gate.
