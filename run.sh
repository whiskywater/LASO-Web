#!/bin/sh
set -eu
cd "$(dirname "$0")"
if ! command -v go >/dev/null 2>&1; then
    echo "LASO-Web requires Go 1.23 or newer. Build the standalone binary with 'go build -o laso-web .' or install Go." >&2
    exit 1
fi
exec go run .
