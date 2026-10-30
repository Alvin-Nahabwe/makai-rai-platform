#!/usr/bin/env bash
# One builder's Postgres for a v0.6.0 build slot (contract "Per-builder database and ports", 00-master.md E2).
#
#   scripts/test-db/slot.sh up <K>     K = 1..10: create container v060-pg-bK on 127.0.0.1:(5440+K), the
#                                      makrai_test and makrai databases, their migrations and both login roles
#   scripts/test-db/slot.sh down <K>   remove that container and its volume
#
# Run it on your own slot number only. The worktree's env file (.env) names the slot's app port, 3100+K, in
# NEXTAUTH_URL, so a typed number cannot touch another builder's database: both commands refuse (exit 2) an env
# file that names another slot's port, and `down`, which removes data, also refuses a worktree whose env file is
# absent or names no port. `up` accepts a worktree with no env file yet, because 00-master.md E2 writes it after
# the database exists. `up` refuses (exit 1) when the container or its volume already exists, because an old data
# directory would hand its old schema to the new database; `down` refuses (exit 1) when the docker daemon does not
# answer, because "no container" would then be a guess. It writes no env file: the slot's variables are the
# controller's.
#
# The data lives on the named volume v060-pg-bK-data, never on tmpfs: `docker stop` empties a tmpfs data
# directory, and e2e/db-outage.spec.ts stops and starts this container (finding WI-02). Nothing is pulled
# (--pull=never): the image is already on the machine. The password below is the well-known local dev
# password of vitest.config.ts, for a database that listens on loopback only; it is never printed.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

CMD="${1:-}"
K="${2-}"
case "$CMD" in
  up | down) ;;
  *) echo "usage: scripts/test-db/slot.sh up|down <K>   (K = 1..10)" >&2; exit 2 ;;
esac
if ! [[ "$K" =~ ^([1-9]|10)$ ]]; then
  echo "slot.sh: the slot number must be 1 to 10" >&2
  exit 2
fi

PORT_PG=$((5440 + K))
PORT_APP=$((3100 + K))
ENV_FILE="${SLOT_ENV_FILE:-.env}"
# The port NEXTAUTH_URL names in the env file, or nothing. sed quits at the first match instead of piping to head:
# a reader that stops early would kill its writer with SIGPIPE, and pipefail would take that for a failure.
named_port=""
if [ -f "$ENV_FILE" ]; then
  named_port="$(sed -n '/^NEXTAUTH_URL="\{0,1\}http:\/\/localhost:[0-9]\{1,\}"\{0,1\}$/{s/.*localhost:\([0-9]*\).*/\1/p;q;}' "$ENV_FILE")"
fi
if [ -n "$named_port" ] && [ "$named_port" != "$PORT_APP" ]; then
  echo "slot.sh: refused: this worktree's env file names port ${named_port}, not ${PORT_APP} (slot ${K}); run it on your own slot" >&2
  exit 2
fi
if [ "$CMD" = down ] && [ -z "$named_port" ]; then
  echo "slot.sh: refused: down removes data, and this worktree's env file does not name port ${PORT_APP} (slot ${K})" >&2
  exit 2
fi

slot_exists() {
  docker container inspect "v060-pg-b${K}" > /dev/null 2>&1 || docker volume inspect "v060-pg-b${K}-data" > /dev/null 2>&1
}

if [ "$CMD" = down ]; then
  if ! docker info > /dev/null 2>&1; then
    echo "slot.sh: the docker daemon does not answer, so whether slot ${K} exists is unknown; nothing was removed" >&2
    exit 1
  fi
  if docker container inspect "v060-pg-b${K}" > /dev/null 2>&1; then
    docker rm -f -v "v060-pg-b${K}" > /dev/null
  fi
  if docker volume inspect "v060-pg-b${K}-data" > /dev/null 2>&1; then
    docker volume rm "v060-pg-b${K}-data" > /dev/null
  fi
  echo "slot ${K} removed"
  exit 0
fi

if slot_exists; then
  echo "slot.sh: slot ${K} already has a container or a volume; run: scripts/test-db/slot.sh down ${K}" >&2
  exit 1
fi

docker run -d --name "v060-pg-b${K}" --pull=never \
  -e POSTGRES_USER=makrai -e POSTGRES_PASSWORD=makrai_dev_password -e POSTGRES_DB=makrai_test \
  -p 127.0.0.1:${PORT_PG}:5432 \
  -v "v060-pg-b${K}-data":/var/lib/postgresql/data \
  postgres:16-alpine > /dev/null

wait_for() { # wait_for <what> <command...>: up to 90 seconds
  local what="$1"
  shift
  for _ in $(seq 1 90); do
    if "$@"; then return 0; fi
    sleep 1
  done
  echo "slot.sh: gave up waiting for ${what} in v060-pg-b${K}" >&2
  return 1
}
# No -q: grep reads the whole log, so docker logs never writes to a closed pipe. With -q grep stops at the first match,
# `docker logs` dies of SIGPIPE (141), and under pipefail a ready database would read as not ready.
init_done() { docker logs "v060-pg-b${K}" 2>&1 | grep 'PostgreSQL init process complete' > /dev/null; }
wait_for "the init process" init_done
wait_for "the database" docker exec "v060-pg-b${K}" pg_isready -U makrai -d makrai_test -q

docker exec "v060-pg-b${K}" createdb -U makrai makrai
for db in makrai_test makrai; do
  DATABASE_URL="postgresql://makrai:makrai_dev_password@localhost:${PORT_PG}/${db}" npx prisma migrate deploy > /dev/null
  for role in makrai_app makrai_identity; do
    PSQL_CMD="docker exec -i v060-pg-b${K} psql -U makrai" ALLOW_DEV_DB_PASSWORD=1 scripts/provision-app-db-role.sh "$db" "$role"
  done
done
echo "slot ${K} (v060-pg-b${K}) ready on 127.0.0.1:${PORT_PG}"
