#!/usr/bin/env bash
# plur1bus user hotfixes for OpenClaw 2026.4.29 latency regressions.
#
# Fixes addressed:
# - openclaw/openclaw#75290 and #74860: apply toolsAllow before plugin tool
#   factories run, so embedded memory recalls do not build every plugin tool.
# - openclaw/openclaw#75329 and #75330: keep active-memory from blocking prompt
#   build for setup-grace + recall timeouts.
# - openclaw/openclaw#75375 class: make boot-md startup work non-blocking.
# - openclaw/openclaw#75305 class: avoid empty hidden memory-flush transcript prompt.
# - OpenClaw 2026.4.29 lane regression: isolate normal embedded agent runs by
#   session so Bernhardine/Heisenberg heartbeat work cannot block Bernd/main.
# - OpenClaw 2026.4.29 subagent lane regression: route native subagent
#   dispatch/steer/send work to per-child lanes instead of the global subagent lane.
# - OpenClaw 2026.4.29 startup/interval regression: keep broad heartbeat
#   sweeps from monopolizing the Gateway; targeted heartbeats and due intervals stay enabled.
# - Task registry compatibility: reconcile stale running task zombies before
#   they can spawn CPU-bound recovery children.
# - Kimi coding params: keep user-facing sessions on thinking, but make
#   active-memory's thinking=off recall use Kimi instant temperature 0.6.

set -u

DIST_DIR="${OPENCLAW_DIST_DIR:-/usr/lib/node_modules/openclaw/dist}"
STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
CONFIG_FILE="${OPENCLAW_CONFIG_FILE:-$STATE_DIR/openclaw.json}"
STAMP="$(date +%Y%m%d%H%M%S)"
rc=0

