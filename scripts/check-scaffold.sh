#!/usr/bin/env bash
# Fresh external-scaffold gate (BUILD_PROMPT §87).
#
#   scripts/check-scaffold.sh            # scaffold from GitHub: Stella112/scaffold-hbar-consumer (main)
#   scripts/check-scaffold.sh --local    # scaffold this checkout via the CLI's CREATE_SCAFFOLD_HBAR_TEMPLATE_DIR seam
#
# Runs the real published CLI in a clean temp directory, then install → typecheck → lint → test → build →
# boot → request core routes. Exits non-zero on the first failing step.
set -euo pipefail

TEMPLATE="${SCAFFOLD_TEMPLATE:-Stella112/scaffold-hbar-consumer}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
APP="$WORK/scaffold-gate-app"
PORT="${SCAFFOLD_GATE_PORT:-3299}"
trap 'kill "${SERVER_PID:-0}" 2>/dev/null || true; rm -rf "$WORK"' EXIT

step() { printf '\n=== %s\n' "$*"; }

step "scaffold ($TEMPLATE${1:+, $1})"
cd "$WORK"
if [ "${1:-}" = "--local" ]; then
  export CREATE_SCAFFOLD_HBAR_TEMPLATE_DIR="$ROOT"
fi
npx --yes create-scaffold-hbar@latest scaffold-gate-app --template "$TEMPLATE" --yes --skip-hedera-skills
cd "$APP"
test -f packages/foundry/contracts/ConsumerAccount.sol
test ! -d packages/hardhat
test ! -f template.json   # consumed by the CLI after zod validation

step "install"
yarn install

step "typecheck"
yarn typecheck

step "lint"
yarn lint

step "test"
yarn test

step "build"
NEXT_TELEMETRY_DISABLED=1 yarn build

step "boot + core routes"
(cd packages/nextjs && npx next start -p "$PORT" > "$WORK/server.log" 2>&1) &
SERVER_PID=$!
for _ in $(seq 1 60); do curl -fs "http://127.0.0.1:$PORT/" > /dev/null && break; sleep 2; done
for route in / /pay /request /activity /agent /sponsor /developer /api/agent /api/sponsor/status; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT$route")
  echo "$route -> $code"
  [ "$code" = "200" ] || { tail -40 "$WORK/server.log"; exit 1; }
done

step "PASS fresh scaffold gate"
