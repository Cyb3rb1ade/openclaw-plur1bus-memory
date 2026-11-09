"""Physically isolated workspace and user shared-memory pools."""

from __future__ import annotations

import hashlib
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .epistemic import epistemic_recall_where_clause, is_missing_epistemic_status_column_error
from .valid_time import is_missing_validity_column_error, validity_where_clause


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:62]


def _schema_names(table: Any) -> set[str]:
    """Read a table schema without modifying a read-only shared namespace."""
    schema_attr = getattr(table, "schema", None)
    schema = schema_attr() if callable(schema_attr) else schema_attr
    return set(getattr(schema, "names", ()) or ()) | {
        str(getattr(field, "name", "")) for field in getattr(schema, "fields", ()) or ()
    }


def _is_missing_expiry_column_error(error: BaseException) -> bool:
    text = str(error).casefold()
    return "expiresat" in text and any(marker in text for marker in (
        "not found", "does not exist", "no such column", "unknown column", "missing column",
    ))


def _search_recall_rows(
    table: Any,
    vector: list[float],
    where_clause: str,
    expiry_where_clause: str,
    legacy_where_clause: str,
    limit: int,
    valid_at: int | None,
    epistemic_fallback: tuple[str, str, str] | None = None,
    retried_columns: frozenset[str] = frozenset(),
) -> list[dict[str, Any]]:
    """Search a shared table with bounded, clause-preserving legacy retries."""
    try:
        return table.search(vector).where(where_clause).limit(limit).to_list()
    except Exception as error:
        if ("epistemic" not in retried_columns and epistemic_fallback is not None
                and is_missing_epistemic_status_column_error(error)):
            fallback_where, fallback_expiry, fallback_legacy = epistemic_fallback
            return _search_recall_rows(
                table, vector, fallback_where, fallback_expiry, fallback_legacy, limit, valid_at,
                None, retried_columns | {"epistemic"},
            )
        if "validity" not in retried_columns and is_missing_validity_column_error(error):
            fallback = None
            if epistemic_fallback is not None:
                _fallback_where, fallback_expiry, fallback_legacy = epistemic_fallback
                fallback = (fallback_expiry, fallback_expiry, fallback_legacy)
            return _search_recall_rows(
                table, vector, expiry_where_clause, expiry_where_clause, legacy_where_clause, limit, None,
                fallback, retried_columns | {"validity"},
            )
        if "expiry" not in retried_columns and _is_missing_expiry_column_error(error):
            if valid_at is None:
                fallback = None
                if epistemic_fallback is not None:
                    _fallback_where, _fallback_expiry, fallback_legacy = epistemic_fallback
                    fallback = (fallback_legacy, fallback_legacy, fallback_legacy)
                return _search_recall_rows(
                    table, vector, legacy_where_clause, legacy_where_clause, legacy_where_clause, limit, None,
                    fallback, retried_columns | {"expiry"},
                )
            validity_where = f"{legacy_where_clause} AND {validity_where_clause(valid_at)}"
            fallback = None
            if epistemic_fallback is not None:
                _fallback_where, _fallback_expiry, fallback_legacy = epistemic_fallback
                fallback = (
                    f"{fallback_legacy} AND {validity_where_clause(valid_at)}",
                    fallback_legacy,
                    fallback_legacy,
                )
            return _search_recall_rows(
                table, vector, validity_where, legacy_where_clause, legacy_where_clause, limit, valid_at,
                fallback, retried_columns | {"expiry"},
            )
        raise


@dataclass(frozen=True)
class SharedPrincipal:
    workspace: str
    platform: str = ""
    account: str = ""
    user: str = ""

    @property
    def workspace_key(self) -> str:
        return _digest(self.workspace)

    @property
    def user_key(self) -> str | None:
        if not self.platform or not self.user:
            return None
        return _digest(
            "|".join((self.workspace, self.platform, self.account, self.user))
        )


