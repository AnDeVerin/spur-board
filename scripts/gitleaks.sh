#!/bin/sh
# Runs gitleaks inside its pinned image (the `docker://` steps in ci.yml and security.yml).
#
# gitleaks exits 0 when git fails: it logs the git error, scans 0 commits and reports no
# leaks. In a container step git runs as root while the checkout belongs to the runner
# user, so git refuses the repository unless it is marked safe. This script marks it safe
# and fails unless gitleaks scanned at least one commit.
#
# GITLEAKS_LOG_OPTS: the `git log` options for the scan (from `pnpm ci:secrets-range`).
# Empty or unset scans the full history.
set -eu

export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0=safe.directory
export GIT_CONFIG_VALUE_0="$PWD"

out=$(mktemp)
status=0
if [ -n "${GITLEAKS_LOG_OPTS:-}" ]; then
  gitleaks git --redact --no-banner --no-color --log-opts="$GITLEAKS_LOG_OPTS" . >"$out" 2>&1 ||
    status=$?
else
  gitleaks git --redact --no-banner --no-color . >"$out" 2>&1 || status=$?
fi
cat "$out"

if [ "$status" -ne 0 ]; then
  exit "$status"
fi
if ! grep -Eq ' [1-9][0-9]* commits scanned' "$out"; then
  echo 'gitleaks.sh: gitleaks scanned no commits, failing closed' >&2
  exit 1
fi
