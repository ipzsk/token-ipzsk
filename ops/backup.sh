#!/bin/bash
set -euo pipefail
umask 077
cd /home/ubuntu/api-gateway
mkdir -p backups
output="backups/gateway-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker compose exec -T db pg_dump -U postgres -d gateway -Fc > "$output.partial"
test -s "$output.partial"
mv "$output.partial" "$output"
# Validate the archive structure without restoring over the live database.
docker compose exec -T db pg_restore --list < "$output" > /dev/null
if [ -f secrets/customer-auth-secret ]; then
  install -m 600 secrets/customer-auth-secret "${output%.dump}.customer-auth-secret"
fi
if [ -f secrets/mail/tencent-ses.json ]; then
  install -m 600 secrets/mail/tencent-ses.json "${output%.dump}.mail-settings"
fi
printf 'Database backup created: %s\n' "$output"
