#!/usr/bin/env bash
# Regression coverage for the Bash 3.2 + set -u empty retrieval-args path.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
installer="$repo_dir/scripts/install-hermes-plugins.sh"
fixtures="$repo_dir/mtplx-embed/tests/fixtures"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/hermes-plugin-installer.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT

fail() {
  printf 'Hermes plugin installer regression failure: %s\n' "$*" >&2
  exit 1
}

stage_repo() {
  local staged_repo="$scratch/repo"
  mkdir -p "$staged_repo/scripts/lib"
  cp "$installer" "$staged_repo/scripts/install-hermes-plugins.sh"
  ln -s "$repo_dir/scripts/lib/hermes-home.sh" "$staged_repo/scripts/lib/hermes-home.sh"
  ln -s "$repo_dir/scripts/run-hermes-workspace-migration-job.sh" "$staged_repo/scripts/run-hermes-workspace-migration-job.sh"
  ln -s "$repo_dir/scripts/mtplx-hermes-up" "$staged_repo/scripts/mtplx-hermes-up"
  # The existing Hermes fixture records argv and exits successfully, so it can
  # stand in for the retrieval installer without performing network or writes.
  ln -s "$fixtures/hermes" "$staged_repo/scripts/install-mtplx-embed.sh"
  ln -s "$repo_dir/plur1bus-hermes" "$staged_repo/plur1bus-hermes"
  ln -s "$repo_dir/plur1bus-controls" "$staged_repo/plur1bus-controls"
  ln -s "$repo_dir/hermes-model-providers" "$staged_repo/hermes-model-providers"
  ln -s "$repo_dir/hermes-dashboard" "$staged_repo/hermes-dashboard"
}

run_plugin_installer() {
  local case_name="$1"
  shift
  local case_dir="$scratch/$case_name"
  mkdir -p "$case_dir/home" "$case_dir/hermes/profiles" "$case_dir/bin"
  printf 'model: {}\n' > "$case_dir/hermes/config.yaml"
  ln -s "$fixtures/hermes" "$case_dir/bin/hermes"
  : > "$case_dir/record"
  HOME="$case_dir/home" MTPLX_TEST_RECORD="$case_dir/record" HERMES_PYTHON=/bin/bash \
    PATH="$case_dir/bin:$PATH" /bin/bash "$scratch/repo/scripts/install-hermes-plugins.sh" \
    --hermes-home "$case_dir/hermes" --no-deps "$@"
}

stage_repo

# Bash 3.2 with nounset must invoke retrieval without an empty-array crash, and
# the wrapper must continue into the Hermes activation phase afterwards.
empty_case="$scratch/empty"
run_plugin_installer empty > "$empty_case.output" 2>&1
resolved_empty_home="$(cd -P "$empty_case/hermes" && pwd)"
grep -Fqx "hermes:--hermes-home $resolved_empty_home" "$empty_case/record" || \
  fail 'retrieval installer was not invoked without extra arguments'
grep -Fqx 'hermes:--profile default config set memory.provider plur1bus' "$empty_case/record" || \
  fail 'empty retrieval-args path did not reach Hermes activation'
grep -Fqx 'hermes:--profile default config set memory.memory_enabled true' "$empty_case/record" || \
  fail 'memory lifecycle was not enabled'
grep -Fqx 'hermes:--profile default plugins enable plur1bus' "$empty_case/record" || \
  fail 'unified PLUR1BUS plugin was not enabled'
grep -Fqx 'hermes:--profile default plugins enable plur1bus-controls' "$empty_case/record" || \
  fail 'controls plugin was not enabled'
cmp "$repo_dir/hermes-dashboard/plur1bus/desktop/plugin.js" "$empty_case/hermes/plugins/plur1bus/desktop/plugin.js" || \
  fail 'plain installation omitted the unified desktop entry'
if grep -Fq 'retrieval_args[@]: unbound variable' "$empty_case.output"; then
  fail 'empty retrieval-args path still triggered the Bash 3.2 nounset crash'
fi

# No-activation applies to optional retrieval configuration as well as the
# primary provider; the source UI still belongs to the installed package.
no_setup_case="$scratch/no-setup"
run_plugin_installer no-setup --no-setup > "$no_setup_case.output" 2>&1
[[ ! -s "$no_setup_case/record" ]] || fail 'no-setup invoked Hermes or retrieval setup'
cmp "$repo_dir/hermes-dashboard/plur1bus/desktop/plugin.js" "$no_setup_case/hermes/plugins/plur1bus/desktop/plugin.js" || \
  fail 'no-setup omitted the unified desktop entry'
cmp "$repo_dir/hermes-dashboard/plur1bus/dashboard/plugin_api.py" "$no_setup_case/hermes/plugins/plur1bus/dashboard/plugin_api.py" || \
  fail 'no-setup omitted the dashboard backend'

# Non-empty retrieval arguments must retain their exact order and values.
args_case="$scratch/with-args"
run_plugin_installer with-args --no-agent --no-smoke > "$args_case.output" 2>&1
resolved_args_home="$(cd -P "$args_case/hermes" && pwd)"
grep -Fqx "hermes:--hermes-home $resolved_args_home --no-agent --no-smoke" "$args_case/record" || \
  fail 'retrieval arguments were not forwarded unchanged'

# A failing optional sidecar must degrade to a warning and must never skip the
# main plugin activation (7.4.0 contract).
rm "$scratch/repo/scripts/install-mtplx-embed.sh"
ln -s "$fixtures/failing-sidecar" "$scratch/repo/scripts/install-mtplx-embed.sh"
sidecar_case="$scratch/sidecar-fails"
run_plugin_installer sidecar-fails > "$sidecar_case.output" 2>&1 || \
  fail 'a failing sidecar aborted the main plugin installer'
resolved_sidecar_home="$(cd -P "$sidecar_case/hermes" && pwd)"
grep -Fqx "failing-sidecar:--hermes-home $resolved_sidecar_home" "$sidecar_case/record" || \
  fail 'failing sidecar was not invoked'
grep -Fqx 'hermes:--profile default config set memory.provider plur1bus' "$sidecar_case/record" || \
  fail 'failing sidecar skipped the main plugin activation'
grep -Fq 'optional retrieval sidecar failed' "$sidecar_case.output" || \
  fail 'sidecar failure did not surface as a warning'

printf 'Hermes plugin installer Bash 3.2 regression passed\n'
