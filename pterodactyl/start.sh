#!/bin/bash
set -euo pipefail
deno run --no-prompt --allow-net --allow-env --allow-read=/app,/node_modules /app/scripts/migrate.ts
exec deno run --no-prompt --allow-net --allow-env --allow-read=/app,/node_modules,/home/container/data,/usr/bin/ldd --allow-write=/home/container/data --allow-ffi --allow-sys=homedir,cpus /app/src/main.ts
