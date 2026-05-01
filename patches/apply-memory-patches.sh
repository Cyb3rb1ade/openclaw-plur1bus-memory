#!/usr/bin/env bash
# OpenClaw Memory System — Patches
# Applied via ExecStartPre in openclaw-gateway.service
#
# Patches:
# 16) stuck-session-abort: SIGUSR1 when session stuck > stuckSessionAbortMs
# 17) memory-core-cohere-rerank: Cohere rerank-v3.5 after mergeHybridResults()
# 18) active-memory-fast-path: retired; preserved as no-op for older installs
# 19) plur1bus-user OpenClaw 2026.4.29 latency hotfixes

set -u

DIST_DIR="/usr/lib/node_modules/openclaw/dist"
rc=0

# 16) Stuck-Session Abort
patch_stuck_session_abort() {
  python3 - "$DIST_DIR" << 'PYEOF'
import sys, glob, os
dist = sys.argv[1]
target = next((f for f in glob.glob(os.path.join(dist, "diagnostic-*.js")) if "logSessionStuck" in open(f).read()), None)
if not target:
    print("[patch] stuck-session-abort: target not found (retired or moved upstream)"); raise SystemExit(0)
with open(target) as f: code = f.read()
if "stuck-session-abort-patch" in code:
    print(f"[patch] stuck-session-abort: already patched ({os.path.basename(target)})"); raise SystemExit(0)
old = (
    '\t\t\tif (state.state === "processing" && ageMs > stuckSessionWarnMs) logSessionStuck({\n'
    '\t\t\t\tsessionId: state.sessionId,\n'
    '\t\t\t\tsessionKey: state.sessionKey,\n'
    '\t\t\t\tstate: state.state,\n'
    '\t\t\t\tageMs\n'
    '\t\t\t});'
)
new = (
    '\t\t\tif (state.state === "processing" && ageMs > stuckSessionWarnMs) {\n'
    '\t\t\t\tlogSessionStuck({ sessionId: state.sessionId, sessionKey: state.sessionKey, state: state.state, ageMs });\n'
    '\t\t\t\tconst _stuckAbortRaw = getRuntimeConfig()?.diagnostics?.stuckSessionAbortMs;\n'
    '\t\t\t\tconst _stuckAbortMs = (typeof _stuckAbortRaw === "number" && _stuckAbortRaw > 0) ? _stuckAbortRaw : stuckSessionWarnMs * 5;\n'
    '\t\t\t\tif (ageMs > _stuckAbortMs) { /* stuck-session-abort-patch */\n'
    '\t\t\t\t\tdiagnosticLogger.warn(`stuck session ABORT: sessionKey=${state.sessionKey} age=${Math.round(ageMs / 1e3)}s > ${Math.round(_stuckAbortMs / 1e3)}s — sending SIGUSR1`);\n'
    '\t\t\t\t\tprocess.kill(process.pid, "SIGUSR1");\n'
    '\t\t\t\t}\n'
    '\t\t\t}'
)
if old not in code:
    print(f"[patch] stuck-session-abort: anchor not found ({os.path.basename(target)}) — skipping")
    raise SystemExit(0)
with open(target, "w") as f: f.write(code.replace(old, new, 1))
print(f"[patch] stuck-session-abort: applied ({os.path.basename(target)})")
PYEOF
}
patch_stuck_session_abort || rc=1

# 17) Memory-Core Cohere Reranking
patch_memory_core_cohere_rerank() {
  python3 - "$DIST_DIR" << 'PYEOF'
import sys, glob, os
dist = sys.argv[1]
target = next((f for f in glob.glob(os.path.join(dist, "manager-*.js")) if "mergeHybridResults" in open(f).read()), None)
if not target:
    print("[patch] memory-core-cohere-rerank: target not found"); raise SystemExit(1)
with open(target) as f: code = f.read()
if "memory-core-cohere-rerank-patch" in code:
    print(f"[patch] memory-core-cohere-rerank: already patched ({os.path.basename(target)})"); raise SystemExit(0)
old = (
    '\t\tconst strict = merged.filter((entry) => entry.score >= minScore);\n'
    '\t\tif (strict.length > 0 || keywordResults.length === 0) return strict.slice(0, maxResults);'
)
new = (
    '\t\tlet __cohereKey = ""; try { __cohereKey = (await import("node:fs")).readFileSync("/root/.openclaw/.env","utf8").match(/COHERE_API_KEY=([^\\n]+)/)?.[1]?.trim() ?? ""; } catch {} /* memory-core-cohere-rerank-patch */\n'
    '\t\tlet strict;\n'
    '\t\tif (__cohereKey && merged.length > 1) {\n'
    '\t\t\ttry {\n'
    '\t\t\t\tconst __cr = await fetch("https://api.cohere.com/v2/rerank", {\n'
    '\t\t\t\t\tmethod: "POST",\n'
    '\t\t\t\t\theaders: { "Authorization": `Bearer ${__cohereKey}`, "Content-Type": "application/json", "User-Agent": "claude-code/1.0" },\n'
    '\t\t\t\t\tbody: JSON.stringify({ model: "rerank-v3.5", query: cleaned, documents: merged.map(r => r.snippet || ""), top_n: Math.min(merged.length, maxResults * 2), return_documents: false }),\n'
    '\t\t\t\t\tsignal: AbortSignal.timeout(8000)\n'
    '\t\t\t\t});\n'
    '\t\t\t\tif (__cr.ok) {\n'
    '\t\t\t\t\tconst __cd = await __cr.json();\n'
    '\t\t\t\t\tconst __reranked = __cd.results.map(r => merged[r.index]).filter(Boolean);\n'
    '\t\t\t\t\tstrict = __reranked.filter(entry => entry.score >= minScore);\n'
    '\t\t\t\t} else { strict = merged.filter(entry => entry.score >= minScore); }\n'
    '\t\t\t} catch { strict = merged.filter(entry => entry.score >= minScore); }\n'
    '\t\t} else { strict = merged.filter((entry) => entry.score >= minScore); }\n'
    '\t\tif (strict.length > 0 || keywordResults.length === 0) return strict.slice(0, maxResults);'
)
if old not in code:
    print(f"[patch] memory-core-cohere-rerank: anchor not found ({os.path.basename(target)})"); raise SystemExit(1)
with open(target, "w") as f: f.write(code.replace(old, new, 1))
print(f"[patch] memory-core-cohere-rerank: applied ({os.path.basename(target)})")
PYEOF
}
patch_memory_core_cohere_rerank || rc=1

