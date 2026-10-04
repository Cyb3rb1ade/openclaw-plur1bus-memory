# Plugin selftest

The `plur1bus` CLI command is a plugin feature. The add-on installer in
Cyb3rb1ade/PLUR1BUS-Host-Addons runs it as its verify step.

`openclaw plur1bus selftest [--json] [--download-models] [--remote] [--keep]
[--state-dir <dir>]` runs in the CLI process without a Gateway, and the
install verify step runs it. It:

1. imports each native addon (`@lancedb/lancedb`, `onnxruntime-node`, `sharp`).
   `@lancedb/lancedb` and `onnxruntime-node` are required. A missing or
   unloadable `sharp` degrades the `vision` capability
   (`native_addon_unavailable:sharp`) and does **not** fail the selftest when
   the text embed, capture and recall steps pass;
2. refuses a configured store inside a PLUR1BUS harness home;
3. checks the embedding model in the plugin's cache (downloads only with
   `--download-models`);
4. opens a **throw-away** store `<stateDir>/plur1bus-selftest-<random>`, embeds
   and captures two probe texts, recalls both, reranks when a local reranker
   with artefacts is configured, closes, and deletes the store unless `--keep`.

A remote embedding provider is not called unless `--remote` is given (that step
reports `skipped: remote-provider`). A missing model without
`--download-models` skips embed, capture and recall with the warning
`model-missing` and leaves the result `ok`.

`--json` prints one `plur1bus.selftest/1` document: `ok`, `addons`,
`capabilities`, `model`, `steps`, `warnings`, `errors`. **Reading a failed
native addon:** an entry `{ "name": "onnxruntime-node", "ok": false,
"package": "...", "error": "..." }` and the error line `addon <name> failed to
load (<package>)` mean the prebuilt binary for this platform is missing or does
not load. Check that `package` is installed under the plugin directory (a
failed or `--ignore-scripts`-trimmed dependency install), that the target is
one of the five supported ones, and that OpenClaw's Node matches the range;
then reinstall the plugin. A failing selftest fails the install verify and
triggers the rollback.

**`sharp` is optional.** `{ "name": "sharp", "ok": false, ... }` with warning
`native_addon_unavailable:sharp` and `capabilities` containing
`{ "id": "vision", "status": "degraded", "reason": "native_addon_unavailable:sharp" }`
means image/vision paths are unavailable. Text embedding still loads
`@huggingface/transformers` (the package imports `sharp` at module load; the
plugin intercepts that import after a failed probe). A redacted warning is
logged once; the failure is never swallowed silently.
