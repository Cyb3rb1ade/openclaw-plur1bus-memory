"""Private, checksum-verified offline snapshot/export and recoverable restore.

Restore targets are supplied explicitly, never taken on authority from a bundle.
Roots keep their original locations so generation manifests and ACL bindings do
not require unsafe rewriting. Every replaced root is retained beside the target.
"""
from __future__ import annotations

import argparse
from contextlib import ExitStack, contextmanager
import hashlib
import json
import os
from pathlib import Path
import stat
import uuid
from datetime import datetime, timezone

from .file_lock import open_existing, open_lock, flock, LOCK_EX, LOCK_NB
from .file_io import replace_file
from .generation import _atomic_json
from .restore_guard import restore_guard_path, assert_restore_idle
from .runtime_lease import exclusive_generation_lease
from .validation import resolve_inside, ValidationError
from .writer_lock import writer_lock


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _path(value: Path) -> Path:
    raw = Path(value).expanduser().absolute()
    for item in (raw, *raw.parents):
        if item.is_symlink() and item != Path("/var"):
            raise ValidationError("snapshot roots must not contain symlinks")
        if item.exists() and getattr(item.lstat(), "st_file_attributes", 0) & 0x400:
            raise ValidationError("snapshot roots must not contain reparse points")
    root = raw.resolve()
    if root in {Path(root.anchor), Path.home().resolve(), (Path.home() / ".hermes").resolve()}:
        raise ValidationError("choose a specific data/config/artifact root, not a filesystem or home root")
    return root


def _roots(data_dirs, includes):
    data = sorted({_path(path) for path in data_dirs})
    extra = sorted({_path(path) for path in includes})
    if not data or len(data) + len(extra) > 64:
        raise ValidationError("specify 1-64 explicit roots including a data directory")
    values = [{"path": str(path), "data": True} for path in data] + [{"path": str(path), "data": False} for path in extra]
    for index, item in enumerate(values):
        path = Path(item["path"])
        for other in values[:index]:
            prior = Path(other["path"])
            if path == prior or path.is_relative_to(prior) or prior.is_relative_to(path):
                raise ValidationError("snapshot roots overlap; include each tree only once")
    return values


def _ephemeral(relative):
    # Coordination is process-owned, never replay PID/lock ownership from backup.
    return (relative in {"state/runtime-generation.lock", "state/memory-writer.lock"}
            or relative.startswith("state/") and Path(relative).name in {"maintenance.lock", ".capture-retry.lock"}
            or relative.startswith("_tombstones/") and relative.endswith(".lock")
            or relative.startswith(("lancedb/.", "lancedb-namespaces/")) and ".reembed-staged-" in relative and relative.endswith(".lock"))


def _file_hash(path):
    fd = open_existing(path)
    with os.fdopen(fd, "rb") as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode):
            raise ValidationError("snapshot contains a non-regular file")
        digest = hashlib.sha256()
        size = 0
        while chunk := stream.read(min(1024 * 1024, max(1, before.st_size + 1 - size))):
            size += len(chunk)
            digest.update(chunk)
            if size > before.st_size:
                raise ValidationError("source grew while snapshot was being read")
        after = os.fstat(stream.fileno())
        if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns) or size != before.st_size:
            raise ValidationError("source changed while snapshot was being read")
        return {"bytes": size, "sha256": digest.hexdigest(), "executable": os.name != "nt" and bool(before.st_mode & 0o111)}


