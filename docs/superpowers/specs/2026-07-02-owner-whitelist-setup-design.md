# Owner-Whitelist im Setup — Design

**Datum:** 2026-07-02
**Status:** Vom User abgesegnet (Brainstorming)
**Module:** `scripts/install-memory-system.sh`, `lib/setup/owner-whitelist.js` (neu), `lib/owners-command.js` (neu), `index.js`, `lib/i18n-dictionary.js`, `README.md`

## Problem

Destruktive PLUR1BUS-Chat-Commands (`/plur1bus temperament`, `/forget`, `/correct`,
`/plur1bus setup`, `/plur1bus owners`) verlangen laut `lib/security.js` eine
konfigurierte Whitelist (`security.allowedUserIds` / `allowedChatIds`). Ist keine
gesetzt, greift eine Fail-Safe: destruktiv nur im privaten 1:1-Chat erlaubt.

**Dieser Fallback ist bei Telegram-Plugin-Commands faktisch tot:** Der vom
Gateway an den Plugin-Handler übergebene ctx (`commands-B0qdB4eG.js`
→ `command.handler(ctx)`) enthält `senderId`, `isAuthorizedSender`, `from`/`to`,
aber **kein** `chatType`/`chatId`/`isGroup`. `resolveChatKind` liefert daher
„unknown" → destruktive Commands werden mit `security.no_auth_configured`
abgelehnt (Incident 2026-07-02: Christian, `/plur1bus temperament warm`).

Weder `install-memory-system.sh` noch `/plur1bus setup` (feature-profiles.js)
setzen jemals einen `security`-Block. **Jeder** neue externe User läuft beim
ersten destruktiven Command in genau diese Wand.

## Ziel

- Der Installer setzt `security.allowedUserIds` beim Setup — mit minimaler
  Reibung, ohne dass der User seine numerische ID kennen muss.
- Owner sind zur Laufzeit über einen Command nachpflegbar.
- Vorhandene Whitelists werden nie überschrieben.

## Entscheidungen (User)

1. **Owner-Quelle:** Auto aus der Vereinigung aller `channels.*.accounts.*.allowFrom`
   + Bestätigung. Ist die Union leer, explizit abfragen.
2. **Runtime-Pflege:** neuer Command `/plur1bus owners` (list / add / remove) plus
   Warnhinweis in `/plur1bus start`, wenn keine Whitelist gesetzt ist.
3. **Non-interaktiv & Idempotenz:** vorhandene `allowedUserIds` immer unangetastet;
   `--non-interactive` ohne vorhandene Liste → aus allowFrom-Union seeden; ist auch
   die leer → leer lassen + laute Warnung.

## Design

### 1. `lib/setup/owner-whitelist.js` (pure, testbar)

- `collectAllowFromUserIds(openclawConfig) → string[]`
  - Union über alle Kanäle: `channels.<ch>.accounts.<acc>.allowFrom` **und**
    `channels.<ch>.accounts.<acc>.groupAllowFrom` sowie ein evtl. vorhandenes
    Top-Level `channels.<ch>.allowFrom`.
  - Jede ID zu String normalisiert, dedupliziert, stabile Reihenfolge
    (erste Vorkommens-Reihenfolge). Tolerant gegen fehlende Kanäle/Felder,
    wirft nie.
- `resolveOwnerSeed({ existing, allowFromUnion }) → { ids: string[], source: "existing" | "allowFrom" | "empty" }`
  - `existing` (nicht-leer) → `{ ids: existing, source: "existing" }` (nie überschreiben).
  - sonst `allowFromUnion` (nicht-leer) → `{ ids: union, source: "allowFrom" }`.
  - sonst `{ ids: [], source: "empty" }`.
- `normalizeOwnerId(raw) → string | null` — trimmt, akzeptiert nur numerische
  IDs (`/^\d+$/`); sonst `null`.

### 2. Installer-Integration (`scripts/install-memory-system.sh`)

