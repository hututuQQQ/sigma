#!/usr/bin/env bash
set -euo pipefail

if [ -n "${PYTHON_BIN:-}" ]; then
  "$PYTHON_BIN" -m unittest -q
elif command -v python3 >/dev/null 2>&1 && python3 -c 'import sys' >/dev/null 2>&1; then
  python3 -m unittest -q
elif command -v python >/dev/null 2>&1 && python -c 'import sys' >/dev/null 2>&1; then
  python -m unittest -q
elif command -v py >/dev/null 2>&1; then
  py -3 -m unittest -q
else
  echo "Python 3 is required to run this smoke task." >&2
  exit 127
fi
