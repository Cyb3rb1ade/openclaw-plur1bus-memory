# Validation artifact notes

`proof.mjs` uses only a fake in-memory table and the repository's exported graph helpers. It demonstrates that a foreign row with missing hydrated ownership is returned to an authorized workspace-A caller. No database, network, or repository file is modified.

Invocation and observed result are recorded in the sibling validation and attack-path reports. These files are audit evidence only; no product source or test file was changed.

