"""PLUR1BUS dashboard status plus narrow, reviewed Skill Workshop actions."""

from __future__ import annotations

import hashlib
import hmac
import re
import secrets
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Iterator

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field, ConfigDict

from plur1bus_hermes.namespaces import binding_from_scope, normalize_scope_context, resolve_namespace_routes
from plur1bus_hermes.operator_status import browse_runtime_memories, read_operator_status
from plur1bus_hermes.provider import Plur1busMemoryProvider
from plur1bus_hermes.runtime import Plur1busRuntime
from plur1bus_hermes.skill_workshop import SkillWorkshop
from plur1bus_hermes.validation import safe_agent_id

def _require_profile_binding(request: Request) -> None:
    """Assert the native caller's expected profile; never use it to select a home."""
    expected = request.query_params.getlist("expectedProfile")
    if not expected:
        return  # Existing browser clients stay process-scoped.
    _actor(request)
    from hermes_cli.profiles import get_active_profile_name
    if len(expected) != 1 or expected[0] != get_active_profile_name():
        raise HTTPException(status_code=409, detail="PLUR1BUS backend profile mismatch")


router = APIRouter(dependencies=[Depends(_require_profile_binding)])
_REVISION = re.compile(r"^[a-f0-9]{64}$")
_NONCE_TTL_SECONDS = 300
_nonce_lock = threading.Lock()
_nonces: dict[str, dict[str, Any]] = {}
_retrieval_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="plur1bus-retrieval")
_retrieval_reviews: dict[str, dict[str, Any]] = {}
_retrieval_jobs: dict[str, dict[str, Any]] = {}


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


@router.get("/memories")
def get_memories(request: Request, query: str = Query("", max_length=200), status: str = Query("active", pattern="^(active|superseded|archived|deleted)$"),
                 offset: int = Query(0, ge=0, le=100000), limit: int = Query(20, ge=1, le=50)) -> dict[str, Any]:
    """Inspect bounded content from the server-selected scope; never a client-selected path."""
    _actor(request)
    try:
        return browse_runtime_memories(_active_runtime_view(), query=query, status=status, offset=offset, limit=limit)
    except ValueError as error:
        raise HTTPException(status_code=422, detail="memory_request_invalid") from error
    except Exception as error:
        raise HTTPException(status_code=503, detail="memories_unavailable") from error


class _DesktopWorkshopAction(_WorkshopAction):
    confirmation: str
    nonce: str


def _desktop_actor(request: Request) -> str:
    """Authenticate native IPC transport, never a browser cookie or an origin bypass.

    Electron sends a host-issued session token (or verified OAuth bearer), JSON,
    and no browser Origin/Fetch-Metadata headers. Web actions retain their
    independent same-origin + confirmation-header checks unchanged.
    """
    if request.headers.get("origin") is not None or request.headers.get("sec-fetch-site") is not None:
        raise HTTPException(status_code=403, detail="native_transport_required")
    session = getattr(request.state, "session", None)
    if session is not None:
        token = str(getattr(session, "access_token", "") or "")
        presented = request.headers.get("authorization", "")
        if not token or not hmac.compare_digest(presented, "Bearer " + token):
            raise HTTPException(status_code=401, detail="native_bearer_required")
    return _actor(request)


@router.get("/desktop/capabilities")
def desktop_capabilities(request: Request) -> dict[str, Any]:
    try:
        _desktop_actor(request)
        actions = True
    except HTTPException:
        actions = False
    result = {"memoryBrowser": True, "workshopActions": actions, "retrievalActions": actions, "obsidianActions": actions}
    if actions:
        from hermes_cli.profiles import get_active_profile_name
        from hermes_cli.config import load_config_readonly
        result.update(profileBinding=1, profile=get_active_profile_name())
        config = load_config_readonly()
        result["memoryProviderEnabled"] = (config.get("memory") or {}).get("provider") == "plur1bus"
    return result


