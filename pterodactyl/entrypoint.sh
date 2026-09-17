#!/bin/bash
set -o pipefail
cd /home/container || exit 1
export INTERNAL_IP="$(ip route get 1 2>/dev/null | awk '{print $(NF-2); exit}')"
MODIFIED_STARTUP="${STARTUP}"
for _ in $(seq 1 100); do
	[[ "${MODIFIED_STARTUP}" =~ \{\{([A-Za-z_][A-Za-z0-9_]*)\}\} ]] || break
	name="${BASH_REMATCH[1]}"
	MODIFIED_STARTUP="${MODIFIED_STARTUP//\{\{${name}\}\}/${!name:-}}"
done
printf '\033[1m\033[33mcontainer@loop~ \033[0m:/home/container$ %s\n' "${MODIFIED_STARTUP}"
exec bash -c "${MODIFIED_STARTUP}"
