#!/usr/bin/env bash
set -euo pipefail

test "$(cat hello.txt)" = "hello world"
