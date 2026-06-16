# Supply-Chain & Dependency-Security Audit

**Datum:** 2026-06-16  
**Branch:** `audit/supply-chain-security-2026-06-16`  
**Basis-Commit:** `45e411f perf: P0/P1 performance hardening after audit (#47)`  
**Auditor:** Kimi Code CLI (subagent-assisted review)  
**Scope:** `package.json`, `package-lock.json`, `node_modules`, `.github/workflows/*`, Runtime-Import-Surface, Secret-Exposure, Release/Publish-Surface

---

## 1. Executive Summary

`npm audit` meldet für den aktuellen Lockfile-Stand **0 bekannte Vulnerabilities**. Die direkten Runtime-Dependencies `@lancedb/lancedb` und `openai` sowie die DevDependency `c8` sind laut npm Advisory Database nicht gemeldet.

Dennoch gibt es relevante Supply-Chain-Risiken:

- **P1:** Lockfile-Drift für `protobufjs` (installiert `7.6.2`, gelockt `7.6.4`). `npm audit` bewertet den Lockfile-Stand und gibt daher 0 Vulnerabilities aus, während die tatsächlich installierte Version von der gelockten abweicht. Das bricht Reproduzierbarkeit und Audit-Aussagekraft.
- **P1:** Der optionale Embedding-/Reranker-Pfad hängt von einem **nightly/dev-Build von `onnxruntime-web`** ab (`1.26.0-dev.20260416-b7804b056c`). Pre-Release-Artefakte unterliegen nicht dem stabilen Release-Lifecycle und erweitern die Trust Boundary erheblich.
- **P1/P2:** CI-Workflow verwendet floating Action-Tags (`@v4`) und hat keine least-privilege `permissions`.
- **P2:** Mehrere transitive Pakete (`protobufjs`, `sharp`, `onnxruntime-node`) führen Install-Scripts aus und laden native Binaries nach.
- **P2/P3:** Fehlende `.npmrc`, fehlende `engines`/`repository` Metadaten, keine npm-Provenance, kein Dependabot, `.gitignore` schützt nicht gegen `.env`-Dateien.

**Empfehlung:** Eine separate Fix-Runde durchführen, priorisiert nach P1 → P2 → P3.

---

## 2. Gesamtrisiko

| Kategorie | Bewertung | Begründung |
|-----------|-----------|------------|
| Akute Ausnutzbarkeit | **niedrig-mittel** | Keine direkt ausnutzbare CVE im Lockfile; jedoch Lockfile-Drift und Pre-Release-Abhängigkeit erhöhen das Risiko. |
| CI-/Build-Integrität | **mittel** | Floating Action-Tags, fehlende Permissions, kein Lockfile-Drift-Check. |
| Release-Provenance | **mittel** | Keine npm-Provenance, kein automatisierter Release-Workflow, fehlende Metadaten. |
| Secret-Exposure | **niedrig** | Keine hartcodierten Secrets gefunden; `.gitignore` schützt aber nicht gegen `.env`. |
| Runtime-Trust-Boundary | **mittel** | Optionaler local-transformers-Pfad lädt native Binaries und Modelle ohne Integritätspolicy. |

**Gesamteinschätzung:** Mittleres Risiko. Kein akuter Notfall, aber die P1-Befunde sollten vor dem nächsten Release behoben werden.

---

## 3. Befunde nach Schweregrad

### P1 — Akute / Hohe Supply-Chain-Risiken

#### P1-1: Lockfile-Drift für `protobufjs` (installiert ≠ gelockt)

- **Datei/Pfad:** `package-lock.json` vs. `node_modules/protobufjs/package.json`
- **Konkrete Stelle:**
  - `package-lock.json`: `"node_modules/protobufjs"` → `"version": "7.6.4"`
  - `node_modules/protobufjs/package.json`: `"version": "7.6.2"`
  - `npm ls protobufjs --all` zeigt `protobufjs@7.6.2`
  - `npm ci --dry-run` meldet `change protobufjs 7.6.2 => 7.6.4`
- **Risiko:** `npm audit` bewertet den Lockfile-Stand (`7.6.4`) und meldet daher 0 Vulnerabilities. Die tatsächlich auf dem Workstation/CI-Cache vorhandene Version ist jedoch `7.6.2`. Das bricht Reproduzierbarkeit und kann zukünftige Sicherheitsbewertungen verfälschen.
- **Exploit-/Failure-Szenario:** Ein Entwickler testet gegen `7.6.2`, CI installiert bei `npm ci` `7.6.4`. Tritt ein Verhaltenunterschied oder eine spätere Advisory auf, die nur eine der Versionen betrifft, wird dies übersehen.
- **Empfohlene Maßnahme:**
  1. `rm -rf node_modules package-lock.json && npm install` ausführen.
  2. `npm ci` im CI erzwingen.
  3. CI-Step hinzufügen: `npm ci --dry-run | grep -E 'change|remove|add'` muss leer sein.
