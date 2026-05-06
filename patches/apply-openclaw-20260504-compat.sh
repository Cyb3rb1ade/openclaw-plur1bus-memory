#!/usr/bin/env bash
# OpenClaw 2026.5.4+ compatibility patches for the local plur1bus deployment.
#
# The 2026.4.29 hotfix patched broad tool-allowlist behavior that is now
# upstream in 2026.5.4. This script keeps only the local runtime fixes that
# are still needed after the upstream refactor.

set -u

DIST_DIR="${OPENCLAW_DIST_DIR:-/usr/lib/node_modules/openclaw/dist}"
rc=0

patch_openclaw_20260504_runtime() {
  python3 - "$DIST_DIR" <<'PYEOF'
import glob
import json
import os
import re
import sys
import time

dist = sys.argv[1]
stamp = time.strftime("%Y%m%d%H%M%S")
backed = set()

def read(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()

def write(path, code):
    backup(path)
    with open(path, "w", encoding="utf-8") as f:
        f.write(code)

def backup(path):
    if path in backed:
        return
    bak = f"{path}.bak-openclaw-20260504-{stamp}"
    if not os.path.exists(bak):
        with open(path, "rb") as src, open(bak, "wb") as dst:
            dst.write(src.read())
    backed.add(path)

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

def replace_once(path, marker, old, new, label, required=True):
    if not path or not os.path.exists(path):
        if required:
            raise RuntimeError(f"{label}: target not found")
        print(f"[patch] {label}: target not found, skipping")
        return
    code = read(path)
    if marker in code:
        print(f"[patch] {label}: already patched ({os.path.basename(path)})")
        return
    if old not in code:
        if required:
            raise RuntimeError(f"{label}: anchor not found ({os.path.basename(path)})")
        print(f"[patch] {label}: anchor not found ({os.path.basename(path)}), skipping")
        return
    write(path, code.replace(old, new, 1))
    print(f"[patch] {label}: applied ({os.path.basename(path)})")

def replace_regex_once(path, marker, pattern, repl, label, required=True):
    if not path or not os.path.exists(path):
        if required:
            raise RuntimeError(f"{label}: target not found")
        print(f"[patch] {label}: target not found, skipping")
        return
    code = read(path)
    if marker in code:
        print(f"[patch] {label}: already patched ({os.path.basename(path)})")
        return
    new_code, count = re.subn(pattern, repl, code, count=1)
    if count == 0:
        if required:
            raise RuntimeError(f"{label}: anchor not found ({os.path.basename(path)})")
        print(f"[patch] {label}: anchor not found ({os.path.basename(path)}), skipping")
        return
    write(path, new_code)
    print(f"[patch] {label}: applied ({os.path.basename(path)})")

pkg_path = os.path.join(os.path.dirname(dist), "package.json")
pkg_version = ""
try:
    pkg_version = json.loads(read(pkg_path)).get("version", "")
except Exception:
    pass
supported_versions = {"2026.5.4", "2026.5.5", "2026.5.6"}
if pkg_version and pkg_version not in supported_versions:
    print(f"[patch] OpenClaw 2026.5.4/2026.5.5/2026.5.6 compat: package version is {pkg_version}, skipping dist patch")
    raise SystemExit(0)

active_memory = os.path.join(dist, "extensions/active-memory/index.js")
if os.path.exists(active_memory):
    replace_once(
        active_memory,
        "plur1bus-openclaw-20260504-active-empty-fallback",
        """\t\tconst raceResult = await Promise.race([
\t\t\tsubagentPromise,
\t\t\ttimeoutPromise,
\t\t\tterminalMemorySearchWatch.promise
\t\t]);
\t\tterminalMemorySearchWatch.stop();
\t\tif (raceResult === TIMEOUT_SENTINEL) {""",
        """\t\tlet raceResult = await Promise.race([
\t\t\tsubagentPromise,
\t\t\ttimeoutPromise,
\t\t\tterminalMemorySearchWatch.promise
\t\t]);
\t\tterminalMemorySearchWatch.stop();
\t\tif (raceResult && typeof raceResult === "object" && "status" in raceResult && raceResult.status === "empty") {
\t\t\tif (params.config.logging) params.api.logger.info?.(`${logPrefix} terminal memory_search returned empty; waiting for fallback recall`);
\t\t\traceResult = await Promise.race([
\t\t\t\tsubagentPromise,
\t\t\t\ttimeoutPromise
\t\t\t]);
\t\t} /* plur1bus-openclaw-20260504-active-empty-fallback */
\t\tif (raceResult === TIMEOUT_SENTINEL) {""",
        "active-memory empty terminal fallback",
    )
    replace_once(
        active_memory,
        "plur1bus-openclaw-20260504-no-empty-cache",
        """function shouldCacheResult(result) {
\treturn result.status === "ok" || result.status === "empty";
}""",
        """function shouldCacheResult(result) {
\treturn result.status === "ok"; /* plur1bus-openclaw-20260504-no-empty-cache */
}""",
        "active-memory no empty-result cache",
    )
    replace_once(
        active_memory,
        "plur1bus-openclaw-20260504-embedded-timeout-cap",
        "\t\tconst embeddedTimeoutMs = params.config.timeoutMs + params.config.setupGraceTimeoutMs;",
        "\t\tconst embeddedTimeoutMs = params.config.timeoutMs; /* plur1bus-openclaw-20260504-embedded-timeout-cap */",
        "active-memory embedded timeout cap",
    )
    replace_once(
        active_memory,
        "plur1bus-openclaw-20260504-watchdog-cap",
        "\tconst watchdogTimeoutMs = params.config.timeoutMs + params.config.setupGraceTimeoutMs;",
        "\tconst watchdogTimeoutMs = params.config.timeoutMs; /* plur1bus-openclaw-20260504-watchdog-cap */",
        "active-memory watchdog cap",
    )
    replace_once(
        active_memory,
        "plur1bus-openclaw-20260504-hook-budget",
        "\t\tconst beforePromptBuildTimeoutMs = config.timeoutMs + config.setupGraceTimeoutMs;",
        "\t\tconst beforePromptBuildTimeoutMs = Math.min(config.timeoutMs, 3e3); /* plur1bus-openclaw-20260504-hook-budget */",
        "active-memory before_prompt_build budget",
    )
    replace_once(
        active_memory,
        "plur1bus-openclaw-20260504-active-memory-lane",
        "\t\t\tagentId: params.agentId,\n\t\t\tmessageChannel,",
        "\t\t\tagentId: params.agentId,\n\t\t\tlane: \"active-memory\", /* plur1bus-openclaw-20260504-active-memory-lane */\n\t\t\tmessageChannel,",
        "active-memory isolated command lane",
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
        "plur1bus-openclaw-20260504-subagent-announce-timeout-cap",
        "const DEFAULT_SUBAGENT_ANNOUNCE_TIMEOUT_MS = 12e4;",
        "const DEFAULT_SUBAGENT_ANNOUNCE_TIMEOUT_MS = 3e4; /* plur1bus-openclaw-20260504-subagent-announce-timeout-cap */",
        "subagent announce timeout cap",
    )
    replace_once(
        subagent_announce,
        "plur1bus-openclaw-20260504-session-only-announce-short-wait",
        "\t\tlet directAnnounceResponse;\n\t\ttry {",
        "\t\tconst directAnnounceTimeoutMs = params.expectsCompletionMessage && !deliveryTarget.deliver ? Math.min(announceTimeoutMs, 15000) : announceTimeoutMs; /* plur1bus-openclaw-20260504-session-only-announce-short-wait */\n\t\tlet directAnnounceResponse;\n\t\ttry {",
        "subagent session-only completion announce short wait",
    )
    replace_once(
        subagent_announce,
        "plur1bus-openclaw-20260504-session-only-announce-no-final-wait",
        "\t\t\t\t\texpectFinal: true,\n\t\t\t\t\ttimeoutMs: announceTimeoutMs",
        "\t\t\t\t\texpectFinal: deliveryTarget.deliver ? true : false, /* plur1bus-openclaw-20260504-session-only-announce-no-final-wait */\n\t\t\t\t\ttimeoutMs: directAnnounceTimeoutMs",
        "subagent session-only completion announce no final wait",
    )
else:
    print("[patch] subagent completion announce backpressure: target not found, skipping")

for pattern, label in [
    ("subagent-spawn-*.js", "subagent per-child dispatch lane"),
    ("acp-spawn-*.js", "ACP per-child dispatch lane"),
]:
    target = find_one(
        pattern,
        lambda c: "lane: AGENT_LANE_SUBAGENT" in c or "plur1bus-openclaw-20260504-subagent-session-lane" in c,
        label,
        required=False,
    )
    if not target:
        print(f"[patch] {label}: target not found, skipping")
        continue
    replace_regex_once(
        target,
        "plur1bus-openclaw-20260504-subagent-child-lane-import",
        r'import \{ t as AGENT_LANE_SUBAGENT \} from "(\./lanes-[^"]+\.js)";',
        r'import { i as resolveNestedAgentLaneForSession, t as AGENT_LANE_SUBAGENT } from "\1"; /* plur1bus-openclaw-20260504-subagent-child-lane-import */',
        f"{label} import",
    )
    session_expr = "childSessionKey" if pattern.startswith("subagent") else "sessionKey"
    replace_once(
        target,
        "plur1bus-openclaw-20260504-subagent-session-lane",
        "\t\t\t\tlane: AGENT_LANE_SUBAGENT,",
        f"\t\t\t\tlane: resolveNestedAgentLaneForSession({session_expr}), /* plur1bus-openclaw-20260504-subagent-session-lane */",
        label,
    )

subagent_control = find_one(
    "subagent-control-*.js",
    lambda c: (
        "lane: AGENT_LANE_SUBAGENT" in c
        or "plur1bus-openclaw-20260504-subagent-steer-child-lane" in c
        or "plur1bus-openclaw-20260504-subagent-send-child-lane" in c
    ) and ("params.entry.childSessionKey" in c or "targetSessionKey" in c),
    "subagent control per-child lane",
    required=False,
)
if subagent_control:
    replace_regex_once(
        subagent_control,
        "plur1bus-openclaw-20260504-subagent-control-child-lane-import",
        r'import \{ t as AGENT_LANE_SUBAGENT \} from "(\./lanes-[^"]+\.js)";',
        r'import { i as resolveNestedAgentLaneForSession, t as AGENT_LANE_SUBAGENT } from "\1"; /* plur1bus-openclaw-20260504-subagent-control-child-lane-import */',
        "subagent control per-child lane import",
    )
    replace_once(
        subagent_control,
        "plur1bus-openclaw-20260504-subagent-steer-child-lane",
        "\t\t\t\tlane: AGENT_LANE_SUBAGENT,\n\t\t\t\ttimeout: 0",
        "\t\t\t\tlane: resolveNestedAgentLaneForSession(params.entry.childSessionKey), /* plur1bus-openclaw-20260504-subagent-steer-child-lane */\n\t\t\t\ttimeout: 0",
        "subagent steer per-child lane",
    )
    replace_once(
        subagent_control,
        "plur1bus-openclaw-20260504-subagent-send-child-lane",
        "\t\t\t\tlane: AGENT_LANE_SUBAGENT,\n\t\t\t\ttimeout: 0",
        "\t\t\t\tlane: resolveNestedAgentLaneForSession(targetSessionKey), /* plur1bus-openclaw-20260504-subagent-send-child-lane */\n\t\t\t\ttimeout: 0",
        "subagent send per-child lane",
    )
else:
    print("[patch] subagent control per-child lane: target not found, skipping")

heartbeat_runner = find_one(
    "heartbeat-runner-*.js",
    lambda c: (
        'const isInterval = reason === "interval";' in c
        or "plur1bus-openclaw-20260504-no-startup-heartbeat-storm" in c
        or "plur1bus-openclaw-20260504-heartbeat-break-agent-after-run" in c
    ) and "for (const agent of state.agents.values())" in c,
    "heartbeat startup/backpressure",
    required=False,
)
if heartbeat_runner:
    replace_once(
        heartbeat_runner,
        "plur1bus-openclaw-20260504-no-startup-heartbeat-storm",
        '\t\tconst isInterval = reason === "interval";',
        '\t\tconst isInterval = reason === "interval" || reason === "startup"; /* plur1bus-openclaw-20260504-no-startup-heartbeat-storm */',
        "heartbeat startup due schedule",
    )
    replace_once(
        heartbeat_runner,
        "plur1bus-openclaw-20260504-heartbeat-break-agent-after-run",
        "\t\t\t}\n\t\t\tif (ran) return {",
        "\t\t\t\tif ((reason === \"interval\" || reason === \"startup\") && ran) {\n"
        "\t\t\t\t\tlet deferIndex = 0; /* plur1bus-openclaw-20260504-heartbeat-break-agent-after-run */\n"
        "\t\t\t\t\tfor (const otherAgent of state.agents.values()) {\n"
        "\t\t\t\t\t\tif (otherAgent === agent || otherAgent.nextDueMs > now) continue;\n"
        "\t\t\t\t\t\tconst deferMs = Math.min(otherAgent.intervalMs, 30000 + deferIndex * 15000);\n"
        "\t\t\t\t\t\totherAgent.nextDueMs = now + deferMs;\n"
        "\t\t\t\t\t\tdeferIndex += 1;\n"
        "\t\t\t\t\t}\n"
        "\t\t\t\t\tbreak;\n"
        "\t\t\t\t}\n"
        "\t\t\t}\n\t\t\tif (ran) return {",
        "heartbeat defer overdue broad backlog",
    )
else:
    print("[patch] heartbeat startup/backpressure: target not found, skipping")

boot_md = os.path.join(dist, "bundled/boot-md/handler.js")
if os.path.exists(boot_md):
    replace_once(
        boot_md,
        "plur1bus-openclaw-20260504-boot-md-nonblocking",
        "\tawait runStartupTasks({",
        "\tsetImmediate(() => {\n\t\trunStartupTasks({ /* plur1bus-openclaw-20260504-boot-md-nonblocking */",
        "boot-md nonblocking start",
    )
    replace_once(
        boot_md,
        "boot: startup tasks failed:",
        "\t\tlog\n\t});",
        "\t\tlog\n\t\t}).catch((err) => log.error(`boot: startup tasks failed: ${err instanceof Error ? err.message : String(err)}`));\n\t});",
        "boot-md nonblocking end",
    )
else:
    print("[patch] boot-md: target not found, skipping")

agent_runner = find_one(
    "agent-runner.runtime-*.js",
    lambda c: ('transcriptPrompt: ""' in c or "plur1bus-openclaw-20260504-nonempty-flush-prompt" in c) and "memoryFlushWritePath" in c,
    "memory flush transcript prompt",
    required=False,
)
if agent_runner:
    replace_once(
        agent_runner,
        "plur1bus-openclaw-20260504-nonempty-flush-prompt",
        '\t\t\t\t\ttranscriptPrompt: "",',
        '\t\t\t\t\ttranscriptPrompt: "Run the hidden pre-compaction memory flush now. Do not send a visible user-facing reply.", /* plur1bus-openclaw-20260504-nonempty-flush-prompt */',
        "memory flush transcript prompt",
    )
else:
    print("[patch] memory flush transcript prompt: target not found or already patched, skipping")

for path in sorted(backed):
    print(f"[patch] backup: {path}.bak-openclaw-20260504-{stamp}")
PYEOF
}

patch_openclaw_20260504_runtime || rc=1

exit "$rc"
