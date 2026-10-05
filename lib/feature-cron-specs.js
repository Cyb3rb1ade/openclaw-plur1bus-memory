/**
 * lib/feature-cron-specs.js — host-neutral feature-cron job specs.
 *
 * REQUIRED_FEATURE_CRONS is the shipped job table (name, schedule, message).
 * OpenClaw native argv and CLI planning live in lib/setup/feature-cron-*.js;
 * engine/** imports this file so it never reaches those modules.
 */

export const REQUIRED_FEATURE_CRONS = [
  {
    name: "plur1bus persona-evolve",
    feature: "persona-evolve",
    command: "/plur1bus internal persona-evolve",
    message: "/plur1bus internal persona-evolve",
    description: "Daily persona-voice evolution, auto-applied (low-traffic slot); brakes in personaVoice.minDaysBetween/minOutcomes.",
    // 7.12.38: daily 04:15 instead of Sunday 04:15. The weekly slot plus a
    // single marker per run made the profile evolve at most once a week; the
    // brakes now live in evolvePersonaVoice (state file), not in the cadence.
    // Per-agent installs stagger off this base — see staggerPersonaEvolveSchedule.
    // Override via personaVoice.cron / personaVoice.timezone.
    schedule: { kind: "cron", expr: "15 4 * * *" },
    needsDelivery: false,
  },
  {
    name: "plur1bus afterthought",
    feature: "afterthought",
    command: "/plur1bus internal afterthought",
    // OpenClaw cron payload.message is what the job actually runs; keep
    // message equal to command.
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
    name: "plur1bus auto-accept-stale",
    feature: "auto-accept-stale",
    command: "/plur1bus internal auto-accept-stale",
    message: "/plur1bus internal auto-accept-stale",
    description: "Let critical cards nobody confirmed within 24 h lapse to plain notes.",
    schedule: { kind: "cron", expr: "50 4 * * *" },
    timezone: "Europe/Berlin",
    needsDelivery: false,
  },
  {
    name: "plur1bus embedding-drain",
    feature: "embedding-drain",
    command: "/plur1bus internal embedding-drain",
    message: "/plur1bus internal embedding-drain",
    description: "Drain the Neo embedding queue outside the agent_end hook budget.",
    schedule: { kind: "cron", expr: "20 3 * * *" },
    timezone: "Europe/Berlin",
    needsDelivery: false,
  },
  {
    name: "plur1bus emotion-refine",
    feature: "emotion-refine",
    command: "/plur1bus internal emotion-refine",
    message: "/plur1bus internal emotion-refine",
    description: "Refine capture-time emotion scores with the tier-3 LLM classifier outside the agent_end hook.",
    schedule: { kind: "every", everyMs: 60 * 60 * 1000 },
    needsDelivery: false,
  },
  {
    name: "plur1bus post-turn-refine",
    feature: "post-turn-refine",
    command: "/plur1bus internal post-turn-refine",
    message: "/plur1bus internal post-turn-refine",
    description: "Run the queued post-turn light dreams and episode extraction outside the finished turn.",
    schedule: { kind: "every", everyMs: 20 * 60 * 1000 },
    needsDelivery: false,
  },
  {
    name: "plur1bus classify-recent",
    feature: "classify-recent",
    command: "/plur1bus internal classify-recent",
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
    schedule: { kind: "cron", expr: "0 5 * * *" },
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
    schedule: { kind: "cron", expr: "45 4 * * *" },
    timezone: "Europe/Berlin",
    needsDelivery: false,
    singleton: true,
  },
];

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

const LEGACY_HOST_RESULT_SEPARATOR = "\n\n[PLUR1BUS] ";

/**
 * @param {unknown} message
 * @returns {object|null}
 */
export function resolveDirectFeatureCronSpec(message) {
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
