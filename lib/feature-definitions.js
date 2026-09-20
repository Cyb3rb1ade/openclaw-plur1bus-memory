// The plugin's feature switches: name, config path, default, and the
// capability a feature depends on. Lives in its own module because both the
// control-plane projection and the dashboard settings table read it, and the
// projection also imports the settings — a shared leaf avoids the cycle.
export const FEATURE_DEFINITIONS = Object.freeze([
  { name: "autoCapture", path: ["autoCapture"], defaultValue: true, dependency: "conversationAccess" },
  { name: "autoRecall", path: ["autoRecall"], defaultValue: true },
  { name: "merging", path: ["merging", "enabled"], defaultValue: true },
  { name: "dailyConsolidation", path: ["dailyConsolidation", "enabled"], defaultValue: true },
  // NOT the PLUR1BUS dream engines -- those are gated by neo.enabled below.
  // This key is the legacy compatibility switch for OpenClaw's own memory-core
  // dreaming sidecar, and its schema documents "keep false when PLUR1BUS owns
  // consolidation/dreaming", which it does. It must stay off by default even
  // under an all-features-on profile; nothing in the plugin reads it.
  { name: "dreamingSidecarCompat", path: ["dreaming", "enabled"], defaultValue: false },
  { name: "skillMiner", path: ["skillMiner", "enabled"], defaultValue: true, dependency: "skillWorkshop" },
  { name: "garbageCollection", path: ["gc", "enabled"], defaultValue: true },
  { name: "obsidianBridge", path: ["obsidianBridge", "enabled"], defaultValue: true },
  { name: "featureCronSetup", path: ["featureCronSetup", "auto"], defaultValue: true, dependency: "cronDispatch" },
  { name: "reranker", path: ["reranker", "enabled"], defaultValue: true, dependency: "rerankerRuntime" },
  { name: "emotionTier3", path: ["emotion", "t3", "enabled"], defaultValue: true },
  { name: "knowledgePromotion", path: ["schicht15", "enabled"], defaultValue: true },
  { name: "criticalPush", path: ["criticalPush", "enabled"], defaultValue: true },
  { name: "afterthought", path: ["afterthought", "enabled"], defaultValue: true },
  { name: "personaVoice", path: ["personaVoice", "enabled"], defaultValue: true },
  { name: "dreamEcho", path: ["dreamEcho", "enabled"], defaultValue: true },
  { name: "continuityEngine", path: ["continuityEngine", "enabled"], defaultValue: true },
  { name: "replyOutcomeTracking", path: ["replyOutcomeTracking", "enabled"], defaultValue: true },
  { name: "contradictionDisclosure", path: ["contradictionDisclosure", "enabled"], defaultValue: true },
  { name: "semanticLens", path: ["semanticLens", "enabled"], defaultValue: true },
  { name: "queryRefinement", path: ["recall", "queryRefinement", "enabled"], defaultValue: true },
  { name: "decisionTrace", path: ["trace", "enabled"], defaultValue: true },
  { name: "semanticCompression", path: ["semanticCompression", "enabled"], defaultValue: true },
  { name: "neo", path: ["neo", "enabled"], defaultValue: true },
  { name: "metaCognition", path: ["metaCognition", "enabled"], defaultValue: true },
  { name: "temporalContext", path: ["temporalContext", "enabled"], defaultValue: true },
  // Four features that had no card until 7.15: three are plain switches, one
  // (reactionNudge) is auto|true|false — "auto" counts as on.
  { name: "conversationReactivationRecall", path: ["conversationReactivationRecall", "enabled"], defaultValue: false },
  { name: "reactionNudge", path: ["reactionNudge", "enabled"], defaultValue: true },
  { name: "morningReview", path: ["morningReview", "enabled"], defaultValue: false },
  { name: "eveningReview", path: ["eveningReview", "enabled"], defaultValue: false },
]);
