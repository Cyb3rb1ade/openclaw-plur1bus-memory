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
grep -Fqx 'hermes:config set memory.provider plur1bus' "$empty_case/record" || \
  fail 'empty retrieval-args path did not reach Hermes activation'
if grep -Fq 'retrieval_args[@]: unbound variable' "$empty_case.output"; then
  fail 'empty retrieval-args path still triggered the Bash 3.2 nounset crash'
fi

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
grep -Fqx 'hermes:config set memory.provider plur1bus' "$sidecar_case/record" || \
  fail 'failing sidecar skipped the main plugin activation'
grep -Fq 'optional retrieval sidecar failed' "$sidecar_case.output" || \
  fail 'sidecar failure did not surface as a warning'

printf 'Hermes plugin installer Bash 3.2 regression passed\n'
