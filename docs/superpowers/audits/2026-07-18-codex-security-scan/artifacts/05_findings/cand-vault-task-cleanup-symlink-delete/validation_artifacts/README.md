# Validation artifact notes

`proof.mjs` isolates its workspace and external target under a temporary directory, sets only its local environment variable, and invokes the original cleanup module. It proves a matching temporary file outside the workspace is removed through the symlink.

Invocation and observed result are recorded in the sibling validation and attack-path reports. These files are audit evidence only; no product source or test file was changed.

