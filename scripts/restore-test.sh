#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/lib/common.sh"

trap 'log "restore-test.sh failed at line $LINENO"' ERR

archive="${1:-}"
[[ -n "$archive" ]] || die "usage: restore-test.sh <backup file>"
[[ -f "$archive" ]] || die "no such backup file: $archive"

require_cmd docker age gzip
if [[ -f "${BACKUP_ENV:-/etc/loop-backup.env}" ]]; then load_env; fi
: "${BACKUP_AGE_IDENTITY:?set BACKUP_AGE_IDENTITY to the age identity file}"
[[ -f "$BACKUP_AGE_IDENTITY" ]] || die "no such age identity: $BACKUP_AGE_IDENTITY"

container="loop-restore-test-$$-${RANDOM}"
password="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"

cleanup() {
	docker rm --force --volumes "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT

log "starting throwaway postgres container $container"
docker run --detach --name "$container" \
	--env POSTGRES_USER=loop \
	--env POSTGRES_PASSWORD="$password" \
	--env POSTGRES_DB=loop \
	postgres:18.6-alpine >/dev/null

ready=0
for _ in $(seq 1 60); do
	if docker exec "$container" pg_isready -h 127.0.0.1 -U loop -d loop >/dev/null 2>&1; then
		ready=1
		break
	fi
	sleep 1
done
((ready)) || die "throwaway postgres never became ready"

log "restoring $archive"
if ! age -d -i "$BACKUP_AGE_IDENTITY" "$archive" |
	gzip -d |
	docker exec -i "$container" pg_restore -U loop -d loop --no-owner --no-privileges; then
	log "pg_restore reported errors; checking the result anyway"
fi

query() {
	docker exec -i "$container" psql -U loop -d loop -tAc "$1" | tr -d '[:space:]'
}

tables="$(query "select count(*) from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'")"
printf 'tables: %s\n' "$tables"
for table in guilds moderation_cases tickets; do
	printf '%s: %s\n' "$table" "$(query "select count(*) from $table")"
done

((tables >= 24)) || die "expected at least 24 tables in public schema, found $tables"
log "restore test passed for $archive"
