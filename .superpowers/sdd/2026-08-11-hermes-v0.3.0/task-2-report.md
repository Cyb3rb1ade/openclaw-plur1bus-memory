# Task 2 Report — Synchronize Hermes 0.3.0 release coordinates

Status: DONE

## Commit(s)

- `0a9f51a4f6cfc9199c32c8beea8f5ab5c323f31b` — `chore: prepare Hermes 0.3.0 installer release`

## Exact file list

- `package.json`
- `package-lock.json`
- `openclaw.plugin.json`
- `test/package-content.test.js`
- `plur1bus-hermes/pyproject.toml`
- `plur1bus-hermes/src/plur1bus_hermes/__init__.py`
- `plur1bus-hermes/src/plur1bus_hermes/cli.py`
- `plur1bus-hermes/src/plur1bus_hermes/plugin.yaml`
- `plur1bus-controls/pyproject.toml`
- `plur1bus-controls/src/plur1bus_controls/plugin.yaml`
- `README.md`
- `plur1bus-hermes/README.md`
- `CHANGELOG.md`
- `.superpowers/sdd/2026-08-11-hermes-v0.3.0/task-2-report.md`

No Upstream-Runtime-Dateien aus Merge `94cef6f` wurden geändert.

## Red-Test

Command:

```bash
node --test test/package-content.test.js
```

Exit code: `1`.

Ergebnis: `2` Tests, `1` pass, `1` fail. Erwartete Ursache: Die Test-Erwartung war bereits auf `7.2.6-hermes.1` umgestellt, während das Paketmetadata noch `7.2.3-hermes.1` meldete. Der beobachtete Assertion-Fehler bestätigte genau diese Versionsabweichung.

## Green-Tests

Node-Fokus:

```bash
node --test test/package-content.test.js tests/installer-config.test.js tests/installer-stub-guard.test.js
```

Exit code: `0`. Ergebnis: `26` Tests, `26` pass, `0` fail; `4` Suites.

Python-Fokus mit dem ausdrücklich unterstützten Runner:

```bash
PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 \
PYTHONPATH=plur1bus-hermes/src:plur1bus-controls/src \
  /tmp/plur1bus-hermes-release-py311/bin/python -m pytest -q \
  plur1bus-hermes/tests/test_runtime_provider.py \
  plur1bus-hermes/tests/test_controls.py \
  plur1bus-hermes/tests/test_embedding_fallback.py \
  plur1bus-hermes/tests/test_reranker_fallback.py
```

Exit code: `0`. Ergebnis: `26 passed`, `4 warnings`, `2 subtests passed` in `1.04s`.

## Versionsabgleich

- `package.json`: `7.2.6-hermes.1`
- beide Root-Versionen in `package-lock.json`: `7.2.6-hermes.1`
- `openclaw.plugin.json`: `7.2.6-hermes.1`
- `plur1bus-hermes/pyproject.toml`: `0.3.0`
- `plur1bus-controls/pyproject.toml`: `0.3.0`
- beide Hermes-/Controls-`plugin.yaml`-Dateien: `0.3.0`
- `plur1bus_hermes.__version__`: `0.3.0`
- CLI-Health-Payload: `0.3.0`; der ausgeführte Payload meldete `provider: plur1bus` und `available: true`
- aktuelle Hermes-Dokumentation: Tag `hermes-v0.3.0`, npm/OpenClaw `7.2.6-hermes.1`
- `publishConfig` unverändert erhalten: Registry `https://npm.pkg.github.com`, Dist-Tag `hermes`
- Changelog-Kopf: `Hermes 0.3.0 / 7.2.6-hermes.1` am `2026-08-11`

## Selbstreview

- `git diff --check`: erfolgreich.
- Geänderter Implementierungsscope: exakt die 13 im Brief erlaubten Dateien.
- Keine Runtimeänderungen aus Merge `94cef6f` verändert oder revertiert.
- Historischer Hermes-0.2.0-Changelog-Eintrag blieb erhalten; nur die aktuellen Installationskoordinaten wurden aktualisiert.
- Der Red/Green-Zyklus wurde in der vorgegebenen Reihenfolge ausgeführt.

## Bedenken

Keine blockierenden Bedenken. Die Python-Green-Tests melden vier bestehende Deprecation-Warnings aus LanceDBs `table_names()`-Verwendung in `plur1bus-hermes/src/plur1bus_hermes/domain.py`; diese Datei lag außerhalb des Brief-Scope und wurde daher nicht verändert.
