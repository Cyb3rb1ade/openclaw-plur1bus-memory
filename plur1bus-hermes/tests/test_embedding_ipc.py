"""Offline tests for scoped Engine embedding IPC, including the Node v1 wire."""
from contextlib import contextmanager
import json
import os
from pathlib import Path
import shutil
import queue
import threading
import subprocess
import sys
import tempfile
from unittest.mock import patch

import pytest

from plur1bus_hermes.embedding_ipc import EngineIpcEmbedding, EngineIpcError, EngineIpcServer, validate_ipc_config
from plur1bus_hermes.validation import ValidationError


FINGERPRINT = "embedding:v1:sha256:" + "4" * 64
IDENTITY = {"model": "test/pinned", "dimensions": 2, "fingerprintId": FINGERPRINT}
POSIX_PEER = sys.platform in {"darwin", "linux"}
IPC_SUPPORTED = POSIX_PEER or sys.platform == "win32"
SOURCE = Path(__file__).resolve().parents[2]


@pytest.fixture
def state_root():
    # Default Darwin process temp directories may exceed sockaddr_un.sun_path.
    parent = "/tmp" if POSIX_PEER else None
    with tempfile.TemporaryDirectory(prefix="p1ip-", dir=parent) as directory:
        yield Path(directory).resolve()


def config(root, **overrides):
    return {"provider": "engine-ipc", "stateRoot": str(root), **IDENTITY, **overrides}


@pytest.mark.parametrize("change", (
    {"stateRoot": "relative"},
    {"model": ""},
    {"dimensions": True},
    {"dimensions": 0},
    {"fingerprintId": "unverified"},
    {"fallback": {"provider": "local-transformers"}},
    {"fallbackProvider": "local-transformers"},
    {"address": "127.0.0.1:3000"},
    {"apiKey": "test-secret"},
    {"timeoutSeconds": float("inf")},
))
def test_invalid_ipc_configuration_is_rejected(state_root, change):
    with pytest.raises(ValidationError):
        validate_ipc_config(config(state_root, **change))


@contextmanager
def serve(state_root, callback=None):
    calls = []

    def embed(texts, *, purpose):
        calls.append((texts, purpose))
        if callback is not None:
            return callback(texts, purpose)
        return [[float(len(text)), 1.0 if purpose == "query" else -1.0] for text in texts]

    with EngineIpcServer(state_root, identity=IDENTITY, embed_many=embed):
        yield calls


@pytest.mark.skipif(not IPC_SUPPORTED, reason="Native IPC peer credentials required")
def test_engine_ipc_query_passage_split_and_restart(state_root):
    provider = EngineIpcEmbedding(config(state_root))
    with serve(state_root) as calls:
        assert provider.embed("first", purpose="query") == [5, 1]
        assert provider.embed("second") == [6, -1]
        assert provider.embed_many(["a", "bb"]) == [[1, -1], [2, -1]]
        assert provider.embed_many(["a", "bb"], purpose="query") == [[1, 1], [2, 1]]
        assert calls == [(["first"], "query"), (["second"], "passage"),
                         (["a", "bb"], "passage"), (["a"], "query"), (["bb"], "query")]
    with pytest.raises(EngineIpcError, match="unavailable"):
        provider.embed("absent")
    with serve(state_root):
        assert provider.embed("new") == [3, -1]
    provider.close()
    with pytest.raises(EngineIpcError, match="closed"):
        provider.embed("closed")


@pytest.mark.skipif(not POSIX_PEER, reason="Unix peer credentials required")
def test_rejects_wrong_scope_and_identity_before_embedding(state_root):
    second_root = state_root / "second"
    second_root.mkdir(mode=0o700)
    a = EngineIpcEmbedding(config(state_root))
    peer_path = second_root / "control/embedding-ipc/owner.sock"
    with serve(state_root) as first, serve(second_root) as second:
        with patch("plur1bus_hermes.embedding_ipc._filesystem_socket_path", return_value=peer_path):
            with pytest.raises(EngineIpcError, match="authentication"):
                a.embed("foreign socket")
        for override in ({"model": "other"}, {"dimensions": 3},
                         {"fingerprintId": "embedding:v1:sha256:" + "5" * 64}):
            with pytest.raises(EngineIpcError, match="identity"):
                EngineIpcEmbedding(config(state_root, **override)).embed("wrong identity")
        assert first == []
        assert second == []