- **Fix-Komplexität:** niedrig
- **Fix-Risiko:** niedrig
- **Verifikation:** `npm ls protobufjs` und `node_modules/protobufjs/package.json` zeigen `7.6.4`.

#### P1-2: Optionaler local-transformers-Pfad hängt von nightly `onnxruntime-web` ab

- **Datei/Pfad:** `package-lock.json` (`node_modules/onnxruntime-web`), `lib/providers/embedding-local-transformers.js`, `lib/providers/reranker-local-transformers.js`
- **Konkrete Stelle:**
  - `package-lock.json`: `onnxruntime-web@1.26.0-dev.20260416-b7804b056c`
  - Dependency-Chain: `@huggingface/transformers@4.2.0` → `onnxruntime-web@1.26.0-dev...` → `protobufjs@^7.2.4`
- **Risiko:** Pre-Release-/Nightly-Artefakte werden nicht wie stabile Releases geprüft, können entfernt oder ersetzt werden und erweitern die Trust Boundary um native/WebAssembly-Binaries.
- **Exploit-/Failure-Szenario:** Ein kompromittierter Nightly-Build oder ein manipuliertes Modell-Repository kann bösartigen Code in den Agent-Prozess einschleusen, sobald `local-transformers` aktiviert ist.
- **Empfohlene Maßnahme:**
  - `onnxruntime-web` via `overrides` in `package.json` auf eine stabile Version pinnen.
  - Alternativ: `@huggingface/transformers` aus `optionalDependencies` entfernen, wenn local-transformers nicht produktiv benötigt wird.
- **Fix-Komplexität:** mittel
- **Fix-Risiko:** mittel (funktionale Auswirkungen auf local-transformers testen)
- **Verifikation:** `npm ls onnxruntime-web` zeigt keine `-dev`/`-nightly`-Version.

#### P1-3: CI verwendet floating Action-Tags

- **Datei/Pfad:** `.github/workflows/ci.yml`
- **Konkrete Stelle:**
  - `uses: actions/checkout@v4`
  - `uses: actions/setup-node@v4`
- **Risiko:** `@v4`-Tags können von den Maintainer*innen verschoben werden. Ein kompromittiertes Action-Repository führt zu Code-Execution im CI mit Zugriff auf `GITHUB_TOKEN` und Secrets.
- **Exploit-/Failure-Szenario:** Ein Angreifer, der `actions/checkout` oder `actions/setup-node` `@v4` auf einen bösartigen Commit umzieht, führt in jedem CI-Run beliebigen Code aus.
- **Empfohlene Maßnahme:** Actions auf konkrete Commit-SHAs pinnen, z.B. `actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2`.
- **Fix-Komplexität:** niedrig
- **Fix-Risiko:** niedrig
- **Verifikation:** SHAs in CI-Logs stimmen mit den gepinnten Werten überein.

#### P1-4: CI hat keine least-privilege `permissions`

- **Datei/Pfad:** `.github/workflows/ci.yml`
- **Konkrete Stelle:** Kein `permissions:`-Block auf Workflow- oder Job-Ebene.
- **Risiko:** Der `GITHUB_TOKEN` erhält standardmäßig weitreichende Write-Scopes.
- **Exploit-/Failure-Szenario:** Eine kompromittierte Action oder ein injizierter Schritt kann Code pushen, Releases erstellen oder PRs modifizieren.
- **Empfohlene Maßnahme:**
  - Top-level `permissions: {}`
  - Pro Job nur minimale Scopes, z.B. `contents: read` für Checkout.
- **Fix-Komplexität:** niedrig
- **Fix-Risiko:** niedrig
- **Verifikation:** CI-Log zeigt unter "Set up job" nur erforderliche Token-Scopes.

---

### P2 — Mittlere Risiken / Hardening

#### P2-1: Install-Scripts laden native Binaries nach

