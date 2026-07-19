# Validation artifact notes

`proof.mjs` uses a fake table and recording reranker around the repository's recall pipeline. It records that a foreign summary reaches the reranker before the final ACL excludes that row. No provider is contacted.

Invocation and observed result are recorded in the sibling validation and attack-path reports. These files are audit evidence only; no product source or test file was changed.

