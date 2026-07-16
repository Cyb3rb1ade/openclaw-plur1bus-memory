/**
 * lib/setup/feature-cron-plan.js — pure planning logic for the feature-cron
 * self-setup (persona-evolve, afterthought). No I/O here — see
 * scripts/setup-feature-crons.mjs for the shell that executes the plan via
 * the `openclaw` CLI.
 *
 * Design:
 * - REQUIRED_FEATURE_CRONS mirrors the real `openclaw cron list --json` job
 *   shape (name + payload.message running "/plur1bus internal <job>"),
 *   observed on a live installation — see the field names below.
 * - planFeatureCrons() is idempotent: re-running it against the current
 *   `openclaw cron list --json` output never proposes a duplicate.
 * - Delivery-needing jobs (afterthought) default to created-but-disabled
 *   when no delivery target can be derived, with a hint on how to wire
 *   delivery — never silently deliver to nobody, never fail the install.
 * - Multi-agent: planFeatureCrons(existingJobs, specs, { agents }) plans a
 *   pair of per-agent jobs (`plur1bus <feature> <agentId>`) for every entry
 *   in `agents` (already filtered/deduped by the caller — see
 *   selectAgentsForCronSetup below). Legacy behavior (no `agents` opt, only
 *   `agent`/`account`) is preserved for backward compatibility.
 */

export const REQUIRED_FEATURE_CRONS = [
  {
    name: "plur1bus persona-evolve",
    feature: "persona-evolve",
    command: "/plur1bus internal persona-evolve",
    message: "/plur1bus internal persona-evolve",
    description: "Weekly persona-voice evolution, auto-applied (low-traffic slot).",
    // Sunday 04:15 — low-traffic slot, mirrors the "0 4 * * 0"-style weekly
    // internal jobs already used for other maintenance crons on this install.
    // Per-agent installs stagger off this base — see staggerPersonaEvolveSchedule.
    schedule: { kind: "cron", expr: "15 4 * * 0" },
    needsDelivery: false,
  },
  {
    name: "plur1bus afterthought",
    feature: "afterthought",
    command: "/plur1bus internal afterthought",
    // README delivery contract (grep "afterthought" README.md):
    // if the JSON result has a `text` field, send exactly that text as the
    // message; if `skipped` is true, reply NO_REPLY (OpenClaw's silent-reply
    // token — the gateway suppresses announce delivery for token-only
    // replies). A positive "reply with exactly NO_REPLY" instruction is far
    // more reliable than "output nothing": models routinely hallucinate
    // filler content when told to stay silent (2026-07-16: a skipped run
    // delivered an invented "MealTime Check" table to Telegram at 3:32 AM).
    message:
      "/plur1bus internal afterthought\n\n" +
      "Delivery contract: the job returns JSON. If it has a `text` field, " +
      "send exactly that text as the message, verbatim, with no additional " +
      "commentary. If `skipped` is true, reply with exactly NO_REPLY and " +
      "nothing else — do not invent content.",
    description: "Delayed follow-up job — runs every 30 minutes.",
    schedule: { kind: "every", everyMs: 30 * 60 * 1000 },
    needsDelivery: true,
  },
];

/**
 * Contract-Migrationen für BESTEHENDE Jobs. Der Planner fasst existierende
 * Jobs sonst nie wieder an ("already-exists"-Skip) — ein fehlerhafter
 * Prompt-Contract würde auf Bestandsinstallationen also für immer
 * weiterlaufen. Ersetzt wird ausschließlich der bekannte alte Satz;
 * Nutzer-Anpassungen im Rest der Message bleiben unangetastet.
 */
export const MESSAGE_CONTRACT_MIGRATIONS = [
  {
    // 2026-07-16: "output NOTHING at all" ist unzuverlässig — auf einem
    // skipped-Run hat das Modell erfundenen Inhalt zugestellt. NO_REPLY ist
    // OpenClaws Silent-Reply-Token: token-only-Antworten unterdrückt das
    // Gateway vor der Announce-Zustellung hart.
    find: "If `skipped` is true, output NOTHING at all.",
    replace: "If `skipped` is true, reply with exactly NO_REPLY and nothing else — do not invent content.",
  },
];

/**
 * Plant ein Message-Update für einen existierenden Job, dessen Message noch
 * einen migrierbaren Alt-Contract enthält. Gibt null zurück, wenn nichts zu
 * migrieren ist oder der Job keine id hat (cron edit braucht die id).
 */
export function planMessageMigration(job) {
  if (!job?.id) return null;
  const message = job.payload?.message;
  if (typeof message !== "string") return null;
  let next = message;
  for (const migration of MESSAGE_CONTRACT_MIGRATIONS) {
    if (next.includes(migration.find)) next = next.split(migration.find).join(migration.replace);
  }
  if (next === message) return null;
  return { id: job.id, name: job.name ?? "", message: next };
}

