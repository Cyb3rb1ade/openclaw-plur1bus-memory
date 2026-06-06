/**
 * lib/i18n-dictionary.js — PLUR1BUS translations.
 *
 * Structure: dictionary[key][lang][tone]
 *
 * Every key MUST have at least `en.default`.
 * Tone variants: "casual", "formal", "default".
 */

export const dictionary = {
  // ─── Maintenance nudges (before_prompt_build) ──────────────────────────────
  "nudge.knowledge_pending": {
    de: { default: "{{count}} wichtige Erinnerungen warten auf KNOWLEDGE.md-Integration{{stale}}. Rufe knowledge_update nach einer Architektur-Entscheidung, einer stabilen Präferenz oder einem abgeschlossenen Projekt auf." },
    en: { default: "{{count}} high-importance memories pending KNOWLEDGE.md integration{{stale}}. Call knowledge_update after an architectural decision, a stable preference, or a finished project." },
  },
  "nudge.knowledge_stale": {
    de: { default: " (letzte Aktualisierung vor {{days}} Tagen)" },
    en: { default: " (last update {{days}} days ago)" },
  },
  "nudge.conflict_review": {
    de: { default: "{{count}} ungeprüfte Entscheidungs-Konflikte ({{sizeKb}} KB). Sprich das proaktiv an und biete eine Durchsicht an; das Log nicht ohne ausdrückliche Bestätigung rotieren/löschen." },
    en: { default: "{{count}} unreviewed decision-conflicts ({{sizeKb}} KB). Surface this proactively and offer to review; do not rotate/delete the log without explicit confirmation." },
  },

  // ─── Reminder Commands ─────────────────────────────────────────────────────
  // Hinweis: bewusst list_none (nicht none) — der none-Key existiert bereits im
  // Nudge-Kontext (No due reminders). Hier: Command-Liste-Variante.
  "reminder.list_none": {
    de: { default: "🔔 Keine aktiven Reminder." },
    en: { default: "🔔 No active reminders." },
  },
  "reminder.list_header": {
    de: { default: "🔔 Aktive Reminder:" },
    en: { default: "🔔 Active reminders:" },
  },
  "reminder.list_item": {
    de: { default: "• {{when}} — {{text}} [{{status}}] (ID: {{id}})" },
    en: { default: "• {{when}} — {{text}} [{{status}}] (ID: {{id}})" },
  },
  "reminder.list_hint": {
    de: { default: "Abbrechen mit: `/plur1bus reminders cancel <id>`" },
    en: { default: "Cancel with: `/plur1bus reminders cancel <id>`" },
  },
  "reminder.cancel_usage": {
    de: { default: "Benutzung: `/plur1bus reminders cancel <id>`" },
    en: { default: "Usage: `/plur1bus reminders cancel <id>`" },
  },
  "reminder.cancel_success": {
    de: { default: "✅ Reminder {{id}} abgebrochen." },
    en: { default: "✅ Reminder {{id}} cancelled." },
  },
  "reminder.cancel_failed": {
    de: { default: "❌ Reminder {{id}} konnte nicht abgebrochen werden: {{error}}" },
    en: { default: "❌ Could not cancel reminder {{id}}: {{error}}" },
  },
  "reminder.unknown": {
    de: { default: "Unbekannter Reminder-Befehl: {{sub}}. Verfügbar: list, cancel <id>" },
    en: { default: "Unknown reminder command: {{sub}}. Available: list, cancel <id>" },
  },

  // ─── Skill Commands ──────────────────────────────────────────────────────
  "skill.no_proposals": {
    de: {
      casual: "Keine offenen Skill-Vorschläge. Der Skill Miner läuft wöchentlich und schlägt neue Skills vor, sobald genug Belege da sind.",
      formal: "Keine offenen Skill-Vorschläge. Der Skill Miner wird wöchentlich ausgeführt und schlägt neue Skills vor, sobald ausreichend Belege vorliegen.",
      default: "Keine offenen Skill-Vorschläge. Der Skill Miner läuft wöchentlich.",
    },
    en: {
      casual: "No open skill proposals. The Skill Miner runs weekly and suggests new skills once enough evidence is available.",
      formal: "No open skill proposals. The Skill Miner is executed weekly and proposes new skills once sufficient evidence has been gathered.",
      default: "No open skill proposals. The Skill Miner runs weekly.",
    },
  },
  "skill.proposals_header": {
    de: { default: "🛠️ Skill-Vorschläge:" },
    en: { default: "🛠️ Skill Proposals:" },
  },
  "skill.proposal_item": {
    de: { default: "• {{title}} (ID: {{id}})" },
    en: { default: "• {{title}} (ID: {{id}})" },
  },
  "skill.proposal_evidence": {
    de: { default: "  Confidence: {{confidence}} | Evidence: {{evidence}} memories" },
    en: { default: "  Confidence: {{confidence}} | Evidence: {{evidence}} memories" },
  },
  "skill.proposal_commands": {
    de: { default: "Befehle: `/plur1bus skills approve <id>` | `/plur1bus skills reject <id>` | `/plur1bus skills show <id>`" },
    en: { default: "Commands: `/plur1bus skills approve <id>` | `/plur1bus skills reject <id>` | `/plur1bus skills show <id>`" },
  },
  "skill.approve_success": {
    de: { default: "✅ Skill \"{{title}}\" bestätigt.\nGespeichert unter: skills/{{name}}/SKILL.md" },
    en: { default: "✅ Skill \"{{title}}\" approved.\nSaved to: skills/{{name}}/SKILL.md" },
  },
  "skill.approve_not_found": {
    de: { default: "❌ Proposal {{id}} not found." },
    en: { default: "❌ Proposal {{id}} not found." },
  },
  "skill.approve_not_pending": {
    de: { default: "❌ Proposal {{id}} is not pending." },
    en: { default: "❌ Proposal {{id}} is not pending." },
  },
  "skill.reject_success": {
    de: { default: "🚫 Skill \"{{title}}\" rejected. Will not be suggested again." },
    en: { default: "🚫 Skill \"{{title}}\" rejected. Will not be suggested again." },
  },
  "skill.reject_not_found": {
    de: { default: "❌ Proposal {{id}} not found." },
    en: { default: "❌ Proposal {{id}} not found." },
  },
  "skill.active_none": {
    de: { default: "Keine aktiven Skills. Bestätige Vorschläge mit `/plur1bus skills approve <id>`." },
    en: { default: "No active skills. Approve proposals with `/plur1bus skills approve <id>`." },
  },
  "skill.active_header": {
    de: { default: "✅ Aktive Skills:" },
    en: { default: "✅ Active Skills:" },
  },
  "skill.active_item": {
    de: { default: "• {{title}} → skills/{{name}}/SKILL.md" },
    en: { default: "• {{title}} → skills/{{name}}/SKILL.md" },
  },
  "skill.show_not_found": {
    de: { default: "❌ Proposal {{id}} not found." },
    en: { default: "❌ Proposal {{id}} not found." },
  },
  "skill.show_description": {
    de: { default: "**Beschreibung:**" },
    en: { default: "**Description:**" },
  },
  "skill.show_instructions": {
    de: { default: "**Anweisungen:**" },
    en: { default: "**Instructions:**" },
  },
  "skill.show_examples": {
    de: { default: "**Beispiele:**" },
    en: { default: "**Examples:**" },
  },

  // ─── Memory Edit ─────────────────────────────────────────────────────────
  "forget.db_read_error": {
    de: { default: "DB-Lesefehler: {{error}}" },
    en: { default: "DB read error: {{error}}" },
  },
  "forget.card_not_found": {
    de: { default: 'Card "{{id}}" not found.' },
    en: { default: 'Card "{{id}}" not found.' },
  },
  "forget.archive_failed": {
    de: { default: "Archive failed — NOT deleted: {{error}}" },
    en: { default: "Archive failed — NOT deleted: {{error}}" },
  },
  "forget.delete_error": {
    de: { default: "Delete error (archive exists): {{error}}" },
    en: { default: "Delete error (archive exists): {{error}}" },
  },
  "forget.success": {
    de: { default: '✅ Forgotten: "{{title}}"\n_(Archive: {{path}})_' },
    en: { default: '✅ Forgotten: "{{title}}"\n_(Archive: {{path}})_' },
  },
  "forget.failed": {
    de: { default: "❌ Forget failed: {{error}}" },
    en: { default: "❌ Forget failed: {{error}}" },
  },
  "correct.db_read_error": {
    de: { default: "DB read error: {{error}}" },
    en: { default: "DB read error: {{error}}" },
  },
  "correct.card_not_found": {
    de: { default: 'Card "{{id}}" not found.' },
    en: { default: 'Card "{{id}}" not found.' },
  },
  "correct.archive_failed": {
    de: { default: "Archive failed — NOT changed: {{error}}" },
    en: { default: "Archive failed — NOT changed: {{error}}" },
  },
  "correct.update_error": {
    de: { default: "Update not possible: {{error}}" },
    en: { default: "Update not possible: {{error}}" },
  },
  "correct.success": {
    de: { default: '✅ Corrected: "{{title}}"\n_(Archive: {{path}})_' },
    en: { default: '✅ Corrected: "{{title}}"\n_(Archive: {{path}})_' },
  },
  "correct.failed": {
    de: { default: "❌ Correction failed: {{error}}" },
    en: { default: "❌ Correction failed: {{error}}" },
  },
  "candidate_choice.forget": {
    de: { default: "🧠 Multiple matches — which one should be forgotten?" },
    en: { default: "🧠 Multiple matches — which one should be forgotten?" },
  },
  "candidate_choice.correct": {
    de: { default: "🧠 Multiple matches — which one should be corrected?" },
    en: { default: "🧠 Multiple matches — which one should be corrected?" },
  },
  "candidate_item": {
    de: { default: "{{n}}. {{title}}\n   _{{source}} · {{date}}_" },
    en: { default: "{{n}}. {{title}}\n   _{{source}} · {{date}}_" },
  },
  "candidate_button": {
    de: { default: "{{n}}. {{title}}" },
    en: { default: "{{n}}. {{title}}" },
  },

  // ─── Memory Query ────────────────────────────────────────────────────────
  "memory.help_header": {
    de: { default: "🧠 /memory — Erinnerungen einsehen" },
    en: { default: "🧠 /memory — View memories" },
  },
  "memory.help_examples": {
    de: { default: "Beispiele:\n• /memory heute\n• /memory diese Woche\n• /memory Mai\n• /memory über Eva\n• /memory was weißt du über Riva" },
    en: { default: "Examples:\n• /memory today\n• /memory this week\n• /memory May\n• /memory about Eva\n• /memory what do you know about Riva" },
  },
  "memory.no_results_time": {
    de: { default: "🧠 Keine Erinnerungen {{range}}." },
    en: { default: "🧠 No memories {{range}}." },
  },
  "memory.no_results_topic": {
    de: { default: 'Nichts gefunden zu "{{topic}}".' },
    en: { default: 'Nothing found for "{{topic}}".' },
  },
  "memory.no_results": {
    de: { default: "🧠 Keine Erinnerungen gefunden." },
    en: { default: "🧠 No memories found." },
  },
  "memory.header_time": {
    de: { default: "🧠 Erinnerungen {{range}} ({{count}}):" },
    en: { default: "🧠 Memories {{range}} ({{count}}):" },
  },
  "memory.header_topic": {
    de: { default: '🧠 Treffer für "{{topic}}" ({{count}}):' },
    en: { default: '🧠 Results for "{{topic}}" ({{count}}):' },
  },
  "memory.header_default": {
    de: { default: "🧠 Erinnerungen ({{count}}):" },
    en: { default: "🧠 Memories ({{count}}):" },
  },
  "memory.item": {
    de: { default: "• {{title}}\n  _{{source}} · {{date}}_" },
    en: { default: "• {{title}}\n  _{{source}} · {{date}}_" },
  },
  "memory.more_results": {
    de: { default: "(Mehr: {{count}} weitere — /memory mit engerer Frage)" },
    en: { default: "(More: {{count}} more — use /memory with a more specific query)" },
  },
  "range.today": {
    de: { default: "von heute" },
    en: { default: "from today" },
  },
  "range.yesterday": {
    de: { default: "von gestern" },
    en: { default: "from yesterday" },
  },
  "range.this_week": {
    de: { default: "aus dieser Woche" },
    en: { default: "from this week" },
  },
  "range.this_month": {
    de: { default: "aus diesem Monat" },
    en: { default: "from this month" },
  },
  "range.month": {
    de: { default: "aus {{month}}" },
    en: { default: "from {{month}}" },
  },

  // ─── Feature Toggle ──────────────────────────────────────────────────────
  "toggle.no_feature": {
    de: { default: "Kein Feature angegeben." },
    en: { default: "No feature specified." },
  },
  "toggle.unknown_feature": {
    de: { default: 'Feature "{{name}}" unbekannt. Bekannt: {{known}}' },
    en: { default: 'Feature "{{name}}" unknown. Known: {{known}}' },
  },
  "toggle.config_not_found": {
    de: { default: "openclaw.json not found: {{path}}" },
    en: { default: "openclaw.json not found: {{path}}" },
  },
  "toggle.config_read_error": {
    de: { default: "openclaw.json cannot be read: {{error}}" },
    en: { default: "openclaw.json cannot be read: {{error}}" },
  },
  "toggle.write_error": {
    de: { default: "Write failed: {{error}}" },
    en: { default: "Write failed: {{error}}" },
  },
  "toggle.success": {
    de: { default: "✅ {{label}} ist jetzt {{state}}. Restart erforderlich: systemctl --user restart openclaw-gateway" },
    en: { default: "✅ {{label}} is now {{state}}. Restart required: systemctl --user restart openclaw-gateway" },
  },
  "toggle.list_header": {
    de: { default: "Bekannte Features:" },
    en: { default: "Known Features:" },
  },
  "toggle.list_item": {
    de: { default: "• {{name}} — {{description}}" },
    en: { default: "• {{name}} — {{description}}" },
  },
  "toggle.list_usage": {
    de: { default: "Benutzung: /enable <feature>  oder  /disable <feature>" },
    en: { default: "Usage: /enable <feature>  or  /disable <feature>" },
  },
  "toggle.lock_error": {
    de: { default: "Config wird gerade von einem anderen Prozess geschrieben (Lock aktiv): {{error}}" },
    en: { default: "Config is being written by another process (lock active): {{error}}" },
  },
  "toggle.error_known": {
    de: { default: "❌ {{error}}\nBekannt: {{known}}" },
    en: { default: "❌ {{error}}\nKnown: {{known}}" },
  },
  "toggle.unknown_error": {
    de: { default: "Unbekannter Fehler." },
    en: { default: "Unknown error." },
  },
  "toggle.feature.vaultSync": {
    de: { default: "Vault-Sync (Obsidian-Bridge)" },
    en: { default: "Vault-Sync (Obsidian-Bridge)" },
  },
  "toggle.feature.kritischPush": {
    de: { default: "Push bei kritischen Memories" },
    en: { default: "Push on critical memories" },
  },
  "toggle.feature.dailyConsolidation": {
    de: { default: "Tägliche Konsolidierung" },
    en: { default: "Daily consolidation" },
  },
  "toggle.state_on": {
    de: { default: "an" },
    en: { default: "on" },
  },
  "toggle.state_off": {
    de: { default: "aus" },
    en: { default: "off" },
  },

  // ─── Status ──────────────────────────────────────────────────────────────
  "status.headline_ok": {
    de: { default: "alles gut" },
    en: { default: "all good" },
  },
  "status.headline_issues": {
    de: { default: "{{count}} Hinweis(e)" },
    en: { default: "{{count}} hint(s)" },
  },
  "status.memory_count": {
    de: { default: "• Erinnerungen: {{count}} Karten" },
    en: { default: "• Memories: {{count}} cards" },
  },
  "status.memory_count_updated": {
    de: { default: "• Erinnerungen: {{count}} Karten (zuletzt aktualisiert vor {{minutes}} Min)" },
    en: { default: "• Memories: {{count}} cards (last updated {{minutes}} min ago)" },
  },
  "status.vault_sync_active": {
    de: { default: "• Vault-Sync: aktiv, verbunden mit {{devices}} Geräten" },
    en: { default: "• Vault-Sync: active, connected to {{devices}} devices" },
  },
  "status.vault_sync_inactive": {
    de: { default: "• Vault-Sync: inaktiv (0 Geräte)" },
    en: { default: "• Vault-Sync: inactive (0 devices)" },
  },
  "status.vault_sync_unconfigured": {
    de: { default: "• Vault-Sync: {{status}}" },
    en: { default: "• Vault-Sync: {{status}}" },
  },
  "status.plausibility": {
    de: { default: "• Plausibilitätsprüfung: zuletzt {{lastRun}}" },
    en: { default: "• Plausibility check: last run {{lastRun}}" },
  },
  "status.mood": {
    de: { default: "• Stimmung: {{emoji}} {{label}} (Intensität: {{intensity}})" },
    en: { default: "• Mood: {{emoji}} {{label}} (intensity: {{intensity}})" },
  },
  "status.issues_header": {
    de: { default: "Hinweise:" },
    en: { default: "Hints:" },
  },
  "status.issue_reason": {
    de: { default: "  Grund: {{reason}}" },
    en: { default: "  Reason: {{reason}}" },
  },
  "status.issue_what_it_does": {
    de: { default: "  Was es macht: {{text}}" },
    en: { default: "  What it does: {{text}}" },
  },
  "status.issue_what_you_lose": {
    de: { default: "  Was du ohne es verlierst: {{text}}" },
    en: { default: "  What you lose without it: {{text}}" },
  },
  "status.issue_how_to_fix": {
    de: { default: "  Einschalten: {{text}}" },
    en: { default: "  Enable: {{text}}" },
  },
  "status.unknown": {
    de: { default: "unbekannt" },
    en: { default: "unknown" },
  },

  // ─── PLUR1BUS Commands (index.js) ────────────────────────────────────────
  "plur1bus.help_quick": {
    de: {
      default: "PLUR1BUS Befehle (auch mit /plur1bus Präfix):\n\n/memory <Anfrage> — Erinnerungen abrufen\n/forget <Beschreibung> — Erinnerung löschen\n/correct <alt> zu <neu> — Erinnerung ändern\n/state — Systemstatus\n/enable <feature> — Feature aktivieren\n/disable <feature> — Feature deaktivieren\n\n/plur1bus setup <profil> — Feature-Profil bestätigen (recommended, safe)\n/plur1bus skills review — Offene Skill-Vorschläge anzeigen\n/plur1bus skills list — Aktive Skills anzeigen\n/plur1bus reminders list — Aktive Reminder anzeigen\nErweitert: /plur1bus help advanced",
    },
    en: {
      default: "PLUR1BUS commands (also work with /plur1bus prefix):\n\n/memory <query> — recall memories\n/forget <description> — delete a memory\n/correct <old> to <new> — edit a memory\n/state — system state\n/enable <feature> — enable a feature\n/disable <feature> — disable a feature\n\n/plur1bus setup <profile> — confirm feature profile (recommended, safe)\n/plur1bus skills review — show open skill proposals\n/plur1bus skills list — show active skills\n/plur1bus reminders list — show active reminders\nAdvanced: /plur1bus help advanced",
    },
  },
  "plur1bus.help_advanced": {
    de: {
      default: "PLUR1BUS erweiterte Befehle:\n/plur1bus status\n/plur1bus doctor\n/plur1bus obsidian doctor\n/plur1bus obsidian dashboards build\n/plur1bus obsidian conflicts build\n/plur1bus obsidian rotate — Alte Archive rotieren (dryRun default)",
    },
    en: {
      default: "PLUR1BUS advanced commands:\n/plur1bus status\n/plur1bus doctor\n/plur1bus obsidian doctor\n/plur1bus obsidian dashboards build\n/plur1bus obsidian conflicts build\n/plur1bus obsidian rotate — Rotate old archives (dryRun default)",
    },
  },
  "plur1bus.setup_header": {
    de: { default: "PLUR1BUS Feature-Profil Setup:" },
    en: { default: "PLUR1BUS Feature Profile Setup:" },
  },
  "plur1bus.setup_profiles": {
    de: { default: "Verfügbare Profile:\n• recommended — Alle v6 Features aktiv\n• safe — Nur Kern-Features, keine LLM-intensiven Jobs\n\nVerwendung: /plur1bus setup <profil>" },
    en: { default: "Available Profiles:\n• recommended — All v6 features active\n• safe — Core features only, no LLM-intensive jobs\n\nUsage: /plur1bus setup <profile>" },
  },
  "plur1bus.setup_unknown": {
    de: { default: "❌ Unbekanntes Profil: {{profile}}. Bekannt: recommended, safe" },
    en: { default: "❌ Unknown profile: {{profile}}. Known: recommended, safe" },
  },
  "plur1bus.setup_confirm": {
    de: { default: '✅ PLUR1BUS Profil "{{profile}}" bestätigt.' },
    en: { default: '✅ PLUR1BUS profile "{{profile}}" confirmed.' },
  },
  "plur1bus.setup_activated": {
    de: { default: "Aktivierte Features:" },
    en: { default: "Activated Features:" },
  },
  "plur1bus.setup_pending": {
    de: { default: "⚠️ Pending Setup (bitte manuell bestätigen):" },
    en: { default: "⚠️ Pending Setup (please confirm manually):" },
  },
  "plur1bus.setup_restart": {
    de: { default: "Restart erforderlich: systemctl --user restart openclaw-gateway" },
    en: { default: "Restart required: systemctl --user restart openclaw-gateway" },
  },
  "plur1bus.setup_blocked": {
    de: { default: "🔒 Chat config changes are disabled (security.allowChatConfigCommands=false). Please edit openclaw.json directly and restart the gateway." },
    en: { default: "🔒 Chat config changes are disabled (security.allowChatConfigCommands=false). Please edit openclaw.json directly and restart the gateway." },
  },
  "plur1bus.skills_help": {
    de: {
      default: "🛠️ Skill-Befehle:\n\n/plur1bus skills review — Offene Vorschläge anzeigen\n/plur1bus skills approve <id> — Skill bestätigen\n/plur1bus skills reject <id> — Skill ablehnen\n/plur1bus skills list — Aktive Skills anzeigen\n/plur1bus skills show <id> — Vorschlag-Details",
    },
    en: {
      default: "🛠️ Skill Commands:\n\n/plur1bus skills review — show open proposals\n/plur1bus skills approve <id> — approve a skill\n/plur1bus skills reject <id> — reject a skill\n/plur1bus skills list — show active skills\n/plur1bus skills show <id> — proposal details",
    },
  },
  "plur1bus.no_workspace": {
    de: { default: "❌ Kein Workspace verfügbar." },
    en: { default: "❌ No workspace available." },
  },
  "plur1bus.skills_show_usage": {
    de: { default: "❌ Verwendung: /plur1bus skills show <id>" },
    en: { default: "❌ Usage: /plur1bus skills show <id>" },
  },
  "plur1bus.skills_approve_usage": {
    de: { default: "❌ Verwendung: /plur1bus skills approve <id>" },
    en: { default: "❌ Usage: /plur1bus skills approve <id>" },
  },
  "plur1bus.skills_reject_usage": {
    de: { default: "❌ Verwendung: /plur1bus skills reject <id>" },
    en: { default: "❌ Usage: /plur1bus skills reject <id>" },
  },
  "plur1bus.skills_unknown": {
    de: { default: "❌ Unbekannter skills-Befehl: {{sub}}" },
    en: { default: "❌ Unknown skills command: {{sub}}" },
  },
  "plur1bus.status_failed": {
    de: { default: "❌ /status failed: {{error}}" },
    en: { default: "❌ /status failed: {{error}}" },
  },
  "plur1bus.memory_failed": {
    de: { default: "❌ /memory failed: {{error}}" },
    en: { default: "❌ /memory failed: {{error}}" },
  },
  "plur1bus.forget_usage": {
    de: { default: "Verwendung: /forget <Beschreibung der zu löschenden Erinnerung>" },
    en: { default: "Usage: /forget <description of memory to forget>" },
  },
  "plur1bus.forget_failed": {
    de: { default: "❌ /forget failed: {{error}}" },
    en: { default: "❌ /forget failed: {{error}}" },
  },
  "plur1bus.forget_not_found": {
    de: { default: "Nothing found for \"{{query}}\"." },
    en: { default: "Nothing found for \"{{query}}\"." },
  },
  "plur1bus.correct_usage": {
    de: { default: "Verwendung: /correct <alt> zu <neu>  (oder: <alt> → <neu>)" },
    en: { default: "Usage: /correct <old> to <new>  (or: <old> → <new>)" },
  },
  "plur1bus.correct_failed": {
    de: { default: "❌ /correct failed: {{error}}" },
    en: { default: "❌ /correct failed: {{error}}" },
  },
  "plur1bus.correct_not_found": {
    de: { default: "Nothing found for \"{{query}}\"." },
    en: { default: "Nothing found for \"{{query}}\"." },
  },
  "plur1bus.correct_no_separator": {
    de: { default: "❌ Kein Trennzeichen gefunden. Erwartet: /correct <alt> zu <neu>" },
    en: { default: "❌ No separator found. Expected: /correct <old> to <new>" },
  },
  "plur1bus.config_blocked": {
    de: { default: "🔒 Chat config changes are disabled (security.allowChatConfigCommands=false). Please edit openclaw.json directly and restart the gateway." },
    en: { default: "🔒 Chat config changes are disabled (security.allowChatConfigCommands=false). Please edit openclaw.json directly and restart the gateway." },
  },
  "plur1bus.toggle_failed": {
    de: { default: "❌ Toggle failed: {{error}}" },
    en: { default: "❌ Toggle failed: {{error}}" },
  },
  "plur1bus.unauthorized": {
    de: { default: "🔒 Nicht autorisiert. Destruktive Befehle erfordern eine Whitelist-Konfiguration (security.allowedUserIds / security.allowedChatIds)." },
    en: { default: "🔒 Unauthorized. Destructive commands require a whitelist configuration (security.allowedUserIds / security.allowedChatIds)." },
  },
  "plur1bus.security.no_auth_configured": {
    de: { default: "🔒 Sicherheits-Whitelist nicht konfiguriert. Destruktive Befehle sind deaktiviert. Füge security.allowedUserIds oder security.allowedChatIds in openclaw.json hinzu." },
    en: { default: "🔒 Security whitelist not configured. Destructive commands are disabled. Add security.allowedUserIds or security.allowedChatIds to openclaw.json." },
  },
  "plur1bus.security.user_not_allowed": {
    de: { default: "🔒 Dein Benutzer ist nicht in der erlaubten Liste (security.allowedUserIds)." },
    en: { default: "🔒 Your user is not in the allowed list (security.allowedUserIds)." },
  },
  "plur1bus.security.no_user_identity": {
    de: { default: "🔒 Dieser Channel liefert keine Benutzer-ID an den Command-Handler — destruktive Befehle können nicht autorisiert werden. (OpenClaw-Version/Channel prüfen.)" },
    en: { default: "🔒 This channel provides no user ID to the command handler — destructive commands cannot be authorized. (Check your OpenClaw version/channel.)" },
  },
  "plur1bus.security.chat_not_allowed": {
    de: { default: "🔒 Dieser Chat ist nicht in der erlaubten Liste (security.allowedChatIds)." },
    en: { default: "🔒 This chat is not in the allowed list (security.allowedChatIds)." },
  },
  "plur1bus.forget_confirm": {
    de: { default: 'Soll ich "{{title}}" wirklich löschen?' },
    en: { default: 'Should I really delete "{{title}}"?' },
  },
  "plur1bus.correct_confirm": {
    de: { default: 'Soll ich "{{title}}" wirklich ändern?' },
    en: { default: 'Should I really edit "{{title}}"?' },
  },
  "plur1bus.confirm_yes": {
    de: { default: "✅ Ja" },
    en: { default: "✅ Yes" },
  },
  "plur1bus.confirm_no": {
    de: { default: "❌ Nein" },
    en: { default: "❌ No" },
  },
  "plur1bus.security.neither_user_nor_chat_allowed": {
    de: { default: "🔒 Nicht autorisiert (weder User noch Chat freigegeben)." },
    en: { default: "🔒 Not authorized (neither user nor chat is allowlisted)." },
  },
  "plur1bus.forget_confirm_text": {
    de: { default: '🗑️ Löschen vorbereitet: "{{title}}".\nZum Bestätigen ausführen: `/forget confirm {{token}}`\n(Archive-first — wiederherstellbar.)' },
    en: { default: '🗑️ Deletion prepared: "{{title}}".\nTo confirm, run: `/forget confirm {{token}}`\n(Archive-first — recoverable.)' },
  },
  "plur1bus.correct_confirm_text": {
    de: { default: '✏️ Änderung vorbereitet: "{{title}}".\nZum Bestätigen ausführen: `/correct confirm {{token}}`' },
    en: { default: '✏️ Edit prepared: "{{title}}".\nTo confirm, run: `/correct confirm {{token}}`' },
  },
  "plur1bus.forget_done": {
    de: { default: "✅ Gelöscht (archiviert). ID: {{id}}" },
    en: { default: "✅ Deleted (archived). ID: {{id}}" },
  },
  "plur1bus.correct_done": {
    de: { default: "✅ Aktualisiert. ID: {{id}}" },
    en: { default: "✅ Updated. ID: {{id}}" },
  },
  "plur1bus.refine_hint": {
    de: { default: "Mehrere Treffer — bitte die Suche präzisieren, bis genau eine Erinnerung übrig ist, dann bestätigen." },
    en: { default: "Multiple matches — refine your query to a single memory, then confirm." },
  },
  "plur1bus.confirm_failed": {
    de: { default: "❌ Bestätigung fehlgeschlagen ({{reason}}). Token evtl. falsch oder abgelaufen — Befehl erneut ausführen." },
    en: { default: "❌ Confirmation failed ({{reason}}). The token may be wrong or expired — re-run the command." },
  },

  // ─── Nudge Renderer ──────────────────────────────────────────────────────
  "nudge.skill_proposal": {
    de: {
      casual: 'Ich habe mir unsere Gespräche angeschaut und ein wiederkehrendes Muster entdeckt: "{{description}}". Soll ich daraus einen Skill machen, damit ich es dir automatisch anbiete? Sag ja, nein oder schau dir alle Vorschläge mit `/plur1bus skills review` an.{{more}}',
      formal: 'Bei der Analyse unserer Gespräche ist ein wiederkehrendes Muster aufgefallen: "{{description}}". Soll dies in einen wiederverwendbaren Skill überführt werden? Bestätigen mit "ja", ablehnen mit "nein", oder alle Vorschläge mit `/plur1bus skills review` prüfen.{{more}}',
      default: 'Ich habe ein Muster in unseren Gesprächen entdeckt: "{{description}}". Soll ich daraus einen Skill erstellen? Du kannst ja, nein sagen oder `/plur1bus skills review` nutzen.{{more}}',
    },
    en: {
      casual: 'I\'ve been reviewing our conversations and noticed a repeatable pattern: "{{description}}". Want me to turn this into a skill so I always act on it? Say yes, no, or review all suggestions with `/plur1bus skills review`.{{more}}',
      formal: 'Analysis of our conversations reveals a repeatable pattern: "{{description}}". Shall this be converted into a reusable skill? Confirm with "yes", decline with "no", or review all proposals via `/plur1bus skills review`.{{more}}',
      default: 'I noticed a pattern in our conversations: "{{description}}". Should I create a skill from this? You can say yes, no, or use `/plur1bus skills review`.{{more}}',
    },
  },
  "nudge.skill_proposal_more": {
    de: {
      casual: " (und {{count}} weitere)",
      formal: " (und {{count}} weitere)",
      default: " (und {{count}} weitere)",
    },
    en: {
      casual: " (and {{count}} more)",
      formal: " (and {{count}} more)",
      default: " (and {{count}} more)",
    },
  },

  // ─── Emotions ────────────────────────────────────────────────────────────
  "emotion.joy": {
    de: { default: "Freude" },
    en: { default: "Joy" },
  },
  "emotion.trust": {
    de: { default: "Vertrauen" },
    en: { default: "Trust" },
  },
  "emotion.anticipation": {
    de: { default: "Erwartung" },
    en: { default: "Anticipation" },
  },
  "emotion.sadness": {
    de: { default: "Traurigkeit" },
    en: { default: "Sadness" },
  },
  "emotion.anger": {
    de: { default: "Ärger" },
    en: { default: "Anger" },
  },
  "emotion.fear": {
    de: { default: "Sorge" },
    en: { default: "Fear" },
  },
  "emotion.surprise": {
    de: { default: "Überraschung" },
    en: { default: "Surprise" },
  },
  "emotion.neutral": {
    de: { default: "Neutral" },
    en: { default: "Neutral" },
  },

  // ─── Reminders ───────────────────────────────────────────────────────────
  "reminder.due_header": {
    de: { default: "⏰ Fällige Erinnerungen:" },
    en: { default: "⏰ Due reminders:" },
  },
  "reminder.due_item": {
    de: { default: "  • \"{{text}}\" (fällig seit {{elapsed}})" },
    en: { default: "  • \"{{text}}\" (due {{elapsed}} ago)" },
  },
  "reminder.none": {
    de: { default: "Keine fälligen Erinnerungen." },
    en: { default: "No due reminders." },
  },

  // ─── Time Context ────────────────────────────────────────────────────────
  "time.context": {
    de: { default: "Letzte Aktivität: vor {{elapsed}}. Aktuelle Zeit (UTC): {{time}}." },
    en: { default: "Last activity: {{elapsed}} ago. Current time (UTC): {{time}}." },
  },
  "time.first_activity": {
    de: { default: "Erste Aktivität. Aktuelle Zeit (UTC): {{time}}." },
    en: { default: "First activity. Current time (UTC): {{time}}." },
  },

  // ─── Semantic Input ─────────────────────────────────────────────────────-
  "semantic.input_missing": {
    de: { default: "Input fehlt oder ist kein Text." },
    en: { default: "Input missing or not text." },
  },
  "semantic.input_too_large": {
    de: { default: "Diese Eingabe ist zu groß für einen Slash-Command ({{length}} Zeichen). Bitte als Datei/Vault-Note/Quelle übergeben, dann verarbeite ich sie vollständig." },
    en: { default: "This input is too large for a slash command ({{length}} chars). Please pass it as a file/vault note/source and I'll process it fully." },
  },
};
