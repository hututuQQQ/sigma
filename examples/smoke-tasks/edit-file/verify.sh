#!/usr/bin/env bash
set -euo pipefail

grep -q '^color=blue$' app.txt
grep -q '^size=small$' app.txt
! grep -q '^color=red$' app.txt
