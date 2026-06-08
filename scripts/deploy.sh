#!/usr/bin/env bash
set -Eeuo pipefail

BRANCH="${BRANCH:-main}"
SERVICE="${SERVICE:-web-c-compiler.service}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8787/api/health}"
RUN_TESTS="${RUN_TESTS:-0}"
RELOAD_NGINX="${RELOAD_NGINX:-0}"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

log() {
  printf '\n[%s] %s\n' "$(date '+%H:%M:%S')" "$*"
}

run_sudo() {
  if [[ "${EUID}" -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

cd "${APP_DIR}"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  printf 'deploy failed: %s is not a git repository.\n' "${APP_DIR}" >&2
  printf 'Clone the repo first, then run this script from that clone.\n' >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" && "${ALLOW_DIRTY:-0}" != "1" ]]; then
  git status --short
  printf '\ndeploy failed: working tree has local changes. Commit/stash them or run with ALLOW_DIRTY=1.\n' >&2
  exit 1
fi

log "Fetching ${BRANCH}"
git fetch origin "${BRANCH}"
git checkout "${BRANCH}"
git pull --ff-only origin "${BRANCH}"

log "Installing dependencies"
npm ci

if [[ "${RUN_TESTS}" == "1" ]]; then
  log "Running tests"
  npm test
fi

log "Building production assets"
npm run build

log "Restarting ${SERVICE}"
run_sudo systemctl restart "${SERVICE}"

if [[ "${RELOAD_NGINX}" == "1" ]]; then
  if systemctl list-unit-files nginx.service >/dev/null 2>&1; then
    log "Reloading nginx"
    run_sudo systemctl reload nginx.service
  else
    log "nginx.service not found; skipping nginx reload"
  fi
fi

if command -v curl >/dev/null 2>&1; then
  log "Checking health ${HEALTH_URL}"
  for attempt in {1..20}; do
    if curl -fsS "${HEALTH_URL}" >/dev/null; then
      printf 'health check ok\n'
      break
    fi
    if [[ "${attempt}" -eq 20 ]]; then
      printf 'deploy warning: health check did not pass: %s\n' "${HEALTH_URL}" >&2
      break
    fi
    sleep 1
  done
fi

log "Current service status"
run_sudo systemctl --no-pager --lines=8 status "${SERVICE}"

log "Deploy complete: $(git rev-parse --short HEAD)"