class _RetrievalPreview(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: str = Field(pattern="^(embedding|reranker|activate)$")
    target: dict = Field(default_factory=dict, max_length=20)
    job: str = Field(default="", max_length=64)


class _RetrievalCommit(BaseModel):
    model_config = ConfigDict(extra="forbid")
    nonce: str = Field(max_length=128)
    confirmation: str = Field(pattern="^(embedding|reranker|activate)$")


@router.get("/desktop/retrieval")
def retrieval_options(request: Request) -> dict[str, Any]:
    """Return editable, secret-free settings for the authenticated current profile."""
    _desktop_actor(request)
    from plur1bus_hermes.retrieval_admin import public_config, EMBEDDING_PROVIDERS, RERANKER_PROVIDERS
    view = _active_runtime_view()
    return {"embedding": public_config(view.config.get("embedding", {})),
            "reranker": public_config(view.config.get("reranker", {})),
            "embeddingProviders": EMBEDDING_PROVIDERS, "rerankerProviders": RERANKER_PROVIDERS}


@router.post("/desktop/retrieval/preview")
def retrieval_preview(body: _RetrievalPreview, request: Request) -> dict[str, Any]:
    """Pin an explicit target and scope; preview does not load models or write data."""
    actor = _desktop_actor(request)
    from plur1bus_hermes.retrieval_admin import context_revision, validate_target
    from plur1bus_hermes.reembed_staged import plan_staged_reembed
    view = _active_runtime_view()
    revision = context_revision(view)
    try:
        if body.kind == "activate":
            with _nonce_lock:
                job = _retrieval_jobs.get(body.job)
                if (not job or job["actor"] != actor or job["revision"] != revision
                        or job["kind"] != "embedding" or job["status"] != "done"):
                    raise HTTPException(409, "reviewed_stage_required")
                target, plan = job["target"], job["plan"]
        else:
            target = validate_target(body.kind, body.target)
            plan = (plan_staged_reembed(view.data_dir, view.agent_id, {**view.config, "embedding": target})
                    if body.kind == "embedding" else None)
        nonce = secrets.token_urlsafe(32)
        with _nonce_lock:
            now = time.monotonic()
            for key in list(_retrieval_reviews):
                if _retrieval_reviews[key]["expires"] < now:
                    del _retrieval_reviews[key]
            if len(_retrieval_reviews) >= 32:
                raise HTTPException(429, "too_many_reviews")
            _retrieval_reviews[nonce] = {"actor": actor, "revision": revision, "target": target,
                "plan": plan, "kind": body.kind, "expires": now + _NONCE_TTL_SECONDS}
        return {"nonce": nonce, "kind": body.kind, "profile": view.profile, "agentId": view.agent_id,
                "target": target, "cards": plan["sourceCards"] if plan else None,
                "planId": plan["planId"] if plan else None,
                "requiresStoppedRuntimes": True,
                "externalData": target.get("provider") in {"openai-compatible", "omlx", "cohere"}}
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(422, "retrieval_preview_invalid_check_target_and_source") from error


def _run_retrieval_job(identifier: str, view: Any) -> None:
    """Run once; status polling never retries a mutation."""
    from plur1bus_hermes.retrieval_admin import save_reranker, stage_embedding, context_revision
    from plur1bus_hermes.generation import activate_staged_generation
    with _nonce_lock:
        job = _retrieval_jobs[identifier]
        job["status"] = "running"
    def progress(value):
        with _nonce_lock:
            job["progress"] = value
    try:
        if context_revision(view) != job["revision"]:
            raise ValueError("review context changed")
        if job["kind"] == "reranker":
            result = save_reranker(view, job["target"], job["revision"])
        elif job["kind"] == "embedding":
            result = stage_embedding(view, job["target"], job["plan"], progress)
        else:
            result = activate_staged_generation(job["plan"], view.data_dir, view.agent_id,
                {**view.config, "embedding": job["target"]}, approved_plan_id=job["plan"]["planId"])
            result = {"activated": result["activated"], "restartRequired": True}
        with _nonce_lock:
            job.update(status="done", result=result)
    except Exception as error:
        # Fixed codes only: inference exceptions may contain keys or memory text.
        code = "runtime_active" if "runtime lease" in str(error) else "retrieval_job_failed"
        with _nonce_lock:
            job.update(status="failed", error=code)


@router.post("/desktop/retrieval/commit")
def retrieval_commit(body: _RetrievalCommit, request: Request) -> dict[str, Any]:
    actor = _desktop_actor(request)
    from plur1bus_hermes.retrieval_admin import context_revision
    view = _active_runtime_view()
    revision = context_revision(view)
    with _nonce_lock:
        review = _retrieval_reviews.get(body.nonce)
        if (not review or review["actor"] != actor or review["revision"] != revision
                or review["kind"] != body.confirmation or review["expires"] < time.monotonic()):
            raise HTTPException(409, "retrieval_review_expired_or_changed")
        if any(job["status"] in {"queued", "running"} for job in _retrieval_jobs.values()):
            raise HTTPException(409, "retrieval_job_already_running")
        del _retrieval_reviews[body.nonce]
        # Retain a bounded number of completed jobs for activation reviews.
        if len(_retrieval_jobs) >= 32:
            del _retrieval_jobs[next(iter(_retrieval_jobs))]
        identifier = secrets.token_urlsafe(24)
        _retrieval_jobs[identifier] = {**review, "status": "queued", "profile": view.profile,
                                      "home": str(view.hermes_home)}
        _retrieval_executor.submit(_run_retrieval_job, identifier, view)
    return {"job": identifier, "status": "queued"}


@router.get("/desktop/retrieval/jobs")
def retrieval_jobs(request: Request) -> dict[str, Any]:
    """Recover the latest in-process job after navigation or a lost commit response."""
    actor = _desktop_actor(request)
    view = _active_runtime_view()
    with _nonce_lock:
        matches = [{"id": identifier, **{key: job[key] for key in ("kind", "status", "progress", "result", "error") if key in job}}
                   for identifier, job in _retrieval_jobs.items()
                   if job["actor"] == actor and job["profile"] == view.profile and job["home"] == str(view.hermes_home)]
        return {"jobs": matches[-1:]}


@router.get("/desktop/retrieval/jobs/{identifier}")
def retrieval_job(identifier: str, request: Request) -> dict[str, Any]:
    actor = _desktop_actor(request)
    view = _active_runtime_view()
    with _nonce_lock:
        job = _retrieval_jobs.get(identifier)
        if not job or job["actor"] != actor or job["profile"] != view.profile or job["home"] != str(view.hermes_home):
            raise HTTPException(404, "retrieval_job_not_found")
        return {key: job[key] for key in ("kind", "status", "progress", "result", "error") if key in job}


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


class _ObsidianAction(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: str = Field(pattern=r"^[a-f0-9]{64}$")
    nonce: str = Field(min_length=20, max_length=128)
    confirmation: str


@router.get("/obsidian/preview")
def obsidian_preview(request: Request) -> dict[str, Any]:
    """Discover changed notes only in the server-selected scoped workspace."""
    actor = _actor(request)
    from plur1bus_hermes.obsidian_sync import plan_obsidian_sync
    try:
        with _runtime_lease() as (runtime, view):
            plan = plan_obsidian_sync(runtime)
            nonce = _issue_nonce(actor=actor, context=_route_context(runtime, view), verb="obsidian-sync",
                                 proposal_id="workspace", revision=plan["revision"])
        return {"files": plan["files"], "revision": plan["revision"], "nonce": nonce,
                "agentId": plan["agentId"], "mode": plan["mode"], "expiresInSeconds": _NONCE_TTL_SECONDS,
                "warning": "Append-only import. Source notes and existing memories are not overwritten. Changed notes create new observations."}
    except (ValueError, OSError) as error:
        raise HTTPException(409, "obsidian_source_unavailable_or_outside_budget") from error


def _commit_obsidian(action: _ObsidianAction, actor: str) -> dict[str, Any]:
    from plur1bus_hermes.obsidian_sync import apply_obsidian_sync
    if action.confirmation != "obsidian-sync":
        raise HTTPException(403, "explicit_confirmation_required")
    with _runtime_lease() as (runtime, view):
        _consume_nonce(nonce=action.nonce, actor=actor, context=_route_context(runtime, view),
                       verb="obsidian-sync", proposal_id="workspace", revision=action.revision)
        try:
            return apply_obsidian_sync(runtime, approved_revision=action.revision)
        except Exception as error:
            raise HTTPException(409, "obsidian_sync_incomplete_review_before_retry") from error


@router.post("/obsidian/sync")
def obsidian_sync(action: _ObsidianAction, request: Request) -> dict[str, Any]:
    _same_origin_confirmation(request, "obsidian-sync")
    return _commit_obsidian(action, _actor(request))


@router.post("/desktop/obsidian/sync")
def desktop_obsidian_sync(action: _ObsidianAction, request: Request) -> dict[str, Any]:
    actor = _desktop_actor(request)
    if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
        raise HTTPException(415, "json_required")
    return _commit_obsidian(action, actor)


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
    return _commit_workshop_action(action, actor, nonce, verb)


def _commit_workshop_action(action: _WorkshopAction, actor: str, nonce: str, verb: str) -> dict[str, Any]:
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


@router.post("/desktop/workshop/{verb}")
def desktop_workshop_action(verb: str, action: _DesktopWorkshopAction, request: Request) -> dict[str, Any]:
    """Native JSON confirmation over host-authenticated IPC with the same review nonce."""
    actor = _desktop_actor(request)
    if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
        raise HTTPException(status_code=415, detail="json_required")
    if verb not in {"approve", "publish"} or action.confirmation != verb:
        raise HTTPException(status_code=403, detail="explicit_confirmation_required")
    return _commit_workshop_action(action, actor, action.nonce, verb)


@router.post("/workshop/approve")
def workshop_approve(action: _WorkshopAction, request: Request) -> dict[str, Any]:
    return _run_workshop_action(action, request, "approve")


@router.post("/workshop/publish")
def workshop_publish(action: _WorkshopAction, request: Request) -> dict[str, Any]:
    return _run_workshop_action(action, request, "publish")
