#!/usr/bin/env bash
set -u

label="${1:?missing launchd label}"
shift

max_attempts="${PLUR1BUS_MIGRATION_MAX_ATTEMPTS:-5}"
attempt=1
status=1

while (( attempt <= max_attempts )); do
  printf 'PLUR1BUS migration attempt %d/%d\n' "$attempt" "$max_attempts" >&2
  "$@"
  status=$?
  if [[ "$status" == "0" ]]; then
    break
  fi
  attempt=$((attempt + 1))
  if (( attempt <= max_attempts )); then
    sleep 10
  fi
done

printf 'PLUR1BUS migration supervisor finished with status %d\n' "$status" >&2
launchctl remove "$label" >/dev/null 2>&1 || true
exit "$status"
