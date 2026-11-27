"""Physically isolated workspace and user shared-memory pools."""

from __future__ import annotations

import hashlib
import logging
import math
import re
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .embedding_text import RAW
from .epistemic import epistemic_recall_where_clause, is_missing_epistemic_status_column_error, is_recallable_epistemic
from .generation import _atomic_json, _read_json_existing, _reject_symlink_components
from .query_refinement import fallback_keywords, fallback_rank
from .sensitivity import SENSITIVITY_LEVELS, is_confidential
from .valid_time import is_entry_live, is_entry_valid_at, is_missing_validity_column_error, validity_where_clause
from .validation import safe_memory_id
from .writer_lock import serialized_memory_write


_FINGERPRINT = re.compile(r'^[0-9a-f]{64}$')
_FINGERPRINT_COLUMN = 'embeddingFingerprint'
_LEGACY_TABLE = 'memories'
_MAX_LEXICAL_TABLES = 16
_LOG = logging.getLogger(__name__)


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:62]


def _shareable(record: dict[str, Any]) -> bool:
    """Shared pool membership does not establish the card's original chat."""
    content = record.get("content")
    if not isinstance(content, str) or not content.strip():
        return False
    sensitivity = record.get("sensitivity")
    if sensitivity is not None and not isinstance(sensitivity, str):
        return False
    level = (sensitivity or "").strip().casefold()
    return (not level or level in SENSITIVITY_LEVELS) and not is_confidential(content, level)


def _schema_names(table: Any) -> set[str]:
    """Read a table schema without modifying a read-only shared namespace."""
    schema_attr = getattr(table, "schema", None)
    schema = schema_attr() if callable(schema_attr) else schema_attr
    return set(getattr(schema, "names", ()) or ()) | {
        str(getattr(field, "name", "")) for field in getattr(schema, "fields", ()) or ()
    }


def _known_fingerprint(value: object) -> str | None:
    return value if isinstance(value, str) and _FINGERPRINT.fullmatch(value) else None


def _vector_width(table: Any) -> int | None:
    import pyarrow as pa

    schema = table.schema
    schema = schema() if callable(schema) else schema
    if 'vector' not in schema.names:
        return None
    kind = schema.field('vector').type
    return kind.list_size if pa.types.is_fixed_size_list(kind) and pa.types.is_floating(kind.value_type) else None


def _valid_vector(vector: object) -> bool:
    return (isinstance(vector, list) and bool(vector)
            and all(type(value) in (int, float) and math.isfinite(value) for value in vector))


def _copy_data(shared: dict, fingerprint: str | None):
    if fingerprint is None:
        return [shared]
    import pyarrow as pa

    # LanceDB can infer a variable-width vector for very small dimensions.
    # Bind the certified schema explicitly for every insertion.
    vector = shared['vector']
    data = pa.Table.from_pylist([shared])
    return data.set_column(data.schema.get_field_index('vector'), 'vector',
                           pa.array([vector], type=pa.list_(pa.float32(), len(vector))))


def _is_missing_expiry_column_error(error: BaseException) -> bool:
    text = str(error).casefold()
    return "expiresat" in text and any(marker in text for marker in (
        "not found", "does not exist", "no such column", "unknown column", "missing column", "no field named",
    ))