function normalize(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

/**
 * Is `prefix` a prefix of `str` that ends on a word boundary (end-of-string,
 * or the next character is not alphanumeric)? Prevents "plur1bus
 * persona-evolve" from matching "plur1bus persona-evolved-thing", and
 * prevents a bare "plur1bus" job from matching every spec.
 */
function isWordBoundaryPrefix(str, prefix) {
  if (!str || !prefix || !str.startsWith(prefix)) return false;
  if (str.length === prefix.length) return true;
  return !/[a-z0-9]/i.test(str[prefix.length]);
}

/**
 * Does an existing cron job (as returned by `openclaw cron list --json`)
 * already cover this spec? Matches on job name (case-insensitive,
 * word-boundary prefix of the spec name — tightened from the previous
 * bidirectional-substring check, which let a bare "plur1bus" job match
 * every spec) or on the job's agent-turn message containing the spec's
 * internal command — cron names are free-form, so the message match is the
 * more reliable idempotency signal for legacy/manually-renamed jobs.
 */
function matchesExisting(job, spec) {
  const jobName = normalize(job?.name);
  const specName = normalize(spec?.name);
  if (jobName && specName && isWordBoundaryPrefix(jobName, specName)) {
    return true;
  }
  const jobMessage = normalize(job?.payload?.message);
  const specCommand = normalize(spec?.command);
  if (jobMessage && specCommand && jobMessage.includes(specCommand)) {
    return true;
  }
  return false;
}

/**
 * Does an existing job satisfy the per-agent spec for `feature`/`agentId`?
 * Exact name match, or a word-boundary prefix match on
 * `plur1bus <feature> <agentId>` (covers operator-decorated names like
 * "plur1bus afterthought bernhardine (custom)").
 */
function matchesPerAgent(job, feature, agentId) {
  const jobName = normalize(job?.name);
  const prefix = normalize(`plur1bus ${feature} ${agentId}`);
  return isWordBoundaryPrefix(jobName, prefix);
}

/**
 * Is `job` the pre-multi-agent, non-suffixed legacy job for `spec`
 * ("plur1bus persona-evolve" / "plur1bus afterthought", exact name)? Such a
 * job is treated as satisfying the DEFAULT agent's per-agent spec only, so
 * upgrading an existing single-agent install to multi-agent never creates a
 * duplicate alongside it.
 */
function isLegacyExactMatch(job, spec) {
  return normalize(job?.name) === normalize(spec?.name);
}

/**
 * Stagger a weekly cron schedule deterministically by agent index, so N
 * agents' persona-evolve jobs don't all fire at the same instant
 * (thundering herd against the same LanceDB/embedding backend). Adds
 * `agentIndex * 5` minutes to the base hour:minute, wrapping within the
 * day. Non-cron schedules pass through unchanged.
 */
export function staggerPersonaEvolveSchedule(baseSchedule, agentIndex) {
  if (!baseSchedule || baseSchedule.kind !== "cron" || !Number.isFinite(agentIndex)) {
    return baseSchedule;
  }
  const match = /^(\d{1,2})\s+(\d{1,2})\s+(.*)$/.exec(baseSchedule.expr || "");
  if (!match) return baseSchedule;
  const [, minStr, hourStr, rest] = match;
  const totalMinutes = parseInt(minStr, 10) + parseInt(hourStr, 10) * 60 + Math.max(0, agentIndex) * 5;
  const newHour = Math.floor(totalMinutes / 60) % 24;
  const newMin = totalMinutes % 60;
  return { kind: "cron", expr: `${newMin} ${newHour} ${rest}` };
}

/**
 * Derive a delivery target for `agentId`'s afterthought cron from its other
 * existing crons — never guessed, never hardcoded. Looks at every existing
 * job belonging to `agentId` with a real delivery target (`delivery.mode`
 * not "none"/falsy, and a non-empty `delivery.to`), preferring jobs whose
 * name starts with "plur1bus" (our own family) over unrelated crons. If
 * every candidate agrees on channel+to, returns
 * `{ channel, to, accountId? }` (accountId included only when every
 * candidate agrees on it too); with conflicting targets or no candidates at
 * all, returns null (caller falls back to created-but-disabled).
 *
 * @param {string} agentId
 * @param {Array<object>} existingJobs
 * @returns {{channel: string, to: string, accountId?: string} | null}
 */
export function deriveAgentDelivery(agentId, existingJobs) {
  const jobs = Array.isArray(existingJobs) ? existingJobs : [];
  const normAgentId = normalize(agentId);
  if (!normAgentId) return null;

  const candidates = jobs.filter((job) => {
    if (normalize(job?.agentId) !== normAgentId) return false;
    // Disabled jobs (e.g. a decommissioned cron the operator turned off
    // rather than deleted) must not seed a "live" delivery target — their
    // `to` may be stale (old chat, departed account). Missing `enabled`
    // counts as enabled (older cron-list shapes never had the field).
    if (job?.enabled === false) return false;
    const delivery = job?.delivery;
    const mode = delivery?.mode;
    const to = delivery?.to;
    return Boolean(mode) && mode !== "none" && typeof to === "string" && to.length > 0;
  });
  if (candidates.length === 0) return null;

  const preferred = candidates.filter((job) => normalize(job?.name).startsWith("plur1bus"));
  const pool = preferred.length > 0 ? preferred : candidates;

  const keyOf = (job) => `${job.delivery.channel || ""} ${job.delivery.to}`;
  const firstKey = keyOf(pool[0]);
  const allAgree = pool.every((job) => keyOf(job) === firstKey);
  if (!allAgree) return null;

  const result = { channel: pool[0].delivery.channel, to: pool[0].delivery.to };
  const accountIds = new Set(pool.map((job) => job.delivery.accountId));
  if (accountIds.size === 1) {
    const only = [...accountIds][0];
    if (only !== undefined) result.accountId = only;
  }
  return result;
}

/**
 * Select which agents get feature crons: bound agents only (bindings > 0 —
 * subagents never get crons, both because the user doesn't want automation
 * running against them and for compute-cost reasons), deduplicated to
 * exactly one agent per workspace.
 *
 * All PLUR1BUS state these crons touch (.proactive-governor.json,
 * persona-voice.md, .dream-echoes.jsonl, .afterthought-state.json, ...) is
 * keyed by workspaceDir, not agentId — two crons on agents sharing one
 * workspace would double-fire against the same state files. Deterministic
 * tiebreak per workspace: prefer `isDefault: true`, else the bound agent
 * with the most bindings, else alphabetically-first id.
 *
 * @param {Array<{id: string, workspace?: string, bindings?: number, isDefault?: boolean}>} agents
 * @returns {Array<{id: string, isDefault: boolean}>} deterministically
 *   ordered (isDefault first, then alphabetical by id) — also the order
 *   used as the stagger index for persona-evolve.
 */
export function selectAgentsForCronSetup(agents) {
  const bound = (Array.isArray(agents) ? agents : []).filter((a) => Number(a?.bindings) > 0 && a?.id);

  const byWorkspace = new Map();
  for (const a of bound) {
    const wsKey = a.workspace || ` no-workspace:${a.id}`;
    const existing = byWorkspace.get(wsKey);
    if (!existing) {
      byWorkspace.set(wsKey, a);
      continue;
    }
    const aIsDefault = Boolean(a.isDefault);
    const eIsDefault = Boolean(existing.isDefault);
    let preferA = false;
    if (aIsDefault !== eIsDefault) {
      preferA = aIsDefault;
    } else {
      const aBindings = Number(a.bindings) || 0;
      const eBindings = Number(existing.bindings) || 0;
      if (aBindings !== eBindings) {
        preferA = aBindings > eBindings;
      } else {
        preferA = String(a.id) < String(existing.id);
      }
    }
    if (preferA) byWorkspace.set(wsKey, a);
  }

  return [...byWorkspace.values()]
    .map((a) => ({ id: a.id, isDefault: Boolean(a.isDefault) }))
    .sort((x, y) => {
      if (x.isDefault !== y.isDefault) return x.isDefault ? -1 : 1;
      return x.id.localeCompare(y.id);
    });
}

function buildLegacyHint(specName) {
  return (
    `Delivery not configured — created disabled. Enable with: ` +
    `openclaw cron edit --name "${specName}" --agent <id> --account <account> --announce, ` +
    `then: openclaw cron enable --name "${specName}"`
  );
}

function buildAgentHint(perAgentName, agentId) {
  return (
    `Delivery not configured — created disabled (no consistent delivery target found on ` +
    `${agentId}'s other crons). Enable with: ` +
    `openclaw cron edit --name "${perAgentName}" --agent ${agentId} --account <account> --announce --channel telegram --to <chatId>, ` +
    `then: openclaw cron enable --name "${perAgentName}"`
  );
}

/**
 * Plan per-agent creates/skips for one spec across all selected agents.
 */
function planSpecForAgents(jobs, spec, agents) {
  const create = [];
  const skip = [];

  agents.forEach((agentEntry, agentIndex) => {
    const agentId = agentEntry.id;
    const isDefault = Boolean(agentEntry.isDefault);
    const perAgentName = `${spec.name} ${agentId}`;

    if (isDefault) {
      const legacyJob = jobs.find((job) => isLegacyExactMatch(job, spec));
      if (legacyJob) {
        skip.push({
          spec: { ...spec, name: perAgentName, agentId },
          reason: "legacy",
          existingJob: legacyJob,
        });
        return;
      }
    }

    const existingJob = jobs.find((job) => matchesPerAgent(job, spec.feature, agentId));
    if (existingJob) {
      skip.push({
        spec: { ...spec, name: perAgentName, agentId },
        reason: "already-exists",
        existingJob,
      });
      return;
    }

    let enabled = true;
    let delivery = null;
    let hint;
    if (spec.needsDelivery) {
      delivery = deriveAgentDelivery(agentId, jobs);
      if (!delivery) {
        enabled = false;
        hint = buildAgentHint(perAgentName, agentId);
      }
    }

    const schedule =
      spec.feature === "persona-evolve" ? staggerPersonaEvolveSchedule(spec.schedule, agentIndex) : spec.schedule;

    create.push({
      name: perAgentName,
      command: spec.command,
      message: spec.message,
      description: spec.description,
      schedule,
      needsDelivery: spec.needsDelivery,
      enabled,
      agent: agentId,
      account: delivery?.accountId ?? null,
      delivery,
      hint,
    });
  });

  return { create, skip };
}

/**
 * Plan which REQUIRED_FEATURE_CRONS specs still need to be created against
 * a list of existing jobs (from `openclaw cron list --json`).
 *
 * Two modes:
 * - Multi-agent (`opts.agents` is a non-empty array of `{id, isDefault}`,
 *   already filtered to bound agents and deduplicated to one per
 *   workspace — see selectAgentsForCronSetup): plans a per-agent pair of
 *   jobs (`plur1bus <feature> <agentId>`) for every agent, deriving
 *   delivery for afterthought from that agent's other crons.
 * - Legacy single-agent (no `opts.agents`, only `opts.agent`/`opts.account`):
 *   unchanged prior behavior — plans the bare (non-suffixed) spec names,
 *   using the given `agent`/`account` for delivery gating.
 *
 * @param {Array<object>} existingJobs
 * @param {Array<object>} specs
 * @param {{agent?: string|null, account?: string|null, agents?: Array<{id: string, isDefault?: boolean}>|null}} opts
 * @returns {{create: Array<object>, skip: Array<{spec: object, reason: string, existingJob?: object}>, update: Array<{id: string, name: string, message: string}>}}
 */
export function planFeatureCrons(existingJobs, specs, opts = {}) {
  const { agent = null, account = null, agents = null } = opts || {};
  const jobs = Array.isArray(existingJobs) ? existingJobs : [];

  if (Array.isArray(agents) && agents.length > 0) {
    const create = [];
    const skip = [];
    for (const spec of specs) {
      const planned = planSpecForAgents(jobs, spec, agents);
      create.push(...planned.create);
      skip.push(...planned.skip);
    }
    return { create, skip, update: collectMessageMigrations(skip) };
  }

  const create = [];
  const skip = [];

  for (const spec of specs) {
    const existingJob = jobs.find((job) => matchesExisting(job, spec));
    if (existingJob) {
      skip.push({ spec, reason: "already-exists", existingJob });
      continue;
    }

    // Delivery-target contract (legacy single-agent mode): `--account` alone
    // is NOT delivery-capable. `openclaw cron add --announce` with no --to
    // resolves to the runtime "last active chat" for that account
    // (channel "last") — there is no concrete recipient baked into the job,
    // so it can silently deliver to the wrong chat or nowhere at all. Only
    // `--agent` gives buildAddArgs a stable, agent-scoped target it already
    // announces to. This mirrors deriveAgentDelivery's own rule (never
    // deliver without a concrete `to`) — see module doc above.
    const hasDeliveryTarget = Boolean(agent);
    const enabled = spec.needsDelivery ? hasDeliveryTarget : true;

    const planned = {
      name: spec.name,
      command: spec.command,
      message: spec.message,
      description: spec.description,
      schedule: spec.schedule,
      needsDelivery: spec.needsDelivery,
      enabled,
      agent,
      account,
    };

    if (spec.needsDelivery && !hasDeliveryTarget) {
      planned.hint = buildLegacyHint(spec.name);
    }

    create.push(planned);
  }

  return { create, skip, update: collectMessageMigrations(skip) };
}

/**
 * Sammelt Message-Migrationen über alle geskippten (= bereits existierenden)
 * Jobs, dedupliziert per Job-id — derselbe Job kann mehrere Specs matchen.
 */
function collectMessageMigrations(skip) {
  const seen = new Set();
  const update = [];
  for (const entry of skip) {
    const migration = planMessageMigration(entry.existingJob);
    if (migration && !seen.has(migration.id)) {
      seen.add(migration.id);
      update.push(migration);
    }
  }
  return update;
}
