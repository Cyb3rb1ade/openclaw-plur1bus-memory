#!/usr/bin/env bash
# Offline regression checks for installer consent, activation, venv, and key gates.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
installer="$repo_dir/scripts/install-mtplx-embed.sh"
fixtures="$repo_dir/mtplx-embed/tests/fixtures"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/mtplx-embed-installer.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT

fail() {
  printf 'installer regression failure: %s\n' "$*" >&2
  exit 1
}

prepare_case() {
  case_dir="$scratch/$1"
  mkdir -p "$case_dir/bin" "$case_dir/home" "$case_dir/hermes/profiles"
  printf 'model: {}\n' > "$case_dir/hermes/config.yaml"
  ln -s "$fixtures/hermes" "$case_dir/bin/hermes"
  ln -s "$fixtures/systemctl" "$case_dir/bin/systemctl"
  ln -s "$fixtures/uname" "$case_dir/bin/uname"
  : > "$case_dir/record"
}

run_installer() {
  local case_dir="$1"
  shift
  HOME="$case_dir/home" HERMES_HOME="$case_dir/hermes" MTPLX_TEST_RECORD="$case_dir/record" \
    MTPLX_TEST_REAL_PYTHON="${MTPLX_TEST_REAL_PYTHON:-/usr/bin/python3}" PATH="$case_dir/bin:$PATH" \
    "$installer" --python "$fixtures/fake-python.sh" "$@"
}

# --no-agent must never invoke Hermes configuration or smoke, but it must use a
# dedicated venv rather than the Python passed to the installer.
prepare_case no-agent
output="$(run_installer "$case_dir" --jina --accept-jina-license --no-agent 2>&1)"
resolved_hermes="$(cd -P "$case_dir/hermes" && pwd)"
[[ "$output" == *'central retrieval was not enabled'* ]] || fail 'no-agent result was not explicit'
! grep -q '^hermes:' "$case_dir/record" || fail 'no-agent activated Hermes retrieval'
! grep -q '^smoke:' "$case_dir/record" || fail 'no-agent ran a smoke test'
grep -Fq "pip:$resolved_hermes/mtplx-embed/venv/bin/python" "$case_dir/record" || fail 'dependencies did not use the isolated venv'
grep -Fqx "MTPLX_EMBED_PYTHON=$resolved_hermes/mtplx-embed/venv/bin/python" "$case_dir/hermes/mtplx-embed/service.env" || fail 'launcher was not bound to the isolated venv'

# Any immediate lancedb* directory with data is an existing vector space, even
# when a deployment uses a model-specific store name rather than plain lancedb.
prepare_case populated-store
mkdir -p "$case_dir/hermes/plur1bus-bernd-qwen3/lancedb-8b/main.lance"
printf 'existing\n' > "$case_dir/hermes/plur1bus-bernd-qwen3/lancedb-8b/main.lance/data"
mkdir -p "$case_dir/hermes/profiles/bernd/plugins/plur1bus"
printf '{"dataDir":"plur1bus-bernd-qwen3"}\n' > "$case_dir/hermes/profiles/bernd/plugins/plur1bus/config.json"
output="$(run_installer "$case_dir" --jina --accept-jina-license 2>&1)"
[[ "$output" == *'Existing LanceDB store detected'* ]] || fail 'profile model-specific populated LanceDB store was not detected'
! grep -q '^venv:' "$case_dir/record" || fail 'populated store attempted a Jina venv install'
! grep -q '^download:' "$case_dir/record" || fail 'populated store attempted a Jina model download'

# A manually skipped smoke test may install/start the service, but cannot
# activate the central Hermes retrieval route.
prepare_case no-smoke
output="$(run_installer "$case_dir" --jina --accept-jina-license --no-smoke 2>&1)"
[[ "$output" == *'smoke was skipped; central retrieval was not enabled'* ]] || fail 'no-smoke result was not explicit'
! grep -q '^hermes:' "$case_dir/record" || fail 'no-smoke activated Hermes retrieval'
! grep -q '^smoke:' "$case_dir/record" || fail 'no-smoke ran a smoke test'
grep -q '^systemctl:--user enable --now com.plur1bus.mtplx-embed.service$' "$case_dir/record" || fail 'no-smoke did not exercise service integration'

# A previous Hermes env key is reused by service, smoke, and route setup. The
# secret must not appear in installer output.
prepare_case existing-key
mkdir -p "$case_dir/hermes"
printf 'OTHER=value\nMTPLX_EMBED_API_KEY=shared-existing-key\n' > "$case_dir/hermes/.env"
output="$(run_installer "$case_dir" --jina --accept-jina-license 2>&1)"
[[ "$output" != *'shared-existing-key'* ]] || fail 'installer printed an API key'
grep -Fq -- '--api-key shared-existing-key' "$case_dir/record" || fail 'smoke did not use the existing API key'
grep -Fq 'Environment=MTPLX_EMBED_API_KEY=shared-existing-key' "$case_dir/home/.config/systemd/user/com.plur1bus.mtplx-embed.service" || fail 'service did not use the existing API key'
grep -q '^hermes:config set retrieval.embeddings.provider omlx$' "$case_dir/record" || fail 'smoke success did not activate central retrieval'
grep -q '^hermes:gateway restart$' "$case_dir/record" || fail 'smoke success did not reload the Hermes gateway'
[[ "$(grep -c '^MTPLX_EMBED_API_KEY=' "$case_dir/hermes/.env")" == '1' ]] || fail 'API key env entry was duplicated'

# A gateway launched before this run cannot read the newly written key until it
# restarts. If that restart fails, retain the written recovery configuration but
# fail the install and never claim the route is active.
prepare_case reload-failure
set +e
output="$(MTPLX_TEST_HERMES_RELOAD_FAIL=1 run_installer "$case_dir" --jina --accept-jina-license 2>&1)"
status=$?
set -e
[[ "$status" -ne 0 ]] || fail 'gateway reload failure succeeded'
[[ "$output" == *'gateway reload failed; central retrieval was not activated'* ]] || fail 'gateway reload failure was not reported accurately'
[[ "$output" != *'declaration enabled after smoke success'* ]] || fail 'gateway reload failure falsely claimed activation'
grep -q '^hermes:config set retrieval.embeddings.api_key_env MTPLX_EMBED_API_KEY$' "$case_dir/record" || fail 'new-key route was not configured before reload'
grep -q '^hermes:gateway restart$' "$case_dir/record" || fail 'new-key route did not attempt gateway reload'
[[ "$(grep -c '^MTPLX_EMBED_API_KEY=' "$case_dir/hermes/.env")" == '1' ]] || fail 'new API key was not persisted once for the restart'

printf 'installer shell regressions passed\n'
