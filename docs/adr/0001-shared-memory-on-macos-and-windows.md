# ADR 0001: Shared memory on macOS and Windows

- **Status:** Proposed — owner decision pending. The analysis and the
  recommendation below are complete; the implementation (engine plan 2a-E4,
  Tasks 9 and 10) is not started and is dispatched only after the owner's
  explicit yes. On acceptance Task 10 sets this line to "Accepted", with the
  owner and the date.
- **Date:** 2026-09-26
- **Scope:** explicit shared memory (workspace and user pools, `/share`,
  shared-copy refresh, change proposals, shared reads) on darwin and win32.
  Linux is out of scope and unchanged.

## Context

Explicit shared memory (spec decision D31) writes one copy of a memory into a
workspace or user pool under `<sharedBaseDir>/.plur1bus-shared`, which every
member of that pool reads. The pool directories are therefore reachable by
more than one agent, and a directory swapped for a symlink between the moment
the engine checks a path and the moment LanceDB writes to it would redirect
another principal's writes.

Today every LanceDB path in the shared pool is routed through a
descriptor alias: `lib/directory-capability.js` opens each directory with
`O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC` (`lib/directory-capability.js:11-14`),
keeps the descriptor, and hands LanceDB the path `/proc/self/fd/<n>/…`
(`lib/directory-capability.js:50-62`). The kernel resolves that path through
the held descriptor, so a rename-and-symlink of the directory after the check
cannot change what LanceDB opens. The mode is selected once per process by
`stableDirectoryCapabilitiesSupported()` (`lib/directory-capability.js:30-48`),
which `SharedMemoryPool` consults in its constructor
(`lib/shared-memory-pool.js:52-53`).

That routing does not exist on two of the three D8 targets
(spec D8: macOS arm64, Linux x64/arm64, Windows x64/arm64):

- **macOS** has no `/proc`. `/dev/fd/<n>` for a directory descriptor stats as
  the `fdesc` device rather than the directory, and `readdir` on it answers
  `ENOTDIR`, so it cannot be used as a path prefix. `fdAlias` finds no
  candidate whose `{dev, ino}` matches (`lib/directory-capability.js:51-61`)
  and the probe answers `false` (`docs/audits/macos-directory-capability-tests.md`
  records the same finding).
- **win32** is excluded outright (`lib/directory-capability.js:32`); Windows
  has no path syntax that routes through an open handle.
- Node exposes no `openat`/`mkdirat`, so there is no pure-JavaScript
  alternative that resolves a child relative to a held descriptor.

Result: share, shared-copy refresh, proposals and shared reads are disabled on
macOS and Windows. Since E4 Task 6 (`fa822b64`, `ff517bd9`) this is explicit
rather than a generic failure: the write-path root check throws
`sharedMemoryUnsupportedError("platform")` (`lib/shared-memory-pool.js:120-130`),
`engine.memory.share` and `proposals.accept` answer the `unsupported`
`MemoryOpError` before any row, archive or `.plur1bus-shared` directory is
written (`engine/memory-ops/write.js:255-257`,
`engine/memory-ops/proposals.js:306-308`), shared reads stay empty, and the
OpenClaw `/share` reply says why (`adapter/openclaw/register-commands.js:1274`).
E4 Task 4 surfaces the same fact in `Engine.status().sharedMemory`
(`types/engine.d.ts:723-729`, `lib/shared-memory-pool.js:76-80`,
`engine/status/status-reporter.js:134`): `{ supported: false, mode:
"unavailable", reason: "platform" }` on darwin and win32.

The question is whether, and how, to enable shared memory on those platforms.

## Options

### Option A — native addon

A small C/C++ (N-API) addon that opens and creates directories relative to a
held descriptor: `openat`/`mkdirat` with `O_NOFOLLOW` on POSIX,
handle-relative `NtCreateFile` (`RootDirectory` in `OBJECT_ATTRIBUTES`,
`FILE_OPEN_REPARSE_POINT`) on Windows.

