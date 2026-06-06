# PLUR1BUS — Agent Development Guide

This document supplements `README.md` with build steps, conventions, and agent-focused guidance for the PLUR1BUS memory plugin.

## Architecture Overview

PLUR1BUS is an OpenClaw v6 plugin that provides per-agent long-term memory using:

- **LanceDB** — authoritative store, per-agent isolated tables (`{baseDbPath}/{agentId}/`)
- **Obsidian Bridge** — human-readable Markdown vault mirror, bidirectional sync
- **Memory Graph** — semantic, entity, emotional, and episode edges between memory cards
- **Telegram/Chat Commands** — user-facing inspection and editing without leaving the chat
- **Background Jobs** — daily consolidation, critical-push classification, skill mining, REM dreaming

## Coding Standards

### Naming
- `camelCase` for functions, variables, and file names
- `PascalCase` for classes
- `UPPER_SNAKE_CASE` for constants

### Documentation
- **JSDoc for new or changed exports in the current phase**. Existing exports may be supplemented when touched, but do not retroactively document everything.
- Keep JSDoc focused: `@param`, `@returns`, and a one-line description are sufficient.

### Async Style
- Prefer `async/await` over raw Promise chains.
- Promise chains (`.then().catch()`) are **allowed only for justified technical cases**, e.g.:
  - Per-file Promise-Queue mutexes (`atomic-json.js`)
  - Bounded concurrency workers (`runWithConcurrency`)
- Never use floating `.catch(() => {})` that silently swallows errors. Log via `safeWarn`/`safeDebug`.

### Error Handling
- No silent catches. Every catch must either re-throw, return an error result, or log at `warn`/`debug` level.
- Use `safeWarn` / `safeDebug` helpers when logging without access to `api.logger`.
- Destructive operations must write an audit log entry via `appendDestructiveOpLog`.

## Security Guidelines

### Input Validation
- `safeUuid(id)` — mandatory for every LanceDB memory ID parameter
- `safeAgentId(id)` — mandatory before using an ID in a filesystem path
- `resolveInside(baseDir, ...parts)` — mandatory before any file read/write; blocks path traversal even for non-existent targets
- `validateInput(value, { maxLength, name, required })` — mandatory for all user-facing text inputs (commands, callbacks, corrections, search queries)

### Enum Validation
- `safeStatus(value)` — allows only: `active`, `superseded`, `archived`, `deleted`
- `safeType(value)` — allows only the documented memory type set

### Authorization
- Destructive commands (`/forget`, `/correct`, `/enable`, `/disable`, `/plur1bus setup`) use `isAuthorized()` with `fail-closed` logic:
  - If no whitelist is configured, destructive commands are **denied**.
  - Destructive commands require `userId` in `allowedUserIds`; `chatId` alone is never sufficient.
- Confirmation callbacks are bound to `userId + chatId + nonce` via `createConfirmation()` / `validateConfirmation()`.

## LanceDB Schema Extensions

When adding new columns to the LanceDB `memories` table:

1. Use `addColumns` with `valueSql` for defaults:
   ```js
   await table.addColumns([
     { name: "newColumn", type: new Float32(), valueSql: "0.0" },
   ]);
   ```
2. Provide a fallback in code for tables that have not yet been migrated:
   ```js
   const val = record.newColumn ?? 0.0;
   ```
3. Migration is idempotent and non-destructive; it runs on first `init()`.

## Testing

Run tests with:

```bash
node --test tests/*.test.js
```

- Tests are unit-level and DB-free.
- Every phase must add its own regression tests.
- Current baseline: 190 tests, all passing.

## Dependency Audit

Last audit run: 2026-06-05

- `npm audit`: **0 vulnerabilities**
- `npm ci --ignore-scripts`: passes

### Runtime Dependencies

| Package | Spec | Resolved | Pinned? |
|---------|------|----------|---------|
| `@lancedb/lancedb` | `^0.26.2` | `0.26.2` | No (`^`) — version fixed by `package-lock.json` |
| `openai` | `^6.27.0` | `6.41.0` | No (`^`) — version fixed by `package-lock.json` |

### Optional Dependencies

| Package | Spec | Resolved | Pinned? |
|---------|------|----------|---------|
| `@huggingface/transformers` | `4.2.0` | `4.2.0` | Yes |

All versions are effectively pinned at install time by `package-lock.json`. No critical CVEs were reported at the time of the last audit. Major upgrades require a separate plan.

## Backup / Restore

Before destructive fixes or schema migrations, create a snapshot:

```bash
# Automatic snapshot (recommended)
./scripts/backup-snapshot.sh

# Manual snapshot (fallback)
cp -r ~/.openclaw/memory/lancedb-namespaced ~/.openclaw/memory/lancedb-namespaced.bak.$(date +%Y%m%d-%H%M%S)
```

Restore from a snapshot (dry-run by default):

```bash
# Dry-run: see what would be restored
./scripts/restore-snapshot.sh ~/.openclaw/.snapshots/plur1bus-YYYYMMDD-HHMMSS

# Actually restore
./scripts/restore-snapshot.sh --confirm ~/.openclaw/.snapshots/plur1bus-YYYYMMDD-HHMMSS
```

The plugin writes archives before every deletion (`/forget`, `/correct`). The archive path is reported in the command response.
