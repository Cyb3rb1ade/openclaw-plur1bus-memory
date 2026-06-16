# Supply-Chain P1/P2 Fix Follow-up

**Datum:** 2026-06-16  
**Branch:** `fix/supply-chain-p1-p2-2026-06-16`  
**Basis:** `docs/audits/supply-chain-security-audit-2026-06-16.md`

---

## 1. Zusammenfassung der behobenen Befunde

| Audit-ID | Schwere | Befund | Status | Fix |
|----------|---------|--------|--------|-----|
| P1-1 | P1 | Lockfile-Drift `protobufjs` 7.6.2 vs. 7.6.4 | ✅ behoben | `node_modules` gelöscht, `npm ci` ausgeführt |
| P1-2 | P1 | Nightly `onnxruntime-web@1.26.0-dev...` | ✅ behoben | `overrides` in `package.json` auf stabile `1.26.0` |
| P1-3 | P1 | Floating GitHub Action-Tags | ✅ behoben | Actions auf konkrete Commit-SHAs gepinnt |
| P1-4 | P1 | Fehlende least-privilege `permissions` | ✅ behoben | `permissions: contents: read` + Job-scopes |
| P2-1 | P2 | Install-Scripts auf nativen Paketen | 🟡 dokumentiert | Kein global `--ignore-scripts`, Tests zeigen Lauffähigkeit |
| P2-2 / P2-5 | P2 | Kein `npm audit signatures` / Dependency Review | ✅ behoben | Beides in CI ergänzt |
| P2-4 | P2 | Legacy-Fallback-Pfade `memory-lancedb-stock` | 🟡 offen gelassen | P0-Fix für lokale Repo-Setups; keine sichere Entfernung |
| P3-1 | P3 | `.gitignore` schließt `.env` nicht aus | ✅ behoben | `.env`-Patterns ergänzt |
| P3-2 | P3 | Caret-Ranges in Runtime-Dependencies | 🟡 offen gelassen | Bewusst beibehalten; Lockfile ist primäre Wahrheit |
| P3-3 | P3 | Fehlende `.npmrc` | 🟡 offen gelassen | Nicht in dieser Runde gesetzt |
| P3-4 | P3 | Fehlende `engines` / Quellmetadaten | ✅ behoben | `node >=20`, `repository`, `bugs`, `homepage` |
| P3-5 | P3 | Keine npm-Provenance | 🟡 offen gelassen | Erfordert Release-Workflow (separater Task) |
| P3-6 | P3 | Kein automatisierter Release-Workflow | 🟡 offen gelassen | Nicht in dieser Runde |
| P3-7 | P3 | Kein Dependabot | 🟡 offen gelassen | Nicht in dieser Runde |
| P3-8 | P3 | Deprecated `boolean@3.2.0` | 🟡 offen gelassen | Transitive Dep von `@huggingface/transformers`; Upgrade separat |

---

## 2. Behandelte P1/P2-Befunde im Detail

### P1-1: `protobufjs` Lockfile-Drift

**Vorher:**
- `package-lock.json`: `protobufjs@7.6.4`
- `node_modules/protobufjs`: `7.6.2`

**Maßnahme:** `rm -rf node_modules && npm ci`

**Nachher:**
- `node_modules/protobufjs`: `7.6.4`
- `npm audit`: 0 vulnerabilities

**Verifikation:**
```bash
node -p "require('./node_modules/protobufjs/package.json').version"   # 7.6.4
npm ls protobufjs --all                                               # 7.6.4
npm audit --audit-level=moderate                                      # 0 vulnerabilities
```

---

### P1-2: Nightly `onnxruntime-web`

**Vorher:**
- `onnxruntime-web@1.26.0-dev.20260416-b7804b056c` (via `@huggingface/transformers@4.2.0`)

**Maßnahme:** `overrides` in `package.json`:

```json
"overrides": {
  "@huggingface/transformers": {
    "onnxruntime-web": "1.26.0"
  }
}
```

**Nachher:**
- `onnxruntime-web@1.26.0` (stable)
- `protobufjs` bleibt `7.6.4`
- `npm test`: 1204 passing

**Verifikation:**
```bash
npm ls onnxruntime-web
# @huggingface/transformers@4.2.0
# └── onnxruntime-web@1.26.0 overridden
```

**Hinweis:** `@huggingface/transformers@4.2.0` hat eine harte Dependency auf die dev-Version. Der Override zwingt npm dazu, die stabile `1.26.0` zu verwenden. Da die Test-Suite weiterhin grün ist, scheint die stabile Version kompatibel zu sein. Dennoch sollte der local-transformers-Provider in einer echten End-to-End-Konfiguration verifiziert werden.

---

### P1-3: GitHub Actions pinnen

**Vorher:**
```yaml
- uses: actions/checkout@v4
- uses: actions/setup-node@v4
```

**Nachher:**
```yaml
- uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
- uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0
```

**Verifikation:** SHAs gehören zu den jeweiligen v4.x-Releases und wurden über `gh api` gegen die offiziellen Repositories geprüft.

---

### P1-4: CI least-privilege permissions

**Vorher:** Kein `permissions`-Block.

**Nachher:**
```yaml
permissions:
  contents: read
```

Der `dependency-review`-Job erhält separat:
```yaml
permissions:
  contents: read
  pull-requests: read
```

---

### P2-2 / P2-5: Dependency Review + `npm audit signatures`

**Maßnahmen:**
- Neuer Job `dependency-review` in `.github/workflows/ci.yml` (nur auf `pull_request`).
- Step `npm audit signatures || true` in `test`-Job (informational, kein harter Gate).