- **Datei/Pfad:** `package-lock.json`, `node_modules/onnxruntime-node/package.json`, `node_modules/sharp/package.json`, `node_modules/protobufjs/package.json`
- **Konkrete Stelle:**
  - `onnxruntime-node`: `"postinstall": "node ./script/install"`
  - `sharp`: `"install": "node install/check.js || npm run build"`
  - `protobufjs`: `"postinstall": "node scripts/postinstall"`
- **Risiko:** Diese Pakete führen während `npm install` Code aus und laden native Binaries von externen CDN/Registry-Endpunkten. Ein kompromittiertes Paket oder CDN führt zu Arbitrary Code Execution beim Installieren.
- **Empfohlene Maßnahme:**
  - In CI/Production: `npm ci --ignore-scripts` verwenden und benötigte Build-Schritte explizit erlauben.
  - Allow-List für Install-Scripts führen.
- **Fix-Komplexität:** mittel
- **Fix-Risiko:** niedrig
- **Verifikation:** `npm config get ignore-scripts` liefert `true`; CI installiert erfolgreich.

#### P2-2: `npm audit` reicht nicht als alleiniger Sicherheitsgate

- **Datei/Pfad:** `.github/workflows/ci.yml`, `package.json`
- **Konkrete Stelle:** CI-Step `npm audit --audit-level=moderate`
- **Risiko:** `npm audit` deckt keine Pre-Release-Versionen, Lockfile-Drift, noch Zero-Days außerhalb der Advisory-Datenbank ab.
- **Empfohlene Maßnahme:**
  - `npm audit signatures` ergänzen.
  - Dependency-Review-Action für Pull Requests hinzufügen.
  - Zweiten Scanner (z.B. Snyk, OSV) integrieren.
- **Fix-Komplexität:** niedrig-mittel
- **Fix-Risiko:** niedrig
- **Verifikation:** Draft-PR mit neuer Dependency zeigt Dependency-Review-Check.

#### P2-3: Runtime-Import von optionalen local-transformers lädt remote Modelle ohne Integritätspolicy

- **Datei/Pfad:** `lib/providers/embedding-local-transformers.js:33`, `lib/providers/reranker-local-transformers.js:25`, `lib/providers/openclaw-memory-embedding-adapters.js:171`
- **Konkrete Stelle:** `mod = await import("@huggingface/transformers")` gefolgt von `mod.pipeline(...)`
- **Risiko:** Modelle, Tokenizer und Konfigurationen werden zur Laufzeit von Hugging Face Hub heruntergeladen, ohne SHA-256- oder Signaturprüfung.
- **Empfohlene Maßnahme:**
  - In Produktion local-transformers deaktivieren und `openai`-Provider verwenden.
  - Wenn local-transformers benötigt: Modelle auf lokale Pfade pinnen und Hashes prüfen.
- **Fix-Komplexität:** mittel
- **Fix-Risiko:** niedrig
- **Verifikation:** Netzwerk-Capture zeigt keine unvalidierten Downloads; Config-Audit verifiziert `provider`.

#### P2-4: Legacy-Fallback lädt Dependencies aus außerhalb des Projektbaums

- **Datei/Pfad:** `index.js:173-174`, `index.js:250-251`, `index.js:278-279`
- **Konkrete Stelle:**
  - `LANCEDB_LEGACY_PATH = join(__pluginDir, "../memory-lancedb-stock/node_modules/@lancedb/lancedb/dist/index.js")`
  - `OPENAI_LEGACY_PATH = join(__pluginDir, "../memory-lancedb-stock/node_modules/openai/index.js")`
- **Risiko:** Der Plugin kann Core-Dependencies aus einem Geschwisterverzeichnis laden, das nicht durch `package-lock.json` geregelt ist.
- **Empfohlene Maßnahme:** Legacy-Fallback entfernen oder vor dem Laden Versions-/Integritätsprüfung hinzufügen.
- **Fix-Komplexität:** niedrig
- **Fix-Risiko:** niedrig
- **Verifikation:** Keine `memory-lancedb-stock`-Referenzen mehr im Code; `npm ls` aus Plugin-Verzeichnis stimmt mit Lockfile überein.

#### P2-5: Kein Dependency-Review / SBOM in CI

- **Datei/Pfad:** `.github/workflows/ci.yml`
- **Konkrete Stelle:** Kein `actions/dependency-review-action`-Step.
- **Risiko:** Neue Dependencies in PRs werden nicht auf Typosquatting, Lizenzänderungen oder unerwartete native Pakete geprüft.
- **Empfohlene Maßnahme:** `actions/dependency-review-action` im `pull_request`-Job hinzufügen.
- **Fix-Komplexität:** niedrig
- **Fix-Risiko:** niedrig
- **Verifikation:** Draft-PR mit neuer Dependency zeigt Dependency-Review-Check.

