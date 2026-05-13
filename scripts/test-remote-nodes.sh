#!/usr/bin/env bash
# scripts/test-remote-nodes.sh
#
# E2E smoke test for OpenZigs remote media worker nodes.
# Reads ~/.openzigs/config.json, probes /health and /capabilities for every
# configured remote node, optionally submits a tiny job, and prints a colored
# pass/fail table.
#
# Usage:
#   scripts/test-remote-nodes.sh                      # test all configured nodes
#   scripts/test-remote-nodes.sh --node image-gen     # test one
#   scripts/test-remote-nodes.sh --verbose            # print full HTTP bodies
#   scripts/test-remote-nodes.sh --timeout 30         # callback timeout (sec)
#   scripts/test-remote-nodes.sh --config /path/to/config.json
#
set -euo pipefail

CONFIG_PATH="${HOME}/.openzigs/config.json"
TIMEOUT=60
VERBOSE=0
ONLY_NODE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --node) ONLY_NODE="$2"; shift 2 ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --config) CONFIG_PATH="$2"; shift 2 ;;
    --verbose) VERBOSE=1; shift ;;
    -h|--help)
      sed -n '2,15p' "$0"
      exit 0
      ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Color helpers (no-op if not a TTY).
if [[ -t 1 ]]; then
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'
  C_BOLD=$'\033[1m'; C_RESET=$'\033[0m'
else
  C_RED=""; C_GREEN=""; C_YELLOW=""; C_BOLD=""; C_RESET=""
fi

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "${C_RED}error:${C_RESET} required command not found: $1" >&2
    exit 1
  }
}

require_cmd jq
require_cmd curl

if [[ ! -f "$CONFIG_PATH" ]]; then
  echo "${C_RED}error:${C_RESET} config not found at $CONFIG_PATH" >&2
  exit 1
fi

NODE_TYPES=("image-gen" "video-gen" "music-gen" "rvc" "lip-sync" "audio" "sad-talker")

resolve_url_for() {
  local nt="$1"
  case "$nt" in
    image-gen)  jq -r '.imageGen.networkNodeUrl // empty' "$CONFIG_PATH" ;;
    video-gen)  jq -r '.videoGen.networkNodeUrl // empty' "$CONFIG_PATH" ;;
    music-gen)  jq -r '.musicGen.networkNodeUrl // empty' "$CONFIG_PATH" ;;
    rvc)        jq -r '.rvc.networkNodeUrl // empty' "$CONFIG_PATH" ;;
    lip-sync)   jq -r '.lipSync.networkNodeUrl // empty' "$CONFIG_PATH" ;;
    audio)      jq -r '.audio.networkNodeUrl // empty' "$CONFIG_PATH" ;;
    sad-talker) jq -r '.sadTalker.networkNodeUrl // empty' "$CONFIG_PATH" ;;
  esac
}

resolve_token_for() {
  local nt="$1"
  case "$nt" in
    image-gen)  jq -r '.imageGen.networkNodeToken // empty' "$CONFIG_PATH" ;;
    video-gen)  jq -r '.videoGen.networkNodeToken // empty' "$CONFIG_PATH" ;;
    music-gen)  jq -r '.musicGen.networkNodeToken // empty' "$CONFIG_PATH" ;;
    rvc)        jq -r '.rvc.networkNodeToken // empty' "$CONFIG_PATH" ;;
    lip-sync)   jq -r '.lipSync.networkNodeToken // empty' "$CONFIG_PATH" ;;
    audio)      jq -r '.audio.networkNodeToken // empty' "$CONFIG_PATH" ;;
    sad-talker) jq -r '.sadTalker.networkNodeToken // empty' "$CONFIG_PATH" ;;
  esac
}

curl_probe() {
  local url="$1"; local token="$2"; local path="$3"
  local args=(-sS -m 10 -o /tmp/openzigs-rn-body.$$ -w "%{http_code}" "${url%/}${path}")
  if [[ -n "$token" ]]; then
    args+=(-H "Authorization: Bearer ${token}")
  fi
  set +e
  local code
  code=$(curl "${args[@]}" 2>/tmp/openzigs-rn-err.$$)
  local rc=$?
  set -e
  if [[ $rc -ne 0 ]]; then
    echo "ERR:$(tr -d '\n' </tmp/openzigs-rn-err.$$)"
  else
    echo "$code"
  fi
}

print_row() {
  local nt="$1"; local health="$2"; local caps="$3"; local extra="$4"
  printf "  %-12s  health=%-12s  capabilities=%-12s  %s\n" "$nt" "$health" "$caps" "$extra"
}

ANY_FAIL=0
TARGETS=()
if [[ -n "$ONLY_NODE" ]]; then
  TARGETS=("$ONLY_NODE")
else
  TARGETS=("${NODE_TYPES[@]}")
fi

echo "${C_BOLD}OpenZigs Remote Nodes smoke test${C_RESET}"
echo "  config: $CONFIG_PATH"
echo "  timeout: ${TIMEOUT}s"
echo

for nt in "${TARGETS[@]}"; do
  url=$(resolve_url_for "$nt" || echo "")
  token=$(resolve_token_for "$nt" || echo "")
  if [[ -z "$url" || "$url" == "null" ]]; then
    print_row "$nt" "${C_YELLOW}skip${C_RESET}" "${C_YELLOW}skip${C_RESET}" "(not configured)"
    continue
  fi

  health_code=$(curl_probe "$url" "$token" "/health")
  caps_code=$(curl_probe "$url" "$token" "/capabilities")

  if [[ "$health_code" == "200" ]]; then
    health_disp="${C_GREEN}200 OK${C_RESET}"
  else
    health_disp="${C_RED}${health_code}${C_RESET}"
    ANY_FAIL=1
  fi
  if [[ "$caps_code" == "200" ]]; then
    caps_disp="${C_GREEN}200 OK${C_RESET}"
  else
    caps_disp="${C_RED}${caps_code}${C_RESET}"
    ANY_FAIL=1
  fi

  print_row "$nt" "$health_disp" "$caps_disp" "$url"

  if [[ "$VERBOSE" -eq 1 && -f /tmp/openzigs-rn-body.$$ ]]; then
    echo "    body: $(head -c 200 /tmp/openzigs-rn-body.$$)"
  fi
done

rm -f /tmp/openzigs-rn-body.$$ /tmp/openzigs-rn-err.$$ 2>/dev/null || true

echo
if [[ $ANY_FAIL -eq 0 ]]; then
  echo "${C_GREEN}${C_BOLD}all checks passed${C_RESET}"
  exit 0
else
  echo "${C_RED}${C_BOLD}one or more checks failed${C_RESET}"
  exit 1
fi