class SharedPoolStore:
    """Copy and recall vectors from ACL-by-physical-route shared pools."""

    def __init__(self, data_dir: Path, principal: SharedPrincipal) -> None:
        self.root = Path(data_dir) / ".plur1bus-shared"
        self.principal = principal

    def _path(self, user_scope: bool) -> Path:
        if user_scope:
            user_key = self.principal.user_key
            if user_key is None:
                raise ValueError("user sharing requires platform and user identity")
            return self.root / "users" / f"u-{user_key}"
        return self.root / "workspaces" / f"w-{self.principal.workspace_key}"

    def copy(
        self,
        record: dict[str, Any],
        *,
        source_agent: str,
        user_scope: bool = False,
    ) -> dict[str, Any]:
        """Copy one card idempotently while preserving its private origin."""
        try:
            import lancedb
        except ImportError as error:
            raise RuntimeError("PLUR1BUS requires lancedb") from error
        original_id = str(record.get("id") or "")
        pool_kind = "user" if user_scope else "workspace"
        shared_id = str(
            uuid.uuid5(
                uuid.NAMESPACE_URL,
                f"plur1bus:{pool_kind}:{self._path(user_scope)}:{original_id}",
            )
        )
        shared = {
            key: value
            for key, value in record.items()
            if not str(key).startswith("_")
        }
        shared.update({
            "id": shared_id,
            "originId": original_id,
            "originAgent": source_agent,
            "sharedScope": pool_kind,
            "principalHash": (
                self.principal.user_key
                if user_scope
                else self.principal.workspace_key
            ),
        })
        for field in ("validFrom", "validUntil", "expiresAt"):
            shared.setdefault(field, 0)
        path = self._path(user_scope)
        path.mkdir(parents=True, exist_ok=True)
        database = lancedb.connect(str(path))
        listed = database.list_tables()
        table_names = getattr(listed, "tables", listed)
        names = {str(getattr(item, "name", item)) for item in table_names}
        if "memories" not in names:
            database.create_table("memories", data=[shared])
        else:
            # Do not turn a corrupt/unreadable existing table into an
            # accidental replacement database.
            table = database.open_table("memories")
            self._ensure_temporal_columns(table)
            # Idempotent copy of a card that is active in the guard-protected
            # agent table (share_memory filters status='active'); a forgotten
            # card cannot enter this guarded upsert, so no tombstone check is
            # applicable here (7.4.0 contract review).
            table.merge_insert("id").when_matched_update_all().when_not_matched_insert_all().execute([shared])
        return {
            "id": shared_id,
            "originId": original_id,
            "scope": pool_kind,
            "path": str(path),
            "copied": True,
        }

    @staticmethod
    def _ensure_temporal_columns(table: Any) -> None:
        schema = table.schema
        schema = schema() if callable(schema) else schema
        names = set(getattr(schema, "names", ()) or ())
        for field in ("validFrom", "validUntil", "expiresAt"):
            if field not in names:
                table.add_columns({field: "0"})
                names.add(field)

    def recall_rows(self, vector: list[float], limit: int, *, valid_at: int | None = None,
                    now_ms: int | None = None) -> list[dict[str, Any]]:
        """Read bounded additive rows only from this validated principal's pools."""
        try:
            import lancedb
        except ImportError as error:
            raise RuntimeError("PLUR1BUS requires lancedb") from error
        rows = []
        routes = [("workspace-shared", self._path(False))]
        if self.principal.user_key is not None:
            routes.append(("user-shared", self._path(True)))
        for name, path in routes:
            if not path.is_dir():
                continue
            database = lancedb.connect(str(path))
            try:
                table = database.open_table("memories")
            except Exception:
                continue
            principal_hash = (
                self.principal.user_key
                if name == "user-shared"
                else self.principal.workspace_key
            )
            base_where = (
                f"sharedScope = '{'user' if name == 'user-shared' else 'workspace'}' "
                f"AND principalHash = '{principal_hash}' AND status = 'active'"
            )
            include_epistemic = "epistemicStatus" in _schema_names(table)
            scoped_where = base_where
            if include_epistemic:
                scoped_where += f" AND {epistemic_recall_where_clause()}"
            expiry_where = scoped_where
            if now_ms is not None:
                expiry_where += f" AND (expiresAt IS NULL OR expiresAt = 0 OR expiresAt > {now_ms})"
            where = expiry_where
            if valid_at is not None:
                where += f" AND {validity_where_clause(valid_at)}"
            fallback_expiry = base_where
            if now_ms is not None:
                fallback_expiry += f" AND (expiresAt IS NULL OR expiresAt = 0 OR expiresAt > {now_ms})"
            fallback_where = fallback_expiry
            if valid_at is not None:
                fallback_where += f" AND {validity_where_clause(valid_at)}"
            fallback = (fallback_where, fallback_expiry, base_where) if include_epistemic else None
            found = _search_recall_rows(
                table, vector, where, expiry_where, scoped_where, limit, valid_at, fallback,
            )
            for row in found:
                row["_namespace"] = name
            rows.extend(found)
        return rows[:limit]