**Decisive fact:** LanceDB (`@lancedb/lancedb`, Rust) opens its own files, by
path string, inside its object store. The addon can open *our* directories
race-free, but it cannot hand LanceDB a descriptor, and macOS and Windows have
no path form that resolves through a held descriptor (the very gap described
above). Every LanceDB open and create still goes through a path string that is
re-resolved by the kernel at the time of use.

So Option A protects the engine's **checks**, not LanceDB's **writes**. The
check-to-use window it leaves is the same one Option B leaves. Its costs:

- five signed prebuilt binaries (darwin-arm64, linux-x64, linux-arm64,
  win32-x64, win32-arm64), produced and signed per release;
- a C/C++ toolchain (and MSVC on Windows runners) in CI;
- a new native supply-chain surface in a package that has none today, which
  also contradicts E4's global constraint "no new third-party dependency, no
  native addon".

### Option B — verified-path mode

Pure JavaScript on the existing Node APIs. The shared base and root are
verified by path, their identity is pinned, and the identity is re-checked
around every LanceDB operation:

1. **Canonicalise once, walk from the root.** The shared base is canonicalised
   once (`realpathSync.native` of its nearest existing ancestor plus the
   missing segments) and walked from the filesystem root segment by segment
   with `lstat` (bigint). Any symlink, junction or reparse point is refused,
   with `isUnsafeLink` semantics (`lib/platform.js:107-133`: a symlink
   anywhere; on win32 additionally any path whose `realpathSync.native`
   differs from its resolved form).
2. **Ancestors.** POSIX: owner `root` or the current uid, and not group- or
   other-writable unless the sticky bit is set (so `/tmp`-style parents pass,
   world-writable non-sticky parents do not). Windows: no reparse point.
3. **The shared base.** Owner = current user; POSIX `(mode & 0o022) === 0`.
4. **The shared root `.plur1bus-shared`.** Created `0o700`; owner = current
   user; POSIX `(mode & 0o077) === 0`. Windows: owner = current user SID and
   every Allow ACE's SID is one of {current user, `S-1-5-18` SYSTEM,
   `S-1-5-32-544` Administrators}; applied at creation with
   `icacls <root> /inheritance:r /grant:r <user>:(OI)(CI)(F)`.
5. **Pinned identity, re-verified.** Every held directory keeps its
   `{dev, ino}`. POSIX additionally holds an `O_RDONLY|O_DIRECTORY|O_NOFOLLOW`
   anchor descriptor, so the inode cannot be freed and recycled for a
   look-alike directory; NTFS file ids carry a sequence number, which gives
   the same guarantee on Windows. The identity is re-verified by `lstat`
   before every LanceDB operation — `MemoryDB` already calls
   `directoryCapability.assertOpen()` there
   (`_assertTrustedPath`, `engine/store/memory-db.js:437-443`; `_lancePath()`
   at `engine/store/memory-db.js:445-451` hands LanceDB the held directory's
   `path`), so a verified-path directory with the same interface plugs in
   unchanged — and after every lease (a new `finally` check in `_lease`,
   `lib/shared-memory-pool.js:213-225`). A mismatch taints the pool until
   restart: `support()` then answers `{ supported: false, mode:
   "verified-path", reason: "identity-changed" }` and later shares answer
   `unsupported`.

**Security argument.** After steps 2-4, no other unprivileged user can create,
rename or replace anything at or below the shared root, and none can rename
the base out from under it (no ancestor is writable by them, sticky parents
excepted, where only the owner may rename). Whoever can still race the
residual check-to-use window therefore already holds the current user's write
access, or root/Administrators — and with that can edit the LanceDB files
directly. Winning the race gives that principal no power beyond what it
already has. What B does not defend against — malware running as the user —
the Linux fd mode does not defend against either: such a process can write the
tables directly. Step 5 turns an accidental or hostile swap by that principal
into a fail-closed taint instead of a silent redirect.

**Cost.** One `lstat` per path segment at open, one `lstat` per LanceDB
operation and per lease, and on Windows one ACL read per process. No new
dependency, no build toolchain, no binaries.

### Option C — status quo

