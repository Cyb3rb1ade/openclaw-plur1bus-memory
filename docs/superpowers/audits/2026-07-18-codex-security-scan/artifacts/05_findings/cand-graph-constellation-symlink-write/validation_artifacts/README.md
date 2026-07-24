# Validation artifact notes

`proof.mjs` builds an isolated temporary workspace and an external temporary directory, then invokes the original writer. It proves a directory symlink can redirect the generated report. All temporary paths are self-contained.

Invocation and observed result are recorded in the sibling validation and attack-path reports. These files are audit evidence only; no product source or test file was changed.

