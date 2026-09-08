#!/bin/bash
set -euo pipefail
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<'SQL'
\getenv app_password GATEWAY_DB_PASSWORD
SELECT format('CREATE ROLE gateway LOGIN PASSWORD %L', :'app_password') \gexec
CREATE DATABASE gateway OWNER gateway;
SQL
