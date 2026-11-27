"""Route query embeddings by certified generation and fuse rank positions."""

from __future__ import annotations

import logging
import math
import threading
import time
from collections import defaultdict
from collections.abc import Mapping
from concurrent.futures import wait

from .embedding_text import configured_text_mode, prepare_embedding_query
from .runtime_scheduler import AdmissionRejected
from .valid_time import normalize_timestamp


LOGGER = logging.getLogger(__name__)


def _distance(row):
    value = row.get("_distance")
    return value if type(value) in (int, float) and math.isfinite(value) else math.inf


def _row_identity(row, ordinal):
    if not row.get("id"):
        return (None, ordinal)
    return (
        row.get("agentId"), row.get("scopeKey"), row.get("id"), row.get("content"),
        normalize_timestamp(row.get("validFrom")), normalize_timestamp(row.get("validUntil")),
    )


def fuse_recall_identities(rows: list[dict], k: float = 60, *, primary_identity: str | None = None) -> list[dict]:
    """Fuse distinct identity-ranked lists and keep the first admitted copy."""
    groups = defaultdict(list)
    for ordinal, row in enumerate(rows):
        groups[row.get("_embeddingIdentity")].append((ordinal, row))
    if not groups or (len(groups) == 1 and (primary_identity is None or primary_identity in groups)):
        return rows
    k = k if type(k) in (int, float) and math.isfinite(k) and k > 0 else 60
    scores, winners = {}, {}
    for group in groups.values():
        seen = set()
        for ordinal, row in sorted(group, key=lambda entry: _distance(entry[1])):
            key = _row_identity(row, ordinal)
            if key in seen:
                continue
            seen.add(key)
            scores[key] = scores.get(key, 0) + 1 / (k + len(seen))
            winners.setdefault(key, row)
    return [
        {**{key: value for key, value in winners[identity].items() if key != "_distance"},
         "rrfScore": scores[identity]}
        for identity in sorted(winners, key=scores.__getitem__, reverse=True)
    ]


class RecallIdentityRouter:
    """One profile-owned query encoder per approved, certified embedding identity."""

    def __init__(self, writer, routes, config, backend_factory):
        self.primary = writer.embedding_fingerprint
        self._identities = {route.name: route.embedding_fingerprint for route in routes}
        self.active = len(set(self._identities.values())) > 1
        self._routes = {route.embedding_fingerprint: route for route in routes}
        self._routes[self.primary] = writer
        self._factory = backend_factory
        self._lock = threading.Lock()
        self._configs = {}
        self._backends = {}
        if not self.active:
            return
        from .reembed_staged import _embedding_fingerprint
        approved = config["namespaces"].get("recallEmbeddings", {})
        if not isinstance(approved, Mapping):
            raise ValueError("namespaces.recallEmbeddings must be an object")
        for route in routes:
            identity = route.embedding_fingerprint
            if identity == self.primary:
                continue
            approved_embedding = approved.get(route.name)
            if not isinstance(approved_embedding, Mapping):
                continue
            try:
                fingerprint = _embedding_fingerprint({"embedding": approved_embedding})
            except ValueError:
                LOGGER.warning("recall encoder settings invalid for namespace %s", route.name)
                continue
            if (fingerprint["fingerprint"] == identity
                    and fingerprint["dimensions"] == route.embedding_dimensions):
                self._configs[identity] = dict(approved_embedding)
            else:
                LOGGER.warning("recall encoder settings do not match generation for namespace %s", route.name)

    def route_identity(self, namespace):
        """Return a configured namespace's identity; shared pools use the writer."""
        return self._identities[namespace]

    def _embed_secondary(self, identity, query, clean_text):
        with self._lock:
            if identity not in self._backends:
                self._backends[identity] = self._factory(self._configs[identity])
            backend = self._backends[identity]
        if clean_text:
            mode = configured_text_mode({"embedding": self._configs[identity]})
            query = prepare_embedding_query(query, mode)
        return backend.embed(query, purpose="query")

    def query_vectors(self, query, primary_query, primary_backend, submit, deadline, *, clean_text=False):
        """Return completed vectors once per identity within a common deadline."""
        if time.monotonic() >= deadline:
            return {}

        def before_deadline(embed, *args, **kwargs):
            if time.monotonic() >= deadline:
                raise TimeoutError("recall embedding deadline reached before admission")
            return embed(*args, **kwargs)

        jobs = {}
        try:
            jobs[self.primary] = submit(before_deadline, primary_backend.embed, primary_query, purpose="query")
        except AdmissionRejected:
            LOGGER.debug("primary recall encoder is busy")
        for identity in self._configs:
            try:
                jobs[identity] = submit(before_deadline, self._embed_secondary, identity, query, clean_text)
            except AdmissionRejected:
                LOGGER.debug("secondary recall encoder is busy")
        completed, outstanding = wait(jobs.values(), timeout=max(0, deadline - time.monotonic()))
        for pending in outstanding:
            pending.cancel()
        vectors = {}
        for identity, future in jobs.items():
            if future not in completed:
                continue
            try:
                vector = future.result()
                if (len(vector) != self._routes[identity].embedding_dimensions
                        or any(type(value) not in (int, float) or not math.isfinite(value) for value in vector)):
                    raise ValueError("query vector does not match verified generation")
            except Exception as error:
                LOGGER.debug("recall identity has no eligible vector (%s)", type(error).__name__)
                continue
            vectors[identity] = vector
        return vectors

    def close(self):
        """Dispose secondary encoders after the runtime has drained query I/O."""
        with self._lock:
            for backend in self._backends.values():
                try:
                    backend.close()
                except Exception as error:
                    LOGGER.warning("recall encoder close failed (%s)", type(error).__name__)
            self._backends.clear()