def _inventory(root: Path, *, missing=False):
    if not root.exists():
        if missing:
            return None
        raise ValidationError(f"snapshot source is absent: {root}")
    if root.is_symlink():
        raise ValidationError("snapshot root changed to a symlink")
    if root.is_file():
        return {"kind": "file", "files": {"": _file_hash(root)}, "directories": []}
    if not root.is_dir():
        raise ValidationError("snapshot root is not a file or directory")
    files, directories = {}, []
    for current, children, names in os.walk(root, followlinks=False):
        for name in sorted(children + names):
            path = Path(current) / name
            metadata = path.lstat()
            if stat.S_ISLNK(metadata.st_mode) or getattr(metadata, "st_file_attributes", 0) & 0x400:
                raise ValidationError("snapshot trees must not contain links/reparse points")
            relative = path.relative_to(root).as_posix()
            safe = resolve_inside(str(root), relative)
            if stat.S_ISDIR(metadata.st_mode):
                directories.append(relative)
            elif stat.S_ISREG(metadata.st_mode):
                if not _ephemeral(relative):
                    files[relative] = _file_hash(safe)
            else:
                raise ValidationError("snapshot trees must contain only regular files and directories")
    return {"kind": "directory", "files": files, "directories": sorted(directories)}


def _outside(snapshot, roots):
    for item in roots:
        root = Path(item["path"])
        if snapshot == root or snapshot.is_relative_to(root) or root.is_relative_to(snapshot):
            raise ValidationError("snapshot directory must be outside every target root")


def _root_inventory(item, *, missing=False):
    inventory = _inventory(Path(item["path"]), missing=missing)
    if item["data"] and inventory is not None and inventory["kind"] == "directory":
        # Runtime coordination creates this otherwise empty directory when
        # taking the first lease; account for it without making preview writes.
        inventory["directories"] = sorted(set(inventory["directories"]) | {"state"})
    return inventory


def plan_export(data_dirs, includes, destination: Path):
    """Read a concrete export plan without creating files or acquiring leases."""
    roots, destination = _roots(data_dirs, includes), _path(destination)
    _outside(destination, roots)
    if destination.exists():
        raise ValidationError("snapshot destination must not exist")
    entries = []
    for item in roots:
        root = Path(item["path"])
        if item["data"]:
            assert_restore_idle(root)
        inventory = _root_inventory(item)
        if item["data"] and inventory["kind"] != "directory":
            raise ValidationError("data root must be a directory")
        entries.append({**item, "inventory": inventory})
    plan = {"version": 1, "operation": "export", "destination": str(destination), "roots": entries,
            "warning": "Private plaintext snapshot: memories/configs may contain credentials. Keep it private."}
    return {**plan, "confirmation": _digest(plan)}


@contextmanager
def _offline(roots, *, restoring=False):
    with ExitStack() as stack:
        for item in sorted((item for item in roots if item["data"]), key=lambda x: x["path"]):
            root = Path(item["path"])
            if restoring and restore_guard_path(root).exists():
                continue  # This transaction already guards the root externally.
            stack.enter_context(exclusive_generation_lease(root, restoring=restoring))
            stack.enter_context(writer_lock(root, restoring=restoring))
        yield stack


def _copy_tree(source, destination, inventory):
    if destination.exists() or destination.is_symlink():
        raise ValidationError("staging destination already exists")
    if inventory["kind"] == "directory":
        destination.mkdir(mode=0o700)
        for relative in inventory["directories"]:
            resolve_inside(str(destination), relative).mkdir(parents=True, exist_ok=True, mode=0o700)
    for relative, expected in inventory["files"].items():
        src = resolve_inside(str(source), relative) if relative else source
        dest = resolve_inside(str(destination), relative) if relative else destination
        dest.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd = open_existing(src)
        with os.fdopen(fd, "rb") as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                raise ValidationError("snapshot source is not a regular file")
            out = os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(out, "wb") as output:
                copied = 0
                while chunk := stream.read(min(1024 * 1024, max(1, expected["bytes"] + 1 - copied))):
                    copied += len(chunk)
                    if copied > expected["bytes"]:
                        raise ValidationError("source grew while copying snapshot")
                    output.write(chunk)
                output.flush()
                os.fsync(output.fileno())
        os.chmod(dest, 0o700 if expected.get("executable") else 0o600)
        if _file_hash(dest) != expected:
            raise ValidationError("source changed while copying snapshot")
    if _inventory(destination) != inventory:
        raise ValidationError("snapshot copy did not preserve every file/directory")
    if inventory["kind"] == "directory":
        for relative in sorted(inventory["directories"], key=lambda value: len(Path(value).parts), reverse=True):
            _sync_directory(resolve_inside(str(destination), relative))
        _sync_directory(destination)
    _sync_directory(destination.parent)


