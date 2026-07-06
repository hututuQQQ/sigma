#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v harbor >/dev/null 2>&1; then
  cat >&2 <<'EOF'
Harbor is not installed or is not on PATH.
Install Harbor, then rerun:
  AGENT_PROVIDER=deepseek DEEPSEEK_API_KEY=... pnpm smoke:harbor
EOF
  exit 1
fi

pnpm package:agent-cli

if [ -z "${AGENT_CLI_TARBALL:-}" ]; then
  export AGENT_CLI_TARBALL="$ROOT_DIR/.artifacts/agent-cli-linux-${AGENT_TARGET_ARCH:-x64}.tgz"
fi

if [ ! -f "$AGENT_CLI_TARBALL" ]; then
  echo "AGENT_CLI_TARBALL does not exist: $AGENT_CLI_TARBALL" >&2
  exit 1
fi

export PYTHONPATH="$ROOT_DIR:${PYTHONPATH:-}"

harbor run -d terminal-bench/terminal-bench-2 -a oracle -l 5

agent_args=(
  run
  -d terminal-bench/terminal-bench-2
  --agent-import-path "integrations.harbor.agent:AgentCliHarborAgent"
  -k 1
  --ak "provider:str=${AGENT_PROVIDER:-deepseek}"
)

if [ -n "${AGENT_MODEL:-}" ]; then
  agent_args+=(--ak "model:str=$AGENT_MODEL")
fi

harbor "${agent_args[@]}"
