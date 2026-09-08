#!/bin/bash
set -euo pipefail
# Read as root before the official entrypoint switches to its database user.
export GATEWAY_DB_PASSWORD="$(cat /run/secrets/db-password)"
exec /usr/local/bin/docker-entrypoint.sh "$@"