- Nach dem Bau von `$plugin_config`, vor dem jq/node-Merge (~Zeile 1204/1246):
  - Bestehende Whitelist lesen:
    `EXISTING_OWNER_IDS=$(run_target "jq -c '.plugins.entries[\"memory-lancedb-namespaced\"].config.security.allowedUserIds // []' '$TARGET_CONFIG'")`.
  - Union berechnen über das neue Modul (DRY, getestet):
    `node -e "import('.../lib/setup/owner-whitelist.js').then(m=>{const c=JSON.parse(fs.readFileSync(process.argv[1]));process.stdout.write(JSON.stringify(m.collectAllowFromUserIds(c)))})" "$TARGET_CONFIG"`.
  - `resolveOwnerSeed` in Bash nachbilden ist unnötig — dasselbe Modul liefert
    zusätzlich `resolveOwnerSeed` via zweitem `node -e`, das `existing` + `union`
    bekommt und die finale ID-Liste + `source` als JSON ausgibt.
  - **Interaktiv** (`NON_INTERACTIVE=0`):
    - `source === "existing"` → nichts fragen, Liste behalten, Info loggen.
    - sonst: Vorschlag (Union) via `prompt_input` mit kommagetrenntem Default
      anzeigen; leere Eingabe = Vorschlag übernehmen; ist der Vorschlag leer,
      Pflichthinweis („Ohne Owner sind destruktive Commands gesperrt").
      Eingabe über `normalizeOwnerId` filtern (ungültige verwerfen + Warnung).
  - **Non-interaktiv** (`NON_INTERACTIVE=1`):
    - `source === "existing"` → behalten.
    - `source === "allowFrom"` → seeden.
    - `source === "empty"` → leer lassen + `warn` ins Log
      („security.allowedUserIds leer — destruktive Commands bleiben gesperrt;
      später `/plur1bus owners add <id>`").
  - Ergebnis-Array in den Merge einweben: **beide** Schreibpfade (jq bei ~1204
    und der node-Fallback bei ~1246) ergänzen
    `.config.security.allowedUserIds`. Vorhandene `security`-Subkeys bleiben
    erhalten (Merge, kein Replace).
- `--dry-run` respektiert die bestehenden `dryrun`-Helfer (keine Schreibaktion).

### 3. `/plur1bus owners` Command

- **`lib/owners-command.js` (pure):**
  - `renderOwnersOverview({ allowedUserIds, lang }) → string` — aktuelle Liste
    (oder „keine gesetzt") + Nutzungshinweis (`add`/`remove`).
  - `applyOwnersMutation(rawCfg, pluginKey, op, id) → { ok: true, merged } | { error }`
    - `op ∈ {"add","remove"}`; `id` via `normalizeOwnerId` validiert (sonst error).
    - `add`: idempotent (kein Duplikat). `remove`: entfernt, tolerant wenn nicht
      vorhanden. Schreibt `merged.plugins.entries[pluginKey].config.security.allowedUserIds`.
    - Kopie via `structuredClone`, Original unangetastet.
- **index.js-Dispatch (`actionKey === "owners"`):**
  - `sub === ""` oder `"list"` → nicht-destruktiv: `renderOwnersOverview` aus
    `cfg.security?.allowedUserIds`.
  - `sub === "add" | "remove"` mit `id = tokens[2]` → config-mutierend:
    - **Bootstrap-Allowance:** ist die aktuelle Whitelist leer
      (`allowedUserIds`+`allowedChatIds` beide leer), genügt
      `commandCtx.isAuthorizedSender === true` — der Gateway hat via `allowFrom`
      bereits channel-autorisiert. (`isAuthorizedSender` ist im Plugin-ctx immer
      vorhanden; `senderIsOwner` nur bei bestimmten Command-Typen, daher nicht
      als Bootstrap-Signal genutzt.) Ein gültiger `userId` muss zusätzlich
      auflösbar sein (sonst `no_user_identity`), damit `add` einen echten Owner
      einträgt. Andernfalls (Whitelist nicht leer) normale
      `checkAuth({ destructive: true })`.
    - `allowChatConfigCommands === false` → `setup_blocked`.
    - `withConfigLock` + `applyOwnersMutation` + atomarer tmp+rename-Write
      (wie `/plur1bus temperament`/`setup`). Erfolg → Bestätigung +
      `setup_restart`-Hinweis.
  - Registrierung in `plur1busCommands` (`prefixTokens: ["owners"]`) analog
    `plur1bus_temperament`; `deploy-integrity` DEPLOY_FILES um
    `lib/owners-command.js` erweitern.

### 4. `/plur1bus start`-Warnung

- Im `actionKey === "start"`-Block: wenn
  `(cfg.security?.allowedUserIds?.length ?? 0) === 0` **und**
  `(cfg.security?.allowedChatIds?.length ?? 0) === 0`, eine Warnzeile anhängen:
  „⚠️ Keine Owner konfiguriert — destruktive Commands sind gesperrt. Setze sie
  mit `/plur1bus owners add <deine-id>` oder beim Installer." (i18n de/en).

### 5. i18n / Docs

- `lib/i18n-dictionary.js`: Keys für owners-Overview, owners-add/remove-Erfolg,
  owners-invalid-id, start-owner-warning (de/en). Quick-Help um `/plur1bus owners`
  ergänzen.
- `README.md`: Abschnitt „Owner / destruktive Commands" — Installer-Verhalten,
  `/plur1bus owners`, Bootstrap-Hinweis.

## Fehlerbehandlung

- Kaputte/fehlende `openclaw.json` beim Union-Lesen → leere Union, Installer
  fragt explizit (interaktiv) bzw. warnt (non-interaktiv).
- Nicht-numerische IDs → verworfen (Installer) bzw. `error` (Command).
- `collectAllowFromUserIds` wirft nie (tolerant gegen fehlende Container).

## Tests

- **owner-whitelist:** Union über mehrere Kanäle/Accounts inkl. `groupAllowFrom`;
  Dedup; leere/fehlende Kanäle → `[]`; `resolveOwnerSeed` preserve vs. seed vs.
  empty; `normalizeOwnerId` (numerisch/whitespace/invalid).
- **owners-command:** `renderOwnersOverview` (leer + gefüllt, de/en);
  `applyOwnersMutation` add idempotent, remove tolerant, invalid id → error,
  Original nicht mutiert.
- **index-Dispatch:** `owners list` nicht-destruktiv; `owners add` mit leerer
  Whitelist + `isAuthorizedSender` → erlaubt (Bootstrap); `owners add` mit
  gefüllter Whitelist + fremder User → blockiert; `/plur1bus start`-Warnung
  erscheint nur bei leerer Whitelist. Registrierung des Commands über Mock-API.
- **deploy-integrity:** bleibt grün (neue Datei in DEPLOY_FILES).

## Nicht im Scope (YAGNI)

- Kein `allowedChatIds`-Seed (destruktiv verlangt ohnehin `userId`).
- Keine Änderung an der Gateway-ctx (kein `chatType`-Durchreichen) — das wäre
  ein Core-Patch; die Whitelist löst das Problem sauberer und plattformweit.
- Keine Migration bestehender Installationen außerhalb des Installer-Laufs
  (der `/plur1bus start`-Hinweis + `/plur1bus owners` decken das ab).
