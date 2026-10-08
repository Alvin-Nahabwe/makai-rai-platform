#!/usr/bin/env bash
# Sets the password of one of the two application roles (ADR-0009). Deliberately NOT a
# migration: migrations are committed and run in every environment, so a password in one
# would publish production's credential. Run this after `prisma migrate deploy`, which
# creates both roles without a password.
#
#   APP_DB_PASSWORD=<secret>      scripts/provision-app-db-role.sh <database> [makrai_app]
#   IDENTITY_DB_PASSWORD=<secret> scripts/provision-app-db-role.sh <database> makrai_identity
#
# The role defaults to makrai_app, so the one-argument form keeps its old meaning.
#
# The well-known local passwords -- 'app_dev_password' and 'identity_dev_password', the
# values vitest.config.ts expects -- are refused unless ALLOW_DEV_DB_PASSWORD=1, whatever
# NODE_ENV says (D-076). NODE_ENV used to be the guard, and it is trivially unset in a
# container or a fresh shell, which made the published password the default for
# production. The flag is set in exactly two places: `npm run db:provision` (local) and
# the CI provisioning steps. A dev password passed explicitly is refused too: deriving
# the password from a URL copied out of .env.example would otherwise provision it.
set -euo pipefail

DB="${1:?usage: provision-app-db-role.sh <database> [makrai_app|makrai_identity]}"
ROLE="${2:-makrai_app}"

# The role name reaches SQL below, so it comes from this list and nowhere else.
case "$ROLE" in
  makrai_app)      PW_VAR=APP_DB_PASSWORD;      DEV_PW='app_dev_password' ;;
  makrai_identity) PW_VAR=IDENTITY_DB_PASSWORD; DEV_PW='identity_dev_password' ;;
  *) echo "unknown role '$ROLE': this script provisions makrai_app or makrai_identity" >&2; exit 1 ;;
esac

PW="${!PW_VAR:-}"
if [ -z "$PW" ] || [ "$PW" = "$DEV_PW" ]; then
  if [ "${ALLOW_DEV_DB_PASSWORD:-}" != "1" ]; then
    echo "refusing to provision $ROLE with the well-known dev password: set $PW_VAR to a real secret," \
         "or ALLOW_DEV_DB_PASSWORD=1 for a local or CI database" >&2
    exit 1
  fi
  PW="$DEV_PW"
  echo "ALLOW_DEV_DB_PASSWORD=1: provisioning $ROLE on '$DB' with the local dev password" >&2
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
# The password goes in on STDIN, never as an argument. `-v pw="$APP_DB_PASSWORD"`
# -- what this used to be -- placed the production credential in psql's argv,
# world-readable in the process table for the life of the command, on both the
# host and (through `docker exec`) inside the container. That is register row
# D-091, open since 2026-08-06.
#
# `\set` takes the value through the same stream as the SQL, so nothing sensitive
# ever appears in an argument list. Two layers of quoting are involved and they
# are NOT the same: the escaping below is for psql's own backslash-command
# parser, which within single quotes treats `\` as an escape character; `:'pw'`
# on the next line is what quotes the value for SQL, and that is psql's job, not
# ours. Do not merge them, and do not build the ALTER by string interpolation.
#
# Order matters: backslashes first, or the escapes added for quotes would
# themselves be escaped.
esc=${PW//\\/\\\\}
esc=${esc//\'/\\\'}

# A newline cannot survive `\set`, which is line-oriented -- it would silently
# truncate the password and provision something other than what the app sends.
# Refusing is the only honest option; silently setting a different password is
# how you get an application that cannot authenticate and a script that reported
# success.
case "$PW" in
  *$'\n'*) echo "$PW_VAR contains a newline, which psql \\set cannot carry; refusing" >&2; exit 1 ;;
esac

# What reaches the server, in order:
#
# 1. Every setting that can copy a statement's TEXT into the server log is turned off
#    for this session. `ALTER ROLE ... PASSWORD` carries the password in plain text, and
#    an ordinary production setting such as log_statement = 'ddl' would log it verbatim;
#    log_min_error_statement would log it if the ALTER failed. These are superuser
#    settings, and this script connects as the superuser.
# 2. The role must already exist. Checked in its own statement so that a missing role
#    fails here, with no password in the statement, rather than in the ALTER.
# 3. The password, as a psql variable, then the one statement that uses it.
printf '%s\n' \
  'SET log_min_error_statement = panic;' \
  "SET log_statement = 'none';" \
  'SET log_min_duration_statement = -1;' \
  'SET log_min_duration_sample = -1;' \
  'SET log_transaction_sample_rate = 0;' \
  'SET debug_print_parse = off;' \
  'SET debug_print_rewritten = off;' \
  'SET debug_print_plan = off;' \
  "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$ROLE') THEN RAISE EXCEPTION 'role $ROLE does not exist: run prisma migrate deploy first'; END IF; END \$\$;" \
  "\\set pw '${esc}'" \
  "ALTER ROLE $ROLE WITH PASSWORD :'pw';" \
  | "${PSQL_CMD[@]}" -v ON_ERROR_STOP=1 -d "$DB"

echo "$ROLE password provisioned on '$DB'"
