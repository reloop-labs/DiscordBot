#!/usr/bin/env bash

log() {
	printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2
}

die() {
	log "error: $*"
	exit 1
}

require_cmd() {
	local cmd
	for cmd in "$@"; do
		command -v "$cmd" >/dev/null 2>&1 || die "missing required command: $cmd"
	done
}

load_env() {
	local file="${BACKUP_ENV:-/etc/loop-backup.env}"
	[[ -f "$file" ]] || die "missing $file"
	set -a
	. "$file"
	set +a
}
