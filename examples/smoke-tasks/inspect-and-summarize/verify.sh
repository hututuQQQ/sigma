#!/usr/bin/env bash
set -euo pipefail

test "$(cat result.txt)" = "3"