# 18) Active-Memory Fast Path
patch_active_memory_fast_path() {
  echo "[patch] active-memory-fast-path: retired (plur1bus-user hotfix keeps active-memory on the plugin tool path)"
  return 0
  python3 - << 'PYEOF'
import os, glob

dist = "/usr/lib/node_modules/openclaw/dist"
target = os.path.join(dist, "extensions/active-memory/index.js")
if not os.path.exists(target):
    print("[patch] active-memory-fast-path: target not found"); raise SystemExit(1)

with open(target) as f: code = f.read()
if "/* active-memory-fast-path-patch */" in code:
    print("[patch] active-memory-fast-path: already patched"); raise SystemExit(0)

anchor = 'return cached;\n\t}\n\tif (params.config.logging) params.api.logger.info?.(`${logPrefix} start timeoutMs=${String(params.config.timeoutMs)} queryChars=${String(params.query.length)}`);'
if anchor not in code:
    print("[patch] active-memory-fast-path: anchor not found"); raise SystemExit(1)

# Find correct memory module name (changes with each OpenClaw version)
mem_module = next(
    (os.path.basename(f) for f in glob.glob(os.path.join(dist, "memory-*.js"))
     if 'getMemorySearchManager' in open(f).read() and 'export { getMemorySearchManager as n' in open(f).read()),
    None
)
if not mem_module:
    print("[patch] active-memory-fast-path: memory module not found"); raise SystemExit(1)

js = f'''
\t\t/* active-memory-fast-path-patch */
\t\tlet __am_fp_result = null;
\t\ttry {{
\t\t\tconst {{ n: __gsm }} = await import("../../{mem_module}");
\t\t\tconst __am_cfg = params.api.config ?? params.config;
\t\t\tconst {{ manager: __mm }} = await __gsm({{ cfg: __am_cfg, agentId: params.agentId }});
\t\t\tif (__mm) {{
\t\t\t\tconst __sr = await __mm.search(params.query, {{
\t\t\t\t\tmaxResults: params.config.maxResults ?? 6,
\t\t\t\t\tsessionKey: params.sessionKey
\t\t\t\t}}).catch(() => null);
\t\t\t\tif (__sr?.length) {{
\t\t\t\t\tconst __sum = __sr.map(r => r.text ?? "").join("\\n---\\n");
\t\t\t\t\tconst __prefix = buildPromptPrefix(__sum);
\t\t\t\t\tif (__prefix) {{
\t\t\t\t\t\t__am_fp_result = {{ status: "ok", elapsedMs: Date.now() - startedAt, summary: truncateSummary(__sum, params.config.maxSummaryChars), searchDebug: {{ backend: __mm.status?.().backend ?? "unknown", searchMs: 0, hits: __sr.length }} }};
\t\t\t\t\t\tif (params.config.logging) params.api.logger.info?.(`${{logPrefix}} done status=ok elapsedMs=${{String(__am_fp_result.elapsedMs)}} summaryChars=${{String(__sum.length)}} [fast-path]`);
\t\t\t\t\t\tawait persistPluginStatusLines({{ api: params.api, agentId: params.agentId, sessionKey: params.sessionKey, statusLine: buildPluginStatusLine({{ result: __am_fp_result, config: params.config }}), debugSummary: __sum, searchDebug: __am_fp_result.searchDebug }});
\t\t\t\t\t\tsetCachedResult(cacheKey, __am_fp_result, params.config.cacheTtlMs);
\t\t\t\t\t\treturn __am_fp_result;
\t\t\t\t\t}}
\t\t\t\t}}
\t\t\t}}
\t\t}} catch {{}} /* active-memory-fast-path-patch */'''

open(target, "w").write(code.replace(anchor, anchor + js, 1))
print(f"[patch] active-memory-fast-path: applied ({os.path.basename(target)}, module={mem_module})")
PYEOF
}
patch_active_memory_fast_path || rc=1

# 19) OpenClaw 2026.4.29 latency hotfixes for plur1bus users
patch_plur1bus_user_hotfix() {
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  bash "$script_dir/apply-plur1bus-user-hotfix.sh"
}
patch_plur1bus_user_hotfix || rc=1

exit $rc