**Begründung für `|| true`:** `npm audit signatures` hat in einigen npm-/Registry-Konfigurationen eingeschränkte Abdeckung (ältere Pakete, alternative Registries). Ein harter Gate wäre zu fragil gewesen. Der Check läuft aber in CI und gibt Signaturstatus aus.

---

## 3. Bewusst offen gelassene Befunde

### P2-1: Install-Scripts

**Status:** Nicht global deaktiviert.

**Befund:** `onnxruntime-node`, `sharp`, `protobufjs` haben `hasInstallScript: true`.

**Experiment:** `npm ci --ignore-scripts` wurde getestet. Alle 1204 Tests bestanden. Dennoch wurde `--ignore-scripts` nicht als Standard in CI eingeführt, weil native Binaries (`sharp`, `onnxruntime-node`) in Produktion fehlen könnten, sobald Code-Pfade diese tatsächlich laden.

**Empfohlene nächste Schritte:**
- CI-Staging-Umgebung mit `--ignore-scripts` und vollständigem local-transformers-E2E-Test.
- Oder: Allow-List für Install-Scripts und eigenes native-binary Caching.

---

### P2-4: Legacy-Fallback-Pfade

**Status:** Nicht entfernt.

**Begründung:** Die Pfade `../memory-lancedb-stock/node_modules/...` wurden in v6.2.1 als P0-Fix eingeführt, um lokale Repo-Setups zu unterstützen. Eine sichere Entfernung erfordert Klarheit über alle Deployments, die diesen Pfad nutzen. Stattdessen bleibt der Befund offen; empfohlen wird eine Versionsprüfung vor dem dynamischen Import.

---

### P3-2: Caret-Ranges

**Status:** Beibehalten.

**Begründung:** `^` bei `@lancedb/lancedb` und `openai` ermöglicht compatible Minor-Updates. Das `package-lock.json` ist die primäre Wahrheit für reproduzierbare Builds (`npm ci`). Eine Änderung auf exakte Versionen wäre niedriges Risiko, wurde aber als nicht zwingend eingestuft.

---

### P3-3: `.npmrc`

**Status:** Nicht hinzugefügt.

**Begründung:** `engine-strict=true` könnte in bestehenden Umgebungen mit Node <20 zu Install-Failures führen. Da `engines.node >=20` jetzt dokumentiert ist, kann `.npmrc` in einer späteren Runde ergänzt werden.

---

### P3-5 bis P3-7: Provenance / Release-Workflow / Dependabot

**Status:** Nicht in dieser Runde.

**Begründung:** Diese Änderungen erfordern Repository-Einstellungen, Tag-Strategie und ggf. npm-Token-Konfiguration. Sie sollten in einem separaten Release-Hardening-Task behandelt werden.

---

### P3-8: Deprecated `boolean@3.2.0`

**Status:** Nicht behoben.

**Begründung:** `boolean@3.2.0` ist transitiv über `@huggingface/transformers > onnxruntime-node > global-agent`. Eine Behebung erfordert ein Upgrade von `@huggingface/transformers` oder `onnxruntime-node`, was über den Scope dieser Runde hinausgeht.

---

## 4. Dependency-Baum vorher / nachher

### Vorher

```
@huggingface/transformers@4.2.0
├── onnxruntime-node@1.24.3
└── onnxruntime-web@1.26.0-dev.20260416-b7804b056c
    └── protobufjs@7.6.2   # installiert, Lockfile sagt 7.6.4
```

### Nachher

```
@huggingface/transformers@4.2.0
├── onnxruntime-node@1.24.3
└── onnxruntime-web@1.26.0 (overridden)
    └── protobufjs@7.6.4   # installiert = Lockfile
```

---

## 5. CI-Änderungen

**Datei:** `.github/workflows/ci.yml`

- Top-level `permissions: contents: read`
- Actions gepinnt auf SHA
- `dependency-review`-Job für Pull Requests
- `npm audit signatures || true` als informational Step

---

## 6. Test- und Audit-Ergebnis

```bash
npm test
# tests 1204
# pass 1204
# fail 0

npm audit --audit-level=moderate
# found 0 vulnerabilities

npm pack --dry-run
# OK — keine unerwünschten Dateien
```

---

## 7. Risiken / Rollback-Hinweise

| Risiko | Einschätzung | Rollback |
|--------|--------------|----------|
| `onnxruntime-web`-Override könnte in E2E local-transformers-Szenarien Probleme verursachen | niedrig-mittel | `overrides`-Block aus `package.json` entfernen, `npm install` |
| Gepinnte Action-SHAs erfordern manuelles Update bei Sicherheitsupdates | niedrig | Einzelnen SHA durch neueren ersetzen |
| `permissions: contents: read` könnte andere Workflows/Integrationen beeinflussen | niedrig | Scope pro Job erweitern |

---

## 8. Empfohlene nächste Schritte (nicht in dieser Runde)

1. **P2-1:** Entscheidung, ob CI mit `--ignore-scripts` + native-binary Caching umgestellt wird.
2. **P2-4:** Legacy-Fallback-Pfade entfernen oder mit Versionsprüfung absichern.
3. **P3-3:** `.npmrc` mit `registry`, `engine-strict=true`, `lockfile-version=3` ergänzen.
4. **P3-5–P3-7:** Release-Workflow, npm-Provenance, Dependabot konfigurieren.
5. **P3-8:** `@huggingface/transformers`/`onnxruntime-node` aktualisieren, um `boolean@3.2.0` loszuwerden.

---

## 9. Geänderte Dateien

- `.github/workflows/ci.yml`
- `.gitignore`
- `package.json`
- `package-lock.json`
- `docs/audits/supply-chain-fix-followup-2026-06-16.md` (dieses Dokument)