Keep `unsupported` on darwin and win32. Zero risk and zero cost, but shared
memory stays unavailable on two of the three D8 targets, including the
owner's primary platform (macOS).

## Decision (recommended, pending owner)

**Option B, verified-path mode, on darwin and win32. Linux stays on
fd-capability routing** — it remains Linux's only mode, and every existing
`tests/b13-*` case passes unchanged.

Reasoning: A and B leave the same residual window, because LanceDB opens by
path on these platforms regardless of what the engine does. A pays five signed
native builds, a CI toolchain and a new supply-chain surface for protecting
only the checks, which B protects adequately with ownership and permission
policy. B's residual window is exploitable only by a principal that can
already write the tables directly.

This supersedes, for darwin and win32 only and only once accepted, the
guidance in `docs/audits/macos-directory-capability-tests.md` not to replace
descriptor routing with path-only routing: verified-path mode is not plain
path-only routing — it adds the owner-only policy and the pinned, re-verified
identity that make the remaining window harmless.

## Consequences

If the owner accepts:

- `SharedMemorySupport.mode` (`types/engine.d.ts:723`) answers
  `"verified-path"` on darwin and win32; `supported` is `true` unless a check
  failed, in which case `reason` is `"unsafe-root"`, `"acl-tool-unavailable"`
  or `"identity-changed"` (all already in the 1.8.0 union,
  `types/engine.d.ts:724-729`). No further contract bump is needed.
- Tasks 9 (`lib/verified-path-directory.js`, `secureDirectoryOwnerOnly`,
  `readDirectoryAcl` in `lib/platform.js`) and 10 (mode selection and taint in
  `lib/shared-memory-pool.js`) are dispatched; the macOS portability workflow
  (`.github/workflows/macos-portability.yml`) runs the new tests; this ADR
  becomes Accepted.
- Pre-existing shared roots created with looser permissions are refused
  (`unsafe-root`) rather than silently tightened; the operator fixes the mode
  or ACL.

If the owner declines:

- `unsupported` (reason `"platform"`) stays the answer on darwin and win32,
  exactly as shipped by Tasks 4 and 6.
- The `"verified-path"` literal is removed from the `SharedMemoryMode` union
  (`types/engine.d.ts:723`) before the E4 PR, so the contract does not
  advertise a mode that cannot occur.

## Residual risks

- **Windows ancestors** above the shared base are checked for reparse points
  only; their ACLs are the OS profile defaults and are not inspected.
- **Windows ACL read** depends on `powershell.exe`. If it is absent or cannot
  run, the check fails closed with `acl-tool-unavailable`.
- **Network and virtual filesystems** with unstable inode numbers fail the
  identity check and fail closed with `identity-changed`.
- **Legacy shared migration** (`lib/shared-memory-migration.js`, which opens
  through `openDirectoryCapability`, line 186) and **explicit named
  namespaces** (`lib/multi-namespace-pool.js:167`) stay fd-only; off Linux the
  migration answers `unsupported` and named namespaces stay disabled, as the
  B12 audit already records for named routing.
- **The check-to-use window** between the last `lstat` and LanceDB's own open
  remains, by construction (see the security argument); it is exploitable only
  by the current user, root or Administrators.

## References

- Spec `docs/superpowers/specs/2026-09-24-m1b-2a-core-daemon-cli-design.md`
  (PLUR1BUS-Harness repo): D8 (target platforms, line 22), D31 (shared copies,
  line 41).
- B13 plan, Task 6 "Physically isolated workspace/user shared pools":
  `docs/superpowers/plans/2026-07-21-b13-acl-wiki-share.md:784`.
- B12 audit, remaining uncertainty on directory capabilities:
  `docs/audits/2026-07-20-b12-core-recall-namespaces-fix.md:664-667`.
- `docs/audits/macos-directory-capability-tests.md` (macOS `/dev/fd` finding
  and test policy).
- Engine plan 2a-E4 (PLUR1BUS-Harness repo,
  `docs/superpowers/plans/2026-09-26-m1b-2a-e4-engine-status-and-shared-platforms.md`),
  Tasks 4, 6, 7, 9, 10.
