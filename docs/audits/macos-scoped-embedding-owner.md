# Scoped embedding owner election on macOS

The scoped embedding data plane remains a private Unix-domain socket and a
random 256-bit token under the `0700` IPC directory.  Only the owner-election
lease differs by platform.

macOS limits a filesystem Unix-domain socket name to 103 bytes.  The resolver
checks the final data-socket byte length before creating the `control` IPC
children or writing a token; an oversized configured state root fails closed
with `scoped_embedding_socket_path_too_long` and must be shortened.  This does
not make arbitrary long state roots supported.

Linux uses an abstract Unix socket derived from the canonical IPC directory.
Other platforms use a deterministic, exclusive `127.0.0.1` TCP port in the
dynamic range.  Both are kernel-atomic `listen()` claims and disappear when
the owning process exits, so neither requires a filesystem lock nor a stale
claim-path unlink.

The non-Linux port is derived from the SHA-256 directory digest.  The 16-bit
port space permits a rare accidental collision or a local process deliberately
occupying the claim port.  This is fail-closed as an already-active owner; it
does not expose tokens, request data, or the private data-plane socket.  A
filesystem claim socket was rejected because concurrent stale recovery could
unlink a newly elected live owner.
