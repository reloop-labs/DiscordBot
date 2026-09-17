#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/lib/common.sh"

trap 'log "backup.sh failed at line $LINENO"' ERR

subdir="daily"
case "${1:-}" in
"") ;;
--tag) subdir="${2:?--tag needs a name}" ;;
*) die "usage: backup.sh [--tag <name>]" ;;
esac

require_cmd pg_dump age gzip
load_env

: "${PGHOST:?set PGHOST}"
: "${PGPORT:?set PGPORT}"
: "${PGUSER:?set PGUSER}"
: "${PGPASSWORD:?set PGPASSWORD}"
: "${PGDATABASE:?set PGDATABASE}"
: "${BACKUP_DIR:?set BACKUP_DIR}"
: "${BACKUP_AGE_RECIPIENT:?set BACKUP_AGE_RECIPIENT}"
export PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE

BACKUP_KEEP_DAILY="${BACKUP_KEEP_DAILY:-7}"
BACKUP_KEEP_WEEKLY="${BACKUP_KEEP_WEEKLY:-4}"
BACKUP_KEEP_MONTHLY="${BACKUP_KEEP_MONTHLY:-3}"
BACKUP_REMOTE="${BACKUP_REMOTE:-}"

umask 077
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
dest="$BACKUP_DIR/$subdir"
mkdir -p "$dest"
archive="$dest/loop-$stamp.dump.gz.age"

log "dumping $PGDATABASE from $PGHOST:$PGPORT to $archive"
pg_dump -Fc --no-password |
	gzip -9 |
	age -r "$BACKUP_AGE_RECIPIENT" -o "$archive"
chmod 600 "$archive"
[[ -s "$archive" ]] || die "backup archive is empty: $archive"

promoted=()
if [[ "$subdir" == "daily" ]]; then
	if [[ "$(date -u +%u)" == "7" ]]; then
		mkdir -p "$BACKUP_DIR/weekly"
		cp -p "$archive" "$BACKUP_DIR/weekly/"
		promoted+=("weekly")
	fi
	if [[ "$(date -u +%d)" == "01" ]]; then
		mkdir -p "$BACKUP_DIR/monthly"
		cp -p "$archive" "$BACKUP_DIR/monthly/"
		promoted+=("monthly")
	fi
fi

prune_local() {
	local dir="$BACKUP_DIR/$1" keep="$2" stale name
	[[ -d "$dir" ]] || return 0
	stale="$(ls -1t "$dir" 2>/dev/null | tail -n "+$((keep + 1))" || true)"
	[[ -n "$stale" ]] || return 0
	for name in $stale; do
		log "pruning $dir/$name"
		rm -f "$dir/$name"
	done
}

prune_local daily "$BACKUP_KEEP_DAILY"
prune_local weekly "$BACKUP_KEEP_WEEKLY"
prune_local monthly "$BACKUP_KEEP_MONTHLY"
[[ "$subdir" == "daily" ]] || prune_local "$subdir" "$BACKUP_KEEP_DAILY"

if [[ -n "$BACKUP_REMOTE" ]]; then
	require_cmd rclone
	rclone copy "$archive" "$BACKUP_REMOTE/$subdir/"
	local_tier=""
	for local_tier in ${promoted[@]+"${promoted[@]}"}; do
		rclone copy "$archive" "$BACKUP_REMOTE/$local_tier/"
	done
	rclone delete --min-age "${BACKUP_KEEP_DAILY}d" "$BACKUP_REMOTE/daily/" || true
	rclone delete --min-age "$((BACKUP_KEEP_WEEKLY * 7))d" "$BACKUP_REMOTE/weekly/" || true
	rclone delete --min-age "$((BACKUP_KEEP_MONTHLY * 31))d" "$BACKUP_REMOTE/monthly/" || true
	log "uploaded to $BACKUP_REMOTE/$subdir/"
fi

log "backup complete: $archive"