def _sync_directory(directory):
    if os.name != "nt":
        fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def _move_root(source, destination):
    if destination.exists() or destination.is_symlink():
        raise ValidationError("restore destination unexpectedly exists")
    replace_file(source, destination)
    _sync_directory(destination.parent)


def export_snapshot(data_dirs, includes, destination: Path, *, confirmation: str, stopped: bool):
    """Export offline with complete manifest last; interrupted copies are not valid."""
    plan = plan_export(data_dirs, includes, destination)
    if not stopped or confirmation != plan["confirmation"]:
        raise ValidationError("stop all writers and approve the exact export plan")
    with _offline(plan["roots"]):
        if plan_export(data_dirs, includes, destination) != plan:
            raise ValidationError("source changed before snapshot lease")
        directory = Path(plan["destination"])
        directory.mkdir(mode=0o700)
        for index, item in enumerate(plan["roots"]):
            _copy_tree(Path(item["path"]), directory / str(index), item["inventory"])
        manifest = {"version": 1, "roots": plan["roots"], "complete": True}
        _atomic_json(directory / "snapshot.json", {**manifest, "digest": _digest(manifest)})
    return {"complete": True, "snapshot": str(directory), "digest": _digest(manifest)}


def verify_snapshot(snapshot: Path):
    """Verify the complete private bundle and reject extra payload files."""
    snapshot = _path(snapshot)
    metadata = snapshot / "snapshot.json"
    if metadata.is_symlink() or not metadata.is_file() or metadata.stat().st_size > 32 * 1024 * 1024:
        raise ValidationError("snapshot manifest is absent or unsafe")
    value = json.loads(metadata.read_text())
    if not isinstance(value, dict) or value.get("version") != 1 or value.get("complete") is not True:
        raise ValidationError("snapshot is incomplete or unsupported")
    if value.get("digest") != _digest({k: v for k, v in value.items() if k != "digest"}):
        raise ValidationError("snapshot manifest checksum mismatch")
    roots = value.get("roots")
    if not isinstance(roots, list) or not 1 <= len(roots) <= 64:
        raise ValidationError("invalid snapshot root list")
    if {path.name for path in snapshot.iterdir()} != {"snapshot.json", *(str(i) for i in range(len(roots)))}:
        raise ValidationError("snapshot contains unexpected entries")
    for index, item in enumerate(roots):
        if _inventory(snapshot / str(index)) != item.get("inventory"):
            raise ValidationError("snapshot payload checksum mismatch")
    return value


def plan_restore(snapshot: Path, data_dirs, includes):
    """Bind restored roots to explicit caller targets and a verified snapshot."""
    snapshot = _path(snapshot)
    manifest = verify_snapshot(snapshot)
    roots = _roots(data_dirs, includes)
    _outside(snapshot, roots)
    if roots != [{"path": item["path"], "data": item["data"]} for item in manifest["roots"]]:
        raise ValidationError("explicit restore roots must match the original snapshot locations exactly")
    current = [_root_inventory(item, missing=True) for item in roots]
    plan = {"version": 1, "operation": "restore", "snapshot": str(snapshot), "digest": manifest["digest"],
            "roots": roots, "before": current,
            "warning": "Full point-in-time rollback, including memories forgotten since this snapshot and old configuration. Current roots are retained separately."}
    return {**plan, "confirmation": _digest(plan)}