---

### P3 — Hygiene / Dokumentation / Verbesserung

#### P3-1: `.gitignore` schließt `.env`-Dateien nicht aus

- **Datei/Pfad:** `.gitignore`
- **Konkrete Stelle:** Keine `.env`-Regel vorhanden.
- **Risiko:** Lokale `.env`-Dateien mit API-Keys können versehentlich committed werden.
- **Empfohlene Maßnahme:** Folgende Patterns hinzufügen:
  ```gitignore
  .env
  .env.*
  .openclaw/.env
  !.env.example
  ```
- **Fix-Komplexität:** niedrig
- **Fix-Risiko:** niedrig
- **Verifikation:** `git check-ignore -v .env .env.local` zeigt passende Regel.

#### P3-2: Runtime-Dependencies verwenden Caret-Ranges

- **Datei/Pfad:** `package.json`
- **Konkrete Stelle:** `"@lancedb/lancedb": "^0.26.2"`, `"openai": "^6.27.0"`
- **Risiko:** Ohne Lockfile können bei `npm install` neuere Minor/Patch-Versionen gezogen werden.
- **Empfohlene Maßnahme:** Exakte Versionen in `package.json` verwenden.
- **Fix-Komplexität:** niedrig
- **Fix-Risiko:** niedrig
- **Verifikation:** Keine `^`/`~`-Prefixe bei Runtime-Dependencies.

#### P3-3: Fehlende `.npmrc` / Registry-Lockdown

- **Datei/Pfad:** Projektwurzel (keine `.npmrc`)
- **Risiko:** Keine Durchsetzung des öffentlichen npm-Registries, keine `engine-strict`.
- **Empfohlene Maßnahme:** `.npmrc` anlegen:
  ```ini
  registry=https://registry.npmjs.org/
  engine-strict=true
  lockfile-version=3
  ```
- **Fix-Komplexität:** niedrig
- **Fix-Risiko:** niedrig
- **Verifikation:** `npm config list` zeigt keine Registry-Override.

#### P3-4: Fehlende `engines` und Quellmetadaten in `package.json`

- **Datei/Pfad:** `package.json`
- **Risiko:** Keine Node-Version-Anforderung; keine `repository`/`bugs`/`homepage`.
- **Empfohlene Maßnahme:**
  ```json
  "engines": { "node": ">=20" },
  "repository": { "type": "git", "url": "https://github.com/cyberblade/openclaw-plur1bus-memory.git" },
  "bugs": { "url": "https://github.com/cyberblade/openclaw-plur1bus-memory/issues" },
  "homepage": "https://github.com/cyberblade/openclaw-plur1bus-memory#readme"
  ```
- **Fix-Komplexität:** niedrig
- **Fix-Risiko:** niedrig
- **Verifikation:** `npm pack --dry-run` erfolgreich.

#### P3-5: Keine npm-Provenance

- **Datei/Pfad:** `package.json`
- **Risiko:** Verbraucher können nicht kryptographisch nachweisen, dass ein Tarball aus einem bestimmten CI-Run stammt.
- **Empfohlene Maßnahme:** `publishConfig: { "provenance": true }` hinzufügen und über GitHub Actions veröffentlichen.
- **Fix-Komplexität:** niedrig
- **Fix-Risiko:** niedrig
- **Verifikation:** `npm view @cyb3rb1ade/plur1bus-memory --json | jq '.provenance'` zeigt Sigstore-Attestation.

#### P3-6: Kein automatisierter Release-Workflow

- **Datei/Pfad:** `.github/workflows/ci.yml`
- **Risiko:** Manuelles Publishing kann von dirty Worktrees oder unauditierten Branches erfolgen.
- **Empfohlene Maßnahme:** `release.yml` auf Tags (`v*`) hinzufügen, der Tests, Audit und Publish mit Provenance durchführt.
- **Fix-Komplexität:** mittel
- **Fix-Risiko:** niedrig
- **Verifikation:** Tag-Release veröffentlicht Paket mit Provenance.

#### P3-7: Kein Dependabot / Renovate konfiguriert

- **Datei/Pfad:** `.github/`
- **Risiko:** Sicherheitspatches werden nicht proaktiv vorgeschlagen.
- **Empfohlene Maßnahme:** `.github/dependabot.yml` für npm hinzufügen.
- **Fix-Komplexität:** niedrig
- **Fix-Risiko:** niedrig
- **Verifikation:** Dependabot zeigt Alerts und PRs im Repository.

