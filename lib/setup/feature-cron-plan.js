import { commandFromNativeFeaturePayload } from "./feature-cron-native.js";

/**
 * lib/setup/feature-cron-plan.js — pure planning logic for the feature-cron
 * self-setup. No I/O here — see
 * scripts/setup-feature-crons.mjs for the shell that executes the plan via
 * the `openclaw` CLI.
 *
 * Design:
 * - REQUIRED_FEATURE_CRONS mirrors the real `openclaw cron list --json` job
 *   shape (name + payload.message running "/plur1bus internal <job>"),
 *   observed on a live installation — see the field names below.
 * - planFeatureCrons() is idempotent: re-running it against the current
 *   `openclaw cron list --json` output never proposes a duplicate.
 * - Delivery-needing jobs default to created-but-disabled when no safe,
 *   unanimous target can be derived. Non-delivery jobs pin delivery off.
 * - Multi-agent: planFeatureCrons(existingJobs, specs, { agents }) plans a
 *   per-agent job (`plur1bus <feature> <agentId>`) for every selected spec
 *   and every entry
 *   in `agents` (already filtered/deduped by the caller — see
 *   selectAgentsForCronSetup below). Legacy bare-name planning remains
 *   available but uses the same strict agent ownership rules.
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
    // Kept byte-for-byte identical for safe migration of historical agentTurn
    // jobs. New jobs use the native command runner and public plugin Gateway
    // method, bypassing OpenClaw's model executor.
    message: "/plur1bus internal afterthought",
    description: "Delayed follow-up job — runs every 3 hours.",
    schedule: { kind: "every", everyMs: 3 * 60 * 60 * 1000 },
    needsDelivery: true,
  },
  {
    name: "plur1bus consolidate-daily",
    feature: "consolidate-daily",
    command: "/plur1bus internal consolidate-daily",
    message: "/plur1bus internal consolidate-daily",
    description: "Daily memory consolidation and proposal generation.",
    schedule: { kind: "cron", expr: "0 4 * * *" },
    timezone: "Europe/Berlin",
    needsDelivery: false,
  },
  {
    name: "plur1bus classify-recent",
    feature: "classify-recent",
    command: "/plur1bus internal classify-recent",
    // See afterthought above: the command handler formats the delivery result
    // and the native command job finalizes it without a model-backed carrier.
    message: "/plur1bus internal classify-recent",
    description: "Classify recent critical memories and deliver approved push messages.",
    schedule: { kind: "every", everyMs: 3 * 60 * 60 * 1000 },
    needsDelivery: true,
  },
  {
    name: "plur1bus rem-dream",
    feature: "rem-dream",
    command: "/plur1bus internal rem-dream",
    message: "/plur1bus internal rem-dream",
    description: "Nightly REM pattern and narrative processing.",
    schedule: { kind: "cron", expr: "15 1 * * *" },
    timezone: "Europe/Berlin",
    needsDelivery: false,
  },
  {
    name: "plur1bus skill-miner",
    feature: "skill-miner",
    command: "/plur1bus internal skill-miner",
    message: "/plur1bus internal skill-miner",
    description: "Mine reusable skills from durable memory evidence.",
    schedule: { kind: "cron", expr: "0 3 * * 0" },
    timezone: "Europe/Berlin",
    needsDelivery: false,
  },
  {
    name: "plur1bus discover-semantic-links",
    feature: "discover-semantic-links",
    command: "/plur1bus internal discover-semantic-links",
    message: "/plur1bus internal discover-semantic-links",
    description: "Build the confirmed semantic-link discovery index.",
    schedule: { kind: "cron", expr: "0 2 * * *" },
    timezone: "Europe/Berlin",
    needsDelivery: false,
  },
  {
    name: "plur1bus gc-run",
    feature: "gc-run",
    command: "/plur1bus internal gc-run",
    message: "/plur1bus internal gc-run",
    description: "Archive garbage-collectable memories once the daily consolidation has run.",
    // 04:45 — nach consolidate-daily (04:00), das die Kandidaten überhaupt erst
    // erzeugt, und nach persona-evolve (sonntags 04:15).
    schedule: { kind: "cron", expr: "45 4 * * *" },
    timezone: "Europe/Berlin",
    needsDelivery: false,
    // runGcJob iteriert selbst über alle Agent-Datenbanken — genau ein Job,
    // unabhängig davon, wie viele Agenten die Installation hat.
    singleton: true,
  },
];

const PLUGIN_ID = "memory-lancedb-namespaced";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const SECRET_PROVIDER_ALIAS_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const ENV_SECRET_REF_ID_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
const EXEC_SECRET_REF_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,255}$/;
const REDACTED_SECRET_REF_ID = "__OPENCLAW_REDACTED__";

function isValidFileSecretRefId(value) {
  if (value === "value") return true;
  if (!value.startsWith("/")) return false;
  return value.slice(1).split("/").every((segment) => /^(?:[^~]|~0|~1)*$/.test(segment));
}

function isValidExecSecretRefId(value) {
  if (!EXEC_SECRET_REF_ID_PATTERN.test(value)) return false;
  return value.split("/").every((segment) => segment !== "." && segment !== "..");
}

function isValidTelegramSecretRef(value) {
  if (!isPlainObject(value) || Object.keys(value).length !== 3) return false;
  if (!SECRET_PROVIDER_ALIAS_PATTERN.test(value.provider)) return false;
  if (!["env", "file", "exec"].includes(value.source) || typeof value.id !== "string") return false;
  if (value.id === REDACTED_SECRET_REF_ID) return true;
  if (value.source === "env") return ENV_SECRET_REF_ID_PATTERN.test(value.id);
  if (value.source === "file") return isValidFileSecretRefId(value.id);
  return isValidExecSecretRefId(value.id);
}

function hasTelegramRootAccountEvidence(telegram) {
  const botToken = telegram.botToken;
  const hasBotToken = (typeof botToken === "string" && botToken.trim().length > 0)
    || isValidTelegramSecretRef(botToken);
  const hasTokenFile = typeof telegram.tokenFile === "string" && telegram.tokenFile.trim().length > 0;
  return hasBotToken || hasTokenFile;
}

function isValidCronExpression(value) {
  if (typeof value !== "string") return false;
  const fields = value.trim().split(/\s+/);
  if (fields.length !== 5 && fields.length !== 6) return false;
  if (!fields.every((field) => /^[a-z0-9*/?,#lw-]+$/i.test(field))) return false;

  const ranges = fields.length === 6
    ? [[0, 59], [0, 59], [0, 23], [1, 31], [1, 12], [0, 7]]
    : [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
  const monthIndex = fields.length - 2;
  const dayOfWeekIndex = fields.length - 1;
  const dayOfMonthIndex = fields.length - 3;
  const monthNames = new Set(["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]);
  const dayNames = new Set(["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]);
  const monthOrder = [...monthNames];
  const dayOrder = [...dayNames];
  return fields.every((field, index) => {
    const [minimum, maximum] = ranges[index];
    const allowedNames = index === monthIndex
      ? monthNames
      : index === dayOfWeekIndex
        ? dayNames
        : index === dayOfMonthIndex
          ? new Set(["L", "W", "LW"])
          : new Set();
    const alphaTokens = [...field.toUpperCase().matchAll(/[A-Z]+/g)].map(([token]) => (
      index === dayOfWeekIndex && token.length > 1 && token.endsWith("L")
        ? token.slice(0, -1)
        : token
    ));
    if (!alphaTokens.every((token) => allowedNames.has(token) || (index === dayOfWeekIndex && token === "L"))) {
      return false;
    }
    return field.split(",").every((part) => {
      const stepParts = part.split("/");
      if (stepParts.length > 2) return false;
      if (stepParts.length === 2 && !/^[1-9]\d*$/.test(stepParts[1])) return false;
      const maximumStep = index === dayOfWeekIndex ? maximum : maximum - minimum + 1;
      if (stepParts.length === 2 && Number(stepParts[1]) > maximumStep) return false;
      const base = stepParts[0];
      const rangeParts = base.split("-");
      const isAtom = (token) => /^(?:\d+|[A-Z]+)$/i.test(token);
      const resolveEndpoint = (token) => {
        if (/^\d+$/.test(token)) return Number(token);
        const upper = token.toUpperCase();
        if (index === monthIndex) return monthOrder.indexOf(upper) + 1 || null;
        if (index === dayOfWeekIndex) {
          const dayIndex = dayOrder.indexOf(upper);
          return dayIndex >= 0 ? dayIndex : null;
        }
        return null;
      };
      const rangeEndpoints = rangeParts.length === 2 && rangeParts.every(isAtom)
        ? rangeParts.map(resolveEndpoint)
        : null;
      const isRange = Boolean(
        rangeEndpoints
        && rangeEndpoints.every((endpoint) => endpoint !== null)
        && rangeEndpoints[0] <= rangeEndpoints[1],
      );
      const isDayOfMonthModifier = index === dayOfMonthIndex && /^(?:L|LW|\d+W)$/i.test(base);
      const isDayOfWeekModifier = index === dayOfWeekIndex
        && /^(?:(?:[0-7]|SUN|MON|TUE|WED|THU|FRI|SAT)L|(?:\d+|[A-Z]+)#[1-5])$/i.test(base);
      const isBareModifier = (index === dayOfMonthIndex && /^W$/i.test(base))
        || (index === dayOfWeekIndex && /^L$/i.test(base));
      if (!(base === "*" || base === "?" || (isAtom(base) && !isBareModifier) || isRange || isDayOfMonthModifier || isDayOfWeekModifier)) {
        return false;
      }
      if (stepParts.length === 2 && base !== "*" && !isRange) return false;
      return [...base.matchAll(/\d+/g)].every(([digits]) => {
        const numeric = Number(digits);
        return Number.isSafeInteger(numeric) && numeric >= minimum && numeric <= maximum;
      });
    });
  });
}

function isValidTimeZone(value) {
  if (value === null) return true;
  if (typeof value !== "string" || value.trim().length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return true;
  } catch (_error) {
    return false;
  }
}

/**
 * Select cron specifications whose owning features were explicitly enabled in
 * the authored OpenClaw source config. Runtime defaults never provision jobs.
 *
 * @param {object} sourceConfig
 * @returns {Array<object>}
 */
export function selectEnabledFeatureCronSpecs(sourceConfig) {
  if (!isPlainObject(sourceConfig)) return [];
  const entry = sourceConfig.plugins?.entries?.[PLUGIN_ID];
  if (!isPlainObject(entry) || entry.enabled === false || !isPlainObject(entry.config)) return [];
  const cfg = entry.config;
  // PLUR1BUS features are opt-out: an absent switch means on. Only an
  // explicit `enabled: false` keeps a feature and its cron out.
  const explicitlyEnabled = (featureConfig) => featureConfig?.enabled !== false;
  const enabledFeatures = new Set();

  if (explicitlyEnabled(cfg.personaVoice) && explicitlyEnabled(cfg.skillMiner)) {
    enabledFeatures.add("persona-evolve");
  }
  if (explicitlyEnabled(cfg.afterthought) && (explicitlyEnabled(cfg.skillMiner) || explicitlyEnabled(cfg.merging))) {
    enabledFeatures.add("afterthought");
  }
  if (explicitlyEnabled(cfg.dailyConsolidation)) enabledFeatures.add("consolidate-daily");
  if (explicitlyEnabled(cfg.criticalPush)) enabledFeatures.add("classify-recent");
  if (explicitlyEnabled(cfg.merging)) enabledFeatures.add("rem-dream");
  if (explicitlyEnabled(cfg.skillMiner)) enabledFeatures.add("skill-miner");
  if (explicitlyEnabled(cfg.obsidianBridge) && explicitlyEnabled(cfg.obsidianBridge?.graphLinks?.semanticDiscovery)) {
    enabledFeatures.add("discover-semantic-links");
  }
  // Ohne Policy meldet runGcJob `no_policy` und tut nichts; der Cron entsteht
  // jetzt trotzdem, weil gc wie jedes Feature per Default an ist.
  if (explicitlyEnabled(cfg.gc)) enabledFeatures.add("gc-run");

  const selected = [];
  for (const spec of REQUIRED_FEATURE_CRONS) {
    if (!enabledFeatures.has(spec.feature)) continue;
    if (spec.feature === "skill-miner") {
      // Opt-out means a feature can be on without its config object existing,
      // so the schedule override has to tolerate an absent block.
      const skillMinerCfg = cfg.skillMiner ?? {};
      const cron = skillMinerCfg.cron === undefined ? spec.schedule.expr : skillMinerCfg.cron;
      const timezone = skillMinerCfg.timezone === undefined ? spec.timezone : skillMinerCfg.timezone;
      if (!isValidCronExpression(cron) || !isValidTimeZone(timezone)) continue;
      selected.push({ ...spec, schedule: { kind: "cron", expr: cron.trim() }, timezone });
      continue;
    }
    selected.push({ ...spec, schedule: { ...spec.schedule } });
  }
  return selected;
}

/**
 * Contract-Migrationen für BESTEHENDE Jobs. Der Planner fasst existierende
 * Jobs sonst nie wieder an ("already-exists"-Skip). Nur vollständig bekannte,
 * von PLUR1BUS ausgelieferte Carrier-Payloads werden ersetzt; sobald ein
 * Nutzer Prefix, Suffix oder sonstigen Text ergänzt hat, bleibt die Message
 * unangetastet.
 */
export const MESSAGE_CONTRACT_MIGRATIONS = [
  {
    find:
      "/plur1bus internal afterthought\n\n" +
      "Delivery contract: the job returns JSON. If it has a `text` field, " +
      "send exactly that text as the message, verbatim, with no additional " +
      "commentary. If `skipped` is true, output NOTHING at all.",
    replace: "/plur1bus internal afterthought",
  },
  {
    find:
      "/plur1bus internal afterthought\n\n" +
      "Delivery contract: the job returns JSON. If it has a `text` field, " +
      "send exactly that text as the message, verbatim, with no additional " +
      "commentary. If `skipped` is true, reply with exactly NO_REPLY and " +
      "nothing else — do not invent content.",
    replace: "/plur1bus internal afterthought",
  },
  {
    find:
      "/plur1bus internal classify-recent\n\n" +
      "Delivery contract: the job returns JSON. If `pushMessages` is a non-empty array, " +
      "send each array entry verbatim as a separate message, with no additional commentary. " +
      "If `pushMessages` is absent or empty, reply with exactly NO_REPLY and nothing else — " +
      "do not invent content.",
    replace: "/plur1bus internal classify-recent",
  },
];

export const CRON_SAFETY_DISABLED_SUFFIX = " [plur1bus:host-dispatch-unavailable]";
const LEGACY_HOST_RESULT_SEPARATOR = "\n\n[PLUR1BUS] ";

function resolveDirectFeatureCronSpec(message) {
  if (typeof message !== "string") return null;
  const canonicalMessage =
    MESSAGE_CONTRACT_MIGRATIONS.find((candidate) => candidate.find === message)?.replace
    ?? message;
  return REQUIRED_FEATURE_CRONS.find(
    (spec) =>
      (spec.feature === "afterthought" || spec.feature === "classify-recent")
      && spec.message === canonicalMessage,
  ) ?? null;
}

function resolveDirectFeatureCronJobSpec(job) {
  const message = typeof job?.payload?.message === "string"
    ? job.payload.message
    : commandFromNativeFeaturePayload(job?.payload, job?.agentId);
  return resolveDirectFeatureCronSpec(message);
}

/**
 * Match shipped direct-feature messages, including exact legacy carrier
 * contracts and the result envelope injected by PLUR1BUS's previous host
 * dispatcher before it incorrectly continued into the model. Deliberately
 * does not trim or accept other custom prefixes/suffixes.
 *
 * @param {unknown} message
 * @returns {boolean}
 */
export function isGuardedDirectFeatureCronMessage(message) {
  if (resolveDirectFeatureCronSpec(message)) return true;
  if (typeof message !== "string") return false;
  const shippedMessages = new Set([
    ...REQUIRED_FEATURE_CRONS
      .filter((spec) => spec.feature === "afterthought" || spec.feature === "classify-recent")
      .map((spec) => spec.message),
    ...MESSAGE_CONTRACT_MIGRATIONS.map((migration) => migration.find),
  ]);
  for (const shippedMessage of shippedMessages) {
    const envelopePrefix = `${shippedMessage}${LEGACY_HOST_RESULT_SEPARATOR}`;
    if (message.startsWith(envelopePrefix) && message.length > envelopePrefix.length) return true;
  }
  return false;
}

/**
 * Plant ein Message-Update für einen existierenden Job, dessen Message noch
 * einen migrierbaren Alt-Contract enthält. Gibt null zurück, wenn nichts zu
 * migrieren ist oder der Job keine id hat (cron edit braucht die id).
 */
export function planMessageMigration(job) {
  if (!job?.id) return null;
  const message = job.payload?.message;
  if (typeof message !== "string") return null;
  const migration = MESSAGE_CONTRACT_MIGRATIONS.find((candidate) => candidate.find === message);
  if (!migration) return null;
  return { id: job.id, name: job.name ?? "", message: migration.replace };
}

/**
 * Select active, unmistakably PLUR1BUS-owned direct feature jobs that must be
 * disabled when the host dispatcher is unavailable.
 *
 * @param {Array<object>} existingJobs
 * @returns {Array<{id: string, name: string, safetyName: string, disable: true}>}
 */
export function planUnsafeDirectCronDisables(existingJobs) {
  const planned = [];
  const seenIds = new Set();
  for (const job of Array.isArray(existingJobs) ? existingJobs : []) {
    if (job?.enabled === false || typeof job?.id !== "string" || job.id.length === 0) continue;
    const spec = resolveDirectFeatureCronJobSpec(job);
    if (!spec) continue;
    const canonicalPerAgentName = typeof job?.agentId === "string" && job.agentId.length > 0
      ? `${spec.name} ${job.agentId}`
      : null;
    const originalName = job?.name?.endsWith?.(CRON_SAFETY_DISABLED_SUFFIX)
      ? job.name.slice(0, -CRON_SAFETY_DISABLED_SUFFIX.length)
      : job?.name;
    if (originalName !== spec.name && originalName !== canonicalPerAgentName) continue;
    if (seenIds.has(job.id)) continue;
    seenIds.add(job.id);
    planned.push({
      id: job.id,
      name: originalName,
      safetyName: `${originalName}${CRON_SAFETY_DISABLED_SUFFIX}`,
      disable: true,
    });
  }
  return planned;
}

/**
 * Restore only jobs carrying PLUR1BUS's persisted safety-disable marker after
 * the host dispatcher is healthy again.
 *
 * @param {Array<{spec?: object, existingJob?: object}>} scopedSkips
 * @returns {Array<{id: string, name: string, rename: string, enable: true}>}
 */
export function planSafetyDisabledCronRecoveries(scopedSkips) {
  const recoveries = [];
  for (const entry of Array.isArray(scopedSkips) ? scopedSkips : []) {
    const { spec, existingJob: job } = entry || {};
    if (
      !["afterthought", "classify-recent"].includes(spec?.feature)
      || job?.enabled !== false
      || typeof job?.id !== "string"
      || !job.id
      || typeof job?.name !== "string"
      || !job.name.endsWith(CRON_SAFETY_DISABLED_SUFFIX)
    ) {
      continue;
    }
    if (!normalizeDelivery(job.delivery)) continue;
    const originalName = job.name.slice(0, -CRON_SAFETY_DISABLED_SUFFIX.length);
    if (resolveDirectFeatureCronJobSpec(job)?.message !== spec.message) continue;
    const canonicalPerAgentName = typeof job?.agentId === "string" && job.agentId.length > 0
      ? `${spec.name} ${job.agentId}`
      : null;
    if (originalName !== spec.name && originalName !== canonicalPerAgentName) continue;
    recoveries.push({
      id: job.id,
      name: originalName,
      rename: originalName,
      enable: true,
    });
  }
  return recoveries;
}

function normalize(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

const UNSAFE_DELIVERY_SENTINELS = new Set([
  "*",
  "***",
  "last",
  "default",
  "none",
  "null",
  "undefined",
  "auto",
  "__openclaw_redacted__",
]);

function normalizedConcreteString(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  if (!text || UNSAFE_DELIVERY_SENTINELS.has(text.toLowerCase())) return null;
  if (/[\u0000-\u001f\u007f]/.test(text)) return null;
  if (/\$\{|\{\{|\}\}|<[^>]*>|\[redacted\]/i.test(text)) return null;
  return text;
}

function normalizeAccountId(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const accountId = String(value).trim();
  if (!accountId || /\s/.test(accountId)) return null;
  if (["*", "***", "last", "none", "null", "undefined", "auto", "__openclaw_redacted__"].includes(accountId.toLowerCase())) {
    return null;
  }
  if (/\$\{|\{\{|\}\}|<[^>]*>|\[redacted\]/i.test(accountId)) return null;
  return accountId;
}

function normalizeChannel(value) {
  const channel = normalizedConcreteString(value)?.toLowerCase() || null;
  if (!channel || /\s/.test(channel)) return null;
  return channel;
}

function normalizeTelegramTarget(value, peerKind = null) {
  let target = normalizedConcreteString(value);
  if (!target || /\s/.test(target)) return null;

  target = target.replace(/^(?:telegram|tg):/i, "");
  target = target.replace(/^group:/i, "");
  target = normalizedConcreteString(target);
  if (!target || /\s/.test(target)) return null;
  const urlMatch = /^(?:(?:https?:\/\/)?(?:www\.)?)t\.me\/([a-z0-9_]{5,})(?:\/\d+)?$/i.exec(target);
  if (urlMatch) {
    const handle = normalizedConcreteString(urlMatch[1]);
    if (!handle) return null;
    target = `@${handle}`;
  }

  const numericMatch = /^(-?\d+)(?:(?::topic:|:)\d+)?$/i.exec(target);
  if (numericMatch) {
    const numericId = numericMatch[1];
    if (/^-?0+$/.test(numericId)) return null;
    if (peerKind === "direct" && numericId.startsWith("-")) return null;
    if ((peerKind === "group" || peerKind === "channel") && !numericId.startsWith("-")) return null;
    return target;
  }

  const handleMatch = /^@?([a-z0-9_]{5,})$/i.exec(target);
  if (!handleMatch) return null;
  return target.startsWith("@") ? target : `@${handleMatch[1]}`;
}

function normalizeOutboundTarget(channel, value, peerKind = null) {
  if (channel === "telegram") return normalizeTelegramTarget(value, peerKind);
  return null;
}

function normalizeDelivery(delivery) {
  if (!isPlainObject(delivery) || delivery.mode !== "announce") return null;
  const channel = normalizeChannel(delivery.channel);
  if (!channel) return null;
  const to = normalizeOutboundTarget(channel, delivery.to);
  if (!to) return null;
  let accountId;
  if (delivery.accountId !== undefined && delivery.accountId !== null) {
    accountId = normalizeAccountId(delivery.accountId);
    if (!accountId) return null;
  }
  return { channel, to, ...(accountId ? { accountId } : {}) };
}

function firstCommandLine(job) {
  if (typeof job?.payload?.message === "string") {
    return job.payload.message.split(/\r?\n/, 1)[0].trim();
  }
  return commandFromNativeFeaturePayload(job?.payload, job?.agentId);
}

/**
 * Does an existing job satisfy the exact per-agent identity? Ownership is
 * case-sensitive. Consolidation jobs require the canonical name and exact
 * command together because they are eligible for schedule migration. Other
 * jobs retain compatibility with the legacy name-or-command identity.
 */
function matchesPerAgent(job, spec, agentId) {
  if (job?.agentId !== agentId) return false;
  const canonicalName = `${spec.name} ${agentId}`;
  const firstMessageLine = firstCommandLine(job);
  const nameMatches = job?.name === canonicalName;
  const commandMatches = Boolean(firstMessageLine) && firstMessageLine === spec.command;
  return spec?.feature === "consolidate-daily"
    ? nameMatches && commandMatches
    : nameMatches || commandMatches;
}

function matchesLegacyOwned(job, spec, agentId) {
  if (typeof agentId !== "string" || agentId.length === 0 || job?.agentId !== agentId) return false;
  const nameMatches = job?.name === spec?.name;
  const commandMatches = firstCommandLine(job) === spec?.command;
  return spec?.feature === "consolidate-daily"
    ? nameMatches && commandMatches
    : nameMatches || commandMatches;
}

/**
 * Is `job` the pre-multi-agent, non-suffixed legacy job for `spec`
 * ("plur1bus persona-evolve" / "plur1bus afterthought", exact name)? Such a
 * job is treated as satisfying the DEFAULT agent's per-agent spec only, so
 * upgrading an existing single-agent install to multi-agent never creates a
 * duplicate alongside it.
 */
function isLegacyExactMatch(job, spec, agentId) {
  if (job?.agentId !== agentId || job?.name !== spec?.name) return false;
  if (spec?.feature === "consolidate-daily") return firstCommandLine(job) === spec.command;
  return true;
}

/**
 * Stagger a weekly cron schedule deterministically by agent index, so N
 * agents' persona-evolve jobs don't all fire at the same instant
 * (thundering herd against the same LanceDB/embedding backend). Adds
 * `agentIndex * 5` minutes to the base hour:minute, wrapping within the
 * day. Non-cron schedules pass through unchanged.
 */
function staggerCronSchedule(baseSchedule, agentIndex, minutesPerAgent) {
  if (!baseSchedule || baseSchedule.kind !== "cron" || !Number.isFinite(agentIndex)) {
    return baseSchedule;
  }
  const match = /^(\d{1,2})\s+(\d{1,2})\s+(.*)$/.exec(baseSchedule.expr || "");
  if (!match) return baseSchedule;
  const [, minStr, hourStr, rest] = match;
  const totalMinutes = parseInt(minStr, 10)
    + parseInt(hourStr, 10) * 60
    + Math.max(0, agentIndex) * minutesPerAgent;
  const newHour = Math.floor(totalMinutes / 60) % 24;
  const newMin = totalMinutes % 60;
  return { kind: "cron", expr: `${newMin} ${newHour} ${rest}` };
}

export function staggerPersonaEvolveSchedule(baseSchedule, agentIndex) {
  return staggerCronSchedule(baseSchedule, agentIndex, 5);
}

/**
 * Staggers daily consolidation by 15 minutes per selected agent.
 *
 * @param {object} baseSchedule
 * @param {number} agentIndex
 * @returns {object}
 */
export function staggerConsolidationSchedule(baseSchedule, agentIndex) {
  return staggerCronSchedule(baseSchedule, agentIndex, 15);
}

/**
 * Staggers the weekly skill miner by 15 minutes per selected agent.
 *
 * Ohne Versatz starten alle Agenten-Läufe auf derselben Minute. Live bestätigt
 * (16.08.2026): drei gleichzeitige isolierte Läufe brachen alle am
 * 60-Sekunden-Watchdog ab (`stalled before execution start`), ohne ein einziges
 * Ergebnis zu liefern. 15 Minuten, weil der Job den gesamten Bestand scannt und
 * pro Cluster ein LLM befragt.
 *
 * @param {object} baseSchedule
 * @param {number} agentIndex
 * @returns {object}
 */
export function staggerSkillMinerSchedule(baseSchedule, agentIndex) {
  return staggerCronSchedule(baseSchedule, agentIndex, 15);
}

/**
 * Staggers the nightly REM dream by 15 minutes per selected agent.
 *
 * Derselbe Grund wie beim Skill Miner: die Mustererkennung liest den
 * Wochenbestand und ruft je Cluster ein LLM. Auf dieser Installation war der
 * Versatz von Hand nachgetragen — der Installer hätte alle Agenten auf dieselbe
 * Minute gelegt.
 *
 * @param {object} baseSchedule
 * @param {number} agentIndex
 * @returns {object}
 */
export function staggerRemDreamSchedule(baseSchedule, agentIndex) {
  return staggerCronSchedule(baseSchedule, agentIndex, 15);
}

/**
 * Staggers semantic link discovery by 10 minutes per selected agent.
 *
 * @param {object} baseSchedule
 * @param {number} agentIndex
 * @returns {object}
 */
export function staggerSemanticDiscoverySchedule(baseSchedule, agentIndex) {
  return staggerCronSchedule(baseSchedule, agentIndex, 10);
}

/**
 * Jeder per-Agent geplante Job braucht einen Versatz — sonst starten auf einer
 * Mehr-Agenten-Installation N isolierte Läufe auf derselben Minute und laufen
 * in den 60-Sekunden-Watchdog. Wer hier fehlt, kollidiert; der Test
 * `feature-cron-fresh-install-collisions` prüft das für alle Specs.
 */
const STAGGER_BY_FEATURE = {
  "persona-evolve": staggerPersonaEvolveSchedule,
  "consolidate-daily": staggerConsolidationSchedule,
  "skill-miner": staggerSkillMinerSchedule,
  "rem-dream": staggerRemDreamSchedule,
  "discover-semantic-links": staggerSemanticDiscoverySchedule,
};

/**
 * Derive a delivery target for an `agentId` delivery-required cron from its
 * other existing crons — never guessed or hardcoded. Looks at every existing
 * job belonging to `agentId` with a validated delivery target. Every safe
 * candidate must agree on channel, target, and account; conflicting targets
 * or no candidates return null (caller falls back to created-but-disabled).
 *
 * @param {string} agentId
 * @param {Array<object>} existingJobs
 * @returns {{channel: string, to: string, accountId?: string} | null}
 */
export function deriveAgentDelivery(agentId, existingJobs) {
  const jobs = Array.isArray(existingJobs) ? existingJobs : [];
  if (typeof agentId !== "string" || agentId.length === 0) return null;

  const candidates = jobs.flatMap((job) => {
    if (job?.agentId !== agentId) return [];
    // Disabled jobs (e.g. a decommissioned cron the operator turned off
    // rather than deleted) must not seed a "live" delivery target — their
    // `to` may be stale (old chat, departed account). Missing `enabled`
    // counts as enabled (older cron-list shapes never had the field).
    if (job?.enabled === false) return [];
    const delivery = normalizeDelivery(job?.delivery);
    return delivery ? [{ job, delivery }] : [];
  });
  if (candidates.length === 0) return null;

  const keyOf = ({ delivery }) =>
    JSON.stringify([delivery.channel, delivery.to, Object.hasOwn(delivery, "accountId") ? delivery.accountId : null]);
  const firstKey = keyOf(candidates[0]);
  const allAgree = candidates.every((candidate) => keyOf(candidate) === firstKey);
  if (!allAgree) return null;

  return { ...candidates[0].delivery };
}

/**
 * Fallback delivery derivation from OpenClaw's effective runtime config when no
 * existing cron carries a safe target. Sender allowlists are never outbound
 * targets: only a concrete binding peer or effective `defaultTo` is eligible.
 *
 * @param {string} agentId
 * @param {{bindings?: Array<object>, channels?: object} | null} config
 * @returns {{channel: string, to: string, accountId: string} | null}
 */
export function deriveDeliveryFromChannelConfig(agentId, config) {
  if (typeof agentId !== "string" || agentId.length === 0 || !isPlainObject(config)) return null;
  const bindings = Array.isArray(config.bindings) ? config.bindings : [];
  const relevantBindings = bindings.filter(
    (binding) => binding?.type !== "acp" && binding?.agentId === agentId,
  );
  if (relevantBindings.length === 0) return null;
  const bindingChannels = relevantBindings.map((binding) => normalizeChannel(binding?.match?.channel));
  if (!bindingChannels[0] || !bindingChannels.every((channel) => channel === bindingChannels[0])) return null;
  if (bindingChannels[0] !== "telegram") return null;

  const telegram = config.channels?.telegram;
  if (!isPlainObject(telegram) || telegram.enabled === false) return null;
  const accounts = isPlainObject(telegram.accounts) ? telegram.accounts : {};
  const configuredAccountIds = Object.keys(accounts);
  const hasExplicitDefaultAccount = Object.hasOwn(telegram, "defaultAccount");
  const explicitDefaultAccount = hasExplicitDefaultAccount ? normalizeAccountId(telegram.defaultAccount) : null;
  if (hasExplicitDefaultAccount && !explicitDefaultAccount) return null;
  const hasRootAccount = hasTelegramRootAccountEvidence(telegram);
  let implicitDefaultAccount = null;
  let implicitAccountSource = null;
  if (explicitDefaultAccount) {
    implicitDefaultAccount = explicitDefaultAccount;
    implicitAccountSource = "explicit";
  } else if (Object.hasOwn(accounts, "default")) {
    implicitDefaultAccount = "default";
    implicitAccountSource = "configured-default";
  } else if (configuredAccountIds.length === 1) {
    [implicitDefaultAccount] = configuredAccountIds;
    implicitAccountSource = "sole-named";
  } else if (hasRootAccount) {
    implicitDefaultAccount = "default";
    implicitAccountSource = "root";
  }
  if (!implicitDefaultAccount) return null;

  const candidates = [];
  for (const binding of relevantBindings) {
    const rawAccountId = binding.match?.accountId;
    const hasExplicitBindingAccount = isPlainObject(binding.match) && Object.hasOwn(binding.match, "accountId");
    const accountId = !hasExplicitBindingAccount
      ? implicitDefaultAccount
      : normalizeAccountId(rawAccountId);
    if (!accountId) return null;

    const account = accounts[accountId];
    if (account !== undefined && !isPlainObject(account)) return null;
    const explicitlySelectsRoot = hasExplicitBindingAccount && accountId === "default";
    const inheritsRoot = !hasExplicitBindingAccount && ["explicit", "root"].includes(implicitAccountSource);
    const usesRootAccount = accountId === "default" && hasRootAccount && (explicitlySelectsRoot || inheritsRoot);
    if (account === undefined && !usesRootAccount) {
      return null;
    }
    if (account?.enabled === false) return null;

    const peer = binding.match?.peer;
    let peerKind = null;
    let to = null;
    if (peer !== undefined) {
      if (!isPlainObject(peer) || !["direct", "group", "channel"].includes(peer.kind)) return null;
      peerKind = peer.kind;
      to = normalizeOutboundTarget("telegram", peer.id, peerKind);
    } else {
      const defaultTo = account && Object.hasOwn(account, "defaultTo") ? account.defaultTo : telegram.defaultTo;
      to = normalizeOutboundTarget("telegram", defaultTo);
    }
    if (!to) return null;
    candidates.push({ channel: "telegram", to, accountId, peerKind });
  }

  const first = candidates[0];
  const firstKey = JSON.stringify([first.channel, first.to, first.accountId, first.peerKind]);
  if (!candidates.every((candidate) =>
    JSON.stringify([candidate.channel, candidate.to, candidate.accountId, candidate.peerKind]) === firstKey)) {
    return null;
  }
  return { channel: first.channel, to: first.to, accountId: first.accountId };
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
    `openclaw cron edit --name "${specName}" --agent <id> --account <account> ` +
    `--announce --channel telegram --to <chatId>, ` +
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
function planSpecForAgents(jobs, spec, agents, channelConfig = null, accountConstraint = null) {
  const create = [];
  const skip = [];

  // Singleton-Specs laufen genau einmal, unabhängig von der Agentenzahl:
  // `runGcJob` iteriert selbst über alle Agent-Datenbanken, ein Job je Agent
  // würde denselben Bestand N-mal durcharbeiten — gleichzeitig, zur selben
  // Minute. Der erste (voreingestellte) Agent trägt den Job.
  const zielAgenten = spec.singleton ? agents.slice(0, 1) : agents;

  zielAgenten.forEach((agentEntry, agentIndex) => {
    const agentId = agentEntry.id;
    const isDefault = Boolean(agentEntry.isDefault);
    const perAgentName = `${spec.name} ${agentId}`;

    const ownedJobs = jobs.filter(
      (job) => (isDefault && isLegacyExactMatch(job, spec, agentId)) || matchesPerAgent(job, spec, agentId),
    );
    if (ownedJobs.length > 0) {
      for (const existingJob of ownedJobs) {
        skip.push({
          spec: { ...spec, name: perAgentName, agentId, agentIndex },
          reason: isLegacyExactMatch(existingJob, spec, agentId) ? "legacy" : "already-exists",
          existingJob,
        });
      }
      return;
    }

    let enabled = true;
    let delivery = null;
    let hint;
    if (spec.needsDelivery) {
      delivery = deriveAgentDelivery(agentId, jobs) || deriveDeliveryFromChannelConfig(agentId, channelConfig);
      if (accountConstraint && delivery?.accountId !== accountConstraint) delivery = null;
      if (!delivery) {
        enabled = false;
        hint = buildAgentHint(perAgentName, agentId);
      }
    }

    const schedule = STAGGER_BY_FEATURE[spec.feature]
      ? STAGGER_BY_FEATURE[spec.feature](spec.schedule, agentIndex)
      : spec.schedule;

    create.push({
      name: perAgentName,
      feature: spec.feature,
      command: spec.command,
      message: spec.message,
      description: spec.description,
      schedule,
      timezone: spec.timezone ?? null,
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
 *   already filtered to bound agents and deduplicated to one per workspace):
 *   plans each selected feature spec for every agent and derives safe
 *   delivery only for specs that require it.
 * - Legacy single-agent (no `opts.agents`, only `opts.agent`/`opts.account`):
 *   plans bare names but recognizes existing jobs only with an exact target
 *   agent plus exact canonical name or first command line.
 *
 * @param {Array<object>} existingJobs
 * @param {Array<object>} specs
 * @param {{agent?: string|null, account?: string|null, agents?: Array<{id: string, isDefault?: boolean}>|null, channelConfig?: object|null}} opts
 * @returns {{create: Array<object>, skip: Array<{spec: object, reason: string, existingJob?: object}>, update: Array<{id: string, name: string, message?: string, noDeliver?: boolean, disable?: boolean}>}}
 */
export function planFeatureCrons(existingJobs, specs, opts = {}) {
  const { agent = null, account = null, agents = null, channelConfig = null } = opts || {};
  const jobs = Array.isArray(existingJobs) ? existingJobs : [];

  if (Array.isArray(agents) && agents.length > 0) {
    const create = [];
    const skip = [];
    for (const spec of specs) {
      const planned = planSpecForAgents(jobs, spec, agents, channelConfig, account);
      create.push(...planned.create);
      skip.push(...planned.skip);
    }
    return { create, skip, update: collectMessageMigrations(skip) };
  }

  const create = [];
  const skip = [];

  for (const spec of specs) {
    const ownedJobs = jobs.filter((job) => matchesLegacyOwned(job, spec, agent));
    if (ownedJobs.length > 0) {
      for (const existingJob of ownedJobs) {
        skip.push({ spec, reason: "already-exists", existingJob });
      }
      continue;
    }

    // Legacy arguments do not prove a concrete recipient. Announce delivery
    // without an explicit channel and target resolves through the unsafe
    // last-active-chat fallback, so delivery jobs remain disabled here.
    const hasDeliveryTarget = false;
    const enabled = spec.needsDelivery ? hasDeliveryTarget : true;

    const planned = {
      name: spec.name,
      feature: spec.feature,
      command: spec.command,
      message: spec.message,
      description: spec.description,
      schedule: spec.schedule,
      timezone: spec.timezone ?? null,
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
 * Plan a fail-closed delivery migration for an owned existing job. Jobs that
 * do not need delivery lose any delivery configuration. Delivery-required
 * jobs with an unsafe configuration are disabled and pinned to no-deliver.
 * Returns null when no migration is required.
 */
export function planDeliveryMigration(job, spec) {
  if (!job?.id) return null;
  const delivery = job.delivery;
  if (spec?.needsDelivery === false) {
    if (delivery === undefined || delivery === null) return null;
    if (isPlainObject(delivery) && delivery.mode === "none") return null;
    return { id: job.id, name: job.name ?? "", noDeliver: true };
  }
  if (spec?.needsDelivery !== true) return null;
  if (normalizeDelivery(delivery)) return null;
  if (job.enabled === false && (!delivery || delivery.mode === "none")) return null;
  return { id: job.id, name: job.name ?? "", noDeliver: true, disable: true };
}

/**
 * Migrate only PLUR1BUS's shipped 30-minute direct-feature cadence.
 * Operator-defined intervals are intentionally left untouched.
 *
 * @param {object} job
 * @param {object} spec
 * @returns {{id: string, name: string, schedule: object, timezone: string|null} | null}
 */
export function planScheduleMigration(job, spec) {
  if (!job?.id || !["afterthought", "classify-recent"].includes(spec?.feature)) return null;
  if (spec?.schedule?.kind !== "every" || job?.schedule?.kind !== "every") return null;
  if (job.schedule.everyMs !== 30 * 60 * 1000) return null;
  if (job.schedule.everyMs === spec.schedule.everyMs) return null;
  return {
    id: job.id,
    name: job.name ?? "",
    schedule: { ...spec.schedule },
  };
}

const SHIPPED_CONSOLIDATION_SCHEDULES = new Set(["0 3 * * *", "0 4 * * *"]);

/**
 * Migrates only an exact PLUR1BUS-owned shipped consolidation cadence to the
 * deterministic schedule for its selected-agent index.
 *
 * @param {object} job
 * @param {object} spec
 * @returns {{id: string, name: string, schedule: object} | null}
 */
export function planConsolidationScheduleMigration(job, spec) {
  if (!job?.id || spec?.feature !== "consolidate-daily") return null;
  if (job?.schedule?.kind !== "cron" || spec?.schedule?.kind !== "cron") return null;
  if (!SHIPPED_CONSOLIDATION_SCHEDULES.has(job.schedule.expr)) return null;
  const target = staggerConsolidationSchedule(spec.schedule, spec.agentIndex ?? 0);
  const currentTimezone = job.schedule.tz ?? job.timezone ?? null;
  const targetTimezone = spec.timezone ?? null;
  if (job.schedule.expr === target.expr && currentTimezone === targetTimezone) return null;
  return {
    id: job.id,
    name: job.name ?? "",
    schedule: target,
    timezone: targetTimezone,
  };
}

/**
 * Sammelt Message- und Delivery-Migrationen über alle geskippten (= bereits
 * existierenden) Jobs, dedupliziert per Job-id — derselbe Job kann mehrere
 * Specs matchen.
 */
function collectMessageMigrations(skip) {
  const byId = new Map();
  const mergeUpdate = (migration) => {
    if (!migration) return;
    byId.set(migration.id, { ...(byId.get(migration.id) || {}), ...migration });
  };
  for (const entry of skip) {
    mergeUpdate(planMessageMigration(entry.existingJob));
    mergeUpdate(planDeliveryMigration(entry.existingJob, entry.spec));
    mergeUpdate(planScheduleMigration(entry.existingJob, entry.spec));
    mergeUpdate(planConsolidationScheduleMigration(entry.existingJob, entry.spec));
  }
  return [...byId.values()];
}
