# Hermes 7.19.3 catalog candidate

The reviewed Hermes source pin was `a0361bacca5d7792bb369f1fdd4535b483d46a4f`.
The OpenClaw source is v7.19.3 (`0ef3d270c0272f9ba1aec3f4677ba9ac3668b80d`);
the retention change is `063d8e71c21e4569ca357f6da9035a904f53aadd`.

- The Desktop extension uses plugin-scoped REST and asserts the active profile.
  A host with plugin RPC support can use the profile-bound RPC for regular
  settings; a host that supplies only HTTP admission leaves hosted writes off.
- The Hermes provider form stores the optional Jev secret. The dashboard shows
  its presence and the separate opt-in to use it. Credentials resolve in the
  owning profile; a generic OpenAI key never falls back to a configurable
  embedding endpoint.
- Eligible Neo journals use the upstream age, value and emergency limits.
  Daily consolidation visits the hook and owner stores once each and archives
  removed rows before replacing the live file. Content is not deduplicated.
- Hermes' turn journal and raw episodes are addressed by capture receipts with
  exact byte ranges and are not rewritten. Receipt replay already uses those
  ranges instead of an append dedupe tail. Hermes has no corresponding
  OpenClaw canonical workspace-name lookup or retrieval ledger; numeric
  seconds are handled in the eligible native journals' retention calculation.

The catalog is a source-only distribution. It does not carry an installer,
model weights, or credentials.