def _journal_path(plan):
    root = Path(next(item["path"] for item in plan["roots"] if item["data"]))
    return root.parent / f".plur1bus-restore-transaction-{plan['confirmation']}.json"


def append_destructive_op_log(journal_path, event, confirmation, **details):
    """Append a private, durable restore audit outside every replaced root."""
    path = _path(journal_path.with_suffix(".audit.jsonl"))
    fd = open_lock(path)
    with os.fdopen(fd, "a", encoding="utf-8") as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ValidationError("unsafe restore audit file")
        stream.write(json.dumps({"event": event, "confirmation": confirmation,
            "at": datetime.now(timezone.utc).isoformat(), **details}, sort_keys=True) + "\n")
        stream.flush()
        os.fsync(stream.fileno())


def restore_snapshot(snapshot: Path, data_dirs, includes, *, confirmation: str, stopped: bool, resume=False):
    """Restore original paths with retained previous roots and crash-safe guards."""
    roots = _roots(data_dirs, includes)
    if not stopped or len(confirmation) != 64 or any(c not in "0123456789abcdef" for c in confirmation):
        raise ValidationError("stop all writers and approve the exact restore plan")
    if resume:
        journal_path = _journal_path({"roots": roots, "confirmation": confirmation})
        if journal_path.is_symlink() or not journal_path.is_file() or journal_path.stat().st_size > 32 * 1024 * 1024:
            raise ValidationError("restore journal is absent or unsafe")
        journal = json.loads(journal_path.read_text())
        plan = journal["plan"]
        if (plan.get("confirmation") != confirmation or plan.get("roots") != roots
                or plan.get("snapshot") != str(_path(snapshot))
                or _digest({k: v for k, v in plan.items() if k != "confirmation"}) != confirmation):
            raise ValidationError("restore approval or targets differ from interrupted transaction")
    else:
        for item in roots:
            if item["data"]:
                assert_restore_idle(Path(item["path"]))
        plan = plan_restore(snapshot, data_dirs, includes)
        if confirmation != plan["confirmation"]:
            raise ValidationError("restore plan is stale or unapproved")
        journal_path = _journal_path(plan)
        if journal_path.exists():
            raise ValidationError("restore transaction already exists; review it before retrying")
        journal = {"plan": plan, "transaction": uuid.uuid4().hex, "state": "preparing"}
    # The external lock is not part of any replaced tree and serializes resumes.
    descriptor = open_lock(journal_path.with_suffix(".lock"))
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise ValidationError("unsafe restore transaction lock")
        flock(descriptor, LOCK_EX | LOCK_NB)
        for item in roots:
            if item["data"]:
                marker = restore_guard_path(Path(item["path"]))
                if marker.is_symlink() or (marker.exists() and (
                    not marker.is_file() or marker.stat().st_size > 4096
                    or json.loads(marker.read_text()).get("confirmation") != confirmation
                )):
                    raise ValidationError("another or unsafe restore owns this root")
        with _offline(roots, restoring=resume) as leases:
            manifest = verify_snapshot(snapshot)
            if manifest["digest"] != plan["digest"]:
                raise ValidationError("snapshot changed after restore approval")
            if not resume:
                # Lease creation can add only empty coordination state directories.
                for index, item in enumerate(roots):
                    current = _root_inventory(item, missing=True)
                    if plan["before"][index] is not None and current != plan["before"][index]:
                        raise ValidationError("target changed before restore lease")
                _atomic_json(journal_path, journal)
            token = journal["transaction"]
            if not isinstance(token, str) or len(token) != 32 or any(c not in "0123456789abcdef" for c in token):
                raise ValidationError("invalid restore transaction identity")
            for item in roots:
                if item["data"]:
                    marker = restore_guard_path(Path(item["path"]))
                    if marker.exists() and json.loads(marker.read_text()).get("confirmation") != confirmation:
                        raise ValidationError("another restore owns this root")
                    _atomic_json(marker, {"confirmation": confirmation, "journal": str(journal_path)})
            # The outside guards now block starts/writes through new roots.
            # Release child handles before directory renames (required on Windows).
            leases.close()
            append_destructive_op_log(journal_path, "snapshot.restore.resume" if resume else "snapshot.restore.begin", confirmation)
            backups = []
            for index, item in enumerate(roots):
                root = Path(item["path"])
                new = root.with_name(f".{root.name}.plur1bus-{token}-new")
                old = root.with_name(f".{root.name}.plur1bus-{token}-old")
                expected = manifest["roots"][index]["inventory"]
                for path in (root, new, old):
                    _path(path)
                if plan["before"][index] is None and root.exists() and _inventory(root) == expected:
                    backups.append("")
                    continue
                if old.exists():
                    # Never interpret a manual edit after interruption as our output.
                    if plan["before"][index] is not None and _inventory(old) != plan["before"][index]:
                        raise ValidationError("retained pre-restore backup changed")
                    if root.exists() and _inventory(root) == expected:
                        backups.append(str(old))
                        continue
                    if root.exists():
                        raise ValidationError("restore target changed while transaction was interrupted")
                if not new.exists():
                    _copy_tree(_path(snapshot) / str(index), new, expected)
                elif _inventory(new) != expected:
                    if not resume:
                        raise ValidationError("restore staging is incomplete or changed")
                    _move_root(new, new.with_name(new.name + "-incomplete-" + uuid.uuid4().hex))
                    _copy_tree(_path(snapshot) / str(index), new, expected)
                if not old.exists() and root.exists():
                    if plan["before"][index] is not None and _inventory(root) != plan["before"][index]:
                        raise ValidationError("target changed since restore approval")
                    _move_root(root, old)
                _move_root(new, root)
                if _inventory(root) != expected:
                    raise ValidationError("restored root failed final verification")
                backups.append(str(old) if old.exists() else "")
                append_destructive_op_log(journal_path, "snapshot.restore.root_verified", confirmation, root=str(root))
            journal.update(state="complete", retainedBackups=backups)
            _atomic_json(journal_path, journal)
            append_destructive_op_log(journal_path, "snapshot.restore.complete", confirmation, retainedBackups=backups)
            for item in roots:
                if item["data"]:
                    marker = restore_guard_path(Path(item["path"]))
                    marker.unlink()
                    _sync_directory(marker.parent)
            return {"complete": True, "retainedBackups": backups, "journal": str(journal_path)}
    finally:
        os.close(descriptor)


