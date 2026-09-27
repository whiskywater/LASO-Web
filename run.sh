#!/bin/sh
set -eu
cd "$(dirname "$0")"
if command -v go >/dev/null 2>&1; then
    exec go run .
fi
exec python3 server.py
