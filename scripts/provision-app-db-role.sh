#!/usr/bin/env bash
# Sets the makrai_app password. Deliberately NOT a migration: migrations are
# committed and run in every environment, so a password in one would publish
# production's app credential. Run this after `prisma migrate deploy`.
#
#   APP_DB_PASSWORD=<secret> scripts/provision-app-db-role.sh <database>
#
# Local dev/test default is the well-known 'app_dev_password', which matches
# vitest.config.ts. That default is refused when NODE_ENV=production.
set -euo pipefail

DB="${1:?usage: provision-app-db-role.sh <database>}"

if [ -z "${APP_DB_PASSWORD:-}" ]; then
  if [ "${NODE_ENV:-development}" = "production" ]; then
    echo "refusing to use the dev default password in production; set APP_DB_PASSWORD" >&2
    exit 1
  fi
  APP_DB_PASSWORD='app_dev_password'
  echo "APP_DB_PASSWORD unset — using the local dev default for '$DB'" >&2
fi

# The statement goes in on STDIN, not via `-c`. psql only performs variable
# interpolation on input it parses itself; `-c` is documented to require a
# string "completely parsable by the server (i.e., it contains no psql-specific
# features)", so `:'pw'` would reach the server as literal text and error with
# `syntax error at or near ":"` (observed on psql 16.14, 2026-08-03).
#
# `:'pw'` — psql quotes and escapes the variable, so a password containing a
# quote cannot break out of the statement. Do NOT build this SQL by string
# interpolation.
printf "%s\n" "ALTER ROLE makrai_app WITH PASSWORD :'pw';" \
  | docker exec -i docker-postgres-1 psql -v ON_ERROR_STOP=1 -U makrai -d "$DB" \
      -v pw="$APP_DB_PASSWORD"

echo "makrai_app password provisioned on '$DB'"