def main(argv=None):
    """Plan by default; apply requires exact approval and explicit offline acknowledgement."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("export", "verify", "restore"))
    parser.add_argument("--snapshot", required=True, type=Path)
    parser.add_argument("--data-dir", type=Path, action="append", default=[])
    parser.add_argument("--include", type=Path, action="append", default=[])
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--confirm", default="")
    parser.add_argument("--runtimes-stopped", action="store_true")
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args(argv)
    if args.action == "verify":
        if args.apply or args.resume:
            parser.error("verification is read-only")
        verified = verify_snapshot(args.snapshot)
        result = {"complete": True, "digest": verified["digest"], "roots": len(verified["roots"])}
    elif args.action == "export":
        if args.resume:
            parser.error("an interrupted export is not a complete snapshot; choose a new destination")
        result = export_snapshot(args.data_dir, args.include, args.snapshot, confirmation=args.confirm,
            stopped=args.runtimes_stopped) if args.apply else plan_export(args.data_dir, args.include, args.snapshot)
    else:
        if args.resume and not args.apply:
            parser.error("--resume requires --apply")
        result = restore_snapshot(args.snapshot, args.data_dir, args.include, confirmation=args.confirm,
            stopped=args.runtimes_stopped, resume=args.resume) if args.apply else plan_restore(args.snapshot, args.data_dir, args.include)
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
