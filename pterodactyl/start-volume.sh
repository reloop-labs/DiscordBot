#!/bin/bash
set -euo pipefail
cd /home/container
DENO_VERSION="${DENO_VERSION:-2.9.7}"
export DENO_DIR=/home/container/.deno
export DENO_NO_UPDATE_CHECK=1
if [[ ! -x ./deno ]] || [[ "$(./deno --version 2>/dev/null | head -1 | awk '{print $2}')" != "${DENO_VERSION}" ]]; then
	echo "fetching deno ${DENO_VERSION}"
	curl -fsSL "https://github.com/denoland/deno/releases/download/v${DENO_VERSION}/deno-x86_64-unknown-linux-gnu.zip" -o deno.zip
	unzip -oq deno.zip && rm -f deno.zip && chmod +x ./deno
fi
./deno install --frozen
./deno run --no-prompt --allow-net --allow-env --allow-read=/home/container,/home/node_modules,/node_modules,/usr/bin/ldd ./scripts/migrate.ts
exec ./deno run --no-prompt --allow-net --allow-env --allow-read=/home/container,/home/node_modules,/node_modules,/usr/bin/ldd --allow-write=./data --allow-ffi --allow-sys=homedir,cpus ./src/main.ts
