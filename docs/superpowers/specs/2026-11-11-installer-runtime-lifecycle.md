# Installer runtime lifecycle

The setup assistant currently refuses all seven selected profiles when their one shared Hermes gateway is running. Installation must coordinate runtime shutdown and restoration itself on macOS ARM, Windows x64/ARM and Linux x64/ARM/WSL, without requiring terminal knowledge.

The reviewed install action explicitly authorizes the installer to stop and restore affected Hermes runtimes. Bind discovery to the selected Hermes installation and home; deduplicate multiplexed gateways; verify process birth/owner identity; never match an arbitrary argv substring or kill unrelated Python processes. Prefer Hermes' existing drain/pause and service-manager lifecycle mechanisms. No host-source patch or mutation of PM-owned environments with pip.

New work must be held while existing work drains. No silent destructive termination of sessions. When automatic handling is unsupported or cannot be proved safe, show the specific recoverable reason before plugin/config/dependency writes. A genuine active task or externally controlled supervisor must never be bypassed just to make a test green.

Record the restart obligation before stopping. Restore only runtimes that were running, preserving service/manual/Desktop ownership. On success verify readiness; on pre-write failure restore the original set. On a partial failed installation restart only after a verified safe rollback; retain an actionable recovery receipt otherwise. A restart failure must not be reported as a failed dependency installation or silently discarded. Keep all settings, credentials and memories.

Both graphical macOS setup and guided Windows/Linux console setup use the same lifecycle engine and progress phases. Retain an explicit externally-stopped CLI mode. macOS follows system language with English fallback. No secrets in plans, logs or receipts.

Ship the corrected installer as 7.19.3-hermes.2 after regression, sandbox live-runtime, native platform and artifact verification. Sign and notarize the macOS PKG, publish all platform installers on GitHub, and update the catalog source pin consistently when applicable. Use the tested flow for the local seven-profile installation after the build passes.
