"""PLUR1BUS dashboard status plus narrow, reviewed Skill Workshop actions."""

from __future__ import annotations

import hashlib
import hmac
import re
import secrets
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Iterator

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from plur1bus_hermes.namespaces import binding_from_scope, normalize_scope_context, resolve_namespace_routes
from plur1bus_hermes.operator_status import read_operator_status
from plur1bus_hermes.provider import Plur1busMemoryProvider
from plur1bus_hermes.runtime import Plur1busRuntime
from plur1bus_hermes.skill_workshop import SkillWorkshop
from plur1bus_hermes.validation import safe_agent_id

router = APIRouter()
_REVISION = re.compile(r"^[a-f0-9]{64}$")
_NONCE_TTL_SECONDS = 300
_nonce_lock = threading.Lock()
_nonces: dict[str, dict[str, Any]] = {}


def _active_runtime_view() -> Any:
    """Build a read-only view of the dashboard server's active provider route.

    The browser supplies no profile, agent, table, or filesystem value.  Configuration
    resolution deliberately reuses the provider's current read-only merge semantics;
    this keeps a dashboard process scoped with ``HERMES_HOME`` on its own profile.
    """
    from hermes_constants import get_hermes_home
    from hermes_cli.profiles import get_active_profile_name

    hermes_home = Path(get_hermes_home()).expanduser()
    profile = get_active_profile_name()
    # Config resolution is an instance method, but a full provider constructor
    # starts a prefetch executor and shutdown changes process health state.  A
    # bare instance has exactly the read-only fields used by _runtime_config.
    provider = object.__new__(Plur1busMemoryProvider)
    provider._hermes_home = hermes_home
    provider._supplied_config = {}
    # The host passes this exact value as ``agent_identity`` to the provider,
    # including the literal ``default`` and ``custom`` profile identities.
    config = provider._runtime_config(profile)
    agent_id = profile
    aliases = config.get("agentAliases")
    if isinstance(aliases, dict):
        agent_id = str(aliases.get(agent_id, agent_id))
    agent_id = safe_agent_id(agent_id)
    data_dir = Path(str(config.get("dataDir") or "plur1bus")).expanduser()
    if not data_dir.is_absolute():
        data_dir = hermes_home / data_dir
    from plur1bus_hermes.generation import effective_generation_config
    config = effective_generation_config(data_dir, agent_id, config)
    scope = normalize_scope_context({
        "scopeType": config.get("scopeType"),
        "workspace": config.get("workspaceId") or config.get("workspaceIdentity"),
        "platform": config.get("platform"),
        "user": config.get("userId") or config.get("ownerUserId"),
        "chat": config.get("chatId"),
        "account": config.get("account"),
    })
    binding = binding_from_scope(agent_id, scope)
    writer_route, _ = resolve_namespace_routes(data_dir, agent_id, config)
    return SimpleNamespace(
        profile=profile,
        hermes_home=hermes_home,
        agent_id=agent_id,
        data_dir=data_dir,
        config=config,
        scope_binding=binding,
        _writer_route=writer_route,
    )


@router.get("/status")
def get_status() -> dict[str, Any]:
    """Return the safe status projection for only the server-derived profile."""
    try:
        return read_operator_status(_active_runtime_view())
    except Exception:
        # Configuration and storage details can include a local path or endpoint.
        raise HTTPException(status_code=503, detail="status_unavailable")


class _WorkshopAction(BaseModel):
    proposal_id: str
    revision: str


def _actor(request: Request) -> str:
    """Return a server-authenticated actor without accepting browser identity."""
    session = getattr(request.state, "session", None)
    user_id = str(getattr(session, "user_id", "") or "")
    provider = str(getattr(session, "provider", "") or "")
    access_token = str(getattr(session, "access_token", "") or "")
    if user_id and provider and access_token:
        # The user id alone would let a second browser session replay a review
        # nonce.  Keep only a digest of Hermes' already-verified token.
        return "oauth:{}:{}:{}".format(
            provider,
            user_id,
            hashlib.sha256(access_token.encode("utf-8")).hexdigest(),
        )
    if session is not None:
        raise HTTPException(status_code=503, detail="action_identity_unavailable")
    # Loopback mode has no user principal. Bind to the host-issued token only
    # after comparing the header server-side; the raw credential is never kept.
    try:
        from hermes_cli.web_server import _SESSION_TOKEN
    except Exception as error:
        raise HTTPException(status_code=503, detail="action_identity_unavailable") from error
    presented = request.headers.get("X-Hermes-Session-Token", "")
    if not presented or not hmac.compare_digest(presented, _SESSION_TOKEN):
        raise HTTPException(status_code=401, detail="authenticated_actor_required")
    return "loopback:" + hashlib.sha256(_SESSION_TOKEN.encode("utf-8")).hexdigest()


def _same_origin_confirmation(request: Request, verb: str) -> None:
    """Require a non-simple, same-origin reviewed browser action."""
    if request.headers.get("X-Plur1bus-Confirm") != verb:
        raise HTTPException(status_code=403, detail="confirmation_header_required")
    origin = request.headers.get("Origin", "").rstrip("/")
    expected = f"{request.url.scheme}://{request.headers.get('host', '')}".rstrip("/")
    if not origin or not expected or not hmac.compare_digest(origin, expected):
        raise HTTPException(status_code=403, detail="same_origin_required")


def _route_context(runtime: Plur1busRuntime, view: Any) -> dict[str, str]:
    route = runtime._writer_route
    return {
        "profile": str(view.profile),
        "agentId": str(runtime.agent_id),
        "scopeKey": str(runtime.scope_key),
        "writerName": str(route.name),
        "writerPath": str(Path(route.path).resolve()),
    }


