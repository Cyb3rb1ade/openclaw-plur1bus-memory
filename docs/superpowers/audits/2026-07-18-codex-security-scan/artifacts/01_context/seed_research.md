# Advisory Seed Research

## Seed

- Identifier: `GHSA-xcpc-8h2w-3j85` / `CVE-2026-39244`
- Family: uncontrolled memory allocation / denial of service (`CWE-400`, `CWE-789`)
- Affected package: `adm-zip < 0.6.0`
- Fixed package: `adm-zip 0.6.0`

## Authoritative sources checked

- `npm audit --json --ignore-scripts` on 2026-07-18: reported the direct optional dependency chain `@huggingface/transformers@4.2.0 -> onnxruntime-node@1.24.3 -> adm-zip@0.5.17`, severity high, affected range `<0.6.0`.
- GitHub upstream fix commit: https://github.com/cthackers/adm-zip/commit/2450dcf417aa29df49270237d18c5245794da3e2 (`Fixed preallocation security issue`). The regression test demonstrates that a tiny ZIP with an attacker-declared roughly 3-4 GiB uncompressed size caused eager allocation before CRC validation.
- npm package metadata/search confirmed `adm-zip@0.6.0` as the current patched release. Direct package-page retrieval returned HTTP 403, but the registry audit endpoint succeeded.

## Local dependency anchors

- `package.json:67`: optional `@huggingface/transformers` is pinned to `4.2.0`.
- `package-lock.json:64-75`: resolves `@huggingface/transformers@4.2.0` and its `onnxruntime-node@1.24.3` dependency.
- `package-lock.json:893-901`: resolves vulnerable `adm-zip@0.5.17`.
- `package-lock.json:1624-1640`: `onnxruntime-node@1.24.3` has an install script and depends on `adm-zip ^0.5.16`.
- `lib/providers/embedding-local-transformers.js:70-85`: runtime activation of the optional Transformers embedding provider.
- `lib/providers/reranker-local-transformers.js:39-53`: runtime activation of the optional Transformers reranker.
- `lib/providers/openclaw-memory-embedding-adapters.js:170-187`: another local Transformers pipeline entrypoint.

## Upstream reachability evidence

The exact `onnxruntime-node@1.24.3` registry tarball was downloaded from the lockfile/registry URL and its integrity-bearing package contents were retained under `artifacts/01_context/advisory_evidence/onnxruntime-node-1.24.3/`.

- `package/package.json`: declares `postinstall: node ./script/install` and `adm-zip: ^0.5.16`.
- `package/script/install.js`: postinstall invokes `installPackages`; on default Linux x64 metadata it requests the `cuda12` manifest unless explicitly skipped.
- `package/script/install-metadata.js`: the Linux x64 manifest fetches CUDA provider binaries from the Microsoft/NuGet HTTPS feed.
- `package/script/install-utils.js`: downloads the `.nupkg`, constructs `new AdmZip(packageFilePath)`, obtains manifest-selected entries, and calls `extractEntryTo` before copying them into the runtime binary directory.

This proves the vulnerable parser is executable during a supported/default optional-dependency installation on Linux x64. The archive URL is not selected by a chat user; exploitation requires a malicious/compromised package feed, trusted proxy, or equivalent software-supply-chain position. Product-context severity therefore needs separate calibration from the advisory's package-level CVSS.

## Seed hypothesis and proof gap

The vulnerable ZIP parser is installed only with the optional local-Transformers feature. The checked-in lockfile selects the vulnerable version. The product does not directly pass chat/user ZIP uploads to `adm-zip`; the most plausible boundary is dependency installation or ONNX Runtime's native-binary acquisition path. Validation must determine whether `onnxruntime-node` invokes `adm-zip` only during installation and whether an attacker can control that archive in supported deployments. If direct reachability is absent, retain the advisory as a vulnerable-dependency/supply-chain finding with calibrated product severity rather than disabling local inference.

## Required exact closure row

`seed-ghsa-xcpc-8h2w-3j85` remains open until validation closes the exact dependency chain and runtime/install-time reachability as `reportable`, `suppressed`, `not_applicable`, or `deferred`.