patch_silent_reply_config() {
  python3 - "$CONFIG_FILE" "$STAMP" <<'PYEOF'
import json
import os
import shutil
import sys

config_file = sys.argv[1]
stamp = sys.argv[2]

if not os.path.exists(config_file):
    print(f"[patch] silent-reply direct policy: config not found ({config_file}), skipping")
    raise SystemExit(0)

with open(config_file, "r", encoding="utf-8") as f:
    cfg = json.load(f)

agents = cfg.setdefault("agents", {})
defaults = agents.setdefault("defaults", {})
silent = defaults.setdefault("silentReply", {})
rewrite = defaults.setdefault("silentReplyRewrite", {})

changed = False
for key in ("direct", "group", "internal"):
    if silent.get(key) != "allow":
        silent[key] = "allow"
        changed = True
    if rewrite.get(key) is not False:
        rewrite[key] = False
        changed = True

if changed:
    backup = f"{config_file}.bak-plur1bus-silent-reply-{stamp}"
    shutil.copy2(config_file, backup)
    with open(config_file, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print("[patch] silent-reply direct policy: applied (NO_REPLY stays silent in direct chats)")
else:
    print("[patch] silent-reply direct policy: already configured")
PYEOF
}

patch_reply_visibility_config() {
  python3 - "$CONFIG_FILE" "$STAMP" <<'PYEOF'
import json
import os
import shutil
import sys

config_file = sys.argv[1]
stamp = sys.argv[2]

if not os.path.exists(config_file):
    print(f"[patch] telegram reply visibility policy: config not found ({config_file}), skipping")
    raise SystemExit(0)

with open(config_file, "r", encoding="utf-8") as f:
    cfg = json.load(f)

messages = cfg.setdefault("messages", {})
group_chat = messages.setdefault("groupChat", {})

changed = False
if messages.get("visibleReplies") != "automatic":
    messages["visibleReplies"] = "automatic"
    changed = True
if group_chat.get("visibleReplies") != "automatic":
    group_chat["visibleReplies"] = "automatic"
    changed = True

if changed:
    backup = f"{config_file}.bak-plur1bus-reply-visibility-{stamp}"
    shutil.copy2(config_file, backup)
    with open(config_file, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print("[patch] telegram reply visibility policy: applied (direct=automatic, group=automatic)")
else:
    print("[patch] telegram reply visibility policy: already configured")
PYEOF
}

patch_kimi_coding_provider_config() {
  python3 - "$CONFIG_FILE" "$STAMP" <<'PYEOF'
import json
import os
import shutil
import sys

config_file = sys.argv[1]
stamp = sys.argv[2]

if not os.path.exists(config_file):
    print(f"[patch] kimi-coding provider config: config not found ({config_file}), skipping")
    raise SystemExit(0)

with open(config_file, "r", encoding="utf-8") as f:
    cfg = json.load(f)

providers = cfg.get("models", {}).get("providers", {})
provider = providers.get("kimi-coding")
if not isinstance(provider, dict):
    print("[patch] kimi-coding provider config: provider not configured, skipping")
    raise SystemExit(0)

api = provider.get("api")
base_url = provider.get("baseUrl")
target_base_url = None
if api == "anthropic-messages" and isinstance(base_url, str) and base_url.rstrip("/") == "https://api.kimi.com/coding/v1":
    target_base_url = "https://api.kimi.com/coding/"
elif api == "openai-completions" and isinstance(base_url, str) and base_url.rstrip("/") == "https://api.kimi.com/coding":
    target_base_url = "https://api.kimi.com/coding/v1"

headers = provider.setdefault("headers", {})
needs_header = not isinstance(headers.get("User-Agent"), str) or not headers.get("User-Agent").strip()

if not target_base_url and not needs_header:
    print("[patch] kimi-coding provider config: already consistent")
    raise SystemExit(0)

backup = f"{config_file}.bak-plur1bus-kimi-provider-{stamp}"
shutil.copy2(config_file, backup)
if target_base_url:
    provider["baseUrl"] = target_base_url
if needs_header:
    headers["User-Agent"] = "claude-code/1.0"
with open(config_file, "w", encoding="utf-8") as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
    f.write("\n")
print("[patch] kimi-coding provider config: applied (protocol/baseUrl pair consistent)")
PYEOF
}

patch_kimi_coding_thinking_default() {
  python3 - "$CONFIG_FILE" "$STAMP" <<'PYEOF'
import json
import os
import shutil
import sys

config_file = sys.argv[1]
stamp = sys.argv[2]

if not os.path.exists(config_file):
    print(f"[patch] kimi-coding thinking default: config not found ({config_file}), skipping")
    raise SystemExit(0)

with open(config_file, "r", encoding="utf-8") as f:
    cfg = json.load(f)

agents = cfg.setdefault("agents", {})
defaults = agents.setdefault("defaults", {})
primary = (defaults.get("model") or {}).get("primary") if isinstance(defaults.get("model"), dict) else None
def model_refs(raw):
    if isinstance(raw, str):
        return [raw]
    if isinstance(raw, dict):
        refs = []
        if isinstance(raw.get("primary"), str):
            refs.append(raw["primary"])
        if isinstance(raw.get("fallbacks"), list):
            refs.extend([x for x in raw["fallbacks"] if isinstance(x, str)])
        return refs
    return []

agent_models = []
for agent in agents.get("list", []):
    if isinstance(agent, dict):
        agent_models.extend(model_refs(agent.get("model")))
uses_kimi_coding = str(primary or "").startswith("kimi-coding/") or any(model.startswith("kimi-coding/") for model in agent_models)

if not uses_kimi_coding:
    print("[patch] kimi-coding thinking default: no kimi-coding models configured, skipping")
    raise SystemExit(0)

if defaults.get("thinkingDefault") == "low":
    print("[patch] kimi-coding thinking default: already configured")
    raise SystemExit(0)

backup = f"{config_file}.bak-plur1bus-kimi-thinking-{stamp}"
shutil.copy2(config_file, backup)
defaults["thinkingDefault"] = "low"
with open(config_file, "w", encoding="utf-8") as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
    f.write("\n")
print("[patch] kimi-coding thinking default: applied (agents.defaults.thinkingDefault=low)")
PYEOF
}

patch_stale_task_zombies() {
  python3 - "$STATE_DIR" "$STAMP" <<'PYEOF'
import os
import shutil
import sqlite3
import sys
import time

state_dir = sys.argv[1]
stamp = sys.argv[2]
db_path = os.path.join(state_dir, "tasks", "runs.sqlite")

if not os.path.exists(db_path):
    print(f"[patch] stale task zombies: task DB not found ({db_path}), skipping")
    raise SystemExit(0)

now_ms = int(time.time() * 1000)
cutoff_ms = now_ms - 24 * 60 * 60 * 1000

con = sqlite3.connect(db_path, timeout=5)
try:
    cur = con.cursor()
    cur.execute(
        "select count(*) from task_runs where status = 'running' and coalesce(last_event_at, started_at, created_at, 0) < ?",
        (cutoff_ms,),
    )
    count = int(cur.fetchone()[0] or 0)
    if count <= 0:
        print("[patch] stale task zombies: none")
        raise SystemExit(0)

    backup = f"{db_path}.bak-stale-running-{stamp}"
    shutil.copy2(db_path, backup)
    cur.execute(
        """
        update task_runs
           set status = 'lost',
               ended_at = coalesce(ended_at, ?),
               last_event_at = ?,
               cleanup_after = ?,
               error = coalesce(error, 'stale running task reconciled by plur1bus hotfix')
         where status = 'running'
           and coalesce(last_event_at, started_at, created_at, 0) < ?
        """,
        (now_ms, now_ms, now_ms + 7 * 24 * 60 * 60 * 1000, cutoff_ms),
    )
    con.commit()
    print(f"[patch] stale task zombies: reconciled {count} running task(s)")
    print(f"[patch] backup: {backup}")
finally:
    con.close()
PYEOF
}

patch_openclaw_20260429_latency() {
  python3 - "$DIST_DIR" "$STAMP" <<'PYEOF'
import glob
import os
import re
import shutil
import sys

dist = sys.argv[1]
stamp = sys.argv[2]
backed = set()

def read(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()

def write(path, code):
    if path not in backed:
        shutil.copy2(path, f"{path}.bak-plur1bus-{stamp}")
        backed.add(path)
    with open(path, "w", encoding="utf-8") as f:
        f.write(code)

def find_one(pattern, predicate, label, required=True):
    for path in sorted(glob.glob(os.path.join(dist, pattern))):
        try:
            code = read(path)
        except OSError:
            continue
        if predicate(code):
            return path
    if required:
        raise RuntimeError(f"{label}: target not found")
    return None

def replace_once(path, marker, old, new, label):
    code = read(path)
    if marker in code:
        print(f"[patch] {label}: already patched ({os.path.basename(path)})")
        return
    if old not in code:
        raise RuntimeError(f"{label}: anchor not found ({os.path.basename(path)})")
    write(path, code.replace(old, new, 1))
    print(f"[patch] {label}: applied ({os.path.basename(path)})")

def regex_once(path, marker, pattern, repl, label):
    code = read(path)
    if marker in code:
        print(f"[patch] {label}: already patched ({os.path.basename(path)})")
        return
    next_code, count = re.subn(pattern, repl, code, count=1, flags=re.S)
    if count != 1:
        raise RuntimeError(f"{label}: anchor not found ({os.path.basename(path)})")
    write(path, next_code)
    print(f"[patch] {label}: applied ({os.path.basename(path)})")

for stream_path in sorted(glob.glob(os.path.join(dist, "stream-*.js"))):
    code = read(stream_path)
    marker = "kimi-coding fixed-temp thinking payload"
    old = '''function createKimiThinkingWrapper(baseStreamFn, thinkingType) {
\tconst underlying = baseStreamFn ?? streamSimple;
\treturn (model, context, options) => streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
\t\tpayloadObj.thinking = { type: thinkingType };
\t\tdelete payloadObj.reasoning;
\t\tdelete payloadObj.reasoning_effort;
\t\tdelete payloadObj.reasoningEffort;
\t});
}'''
    new = '''function createKimiThinkingWrapper(baseStreamFn, thinkingType) {
\tconst underlying = baseStreamFn ?? streamSimple;
\treturn (model, context, options) => streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
\t\tconst _kcp = typeof model?.provider === "string" ? model.provider.trim().toLowerCase() : "";
\t\tconst _kc = _kcp === "kimi-coding" || _kcp === "kimi" || _kcp === "kimi-code";
\t\tpayloadObj.thinking = _kc && thinkingType === "enabled" ? { type: thinkingType, budget_tokens: 16384 } : { type: thinkingType };
\t\tif (_kc) {
\t\t\tpayloadObj.temperature = thinkingType === "disabled" ? 0.6 : 1.0;
\t\t\tpayloadObj.top_p = 0.95;
\t\t} /* kimi-coding fixed-temp thinking payload */
\t\tdelete payloadObj.reasoning;
\t\tdelete payloadObj.reasoning_effort;
\t\tdelete payloadObj.reasoningEffort;
\t});
}'''
    legacy = '''\t\tconst _kc = typeof model?.provider === "string" && model.provider.trim().toLowerCase() === "kimi-coding";
\t\tpayloadObj.thinking = _kc ? { type: thinkingType, budget_tokens: 16384 } : { type: thinkingType };
\t\tif (_kc) payloadObj.temperature = 1.0;'''
    fixed_legacy = '''\t\tconst _kcp = typeof model?.provider === "string" ? model.provider.trim().toLowerCase() : "";
\t\tconst _kc = _kcp === "kimi-coding" || _kcp === "kimi" || _kcp === "kimi-code";
\t\tpayloadObj.thinking = _kc && thinkingType === "enabled" ? { type: thinkingType, budget_tokens: 16384 } : { type: thinkingType };
\t\tif (_kc) {
\t\t\tpayloadObj.temperature = thinkingType === "disabled" ? 0.6 : 1.0;
\t\t\tpayloadObj.top_p = 0.95;
\t\t} /* kimi-coding fixed-temp thinking payload */'''
    if marker in code:
        alias_old = 'const _kc = typeof model?.provider === "string" && model.provider.trim().toLowerCase() === "kimi-coding";'
        alias_new = 'const _kcp = typeof model?.provider === "string" ? model.provider.trim().toLowerCase() : "";\\n\\t\\tconst _kc = _kcp === "kimi-coding" || _kcp === "kimi" || _kcp === "kimi-code";'
        if alias_old in code:
            write(stream_path, code.replace(alias_old, alias_new, 1))
            print(f"[patch] kimi provider thinking payload: upgraded provider aliases ({os.path.basename(stream_path)})")
        else:
            print(f"[patch] kimi provider thinking payload: already patched ({os.path.basename(stream_path)})")
        break
    if legacy in code:
        write(stream_path, code.replace(legacy, fixed_legacy, 1))
        print(f"[patch] kimi provider thinking payload: fixed legacy temperature ({os.path.basename(stream_path)})")
        break
    if old in code:
        write(stream_path, code.replace(old, new, 1))
        print(f"[patch] kimi provider thinking payload: applied ({os.path.basename(stream_path)})")
        break
else:
    print("[patch] kimi provider thinking payload: stream wrapper not found, skipping")

selection = find_one(
    "selection-*.js",
    lambda c: "async function runEmbeddedAttempt" in c and "createOpenClawCodingTools({" in c,
    "selection toolsAllow prefilter",
)
regex_once(
    selection,
    "plur1bus-openclaw-20260429-toolsallow-prefilter",
    r"(\n\t+const toolsRaw = params\.disableTools \|\| isRawModelRun \? \[\] : applyEmbeddedAttemptToolsAllow\(createOpenClawCodingTools\(\{\n)(\t+agentId: sessionAgentId,)",
    r"\1\t\t\ttoolsAllow: params.toolsAllow, /* plur1bus-openclaw-20260429-toolsallow-prefilter */\n\2",
    "selection toolsAllow prefilter",
)

pi_tools = find_one(
    "pi-tools-*.js",
    lambda c: "function createOpenClawCodingTools" in c and "pluginToolAllowlist: collectExplicitAllowlist" in c,
    "pi-tools runtime allowlist",
)
replace_once(
    pi_tools,
    "plur1bus-openclaw-20260429-runtime-toolsallow-policy",
    "\tconst subagentPolicy = options?.sessionKey && isSubagentEnvelopeSession(options.sessionKey, {\n"
    "\t\tcfg: options.config,\n"
    "\t\tstore: subagentStore\n"
    "\t}) ? resolveSubagentToolPolicyForSession(options.config, options.sessionKey, { store: subagentStore }) : void 0;",
    "\tconst subagentPolicy = options?.sessionKey && isSubagentEnvelopeSession(options.sessionKey, {\n"
    "\t\tcfg: options.config,\n"
    "\t\tstore: subagentStore\n"
    "\t}) ? resolveSubagentToolPolicyForSession(options.config, options.sessionKey, { store: subagentStore }) : void 0;\n"
    "\tconst runtimeToolsAllowPolicy = Array.isArray(options?.toolsAllow) ? { allow: options.toolsAllow } : void 0; /* plur1bus-openclaw-20260429-runtime-toolsallow-policy */",
    "pi-tools runtime toolsAllow policy",
)
code = read(pi_tools)
if "runtimeToolsAllowPolicy\n\t\t\t])" in code or "runtimeToolsAllowPolicy\r\n\t\t\t])" in code:
    print(f"[patch] pi-tools plugin allowlist: already patched ({os.path.basename(pi_tools)})")
else:
    old = (
        "\t\t\t\tgroupPolicy,\n"
        "\t\t\t\tsandboxToolPolicy,\n"
        "\t\t\t\tsubagentPolicy\n"
        "\t\t\t]),"
    )
    new = (
        "\t\t\t\tgroupPolicy,\n"
        "\t\t\t\tsandboxToolPolicy,\n"
        "\t\t\t\tsubagentPolicy,\n"
        "\t\t\t\truntimeToolsAllowPolicy\n"
        "\t\t\t]),"
    )
    if old not in code:
        raise RuntimeError(f"pi-tools plugin allowlist: anchor not found ({os.path.basename(pi_tools)})")
    write(pi_tools, code.replace(old, new, 1))
    print(f"[patch] pi-tools plugin allowlist: applied ({os.path.basename(pi_tools)})")

plugin_tools = find_one(
    "tools-*.js",
    lambda c: "function resolvePluginTools" in c and "function normalizeAllowlist" in c,
    "plugin tool factory prefilter",
)
replace_once(
    plugin_tools,
    "plur1bus-openclaw-20260429-active-registry-reuse",
    'function resolvePluginToolRegistry(params) {\n'
    '\tif (params.allowGatewaySubagentBinding && getActivePluginRegistryKey() && getActivePluginRuntimeSubagentMode() === "gateway-bindable") return getActivePluginRegistry() ?? resolveRuntimePluginRegistry(params.loadOptions);\n'
    '\treturn resolveRuntimePluginRegistry(params.loadOptions);\n'
    '}',
    'function resolvePluginToolRegistry(params) {\n'
    '\tconst activeRegistry = getActivePluginRegistry();\n'
    '\tif (activeRegistry && getActivePluginRegistryKey()) return activeRegistry; /* plur1bus-openclaw-20260429-active-registry-reuse */\n'
    '\tif (params.allowGatewaySubagentBinding && getActivePluginRegistryKey() && getActivePluginRuntimeSubagentMode() === "gateway-bindable") return getActivePluginRegistry() ?? resolveRuntimePluginRegistry(params.loadOptions);\n'
    '\treturn resolveRuntimePluginRegistry(params.loadOptions);\n'
    '}',
    "plugin tool active registry reuse",
)
replace_once(
    plugin_tools,
    "plur1bus-openclaw-20260429-plugin-factory-prefilter",
    'function isOptionalToolAllowed(params) {\n'
    '\tif (params.allowlist.size === 0) return false;\n'
    '\tconst toolName = normalizeToolName(params.toolName);\n'
    '\tif (params.allowlist.has(toolName)) return true;\n'
    '\tconst pluginKey = normalizeToolName(params.pluginId);\n'
    '\tif (params.allowlist.has(pluginKey)) return true;\n'
    '\treturn params.allowlist.has("group:plugins");\n'
    '}',
    'function isOptionalToolAllowed(params) {\n'
    '\tif (params.allowlist.size === 0) return false;\n'
    '\tconst toolName = normalizeToolName(params.toolName);\n'
    '\tif (params.allowlist.has(toolName)) return true;\n'
    '\tconst pluginKey = normalizeToolName(params.pluginId);\n'
    '\tif (params.allowlist.has(pluginKey)) return true;\n'
    '\treturn params.allowlist.has("group:plugins");\n'
    '}\n'
    'function isPluginToolEntryAllowedByAllowlist(entry, allowlist) {\n'
    '\tif (allowlist.size === 0) return true;\n'
    '\tconst pluginKey = normalizeToolName(entry.pluginId);\n'
    '\tif (allowlist.has(pluginKey) || allowlist.has("group:plugins")) return true;\n'
    '\tif (!Array.isArray(entry.names) || entry.names.length === 0) return true;\n'
    '\treturn entry.names.some((name) => allowlist.has(normalizeToolName(name)));\n'
    '} /* plur1bus-openclaw-20260429-plugin-factory-prefilter */',
    "plugin tool factory prefilter helper",
)
replace_once(
    plugin_tools,
    "!isPluginToolEntryAllowedByAllowlist(entry, allowlist)",
    "\t\tif (existingNormalized.has(pluginIdKey)) {\n"
    "\t\t\tconst message = `plugin id conflicts with core tool name (${entry.pluginId})`;",
    "\t\tif (!isPluginToolEntryAllowedByAllowlist(entry, allowlist)) continue;\n"
    "\t\tif (existingNormalized.has(pluginIdKey)) {\n"
    "\t\t\tconst message = `plugin id conflicts with core tool name (${entry.pluginId})`;",
    "plugin tool factory prefilter loop",
)
replace_once(
    plugin_tools,
    "const pluginToolDescriptorCache",
    "const pluginToolMeta = /* @__PURE__ */ new WeakMap();",
    "const pluginToolMeta = /* @__PURE__ */ new WeakMap();\n"
    "const pluginToolDescriptorCache = /* @__PURE__ */ new Map(); /* plur1bus-openclaw-20260429-plugin-descriptor-cache-map */",
    "plugin tool descriptor cache map",
)
replace_once(
    plugin_tools,
    "plur1bus-openclaw-20260429-plugin-descriptor-cache",
    'function readPluginToolName(tool) {\n'
    '\tif (!isRecord(tool)) return "";\n'
    '\treturn typeof tool.name === "string" ? tool.name.trim() : "";\n'
    '}',
    'function readPluginToolName(tool) {\n'
    '\tif (!isRecord(tool)) return "";\n'
    '\treturn typeof tool.name === "string" ? tool.name.trim() : "";\n'
    '}\n'
    'function buildPluginToolDescriptorCacheKey(entry) {\n'
    '\treturn JSON.stringify([entry.pluginId, entry.source, entry.names]);\n'
    '}\n'
    'function clonePluginToolDescriptor(tool) {\n'
    '\tconst { execute, ...descriptor } = tool;\n'
    '\treturn descriptor;\n'
    '}\n'
    'function buildLazyPluginToolFromDescriptor(entry, descriptor, context) {\n'
    '\treturn {\n'
    '\t\t...descriptor,\n'
    '\t\texecute: async (...args) => {\n'
    '\t\t\tconst resolved = entry.factory(context);\n'
    '\t\t\tconst list = Array.isArray(resolved) ? resolved : resolved ? [resolved] : [];\n'
    '\t\t\tconst live = list.find((tool) => readPluginToolName(tool) === descriptor.name);\n'
    '\t\t\tif (!live || typeof live.execute !== "function") throw new Error(`plugin tool unavailable (${entry.pluginId}): ${descriptor.name}`);\n'
    '\t\t\treturn live.execute(...args);\n'
    '\t\t}\n'
    '\t};\n'
    '} /* plur1bus-openclaw-20260429-plugin-descriptor-cache */',
    "plugin tool descriptor cache helpers",
)
replace_once(
    plugin_tools,
    "pluginToolDescriptorCache.get(descriptorCacheKey)",
    '\t\tlet resolved = null;\n'
    '\t\ttry {\n'
    '\t\t\tresolved = entry.factory(params.context);\n'
    '\t\t} catch (err) {\n'
    '\t\t\tcontext.logger.error(`plugin tool failed (${entry.pluginId}): ${String(err)}`);\n'
    '\t\t\tcontinue;\n'
    '\t\t}',
    '\t\tlet resolved = null;\n'
    '\t\tconst descriptorCacheKey = buildPluginToolDescriptorCacheKey(entry);\n'
    '\t\tconst cachedDescriptors = pluginToolDescriptorCache.get(descriptorCacheKey);\n'
    '\t\tif (cachedDescriptors) resolved = cachedDescriptors.map((descriptor) => buildLazyPluginToolFromDescriptor(entry, descriptor, params.context));\n'
    '\t\telse try {\n'
    '\t\t\tresolved = entry.factory(params.context);\n'
    '\t\t} catch (err) {\n'
    '\t\t\tcontext.logger.error(`plugin tool failed (${entry.pluginId}): ${String(err)}`);\n'
    '\t\t\tcontinue;\n'
    '\t\t}',
    "plugin tool descriptor cache lookup",
)
replace_once(
    plugin_tools,
    "pluginToolDescriptorCache.set(descriptorCacheKey",
    '\t\tconst list = entry.optional ? listRaw.filter((tool) => isOptionalToolAllowed({\n'
    '\t\t\ttoolName: readPluginToolName(tool),\n'
    '\t\t\tpluginId: entry.pluginId,\n'
    '\t\t\tallowlist\n'
    '\t\t})) : listRaw;\n'
    '\t\tif (list.length === 0) continue;',
    '\t\tconst list = entry.optional ? listRaw.filter((tool) => isOptionalToolAllowed({\n'
    '\t\t\ttoolName: readPluginToolName(tool),\n'
    '\t\t\tpluginId: entry.pluginId,\n'
    '\t\t\tallowlist\n'
    '\t\t})) : listRaw;\n'
    '\t\tif (!cachedDescriptors && list.length > 0) pluginToolDescriptorCache.set(descriptorCacheKey, list.map((tool) => clonePluginToolDescriptor(tool)));\n'
    '\t\tif (list.length === 0) continue;',
    "plugin tool descriptor cache store",
)

openclaw_tools = find_one(
    "openclaw-tools-*.js",
    lambda c: "function createOpenClawTools(options)" in c and "function createImageGenerateTool" in c,
    "openclaw heavy tool lazy descriptors",
    required=False,
)
if openclaw_tools:
    replace_once(
        openclaw_tools,
        "plur1bus-openclaw-20260429-lazy-heavy-tools",
        "let openClawToolsDeps = { callGateway };",
        "let openClawToolsDeps = { callGateway };\n"
        "function createLazyOpenClawToolDescriptor(descriptor, factory) {\n"
        "\treturn {\n"
        "\t\t...descriptor,\n"
        "\t\texecute: async (...args) => {\n"
        "\t\t\tconst tool = factory();\n"
        "\t\t\tif (!tool || typeof tool.execute !== \"function\") throw new Error(`${descriptor.name} is not available in the current configuration.`);\n"
        "\t\t\treturn tool.execute(...args);\n"
        "\t\t}\n"
        "\t};\n"
        "} /* plur1bus-openclaw-20260429-lazy-heavy-tools */",
        "openclaw heavy tool lazy helper",
    )
    replace_once(
        openclaw_tools,
        "createLazyOpenClawToolDescriptor({\n\t\tlabel: \"Image\",",
        "\tconst imageTool = options?.agentDir?.trim() ? createImageTool({\n"
        "\t\tconfig: options?.config,\n"
        "\t\tagentDir: options.agentDir,\n"
        "\t\tworkspaceDir,\n"
        "\t\tsandbox,\n"
        "\t\tfsPolicy: options?.fsPolicy,\n"
        "\t\tmodelHasVision: options?.modelHasVision\n"
        "\t}) : null;",
        "\tconst imageTool = options?.agentDir?.trim() ? createLazyOpenClawToolDescriptor({\n"
        "\t\tlabel: \"Image\",\n"
        "\t\tname: \"image\",\n"
        "\t\tdescription: options?.modelHasVision ? \"Analyze one or more images with a vision model. Use image for a single path/URL, or images for multiple.\" : \"Analyze one or more images with the configured image model. Provide a prompt describing what to analyze.\",\n"
        "\t\tparameters: Type.Object({\n"
        "\t\t\tprompt: Type.Optional(Type.String()),\n"
        "\t\t\timage: Type.Optional(Type.String({ description: \"Single image path or URL.\" })),\n"
        "\t\t\timages: Type.Optional(Type.Array(Type.String(), { description: \"Multiple image paths or URLs.\" })),\n"
        "\t\t\tmodel: Type.Optional(Type.String()),\n"
        "\t\t\tmaxBytesMb: Type.Optional(Type.Number()),\n"
        "\t\t\tmaxImages: Type.Optional(Type.Number())\n"
        "\t\t})\n"
        "\t}, () => createImageTool({\n"
        "\t\tconfig: options?.config,\n"
        "\t\tagentDir: options.agentDir,\n"
        "\t\tworkspaceDir,\n"
        "\t\tsandbox,\n"
        "\t\tfsPolicy: options?.fsPolicy,\n"
        "\t\tmodelHasVision: options?.modelHasVision\n"
        "\t})) : null;",
        "openclaw image tool lazy descriptor",
    )
    replace_once(
        openclaw_tools,
        "createLazyOpenClawToolDescriptor({\n\t\tlabel: \"Image Generation\",",
        "\tconst imageGenerateTool = createImageGenerateTool({\n"
        "\t\tconfig: options?.config,\n"
        "\t\tagentDir: options?.agentDir,\n"
        "\t\tworkspaceDir,\n"
        "\t\tsandbox,\n"
        "\t\tfsPolicy: options?.fsPolicy\n"
        "\t});",
        "\tconst imageGenerateTool = createLazyOpenClawToolDescriptor({\n"
        "\t\tlabel: \"Image Generation\",\n"
        "\t\tname: \"image_generate\",\n"
        "\t\tdescription: \"Generate new images or edit reference images with the configured or inferred image-generation model. Use action=\\\"list\\\" to inspect registered providers, models, readiness, and auth hints. Generated images are delivered automatically from the tool result as MEDIA paths.\",\n"
        "\t\tparameters: ImageGenerateToolSchema\n"
        "\t}, () => createImageGenerateTool({\n"
        "\t\tconfig: options?.config,\n"
        "\t\tagentDir: options?.agentDir,\n"
        "\t\tworkspaceDir,\n"
        "\t\tsandbox,\n"
        "\t\tfsPolicy: options?.fsPolicy\n"
        "\t}));",
        "openclaw image_generate lazy descriptor",
    )
    replace_once(
        openclaw_tools,
        "createLazyOpenClawToolDescriptor({\n\t\tlabel: \"Video Generation\",",
        "\tconst videoGenerateTool = createVideoGenerateTool({\n"
        "\t\tconfig: options?.config,\n"
        "\t\tagentDir: options?.agentDir,\n"
        "\t\tagentSessionKey: options?.agentSessionKey,\n"
        "\t\trequesterOrigin: deliveryContext ?? void 0,\n"
        "\t\tworkspaceDir,\n"
        "\t\tsandbox,\n"
        "\t\tfsPolicy: options?.fsPolicy\n"
        "\t});",
        "\tconst videoGenerateTool = createLazyOpenClawToolDescriptor({\n"
        "\t\tlabel: \"Video Generation\",\n"
        "\t\tname: \"video_generate\",\n"
        "\t\tdisplaySummary: \"Generate videos\",\n"
        "\t\tdescription: \"Generate videos using configured providers. Generated videos are saved under OpenClaw-managed media storage and delivered automatically as attachments.\",\n"
        "\t\tparameters: VideoGenerateToolSchema\n"
        "\t}, () => createVideoGenerateTool({\n"
        "\t\tconfig: options?.config,\n"
        "\t\tagentDir: options?.agentDir,\n"
        "\t\tagentSessionKey: options?.agentSessionKey,\n"
        "\t\trequesterOrigin: deliveryContext ?? void 0,\n"
        "\t\tworkspaceDir,\n"
        "\t\tsandbox,\n"
        "\t\tfsPolicy: options?.fsPolicy\n"
        "\t}));",
        "openclaw video_generate lazy descriptor",
    )
    replace_once(
        openclaw_tools,
        "createLazyOpenClawToolDescriptor({\n\t\tlabel: \"Music Generation\",",
        "\tconst musicGenerateTool = createMusicGenerateTool({\n"
        "\t\tconfig: options?.config,\n"
        "\t\tagentDir: options?.agentDir,\n"
        "\t\tagentSessionKey: options?.agentSessionKey,\n"
        "\t\trequesterOrigin: deliveryContext ?? void 0,\n"
        "\t\tworkspaceDir,\n"
        "\t\tsandbox,\n"
        "\t\tfsPolicy: options?.fsPolicy\n"
        "\t});",
        "\tconst musicGenerateTool = createLazyOpenClawToolDescriptor({\n"
        "\t\tlabel: \"Music Generation\",\n"
        "\t\tname: \"music_generate\",\n"
        "\t\tdisplaySummary: \"Generate music\",\n"
        "\t\tdescription: \"Generate music using configured providers. Generated tracks are saved under OpenClaw-managed media storage and delivered automatically as attachments.\",\n"
        "\t\tparameters: MusicGenerateToolSchema\n"
        "\t}, () => createMusicGenerateTool({\n"
        "\t\tconfig: options?.config,\n"
        "\t\tagentDir: options?.agentDir,\n"
        "\t\tagentSessionKey: options?.agentSessionKey,\n"
        "\t\trequesterOrigin: deliveryContext ?? void 0,\n"
        "\t\tworkspaceDir,\n"
        "\t\tsandbox,\n"
        "\t\tfsPolicy: options?.fsPolicy\n"
        "\t}));",
        "openclaw music_generate lazy descriptor",
    )
    replace_once(
        openclaw_tools,
        "createLazyOpenClawToolDescriptor({\n\t\tlabel: \"PDF\",",
        "\tconst pdfTool = options?.agentDir?.trim() ? createPdfTool({\n"
        "\t\tconfig: options?.config,\n"
        "\t\tagentDir: options.agentDir,\n"
        "\t\tworkspaceDir,\n"
        "\t\tsandbox,\n"
        "\t\tfsPolicy: options?.fsPolicy\n"
        "\t}) : null;",
        "\tconst pdfTool = options?.agentDir?.trim() ? createLazyOpenClawToolDescriptor({\n"
        "\t\tlabel: \"PDF\",\n"
        "\t\tname: \"pdf\",\n"
        "\t\tdescription: \"Analyze one or more PDF documents with a model. Use pdf for a single path/URL, or pdfs for multiple. Provide a prompt describing what to analyze.\",\n"
        "\t\tparameters: PdfToolSchema\n"
        "\t}, () => createPdfTool({\n"
        "\t\tconfig: options?.config,\n"
        "\t\tagentDir: options.agentDir,\n"
        "\t\tworkspaceDir,\n"
        "\t\tsandbox,\n"
        "\t\tfsPolicy: options?.fsPolicy\n"
        "\t})) : null;",
        "openclaw pdf tool lazy descriptor",
    )
    replace_once(
        openclaw_tools,
        "createLazyOpenClawToolDescriptor({\n\t\tlabel: \"Web Search\",",
        "\tconst webSearchTool = createWebSearchTool({\n"
        "\t\tconfig: options?.config,\n"
        "\t\tsandboxed: options?.sandboxed,\n"
        "\t\truntimeWebSearch: runtimeWebTools?.search\n"
        "\t});",
        "\tconst webSearchTool = createLazyOpenClawToolDescriptor({\n"
        "\t\tlabel: \"Web Search\",\n"
        "\t\tname: \"web_search\",\n"
        "\t\tdescription: \"Search the web with the configured OpenClaw web-search provider.\",\n"
        "\t\tparameters: Type.Object({ query: Type.String({ description: \"Search query.\" }) }, { additionalProperties: true })\n"
        "\t}, () => createWebSearchTool({\n"
        "\t\tconfig: options?.config,\n"
        "\t\tsandboxed: options?.sandboxed,\n"
        "\t\truntimeWebSearch: runtimeWebTools?.search\n"
        "\t}));",
        "openclaw web_search lazy descriptor",
    )
else:
    print("[patch] openclaw heavy tool lazy descriptors: target not found, skipping")

active_memory = os.path.join(dist, "extensions/active-memory/index.js")
if os.path.exists(active_memory):
    replace_once(
        active_memory,
        "plur1bus-openclaw-20260429-no-setup-grace",
        "const DEFAULT_SETUP_GRACE_TIMEOUT_MS = 3e4;",
        "const DEFAULT_SETUP_GRACE_TIMEOUT_MS = 0; /* plur1bus-openclaw-20260429-no-setup-grace */",
        "active-memory setup grace",
    )
    replace_once(
        active_memory,
        "plur1bus-openclaw-20260429-watchdog-cap",
        "\tconst watchdogTimeoutMs = params.config.timeoutMs + setupGraceTimeoutMs;",
        "\tconst watchdogTimeoutMs = params.config.timeoutMs; /* plur1bus-openclaw-20260429-watchdog-cap */",
        "active-memory watchdog cap",
    )
    replace_once(
        active_memory,
        "plur1bus-openclaw-20260429-hook-budget",
        "\t\tconst beforePromptBuildTimeoutMs = config.timeoutMs + setupGraceTimeoutMs;",
        "\t\tconst beforePromptBuildTimeoutMs = Math.min(config.timeoutMs, 3e3); /* plur1bus-openclaw-20260429-hook-budget */",
        "active-memory before_prompt_build budget",
    )
    code = read(active_memory)
    legacy_hook_budget = "\t\tconst beforePromptBuildTimeoutMs = Math.min(config.timeoutMs, Math.max(3e3, Number(config.hookTimeoutMs) || 1e4)); /* plur1bus-openclaw-20260429-hook-budget */"
    if legacy_hook_budget in code:
        write(active_memory, code.replace(
            legacy_hook_budget,
            "\t\tconst beforePromptBuildTimeoutMs = Math.min(config.timeoutMs, 3e3); /* plur1bus-openclaw-20260429-hook-budget */",
            1,
        ))
        print(f"[patch] active-memory before_prompt_build budget: tightened to 3000ms ({os.path.basename(active_memory)})")
    replace_once(
        active_memory,
        "plur1bus-openclaw-20260429-active-memory-lane",
        "\t\t\t\tagentId: params.agentId,\n"
        "\t\t\t\tmessageChannel,",
        "\t\t\t\tagentId: params.agentId,\n"
        "\t\t\t\tlane: \"active-memory\", /* plur1bus-openclaw-20260429-active-memory-lane */\n"
        "\t\t\t\tmessageChannel,",
        "active-memory isolated command lane",
    )
    replace_once(
        active_memory,
        "config: { ...config, timeoutMs: beforePromptBuildTimeoutMs }",
        "\t\t\t\tconst result = await maybeResolveActiveRecall({\n"
        "\t\t\t\t\tapi,\n"
        "\t\t\t\t\tconfig,",
        "\t\t\t\tconst result = await maybeResolveActiveRecall({\n"
        "\t\t\t\t\tapi,\n"
        "\t\t\t\t\tconfig: { ...config, timeoutMs: beforePromptBuildTimeoutMs },",
        "active-memory hook timeout propagation",
    )
else:
    print("[patch] active-memory: target not found, skipping")

subagent_announce = find_one(
    "subagent-announce-delivery-*.js",
    lambda c: "DEFAULT_SUBAGENT_ANNOUNCE_TIMEOUT_MS" in c and "completion direct announce agent call" in c,
    "subagent completion announce backpressure",
    required=False,
)
if subagent_announce:
    replace_once(
        subagent_announce,
        "plur1bus-openclaw-20260429-subagent-announce-timeout-cap",
        "const DEFAULT_SUBAGENT_ANNOUNCE_TIMEOUT_MS = 12e4;",
        "const DEFAULT_SUBAGENT_ANNOUNCE_TIMEOUT_MS = 3e4; /* plur1bus-openclaw-20260429-subagent-announce-timeout-cap */",
        "subagent announce timeout cap",
    )
    replace_once(
        subagent_announce,
        "plur1bus-openclaw-20260429-session-only-announce-short-wait",
        "\t\tlet directAnnounceResponse;\n"
        "\t\ttry {",
        "\t\tconst directAnnounceTimeoutMs = params.expectsCompletionMessage && !deliveryTarget.deliver ? Math.min(announceTimeoutMs, 15000) : announceTimeoutMs; /* plur1bus-openclaw-20260429-session-only-announce-short-wait */\n"
        "\t\tlet directAnnounceResponse;\n"
        "\t\ttry {",
        "subagent session-only completion announce short wait",
    )
    replace_once(
        subagent_announce,
        "plur1bus-openclaw-20260429-session-only-announce-no-final-wait",
        "\t\t\t\t\texpectFinal: true,\n"
        "\t\t\t\t\ttimeoutMs: announceTimeoutMs\n",
        "\t\t\t\t\texpectFinal: deliveryTarget.deliver ? true : false, /* plur1bus-openclaw-20260429-session-only-announce-no-final-wait */\n"
        "\t\t\t\t\ttimeoutMs: directAnnounceTimeoutMs\n",
        "subagent session-only completion announce no final wait",
    )
else:
    print("[patch] subagent completion announce backpressure: target not found, skipping")

subagent_spawn = find_one(
    "subagent-spawn-*.js",
    lambda c: (
        ("lane: AGENT_LANE_SUBAGENT" in c and "childSessionKey" in c)
        or "plur1bus-openclaw-20260429-native-subagent-session-lane" in c
    ),
    "subagent per-child dispatch lane",
    required=False,
)
if subagent_spawn:
    replace_once(
        subagent_spawn,
        "plur1bus-openclaw-20260429-subagent-child-lane-import",
        'import { t as AGENT_LANE_SUBAGENT } from "./lanes-B35PnfP1.js";',
        'import { i as resolveNestedAgentLaneForSession, t as AGENT_LANE_SUBAGENT } from "./lanes-B35PnfP1.js"; /* plur1bus-openclaw-20260429-subagent-child-lane-import */',
        "subagent per-child dispatch lane import",
    )
    replace_once(
        subagent_spawn,
        "plur1bus-openclaw-20260429-native-subagent-session-lane",
        "\t\t\t\tlane: AGENT_LANE_SUBAGENT,",
        "\t\t\t\tlane: resolveNestedAgentLaneForSession(childSessionKey), /* plur1bus-openclaw-20260429-native-subagent-session-lane */",
        "subagent per-child dispatch lane",
    )
else:
    print("[patch] subagent per-child dispatch lane: target not found, skipping")

acp_spawn = find_one(
    "acp-spawn-*.js",
    lambda c: (
        ("lane: AGENT_LANE_SUBAGENT" in c and "sessionKey" in c)
        or "plur1bus-openclaw-20260429-acp-session-lane" in c
    ),
    "ACP per-child dispatch lane",
    required=False,
)
if acp_spawn:
    replace_once(
        acp_spawn,
        "plur1bus-openclaw-20260429-acp-child-lane-import",
        'import { t as AGENT_LANE_SUBAGENT } from "./lanes-B35PnfP1.js";',
        'import { i as resolveNestedAgentLaneForSession, t as AGENT_LANE_SUBAGENT } from "./lanes-B35PnfP1.js"; /* plur1bus-openclaw-20260429-acp-child-lane-import */',
        "ACP per-child dispatch lane import",
    )
    replace_once(
        acp_spawn,
        "plur1bus-openclaw-20260429-acp-session-lane",
        "\t\t\t\tlane: AGENT_LANE_SUBAGENT,",
        "\t\t\t\tlane: resolveNestedAgentLaneForSession(sessionKey), /* plur1bus-openclaw-20260429-acp-session-lane */",
        "ACP per-child dispatch lane",
    )
else:
    print("[patch] ACP per-child dispatch lane: target not found, skipping")

subagent_control = find_one(
    "subagent-control-*.js",
    lambda c: (
        ("lane: AGENT_LANE_SUBAGENT" in c and "targetSessionKey" in c)
        or "plur1bus-openclaw-20260429-subagent-steer-child-lane" in c
        or "plur1bus-openclaw-20260429-subagent-send-child-lane" in c
    ),
    "subagent control per-child lane",
    required=False,
)
if subagent_control:
    replace_once(
        subagent_control,
        "plur1bus-openclaw-20260429-subagent-control-child-lane-import",
        'import { t as AGENT_LANE_SUBAGENT } from "./lanes-B35PnfP1.js";',
        'import { i as resolveNestedAgentLaneForSession, t as AGENT_LANE_SUBAGENT } from "./lanes-B35PnfP1.js"; /* plur1bus-openclaw-20260429-subagent-control-child-lane-import */',
        "subagent control per-child lane import",
    )
    replace_once(
        subagent_control,
        "plur1bus-openclaw-20260429-subagent-steer-child-lane",
        "\t\t\t\tlane: AGENT_LANE_SUBAGENT,\n"
        "\t\t\t\ttimeout: 0",
        "\t\t\t\tlane: resolveNestedAgentLaneForSession(params.entry.childSessionKey), /* plur1bus-openclaw-20260429-subagent-steer-child-lane */\n"
        "\t\t\t\ttimeout: 0",
        "subagent steer per-child lane",
    )
    replace_once(
        subagent_control,
        "plur1bus-openclaw-20260429-subagent-send-child-lane",
        "\t\t\t\tlane: AGENT_LANE_SUBAGENT,\n"
        "\t\t\t\ttimeout: 0",
        "\t\t\t\tlane: resolveNestedAgentLaneForSession(targetSessionKey), /* plur1bus-openclaw-20260429-subagent-send-child-lane */\n"
        "\t\t\t\ttimeout: 0",
        "subagent send per-child lane",
    )
else:
    print("[patch] subagent control per-child lane: target not found, skipping")

pi_embedded = find_one(
    "pi-embedded-*.js",
    lambda c: "function runEmbeddedPiAgent" in c and "resolveGlobalLane(params.lane" in c,
    "session-isolated embedded agent lane",
    required=False,
)
if pi_embedded:
    code = read(pi_embedded)
    marker = "plur1bus-openclaw-20260429-session-global-lane"
    if marker in code:
        print(f"[patch] session-isolated embedded agent lane: already patched ({os.path.basename(pi_embedded)})")
    else:
        old = (
            "\tconst sessionLane = resolveSessionLane(params.sessionKey?.trim() || params.sessionId);\n"
            "\tconst globalLane = resolveGlobalLane(params.lane);"
        )
        new = (
            "\tconst defaultGlobalLane = params.sessionKey?.trim() ? `agent:${params.sessionKey.trim()}` : void 0; /* plur1bus-openclaw-20260429-session-global-lane */\n"
            "\tconst sessionLane = resolveSessionLane(params.sessionKey?.trim() || params.sessionId);\n"
            "\tconst globalLane = resolveGlobalLane(params.lane ?? defaultGlobalLane);"
        )
        count = code.count(old)
        if count:
            backup(pi_embedded)
            write(pi_embedded, code.replace(old, new))
            print(f"[patch] session-isolated embedded agent lane: patched {count} occurrence(s) ({os.path.basename(pi_embedded)})")
        else:
            print(f"[patch] session-isolated embedded agent lane: anchor not found ({os.path.basename(pi_embedded)})")
else:
    print("[patch] session-isolated embedded agent lane: target not found, skipping")

heartbeat_runner = find_one(
    "heartbeat-runner-*.js",
    lambda c: (
        'const isInterval = reason === "interval";' in c
        or "plur1bus-openclaw-20260429-no-startup-heartbeat-storm" in c
    ) and "for (const agent of state.agents.values())" in c,
    "heartbeat startup due schedule",
    required=False,
)
if heartbeat_runner:
    replace_once(
        heartbeat_runner,
        "plur1bus-openclaw-20260429-no-startup-heartbeat-storm",
        '\t\tconst isInterval = reason === "interval";',
        '\t\tconst isInterval = reason === "interval" || reason === "startup"; /* plur1bus-openclaw-20260429-no-startup-heartbeat-storm */',
        "heartbeat startup due schedule",
    )
    replace_once(
        heartbeat_runner,
        "plur1bus-openclaw-20260429-heartbeat-startup-grace",
        "\t\t\tconst nextDueMs = resolveNextDue(now, intervalMs, phaseMs, prevAgents.get(agent.agentId));\n",
        "\t\t\tconst resolvedNextDueMs = resolveNextDue(now, intervalMs, phaseMs, prevAgents.get(agent.agentId));\n"
        "\t\t\tconst nextDueMs = !initialized ? Math.max(resolvedNextDueMs, now + Math.min(intervalMs, 120000)) : resolvedNextDueMs; /* plur1bus-openclaw-20260429-heartbeat-startup-grace */\n",
        "heartbeat startup grace",
    )
    heartbeat_code = read(heartbeat_runner)
    defer_marker = "plur1bus-openclaw-20260429-heartbeat-defer-overdue-after-broad-run"
    one_run_marker = "plur1bus-openclaw-20260429-heartbeat-one-run-per-tick"
    one_run_line = "\t\t\t\tif ((reason === \"interval\" || reason === \"startup\") && ran) break; /* plur1bus-openclaw-20260429-heartbeat-one-run-per-tick */\n"
    if defer_marker not in heartbeat_code and one_run_marker not in heartbeat_code:
        replace_once(
            heartbeat_runner,
            one_run_marker,
            "\t\t\t\tfor (const dueSessionKey of dueSessionKeys) {\n",
            one_run_line +
            "\t\t\t\tfor (const dueSessionKey of dueSessionKeys) {\n",
            "heartbeat one broad run per tick",
        )
        heartbeat_code = read(heartbeat_runner)
    if defer_marker in heartbeat_code:
        print(f"[patch] heartbeat defer overdue broad backlog: already patched ({os.path.basename(heartbeat_runner)})")
        if one_run_line in heartbeat_code:
            write(heartbeat_runner, heartbeat_code.replace(one_run_line, "", 1))
            heartbeat_code = read(heartbeat_runner)
            print(f"[patch] heartbeat redundant one-run marker cleanup: applied ({os.path.basename(heartbeat_runner)})")
    else:
        new_block = (
            "\t\t\t\tif ((reason === \"interval\" || reason === \"startup\") && ran) {\n"
            "\t\t\t\t\tlet deferIndex = 0; /* plur1bus-openclaw-20260429-heartbeat-defer-overdue-after-broad-run */\n"
            "\t\t\t\t\tfor (const otherAgent of state.agents.values()) {\n"
            "\t\t\t\t\t\tif (otherAgent === agent || otherAgent.nextDueMs > now) continue;\n"
            "\t\t\t\t\t\tconst deferMs = Math.min(otherAgent.intervalMs, 30000 + deferIndex * 15000);\n"
            "\t\t\t\t\t\totherAgent.nextDueMs = now + deferMs;\n"
            "\t\t\t\t\t\tdeferIndex += 1;\n"
            "\t\t\t\t\t}\n"
            "\t\t\t\t\tbreak;\n"
            "\t\t\t\t}\n"
        )
        if one_run_line in heartbeat_code:
            write(heartbeat_runner, heartbeat_code.replace(one_run_line, new_block, 1))
            heartbeat_code = read(heartbeat_runner)
            print(f"[patch] heartbeat defer overdue broad backlog: applied ({os.path.basename(heartbeat_runner)})")
        else:
            print(f"[patch] heartbeat defer overdue broad backlog: anchor not found ({os.path.basename(heartbeat_runner)})")
    commitment_marker = "plur1bus-openclaw-20260429-heartbeat-one-commitment-per-tick"
    if commitment_marker in heartbeat_code:
        print(f"[patch] heartbeat one commitment per broad tick: already patched ({os.path.basename(heartbeat_runner)})")
        premature_commitment_break = "\t\t\t\t\t\tif (reason === \"interval\" || reason === \"startup\") break; /* plur1bus-openclaw-20260429-heartbeat-one-commitment-per-tick */\n"
        if premature_commitment_break in heartbeat_code:
            write(
                heartbeat_runner,
                heartbeat_code.replace(
                    premature_commitment_break,
                    "\t\t\t\t\t\tran = true; /* plur1bus-openclaw-20260429-heartbeat-one-commitment-per-tick */\n",
                    1,
                ).replace("\t\t\t\t\t\tran = true;\n\t\t\t\t\t\tran = true; /* plur1bus-openclaw-20260429-heartbeat-one-commitment-per-tick */\n", "\t\t\t\t\t\tran = true; /* plur1bus-openclaw-20260429-heartbeat-one-commitment-per-tick */\n", 1)
            )
            heartbeat_code = read(heartbeat_runner)
            print(f"[patch] heartbeat premature commitment break cleanup: applied ({os.path.basename(heartbeat_runner)})")
    else:
        old_commitment = "\t\t\t\t\tif (commitmentRes.status === \"ran\") ran = true;\n"
        new_commitment = (
            "\t\t\t\t\tif (commitmentRes.status === \"ran\") {\n"
            "\t\t\t\t\t\tran = true; /* plur1bus-openclaw-20260429-heartbeat-one-commitment-per-tick */\n"
            "\t\t\t\t\t}\n"
        )
        if old_commitment in heartbeat_code:
            write(heartbeat_runner, heartbeat_code.replace(old_commitment, new_commitment, 1))
            heartbeat_code = read(heartbeat_runner)
            print(f"[patch] heartbeat one commitment per broad tick: applied ({os.path.basename(heartbeat_runner)})")
        else:
            print(f"[patch] heartbeat one commitment per broad tick: anchor not found ({os.path.basename(heartbeat_runner)})")
    post_commitment_marker = "plur1bus-openclaw-20260429-heartbeat-defer-after-commitment"
    if post_commitment_marker in heartbeat_code:
        print(f"[patch] heartbeat defer after commitment: already patched ({os.path.basename(heartbeat_runner)})")
    else:
        old_after_commitment = (
            "\t\t\t\t\tif (commitmentRes.status === \"ran\") {\n"
            "\t\t\t\t\t\tran = true; /* plur1bus-openclaw-20260429-heartbeat-one-commitment-per-tick */\n"
            "\t\t\t\t\t}\n"
            "\t\t\t\t}\n"
            "\t\t\t}\n"
        )
        new_after_commitment = (
            "\t\t\t\t\tif (commitmentRes.status === \"ran\") {\n"
            "\t\t\t\t\t\tran = true; /* plur1bus-openclaw-20260429-heartbeat-one-commitment-per-tick */\n"
            "\t\t\t\t\t}\n"
            "\t\t\t\t\tif ((reason === \"interval\" || reason === \"startup\") && ran) {\n"
            "\t\t\t\t\t\tlet deferIndex = 0; /* plur1bus-openclaw-20260429-heartbeat-defer-after-commitment */\n"
            "\t\t\t\t\t\tfor (const otherAgent of state.agents.values()) {\n"
            "\t\t\t\t\t\t\tif (otherAgent === agent || otherAgent.nextDueMs > now) continue;\n"
            "\t\t\t\t\t\t\tconst deferMs = Math.min(otherAgent.intervalMs, 30000 + deferIndex * 15000);\n"
            "\t\t\t\t\t\t\totherAgent.nextDueMs = now + deferMs;\n"
            "\t\t\t\t\t\t\tdeferIndex += 1;\n"
            "\t\t\t\t\t\t}\n"
            "\t\t\t\t\t\tbreak;\n"
            "\t\t\t\t\t}\n"
            "\t\t\t\t}\n"
            "\t\t\t}\n"
        )
        if old_after_commitment in heartbeat_code:
            write(heartbeat_runner, heartbeat_code.replace(old_after_commitment, new_after_commitment, 1))
            print(f"[patch] heartbeat defer after commitment: applied ({os.path.basename(heartbeat_runner)})")
        else:
            print(f"[patch] heartbeat defer after commitment: anchor not found ({os.path.basename(heartbeat_runner)})")
    outer_commitment_marker = "plur1bus-openclaw-20260429-heartbeat-break-agent-after-commitment"
    heartbeat_code = read(heartbeat_runner)
    if outer_commitment_marker in heartbeat_code:
        print(f"[patch] heartbeat break outer agent loop after commitment: already patched ({os.path.basename(heartbeat_runner)})")
    else:
        old_outer_commitment = "\t\t\t\t}\n\t\t\t}\n\t\t\tif (ran) return {\n"
        new_outer_commitment = (
            "\t\t\t\t}\n"
            "\t\t\t\tif ((reason === \"interval\" || reason === \"startup\") && ran) {\n"
            "\t\t\t\t\tlet deferIndex = 0; /* plur1bus-openclaw-20260429-heartbeat-break-agent-after-commitment */\n"
            "\t\t\t\t\tfor (const otherAgent of state.agents.values()) {\n"
            "\t\t\t\t\t\tif (otherAgent === agent || otherAgent.nextDueMs > now) continue;\n"
            "\t\t\t\t\t\tconst deferMs = Math.min(otherAgent.intervalMs, 30000 + deferIndex * 15000);\n"
            "\t\t\t\t\t\totherAgent.nextDueMs = now + deferMs;\n"
            "\t\t\t\t\t\tdeferIndex += 1;\n"
            "\t\t\t\t\t}\n"
            "\t\t\t\t\tbreak;\n"
            "\t\t\t\t}\n"
            "\t\t\t}\n"
            "\t\t\tif (ran) return {\n"
        )
        if old_outer_commitment in heartbeat_code:
            write(heartbeat_runner, heartbeat_code.replace(old_outer_commitment, new_outer_commitment, 1))
            print(f"[patch] heartbeat break outer agent loop after commitment: applied ({os.path.basename(heartbeat_runner)})")
        else:
            print(f"[patch] heartbeat break outer agent loop after commitment: anchor not found ({os.path.basename(heartbeat_runner)})")
else:
    print("[patch] heartbeat startup due schedule: target not found, skipping")

boot_md = os.path.join(dist, "bundled/boot-md/handler.js")
if os.path.exists(boot_md):
    replace_once(
        boot_md,
        "plur1bus-openclaw-20260429-boot-md-nonblocking",
        "\tawait runStartupTasks({",
        "\tsetImmediate(() => {\n"
        "\t\trunStartupTasks({ /* plur1bus-openclaw-20260429-boot-md-nonblocking */",
        "boot-md nonblocking start",
    )
    replace_once(
        boot_md,
        "boot: startup tasks failed:",
        "\t\tlog\n"
        "\t});",
        "\t\tlog\n"
        "\t\t}).catch((err) => log.error(`boot: startup tasks failed: ${formatErrorMessage(err)}`));\n"
        "\t});",
        "boot-md nonblocking end",
    )
else:
    print("[patch] boot-md: target not found, skipping")

agent_runner = find_one(
    "agent-runner.runtime-*.js",
    lambda c: 'transcriptPrompt: ""' in c and "memoryFlushWritePath" in c,
    "memory flush transcript prompt",
    required=False,
)
if agent_runner:
    replace_once(
        agent_runner,
        "plur1bus-openclaw-20260429-nonempty-flush-prompt",
        '\t\t\t\t\ttranscriptPrompt: "",',
        '\t\t\t\t\ttranscriptPrompt: "Run the hidden pre-compaction memory flush now. Do not send a visible user-facing reply.", /* plur1bus-openclaw-20260429-nonempty-flush-prompt */',
        "memory flush transcript prompt",
    )
else:
    print("[patch] memory flush transcript prompt: target not found or already patched, skipping")

for path in sorted(backed):
    print(f"[patch] backup: {path}.bak-plur1bus-{stamp}")
PYEOF
}

patch_silent_reply_config || rc=1
patch_reply_visibility_config || rc=1
patch_kimi_coding_provider_config || rc=1
patch_kimi_coding_thinking_default || rc=1
patch_stale_task_zombies || rc=1
patch_openclaw_20260429_latency || rc=1

exit "$rc"
