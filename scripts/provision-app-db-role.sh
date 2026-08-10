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

# How this script reaches psql. Defaults to exactly today's behaviour: exec
# into the local dev container over its Unix socket -- which is also why no
# host or password is needed for the "makrai" superuser connection itself:
# postgres's docker-entrypoint trusts local Unix-socket connections and only
# requires a password over TCP. Override PSQL_CMD for any environment where
# `docker exec docker-postgres-1` does not resolve to anything -- e.g. CI,
# where Postgres is a service container reached over TCP on localhost and
# there is no such container to exec into at all (docs/DEFERRED_REGISTER.md
# D-146):
#   PSQL_CMD='psql -h localhost -p 5432 -U makrai'
#   PGPASSWORD=<superuser password>   # required in TCP mode; trust covers the socket default
# Word-split deliberately (`read -ra`, not a quoted string call): PSQL_CMD is
# a command prefix under our own control (this default, or the CI workflow),
# never untrusted input, and its pieces are plain flags with no embedded
# spaces.
read -ra PSQL_CMD <<< "${PSQL_CMD:-docker exec -i docker-postgres-1 psql -U makrai}"

# The statement goes in on STDIN, not via `-c`. psql only performs variable
# interpolation on input it parses itself; `-c` is documented to require a
# string "completely parsable by the server (i.e., it contains no psql-specific
# features)", so `:'pw'` would reach the server as literal text and error with
# `syntax error at or near ":"` (observed on psql 16.14, 2026-08-03).
#
# `:'pw'` — psql quotes and escapes the variable, so a password containing a
# quote cannot break out of the statement. Do NOT build this SQL by string
# interpolation. This is unchanged by the PSQL_CMD indirection above: only
# HOW psql is reached is overridable, never how the SQL itself is built.
printf "%s\n" "ALTER ROLE makrai_app WITH PASSWORD :'pw';" \
  | "${PSQL_CMD[@]}" -v ON_ERROR_STOP=1 -d "$DB" \
      -v pw="$APP_DB_PASSWORD"

echo "makrai_app password provisioned on '$DB'"
