#!/usr/bin/env sh
base=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
sh "$base/install.sh" --interactive
result=$?
printf '\nExit %s. Press Enter to close.\n' "$result"
read -r unused
exit "$result"
