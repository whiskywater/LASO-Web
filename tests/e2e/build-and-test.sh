#!/bin/sh
set -eu

web_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
laso_root=${LASO_SOURCE_DIR:-"$web_root/../LASO"}
if [ ! -f "$laso_root/CMakeLists.txt" ]; then
  echo "Set LASO_SOURCE_DIR to a clean checkout of the LASO source repository." >&2
  exit 2
fi

cmake -S "$laso_root" -B "$laso_root/build-browser-e2e" -G Ninja \
  -DCMAKE_BUILD_TYPE=Debug -DBUILD_TESTING=OFF -DLASO_INSTALL_SYSTEMD_UNIT=OFF
cmake --build "$laso_root/build-browser-e2e" --target laso-server --parallel

cd "$web_root"
export PLAYWRIGHT_BROWSERS_PATH=${PLAYWRIGHT_BROWSERS_PATH:-"$web_root/.playwright-browsers"}
mkdir -p build
go build -trimpath -o build/laso-web .
npm ci
npx playwright install chromium
npm run test:e2e
