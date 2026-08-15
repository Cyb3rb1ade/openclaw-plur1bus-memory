"""Physically isolated workspace and user shared-memory pools."""

from __future__ import annotations

import hashlib
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any


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
        path = self._path(user_scope)
        path.mkdir(parents=True, exist_ok=True)
        database = lancedb.connect(str(path))
        try:
            table = database.open_table("memories")
        except Exception:
            database.create_table("memories", data=[shared])
        else:
            table.delete(f"id = '{shared_id}'")
            table.add([shared])
        return {
            "id": shared_id,
            "originId": original_id,
            "scope": pool_kind,
            "path": str(path),
            "copied": True,
        }

    def recall_rows(self, vector: list[float], limit: int) -> list[dict[str, Any]]:
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
            found = table.search(vector).where(
                f"sharedScope = '{'user' if name == 'user-shared' else 'workspace'}' "
                f"AND principalHash = '{principal_hash}' AND status = 'active'"
            ).limit(limit).to_list()
            for row in found:
                row["_namespace"] = name
            rows.extend(found)
        return rows[:limit]