@pytest.mark.skipif(not POSIX_PEER, reason="Unix peer credentials required")
def test_rejects_unsafe_paths_and_peer_without_request(state_root):
    provider = EngineIpcEmbedding(config(state_root))
    with serve(state_root) as calls:
        directory = state_root / "control/embedding-ipc"
        token = directory / "owner.token"
        token.chmod(0o644)
        with pytest.raises(EngineIpcError, match="trusted"):
            provider.embed("private")
        token.chmod(0o600)
        directory.chmod(0o755)
        with pytest.raises(EngineIpcError, match="trusted"):
            provider.embed("private")
        directory.chmod(0o700)
        with patch("plur1bus_hermes.embedding_ipc._peer_uid", return_value=os.geteuid() + 1):
            with pytest.raises(EngineIpcError, match="trusted"):
                provider.embed("do not send this")
        assert calls == []
    # A pre-existing filesystem entry must neither be followed nor removed.
    socket_path = directory / "owner.sock"
    sentinel = state_root / "sentinel"
    sentinel.write_text("untouched")
    socket_path.symlink_to(sentinel)
    with pytest.raises(EngineIpcError):
        with serve(state_root):
            pytest.fail("accepted unsafe path")
    assert socket_path.is_symlink() and sentinel.read_text() == "untouched"


@pytest.mark.skipif(not IPC_SUPPORTED, reason="Native IPC peer credentials required")
def test_second_live_owner_cannot_replace_token_or_unlink_socket(state_root):
    provider = EngineIpcEmbedding(config(state_root))
    with serve(state_root):
        before = (state_root / "control/embedding-ipc/owner.token").read_bytes()
        with pytest.raises(EngineIpcError):
            with serve(state_root):
                pytest.fail("duplicate owner bound")
        assert (state_root / "control/embedding-ipc/owner.token").read_bytes() == before
        assert provider.embed("one") == [3, -1]


@pytest.mark.skipif(not IPC_SUPPORTED, reason="Native IPC peer credentials required")
def test_total_timeout_and_content_free_errors(state_root):
    malicious = "test-only response body should not be logged"

    def raises(*args):
        raise RuntimeError(malicious)

    provider = EngineIpcEmbedding(config(state_root, timeoutSeconds=0.15))
    with serve(state_root, raises):
        with pytest.raises(EngineIpcError) as failure:
            provider.embed("example")
        assert malicious not in str(failure.value)

    started = threading.Event()
    release = threading.Event()

    def blocked(*args):
        started.set()
        assert release.wait(3)
        return [[1, 2]]

    with serve(state_root, blocked):
        try:
            with pytest.raises(EngineIpcError, match="timeout"):
                provider.embed("wait for deadline")
            assert started.is_set()
        finally:
            release.set()