#### P3-8: Deprecated transitive `boolean@3.2.0`

- **Datei/Pfad:** `package-lock.json`
- **Konkrete Stelle:** `@huggingface/transformers > onnxruntime-node > global-agent > boolean@3.2.0`
- **Risiko:** Paket wird nicht mehr unterstützt; zukünftige Sicherheits- oder Kompatibilitätsprobleme werden nicht gepatcht.
- **Empfohlene Maßnahme:** `onnxruntime-node`/`onnxruntime-web` auf stabile Releases aktualisieren, die `boolean` nicht mehr benötigen.
- **Fix-Komplexität:** mittel
- **Fix-Risiko:** niedrig
- **Verifikation:** `npm ls boolean` verschwindet oder zeigt nicht-deprecatede Version.

---

## 4. `npm audit`-Auswertung inklusive `protobufjs`

### Ausgeführte Befehle

```bash
npm audit
npm audit --json
npm audit --audit-level=moderate
npm audit signatures
npm ls protobufjs --all
npm explain protobufjs
```

### Ergebnis

```
npm audit
found 0 vulnerabilities
```

- **Vulnerabilities:** info 0, low 0, moderate 0, high 0, critical 0, total 0
- **Dependencies:** prod 13, dev 49, optional 77, peer 19, total 157

### `protobufjs`-Situation

- `package-lock.json` resolved `protobufjs@7.6.4`
- `node_modules/protobufjs` tatsächlich installiert: `7.6.2` → **Lockfile-Drift besteht fort**
- Dependency-Path: `@huggingface/transformers@4.2.0` → `onnxruntime-web@1.26.0-dev...` → `protobufjs@^7.2.4`

### Bewertung

`npm audit` ist **für den gelockten Stand korrekt**: Die gelockte `protobufjs@7.6.4` ist laut npm Advisory Database nicht durch bekannte CVEs gemeldet. Die installierte `7.6.2` lag ebenfalls oberhalb der gepatchten Schwellen für die bekannten Proto6-CVEs (sofern vorhanden).

**Aber:** `npm audit` deckt nicht ab:
- Lockfile-zu-`node_modules`-Drift
- Pre-Release-/Nightly-Artefakte
- Install-Script-basierte Supply-Chain-Angriffe
- Zero-Days vor ihrer Aufnahme in die Advisory-Datenbank

Daher ist `npm audit` ein notwendiger, aber nicht hinreichender Gate.

---

## 5. CI-/GitHub-Actions-Bewertung

### Geprüfte Datei

`.github/workflows/ci.yml`

### Positiv

- Verwendet `npm ci` statt `npm install` (reproduzierbarer).
- Trigger auf `push`/`pull_request` zu `main` beschränkt.
- Testmatrix für Node 20 und 22.
- `npm audit --audit-level=moderate` ist vorhanden.

### Befunde

| ID | Befund | Schwere | Empfohlene Maßnahme |
|----|--------|---------|---------------------|
| P1-3 | Floating Action-Tags (`@v4`) | P1 | Auf SHA pinnen |
| P1-4 | Keine least-privilege `permissions` | P1 | `permissions: {}` + Job-scopes |
| P2-2 | `npm audit` allein reicht nicht | P2 | `npm audit signatures` + Dependency-Review |
| P2-5 | Kein Dependency-Review-Step | P2 | `actions/dependency-review-action` |
| P3-6 | Kein Release-Workflow | P3 | `release.yml` mit Provenance |
| P3-7 | Kein Dependabot | P3 | `.github/dependabot.yml` |

---

## 6. Lockfile-/Dependency-Bewertung

### `package.json`

```json
"dependencies": {
  "@lancedb/lancedb": "^0.26.2",
  "openai": "^6.27.0"
},
"devDependencies": {
  "c8": "^11.0.0"
},
"optionalDependencies": {
  "@huggingface/transformers": "4.2.0"
}
```

### Lockfile

- `package-lock.json` v3, 157 gelockte Pakete.
- Keine verdächtigen `resolved`-URLs (alles `https://registry.npmjs.org/`).
- Integrity-Hashes sind vorhanden.

### Befunde

| ID | Befund | Schwere |
|----|--------|---------|
| P1-1 | Lockfile-Drift `protobufjs` | P1 |
| P1-2 | Nightly `onnxruntime-web` | P1 |
| P2-1 | Install-Scripts auf `protobufjs`, `sharp`, `onnxruntime-node` | P2 |
| P3-2 | Caret-Ranges in Runtime-Dependencies | P3 |
| P3-8 | Deprecated `boolean@3.2.0` | P3 |

