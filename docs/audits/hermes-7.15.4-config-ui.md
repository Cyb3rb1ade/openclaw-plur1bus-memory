# Native configuration UI follow-up

The bundled OpenClaw dashboard is not the native Hermes interface. This change
exposes additional existing Hermes consumers through the authenticated settings
review/commit routes: T3 emotion classification, query refinement, meta-cognition,
contradiction disclosure and daily-consolidation decay mode. Values remain sparse
profile overrides; changes do not modify models, migrate memories or claim live
gateway activation.

Both frontends group settings into collapsible storage, memory-function and
task-model sections with readable labels and per-control help text. The desktop
uses separate settings, models/storage, memories and diagnostic views; boolean
settings use accessible switches with associated descriptions. Host typography and
theme colors are retained, and narrow windows stack description and control.
The desktop loads its settings when the
profile-bound transport changes. Existing scoped requests discard stale responses.
The final footer displays the version of the Python backend that answered status,
including when storage is unavailable; an old backend without version information
is explicitly unknown, never labeled with a hardcoded current release.

Validation: 881 native/controls tests passed, two skipped, 452 subtests passed;
31 dashboard tests passed; desktop and web JavaScript harnesses passed. Additional
regressions cover profile-only persistence of each added control, invalid inputs,
backend version independent of storage, grouped web rendering and footer placement.

This is not full dashboard parity. Native GC capacity policy, full host model
catalogue integration and remaining operating/telemetry controls remain tracked
in the 7.15.4 delta audit. No public release is implied by a local installation.

## Local verification

The candidate was installed into the existing interpreter and all six existing
profile plugin locations, without setup, dependency changes, retrieval setup or
model-provider replacement. Nine existing profile/plugin configuration files
matched their backup byte-for-byte. App and supervised gateway were restarted;
the native page returned version 7.15.4 and rendered the new controls. Backups of
plugins, profile homes, the configured data directory and interpreter were made
under `~/.hermes/plur1bus-install-backups/ui-7.15.4-20260921` before installation.

Live profile-switch testing exposed an independent remaining host-routing issue:
switching the UI from rapidmlx to coder still returned rapidmlx capabilities.
The plugin correctly blocks all data/actions on this mismatch. This is not a
successful all-profile activation test; do not remove the profile guard to hide it.

The design follow-up was installed and inspected in the running native app with
Computer: the settings view shows readable inline help, aligned switches, four
navigation areas, collapsible groups and the 7.15.4 footer. After this follow-up,
41 targeted Python/dashboard tests and both frontend harnesses passed. The desktop
harness now renders the actual settings/page functions to check switch description
associations, navigation and final footer placement, not just helper contracts.