@contextmanager
def _runtime_lease() -> Iterator[tuple[Plur1busRuntime, Any]]:
    """Open and always close the one server-selected runtime for an action."""
    view = _active_runtime_view()
    runtime = Plur1busRuntime(
        view.data_dir, view.config, view.agent_id, view.scope_binding.as_dict()
    )
    try:
        yield runtime, view
    finally:
        runtime.shutdown()


def _prune_nonces(now: float) -> None:
    expired = [key for key, value in _nonces.items() if value["expiresAt"] <= now]
    for key in expired:
        _nonces.pop(key, None)
    while len(_nonces) > 512:
        _nonces.pop(next(iter(_nonces)), None)


def _issue_nonce(*, actor: str, context: dict[str, str], verb: str, proposal_id: str, revision: str) -> str:
    nonce = secrets.token_urlsafe(32)
    with _nonce_lock:
        _prune_nonces(time.monotonic())
        _nonces[nonce] = {
            "actor": actor, "context": context, "verb": verb,
            "proposalId": proposal_id, "revision": revision,
            "expiresAt": time.monotonic() + _NONCE_TTL_SECONDS,
        }
    return nonce


def _consume_nonce(*, nonce: str, actor: str, context: dict[str, str], verb: str, proposal_id: str, revision: str) -> None:
    with _nonce_lock:
        _prune_nonces(time.monotonic())
        record = _nonces.pop(nonce, None)
    if record is None:
        raise HTTPException(status_code=409, detail="review_nonce_invalid_or_replayed")
    expected = {
        "actor": actor, "context": context, "verb": verb,
        "proposalId": proposal_id, "revision": revision,
    }
    if any(record.get(key) != value for key, value in expected.items()):
        raise HTTPException(status_code=409, detail="review_nonce_stale")


def _review(workshop: SkillWorkshop, proposal_id: str, revision: str) -> dict[str, Any]:
    if not _REVISION.fullmatch(revision):
        raise HTTPException(status_code=422, detail="revision_invalid")
    try:
        proposal = workshop.inspect(proposal_id)
    except Exception as error:
        raise HTTPException(status_code=404, detail="proposal_unavailable") from error
    if proposal.get("revision") != revision:
        raise HTTPException(status_code=409, detail="proposal_revision_stale")
    # No source-memory content, paths, or credentials are sent to the browser.
    return {
        key: proposal.get(key)
        for key in ("id", "skillName", "title", "description", "instructions", "evidence", "status", "revision")
    }


@router.get("/workshop/proposals")
def workshop_list() -> dict[str, Any]:
    """List metadata for proposals in the server-selected scope only."""
    with _runtime_lease() as (runtime, _view):
        return {"proposals": SkillWorkshop(runtime).list()}


@router.get("/workshop/proposals/{proposal_id}")
def workshop_inspect(proposal_id: str) -> dict[str, Any]:
    """Return the safe review projection for one proposal in this scope."""
    with _runtime_lease() as (runtime, _view):
        try:
            proposal = SkillWorkshop(runtime).inspect(proposal_id)
        except Exception as error:
            raise HTTPException(status_code=404, detail="proposal_unavailable") from error
        return {
            key: proposal.get(key)
            for key in ("id", "skillName", "title", "description", "instructions", "evidence", "status", "revision")
        }


@router.get("/workshop/approve/preview/{proposal_id}")
def workshop_approve_preview(proposal_id: str, revision: str, request: Request) -> dict[str, Any]:
    actor = _actor(request)
    with _runtime_lease() as (runtime, view):
        review = _review(SkillWorkshop(runtime), proposal_id, revision)
        nonce = _issue_nonce(actor=actor, context=_route_context(runtime, view), verb="approve",
                             proposal_id=proposal_id, revision=revision)
    return {"review": review, "nonce": nonce, "expiresInSeconds": _NONCE_TTL_SECONDS}


@router.get("/workshop/publish/preview/{proposal_id}")
def workshop_publish_preview(proposal_id: str, revision: str, request: Request) -> dict[str, Any]:
    actor = _actor(request)
    with _runtime_lease() as (runtime, view):
        review = _review(SkillWorkshop(runtime), proposal_id, revision)
        nonce = _issue_nonce(actor=actor, context=_route_context(runtime, view), verb="publish",
                             proposal_id=proposal_id, revision=revision)
    return {
        "review": review,
        "warning": "Publishing creates a Hermes profile-global skill accessible to profile agents; it is not protected by a PLUR1BUS agent ACL.",
        "nonce": nonce,
        "expiresInSeconds": _NONCE_TTL_SECONDS,
    }


def _run_workshop_action(action: _WorkshopAction, request: Request, verb: str) -> dict[str, Any]:
    _same_origin_confirmation(request, verb)
    actor = _actor(request)
    nonce = request.headers.get("X-Plur1bus-Action-Nonce", "")
    with _runtime_lease() as (runtime, view):
        context = _route_context(runtime, view)
        _consume_nonce(nonce=nonce, actor=actor, context=context, verb=verb,
                       proposal_id=action.proposal_id, revision=action.revision)
        workshop = SkillWorkshop(runtime)
        try:
            result = (
                workshop.approve(action.proposal_id, action.revision)
                if verb == "approve"
                else workshop.publish(action.proposal_id, action.revision, view.hermes_home)
            )
        except Exception as error:
            # Do not expose local paths, evidence, or backend details.
            raise HTTPException(status_code=409, detail="workshop_action_rejected") from error
    return result


@router.post("/workshop/approve")
def workshop_approve(action: _WorkshopAction, request: Request) -> dict[str, Any]:
    return _run_workshop_action(action, request, "approve")


@router.post("/workshop/publish")
def workshop_publish(action: _WorkshopAction, request: Request) -> dict[str, Any]:
    return _run_workshop_action(action, request, "publish")
