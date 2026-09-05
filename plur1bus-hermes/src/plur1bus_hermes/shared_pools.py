"""Physically isolated workspace and user shared-memory pools."""

from __future__ import annotations

import hashlib
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .valid_time import is_missing_validity_column_error, validity_where_clause


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:62]


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
            expiry_where = base_where
            if now_ms is not None:
                expiry_where += f" AND (expiresAt IS NULL OR expiresAt = 0 OR expiresAt > {now_ms})"
            where = expiry_where
            if valid_at is not None:
                where += f" AND {validity_where_clause(valid_at)}"
            try:
                found = table.search(vector).where(where).limit(limit).to_list()
            except Exception as error:
                text = str(error).lower()
                expiry_missing = "expiresat" in text and any(token in text for token in (
                    "not found", "does not exist", "no such column", "unknown column", "missing column",
                ))
                if is_missing_validity_column_error(error):
                    try:
                        found = table.search(vector).where(expiry_where).limit(limit).to_list()
                    except Exception as retry_error:
                        retry_text = str(retry_error).lower()
                        if "expiresat" not in retry_text or not any(token in retry_text for token in (
                            "not found", "does not exist", "no such column", "unknown column", "missing column",
                        )):
                            raise
                        found = table.search(vector).where(base_where).limit(limit).to_list()
                elif expiry_missing:
                    try:
                        found = table.search(vector).where(
                            base_where if valid_at is None else f"{base_where} AND {validity_where_clause(valid_at)}"
                        ).limit(limit).to_list()
                    except Exception as retry_error:
                        if valid_at is None or not is_missing_validity_column_error(retry_error):
                            raise
                        found = table.search(vector).where(base_where).limit(limit).to_list()
                else:
                    raise
            for row in found:
                row["_namespace"] = name
            rows.extend(found)
        return rows[:limit]
