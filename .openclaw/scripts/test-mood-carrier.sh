#!/bin/bash
# Smoke tests for mood-carrier.sh
# Run: bash scripts/test-mood-carrier.sh   (from openclaw dir)
# Exit 0 = all pass, Exit 1 = failure

set -euo pipefail

OPENCLAW_DIR="${OPENCLAW_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

PASS=0
FAIL=0
TMPDIR_TEST=$(mktemp -d)
trap 'rm -rf "$TMPDIR_TEST"' EXIT

# shellcheck source=/dev/null
source "$OPENCLAW_DIR/scripts/mood-carrier.sh"

ok() { printf 'PASS  %s\n' "$1"; ((PASS++)) || true; }
fail() { printf 'FAIL  %s\n' "$1"; ((FAIL++)) || true; }

# ── T1: missing workspace dir → empty output, no crash ────────────────────────
result=$(build_mood_block "/tmp/nonexistent-$$" /dev/null) || true
if [ -z "$result" ]; then ok "T1: missing workspace dir → empty, no crash"
else fail "T1: expected empty output for missing workspace dir"; fi

# ── T2: missing state file → empty output, no crash ──────────────────────────
ws="$TMPDIR_TEST/ws-t2"; mkdir -p "$ws"
result=$(build_mood_block "$ws" /dev/null) || true
if [ -z "$result" ]; then ok "T2: missing state file → empty output"
else fail "T2: expected empty when state file absent"; fi

# T2b: B-lite .current-mood.txt written with 'mood: unknown'
if grep -q "mood: unknown" "$ws/.current-mood.txt" 2>/dev/null; then
  ok "T2b: B-lite unknown marker written when state missing"
else fail "T2b: .current-mood.txt should contain 'mood: unknown'"; fi

# ── T3: malformed JSON → empty output, no crash ───────────────────────────────
ws="$TMPDIR_TEST/ws-t3"; mkdir -p "$ws"
printf 'not json' > "$ws/.emotional-state.json"
result=$(build_mood_block "$ws" /dev/null) || true
if [ -z "$result" ]; then ok "T3: malformed JSON → empty output"
else fail "T3: expected empty for malformed JSON"; fi

# ── T4: valid state → block contains required tags ───────────────────────────
ws="$TMPDIR_TEST/ws-t4"; mkdir -p "$ws"
cat > "$ws/.emotional-state.json" << 'EOF'
{"label":"fröhlich","dominant":"joy","intensity":"mittel","details":{"joy":0.6,"trust":0.3,"anticipation":0.3,"sadness":0.05,"disgust":0.02,"anger":0.02,"fear":0.03,"surprise":0.1},"nuances":[],"agentId":"test","ts":1000000}
EOF
result=$(build_mood_block "$ws" /dev/null) || true
if [[ "$result" == *"[Stimmungs-Update]"* ]]; then ok "T4: block contains opening tag"
else fail "T4: missing [Stimmungs-Update] tag"; fi
if [[ "$result" == *"[/Stimmungs-Update]"* ]]; then ok "T4b: block contains closing tag"
else fail "T4b: missing [/Stimmungs-Update] tag"; fi
if [[ "$result" == *"fröhlich"* ]]; then ok "T4c: block contains label"
else fail "T4c: missing label in block"; fi
if [[ "$result" == *"Hinweis: Dies ist Kontext"* ]]; then ok "T4d: Hinweis line present"
else fail "T4d: missing Hinweis line"; fi

# ── T5: B-lite .current-mood.txt written atomically ──────────────────────────
ws="$TMPDIR_TEST/ws-t5"; mkdir -p "$ws"
cp "$TMPDIR_TEST/ws-t4/.emotional-state.json" "$ws/"
build_mood_block "$ws" /dev/null > /dev/null || true
if grep -q "label: fröhlich" "$ws/.current-mood.txt" 2>/dev/null; then
  ok "T5: .current-mood.txt written with correct label"
else fail "T5: .current-mood.txt missing or wrong content"; fi
if grep -q "dominant: joy" "$ws/.current-mood.txt" 2>/dev/null; then
  ok "T5b: .current-mood.txt has dominant field"
else fail "T5b: .current-mood.txt missing dominant field"; fi

# ── T6: first run → trend unknown; second run → trend stable ─────────────────
ws="$TMPDIR_TEST/ws-t6"; mkdir -p "$ws"
cp "$TMPDIR_TEST/ws-t4/.emotional-state.json" "$ws/"
r1=$(build_mood_block "$ws" /dev/null) || true
if [[ "$r1" == *"unbekannt"* ]]; then ok "T6: first run trend → unbekannt (no prev state)"
else fail "T6: first run should show 'unbekannt' trend"; fi

r2=$(build_mood_block "$ws" /dev/null) || true
if [[ "$r2" == *"stabil"* ]]; then ok "T6b: second run trend → stabil (same state)"
else fail "T6b: second run should show 'stabil' trend"; fi