@pytest.mark.skipif(not IPC_SUPPORTED, reason="Native IPC peer credentials required")
def test_memory_only_v1_frames_and_node_interop(state_root):
    node = shutil.which("node")
    if not node or not (SOURCE / "lib/providers/scoped-embedding-ipc.js").is_file():
        pytest.skip("Node and the repository IPC implementation are required")
    child_code = r"""
import { createScopedEmbeddingIpcServer, resolveScopedEmbeddingIpcPaths } from './lib/providers/scoped-embedding-ipc.js';
import { ipcAddress } from './lib/platform.js';
const [stateRoot, fingerprintId] = process.argv.slice(1);
const verify = (text, opts, direction) => {
  if (opts?.persist !== false) throw new Error('persistence was not disabled');
  return [text.length, direction];
};
const server = createScopedEmbeddingIpcServer({stateRoot, fingerprintId, embeddings: {
  model: 'test/pinned', dimensions: () => 2,
  embedQuery: (text, opts) => verify(text, opts, 1),
  embedPassage: (text, opts) => verify(text, opts, -1),
  embedBatch: (texts, size, opts) => texts.map(text => verify(text, opts, -1)),
}, address: ipcAddress(resolveScopedEmbeddingIpcPaths(stateRoot).directory), claim: false});
await server.start();
process.stdout.write('ready\n');
process.stdin.resume();
process.stdin.on('end', async () => { await server.shutdown(); });
"""
    child_args = [node, "--input-type=module", "-e", child_code, str(state_root), FINGERPRINT]
    with subprocess.Popen(child_args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, cwd=SOURCE, text=True) as child:
        try:
            replies = queue.Queue()
            reading = threading.Thread(target=lambda: replies.put(child.stdout.readline().strip()), daemon=True)
            reading.start()
            assert replies.get(timeout=10) == "ready"
            provider = EngineIpcEmbedding(config(state_root))
            assert provider.embed("open", purpose="query") == [4, 1]
            assert provider.embed_many(["passage", "batch"]) == [[7, -1], [5, -1]]
        finally:
            try:
                _, errors = child.communicate(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill()
                child.communicate()
                raise
            reading.join(timeout=2)
        assert child.returncode == 0, errors

    client_code = """
import { IpcScopedEmbeddingProvider, resolveScopedEmbeddingIpcPaths } from './lib/providers/scoped-embedding-ipc.js';
import { ipcAddress } from './lib/platform.js';
const [stateRoot, fingerprintId] = process.argv.slice(1);
const client = new IpcScopedEmbeddingProvider({
  stateRoot, model: 'test/pinned', dimensions: 2, fingerprintId,
  address: ipcAddress(resolveScopedEmbeddingIpcPaths(stateRoot).directory),
});
const vector = await client.embedQuery('back', { persist: false });
console.log(JSON.stringify(vector));
"""
    with serve(state_root) as calls:
        result = subprocess.run([node, "--input-type=module", "-e", client_code,
                                 str(state_root), FINGERPRINT], cwd=SOURCE, check=True,
                                capture_output=True, text=True, timeout=10)
        assert json.loads(result.stdout) == [4, 1]
        assert calls == [(["back"], "query")]


@pytest.mark.skipif(not IPC_SUPPORTED, reason="Native IPC peer credentials required")
def test_refuses_invalid_payload_shapes(state_root):
    with serve(state_root) as calls:
        provider = EngineIpcEmbedding(config(state_root))
        for data in ([3], [" "], ["a" * 60_001], ["😀" * 30_001]):
            with pytest.raises(EngineIpcError):
                provider.embed_many(data)
        assert calls == []


@pytest.mark.skipif(sys.platform != "win32", reason="Native Windows named-pipe ACL test")
def test_windows_peer_and_token_checks_fail_before_embedding(state_root):
    from plur1bus_hermes.embedding_ipc_windows import _WindowsScope

    provider = EngineIpcEmbedding(config(state_root))
    with serve(state_root) as calls:
        with patch.object(_WindowsScope, "_process_sid", return_value="S-1-5-7"):
            with pytest.raises(EngineIpcError, match="trusted"):
                provider.embed("peer never receives this")
        token = state_root / "control/embedding-ipc/owner.token"
        subprocess.run(["icacls", str(token), "/grant", "*S-1-5-32-545:(R)"],
                       capture_output=True, check=True, timeout=15)
        try:
            with pytest.raises(EngineIpcError, match="trusted"):
                provider.embed("unsafe token cannot authorize this")
        finally:
            subprocess.run(["icacls", str(token), "/remove:g", "*S-1-5-32-545"],
                           capture_output=True, check=True, timeout=15)
        assert calls == []
        assert provider.embed("recovered") == [9, -1]