def _search_recall_rows(
    table: Any,
    vector: list[float] | None,
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
        query = table.search(vector).where(where_clause)
        if vector is None:
            query = query.select(sorted(_schema_names(table) - {'vector', '_distance'}))
        return query.limit(limit).to_list()
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

    def __init__(self, data_dir: Path, principal: SharedPrincipal, *,
                 embedding_fingerprint: str | None = None, embedding_dimensions: int | None = None) -> None:
        self.data_dir = Path(data_dir)
        self.root = self.data_dir / ".plur1bus-shared"
        self.principal = principal
        self.embedding_fingerprint = _known_fingerprint(embedding_fingerprint)
        self.embedding_dimensions = embedding_dimensions

    def _path(self, user_scope: bool) -> Path:
        if user_scope:
            user_key = self.principal.user_key
            if user_key is None:
                raise ValueError("user sharing requires platform and user identity")
            return self.root / "users" / f"u-{user_key}"
        return self.root / "workspaces" / f"w-{self.principal.workspace_key}"

    @serialized_memory_write
    def copy(
        self,
        record: dict[str, Any],
        *,
        source_agent: str,
        user_scope: bool = False,
        embedding_fingerprint: str | None = None,
    ) -> dict[str, Any]:
        """Copy one card idempotently while preserving its private origin."""
        if not _shareable(record):
            raise ValueError("This memory cannot be shared.")
        if embedding_fingerprint is not None:
            if _known_fingerprint(embedding_fingerprint) is None or not _valid_vector(record.get('vector')):
                raise ValueError('shared copy embedding provenance is invalid')
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
            if not str(key).startswith("_") and key != _FINGERPRINT_COLUMN
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
        if "embeddingTextMode" in shared and shared["embeddingTextMode"] in (None, ""):
            shared["embeddingTextMode"] = RAW
        table_name = self._table_name(embedding_fingerprint)
        if embedding_fingerprint is not None:
            shared[_FINGERPRINT_COLUMN] = embedding_fingerprint
        path = self._path(user_scope)
        _reject_symlink_components(self.data_dir, path, message='unsafe shared pool path')
        path.mkdir(parents=True, exist_ok=True)
        database = lancedb.connect(str(path))
        listed = database.list_tables()
        table_names = getattr(listed, "tables", listed)
        names = {str(getattr(item, "name", item)) for item in table_names}
        if table_name not in names:
            database.create_table(table_name, data=_copy_data(shared, embedding_fingerprint))
        else:
            # Do not turn a corrupt/unreadable existing table into an
            # accidental replacement database.
            table = database.open_table(table_name)
            if embedding_fingerprint is not None and _vector_width(table) != len(shared['vector']):
                raise ValueError('shared copy does not match its certified vector width')
            self._align_copy_columns(table, shared)
            # Idempotent copy of a card that is active in the guard-protected
            # agent table (share_memory filters status='active'); a forgotten
            # card cannot enter this guarded upsert, so no tombstone check is
            # applicable here (7.4.0 contract review).
            table.merge_insert("id").when_matched_update_all().when_not_matched_insert_all().execute(
                _copy_data(shared, embedding_fingerprint))
        self._publish_route(path, shared_id, table_name)
        return {
            "id": shared_id,
            "originId": original_id,
            "scope": pool_kind,
            "path": str(path),
            "copied": True,
        }

    @staticmethod
    def _align_copy_columns(table: Any, shared: dict[str, Any]) -> None:
        names = _schema_names(table)
        for field in ("validFrom", "validUntil", "expiresAt"):
            if field not in names:
                table.add_columns({field: "0"})
        if "embeddingTextMode" in names:
            shared.setdefault("embeddingTextMode", RAW)
        elif "embeddingTextMode" in shared:
            table.add_columns({"embeddingTextMode": f"'{RAW}'"})

    @staticmethod
    def _table_name(fingerprint: str | None) -> str:
        return _LEGACY_TABLE if fingerprint is None else f'memories_{fingerprint}'

    def _receipt_path(self, path: Path, card_id: str) -> Path:
        target = path / 'share-routes' / f'{safe_memory_id(card_id)}.json'
        _reject_symlink_components(self.data_dir, target, message='unsafe shared route receipt path')
        return target

    def _publish_route(self, path: Path, card_id: str, table_name: str) -> None:
        _atomic_json(self._receipt_path(path, card_id), {'version': 1, 'id': card_id, 'table': table_name})

    def _is_current_copy(self, path: Path, row: dict, table_name: str) -> bool:
        try:
            card_id = safe_memory_id(row.get('id'))
        except ValueError:
            # Historical imports can carry opaque IDs; they are lexical only.
            return table_name == _LEGACY_TABLE
        try:
            receipt = _read_json_existing(self._receipt_path(path, card_id), label='shared copy receipt')
        except ValueError as error:
            _LOG.debug('shared copy receipt is unavailable (%s)', type(error).__name__)
            return False
        if receipt is None:
            return table_name == _LEGACY_TABLE
        return receipt == {'version': 1, 'id': card_id, 'table': table_name}

    def _compatible(self, table: Any) -> bool:
        return (self.embedding_fingerprint is not None and type(self.embedding_dimensions) is int
                and self.embedding_dimensions > 0 and _FINGERPRINT_COLUMN in _schema_names(table)
                and _vector_width(table) == self.embedding_dimensions)

    def _pools(self):
        yield 'workspace-shared', self._path(False), 'workspace', self.principal.workspace_key
        if self.principal.user_key is not None:
            yield 'user-shared', self._path(True), 'user', self.principal.user_key

    @staticmethod
    def _search(table, pool_kind, principal_hash, vector, limit, valid_at, now_ms, *, predicate=''):
        base_where = (f"sharedScope = '{pool_kind}' AND principalHash = '{principal_hash}' "
                      f"AND status = 'active'{predicate}")
        columns = _schema_names(table)
        include_epistemic = 'epistemicStatus' in columns
        scoped_where = base_where + (f' AND {epistemic_recall_where_clause()}' if include_epistemic else '')
        expires = (f' AND (expiresAt IS NULL OR expiresAt = 0 OR expiresAt > {now_ms})'
                   if 'expiresAt' in columns else '')
        validity = (f' AND {validity_where_clause(valid_at)}'
                    if valid_at is not None and {'validFrom', 'validUntil'} <= columns else '')
        fallback = (base_where + expires + validity, base_where + expires, base_where) if include_epistemic else None
        return _search_recall_rows(table, vector, scoped_where + expires + validity,
                                   scoped_where + expires, scoped_where, limit, valid_at, fallback)

    def _admitted(self, path, candidates, table_name, pool_kind, principal_hash, valid_at, now_ms):
        for row in candidates:
            if (row.get('sharedScope') == pool_kind and row.get('principalHash') == principal_hash
                    and row.get('status') == 'active' and is_recallable_epistemic(row)
                    and is_entry_live(row, now_ms) and is_entry_valid_at(row, valid_at)
                    and _shareable(row) and self._is_current_copy(path, row, table_name)):
                yield row

    def recall_rows(self, vector: list[float], limit: int, *, valid_at: int | None = None,
                    now_ms: int | None = None) -> list[dict[str, Any]]:
        """Read additive ANN rows from the exact certified query vector space."""
        fingerprint = self.embedding_fingerprint
        if fingerprint is None or not _valid_vector(vector) or len(vector) != self.embedding_dimensions:
            return []
        now_ms = _recall_now(valid_at, now_ms)
        limit = _recall_limit(limit)
        if not limit:
            return []
        try:
            import lancedb
        except ImportError as error:
            raise RuntimeError("PLUR1BUS requires lancedb") from error
        rows = []
        table_name = self._table_name(fingerprint)
        predicate = f" AND {_FINGERPRINT_COLUMN} = '{fingerprint}'"
        for name, path, pool_kind, principal_hash in self._pools():
            if not path.is_dir():
                continue
            try:
                _reject_symlink_components(self.data_dir, path, message='unsafe shared pool path')
                table = lancedb.connect(str(path)).open_table(table_name)
                if not self._compatible(table):
                    continue
                candidates = self._search(table, pool_kind, principal_hash, vector, limit * 4, valid_at, now_ms,
                                          predicate=predicate)
            except Exception as error:
                _LOG.debug('shared vector recall unavailable (%s)', type(error).__name__)
                continue
            rows.extend({**row, '_namespace': name} for row in self._admitted(
                path, candidates, table_name, pool_kind, principal_hash, valid_at, now_ms,
            ) if row.get(_FINGERPRINT_COLUMN) == fingerprint)
        return rows[:limit]

    def recall_lexical_rows(self, query: str, limit: int, *, valid_at: int | None = None,
                            now_ms: int | None = None, include_compatible: bool = False) -> list[dict[str, Any]]:
        """Search authorized text of legacy/incompatible pools without a vector score."""
        keywords = fallback_keywords(query)
        limit = _recall_limit(limit)
        if not keywords or not limit:
            return []
        now_ms = _recall_now(valid_at, now_ms)
        import lancedb

        match = ' OR '.join(f"lower(content) LIKE '%{word}%'" for word in keywords)
        rows = []
        for name, path, pool_kind, principal_hash in self._pools():
            if not path.is_dir():
                continue
            try:
                _reject_symlink_components(self.data_dir, path, message='unsafe shared pool path')
                database = lancedb.connect(str(path))
                tables = database.list_tables(limit=_MAX_LEXICAL_TABLES + 1).tables
            except Exception as error:
                _LOG.debug('shared lexical pool unavailable (%s)', type(error).__name__)
                continue
            for table_name in tables:
                if table_name != _LEGACY_TABLE and not (table_name.startswith('memories_')
                                                        and _known_fingerprint(table_name.removeprefix('memories_'))):
                    continue
                try:
                    table = database.open_table(table_name)
                    if (not include_compatible and table_name == self._table_name(self.embedding_fingerprint)
                            and self._compatible(table)):
                        continue
                    candidates = self._search(table, pool_kind, principal_hash, None, min(200, limit * 8),
                                              valid_at, now_ms, predicate=f' AND ({match})')
                except Exception as error:
                    _LOG.debug('shared lexical recall unavailable (%s)', type(error).__name__)
                    continue
                rows.extend({**row, '_namespace': name, '_sharedRetrieval': 'keyword'} for row in self._admitted(
                    path, candidates, table_name, pool_kind, principal_hash, valid_at, now_ms,
                ))
                rows = sorted(rows, key=lambda row: fallback_rank(row, keywords, now_ms), reverse=True)[:limit]
        return rows


def _recall_limit(value: object) -> int:
    return max(0, min(100, value)) if type(value) is int else 0


def _recall_now(valid_at: int | None, now_ms: int | None) -> int:
    if (valid_at is not None and type(valid_at) is not int) or (now_ms is not None and type(now_ms) is not int):
        raise ValueError('shared recall times must be epoch milliseconds')
    return int(time.time() * 1000) if now_ms is None else now_ms
