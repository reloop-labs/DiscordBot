#!/bin/bash
set -euo pipefail
deno run --allow-net --allow-env --allow-read=/app/drizzle /app/scripts/migrate.ts
exec deno run --allow-net --allow-env --allow-read=/home/container/data --allow-write=/home/container/data /app/src/main.ts
