#!/bin/sh
# Runs gitleaks inside its pinned image (the `docker://` steps in ci.yml and security.yml).
#
# gitleaks exits 0 when git fails: it logs the git error as an ERR line, scans 0 commits and
# reports no leaks. In a container step git runs as root while the checkout belongs to the
# runner user, so git refuses the repository unless it is marked safe. This script marks it
# safe, checks the range with git itself and fails on any ERR line from gitleaks.
#
# A zero-commit scan alone is not an error: gitleaks counts only commits that add lines, so a
# range that only deletes files scans 0 commits.
#
# GITLEAKS_LOG_OPTS: the `git log` options for the scan (from `pnpm ci:secrets-range`).
# Empty or unset scans the full history.
set -eu

export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0=safe.directory
export GIT_CONFIG_VALUE_0="$PWD"

fail() {
  echo "gitleaks.sh: $1, failing closed" >&2
  exit 1
}

# Unquoted on purpose: gitleaks splits --log-opts on whitespace the same way.
# shellcheck disable=SC2086
commits=$(git log --format=%H ${GITLEAKS_LOG_OPTS:-}) || fail 'git log failed on the scan range'
[ -n "$commits" ] || fail 'the scan range has no commits'

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
if grep -q ' ERR ' "$out"; then
  fail 'gitleaks logged an error'
fi