# ── T7: trend ↗ detected correctly ────────────────────────────────────────────
ws="$TMPDIR_TEST/ws-t7"; mkdir -p "$ws"
cat > "$ws/.emotional-state.json" << 'EOF'
{"label":"traurig","dominant":"sadness","intensity":"mittel","details":{"joy":0.1,"trust":0.1,"anticipation":0.1,"sadness":0.6,"disgust":0.1,"anger":0.1,"fear":0.1,"surprise":0.05},"nuances":[],"agentId":"test","ts":1000}
EOF
build_mood_block "$ws" /dev/null > /dev/null || true  # first run → create prev
# Now improve valence: joy goes 0.1 → 0.6
cat > "$ws/.emotional-state.json" << 'EOF'
{"label":"fröhlich","dominant":"joy","intensity":"hoch","details":{"joy":0.6,"trust":0.4,"anticipation":0.4,"sadness":0.05,"disgust":0.02,"anger":0.02,"fear":0.03,"surprise":0.1},"nuances":[],"agentId":"test","ts":2000}
EOF
r=$(build_mood_block "$ws" /dev/null) || true
if [[ "$r" == *"↗"* ]]; then ok "T7: valence trend ↗ detected after improvement"
else fail "T7: expected ↗ trend after valence improvement; got: $r"; fi

# ── T8: trend ↘ detected correctly ────────────────────────────────────────────
ws="$TMPDIR_TEST/ws-t8"; mkdir -p "$ws"
cat > "$ws/.emotional-state.json" << 'EOF'
{"label":"fröhlich","dominant":"joy","intensity":"hoch","details":{"joy":0.6,"trust":0.4,"anticipation":0.4,"sadness":0.05,"disgust":0.02,"anger":0.02,"fear":0.03,"surprise":0.1},"nuances":[],"agentId":"test","ts":1000}
EOF
build_mood_block "$ws" /dev/null > /dev/null || true
cat > "$ws/.emotional-state.json" << 'EOF'
{"label":"traurig","dominant":"sadness","intensity":"mittel","details":{"joy":0.1,"trust":0.1,"anticipation":0.1,"sadness":0.6,"disgust":0.1,"anger":0.1,"fear":0.1,"surprise":0.05},"nuances":[],"agentId":"test","ts":2000}
EOF
r=$(build_mood_block "$ws" /dev/null) || true
if [[ "$r" == *"↘"* ]]; then ok "T8: valence trend ↘ detected after deterioration"
else fail "T8: expected ↘ trend after valence drop; got: $r"; fi

# ── T9: block does not contain secrets ───────────────────────────────────────
ws="$TMPDIR_TEST/ws-t9"; mkdir -p "$ws"
cat > "$ws/.emotional-state.json" << 'EOF'
{"label":"ausgeglichen","dominant":"trust","intensity":"niedrig","details":{"joy":0.25,"trust":0.45,"anticipation":0.25,"sadness":0.08,"disgust":0.02,"anger":0.02,"fear":0.08,"surprise":0.1},"nuances":[],"agentId":"test-agent","ts":9999}
EOF
r=$(build_mood_block "$ws" /dev/null) || true
if [[ "$r" != *"agentId"* ]]; then ok "T9: block does not contain agentId"
else fail "T9: block must not contain agentId"; fi
if [[ "$r" != *"9999"* ]]; then ok "T9b: block does not contain raw ts"
else fail "T9b: block must not contain ts value"; fi

# ── T10: nuances included in label line ───────────────────────────────────────
ws="$TMPDIR_TEST/ws-t10"; mkdir -p "$ws"
cat > "$ws/.emotional-state.json" << 'EOF'
{"label":"neugierig","dominant":"anticipation","intensity":"hoch","details":{"joy":0.3,"trust":0.2,"anticipation":0.7,"sadness":0.05,"disgust":0.0,"anger":0.0,"fear":0.05,"surprise":0.2},"nuances":["gespannt","hoffnungsvoll"],"agentId":"test","ts":1}
EOF
r=$(build_mood_block "$ws" /dev/null) || true
if [[ "$r" == *"gespannt"* ]]; then ok "T10: nuances included in block label line"
else fail "T10: nuances should appear in block; got: $r"; fi

# ── T11: .emotional-state-prev.json saved atomically ─────────────────────────
ws="$TMPDIR_TEST/ws-t11"; mkdir -p "$ws"
cat > "$ws/.emotional-state.json" << 'EOF'
{"label":"müde","dominant":"sadness","intensity":"niedrig","details":{"joy":0.1,"trust":0.3,"anticipation":0.1,"sadness":0.3,"disgust":0.0,"anger":0.0,"fear":0.1,"surprise":0.05},"nuances":[],"agentId":"test","ts":1}
EOF
build_mood_block "$ws" /dev/null > /dev/null || true
if [ -f "$ws/.emotional-state-prev.json" ]; then ok "T11: prev state file created"
else fail "T11: .emotional-state-prev.json not created"; fi
prev_label=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d.get('label',''))" "$ws/.emotional-state-prev.json" 2>/dev/null)
if [ "$prev_label" = "müde" ]; then ok "T11b: prev state contains correct label"
else fail "T11b: prev state label mismatch (got: $prev_label)"; fi

# ── T12: empty workspace_dir arg → empty output ───────────────────────────────
result=$(build_mood_block "" /dev/null) || true
if [ -z "$result" ]; then ok "T12: empty workspace_dir → empty output, no crash"
else fail "T12: expected empty output for empty workspace_dir"; fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
printf 'Results: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
