# PLUR1BUS Memory 6.8.0 — Performance, Code Context, Media, and Runtime Packaging

**Release Date:** 2026-06-26

**Theme:** Main-branch performance follow-up and package completeness

PLUR1BUS v6.8.0 is the first minor release after v6.7.8. It collects the media diarization work, emotional-state injector packaging, optional code-index context, and the main-branch performance-audit follow-ups.

---

## Key Features in v6.8.0

### 1. Media Diarization Support

- Async diarization merge pipeline for media-derived context.
- Speaker naming, manual mapping, and contextual speaker-name proposals.
- No biometric enrollment; speaker labels remain contextual product metadata.

### 2. Emotional-State Injection Runtime Package

- Ships `.openclaw/extensions/emotional-state-injector/` in the npm tarball.
- Includes the plugin entry and manifest so package installs no longer drop the injector files.
- Runtime activation still requires OpenClaw plugin entry/allow config and a gateway restart.

### 3. Performance-Audit Follow-Up

- Legacy auto-capture duplicate checks avoid per-row insert pressure.
- Duplicate lookup can use ANN multi-query search where the LanceDB table API supports it.
- JSON hot-path writes are queued asynchronously.
- Remaining prompt hot-path work was narrowed to reduce repeated high-cost operations.

### 4. Optional Code Index Context

- `npm run code-index -- /path/to/workspace` writes `.plur1bus/code-index.json`.
- `npm run code-index -- /path/to/workspace --query "/plur1bus code-index"` prints bounded `<code-context>` output.
- The implementation uses the TypeScript Compiler API and keeps the stored PLUR1BUS schema parser-independent.

---

## Release Gates

- Version sources should agree on `6.8.0`:
  - `package.json`
  - `package-lock.json`
  - `openclaw.plugin.json`
- `npm test` baseline: 1,931 tests.
- `npm pack --dry-run --json` should show version `6.8.0` and include `.openclaw/extensions/emotional-state-injector/`.

---

**PLUR1BUS Memory** — Make your agent yours.