---

## 7. Secret-Scan-Ergebnis

### Geprüft

- Tracked source files (`git ls-files`)
- `package.json`, `package-lock.json`, `.github/workflows/*`
- Test-Fixtures und Dokumentation
- `.gitignore`

### Ergebnis

- **Keine hartcodierten Secrets, API-Keys oder Tokens gefunden.**
- `.env`, `.env.local`, `.env.*` sind **nicht** in `.gitignore` ausgeschlossen (P3-1).
- Keine committed `.env`-Dateien.
- Keine privaten URLs oder Credentials in Testfixtures.

### Empfohlene Maßnahme

- `.gitignore` um `.env`-Patterns erweitern (P3-1).
- Optional: `git-secrets` oder `trufflehog` in CI integrieren.

---

## 8. Release-/Publish-Surface

### Geprüft

- `package.json` (`files`, `main`, `scripts`, `publishConfig`, `engines`, `repository`)
- `npm pack --dry-run`
- `.npmignore` (nicht vorhanden)

### Ergebnis

`npm pack --dry-run` zeigt nur die beabsichtigten Dateien:
- `index.js`
- `lib/`
- `openclaw.plugin.json`
- `README.md`
- `LICENSE`
- `package.json`

Tests, Docs, Coverage, `.github`, Audit-Dateien etc. werden nicht gepublished.

### Befunde

| ID | Befund | Schwere |
|----|--------|---------|
| P3-4 | Fehlende `engines`/`repository`/`bugs`/`homepage` | P3 |
| P3-5 | Keine npm-Provenance | P3 |
| P3-6 | Kein automatisierter Release-Workflow | P3 |

---

## 9. Empfohlene Fix-Reihenfolge

1. **P1-1:** `node_modules` und `package-lock.json` sauber regenerieren, `npm ci` erzwingen, Lockfile-Drift-Check in CI.
2. **P1-2:** `onnxruntime-web` auf stabile Version pinnen oder local-transformers optional entfernen.
3. **P1-3 + P1-4:** GitHub Actions auf SHA pinnen und least-privilege `permissions` setzen.
4. **P2-1:** CI auf `npm ci --ignore-scripts` umstellen (mit begründeten Ausnahmen).
5. **P2-2 + P2-5:** `npm audit signatures` und `actions/dependency-review-action` hinzufügen.
6. **P2-3:** Integritätspolicy für local-transformers-Modelle oder Deaktivierung in Produktion.
7. **P2-4:** Legacy-Fallback-Pfade entfernen oder absichern.
8. **P3-1:** `.gitignore` um `.env`-Patterns erweitern.
9. **P3-2 bis P3-8:** `package.json`-Metadaten, `.npmrc`, Dependabot, Release-Workflow, Provenance.

---

## 10. Was wurde geprüft, aber nicht als Problem bestätigt

- **Hartcodierte Secrets:** Keine gefunden.
- **Direkte Dependencies:** `@lancedb/lancedb@0.26.2`, `openai@6.42.0`, `c8@11.0.0` sind laut `npm audit` nicht gemeldet.
- **Verdächtige `resolved`-URLs in `package-lock.json`:** Alle URLs zeigen auf `https://registry.npmjs.org/`.
- **npm-Scripts in `package.json`:** Keine `preinstall`/`postinstall`/`prepare`-Hooks; `lint`, `test`, `test:coverage` enthalten nur `node --check`, `node --test`, `c8`.
- **Tarball-Inhalt:** `npm pack --dry-run` enthält keine unerwünschten Dateien.
- **Obsidian-Bridge-Dateizugriffe:** Keine ungewöhnlichen Dateisystem-Operationen außerhalb des Projekt- und konfigurierten Datenverzeichnisses identifiziert.

---

## 11. Zusammenfassung für Stakeholder

| Metrik | Wert |
|--------|------|
| P0 | 0 |
| P1 | 4 |
| P2 | 5 |
| P3 | 8 |
| `npm audit` Vulnerabilities | 0 |
| Empfohlene Fix-Runde | ja |
| Code geändert während Audit | nein |

**Nächster Schritt:** Separate Fix-Runde gemäß Kapitel 9 priorisieren. Keine P0-Befunde; P1-Befunde sollten vor dem nächsten Release oder dem Pushen neuer Builds behoben werden.
