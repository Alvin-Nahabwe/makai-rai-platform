#!/usr/bin/env bash
# Dead-man's switch for makrai-backup.sh.
#
# The backup script can only alert about failures it survives long enough to
# notice. This one asks a question that does not depend on the script running
# at all: is there a recent backup on disk? Silent when healthy, so it is safe
# to run often.
set -Eeuo pipefail
cd /

# Overridable so the ALERT path can be exercised without faking a backup
# failure: point BACKUP_DIR at an empty directory and this script sends a real
# alert through the real code. An alerting mechanism nobody has ever seen fire
# is indistinguishable from one that does not work.
BACKUP_DIR="${BACKUP_DIR:-/srv/makrai/backups}"
APP_DIR="${APP_DIR:-/srv/makrai/app}"
MAX_AGE_HOURS="${MAX_AGE_HOURS:-36}"   # one missed nightly run, plus slack
MIN_BYTES="${MIN_BYTES:-1000}"
# SRS 7.5.8's 2 GB, in decimal units (NFR-REL-03). Overridable only so a test can make the size
# alert fire, as BACKUP_DIR does for the missing-backup alert.
MAX_DB_BYTES="${MAX_DB_BYTES:-2000000000}"

RESEND_API_KEY=$(set -a; . "${APP_DIR}/.env" >/dev/null 2>&1; echo "${RESEND_API_KEY:-}")
ALERT_TO=$(set -a;       . "${APP_DIR}/.env" >/dev/null 2>&1; echo "${ADMIN_EMAIL:-}")
ALERT_FROM=$(set -a;     . "${APP_DIR}/.env" >/dev/null 2>&1; echo "${EMAIL_FROM_ADDRESS:-}")
DB_USER=$(set -a;        . "${APP_DIR}/.env" >/dev/null 2>&1; echo "${POSTGRES_USER:-}")
DB_NAME=$(set -a;        . "${APP_DIR}/.env" >/dev/null 2>&1; echo "${POSTGRES_DB:-}")

alert() {
  [ -n "${RESEND_API_KEY}" ] && [ -n "${ALERT_TO}" ] || {
    echo "no RESEND_API_KEY/ADMIN_EMAIL -- cannot alert: $1" >&2; return 0; }
  payload=$(FROM="${ALERT_FROM}" TO="${ALERT_TO}" SUBJ="[makrai] $1" BODY="$2" python3 -I -c '
import json, os
print(json.dumps({"from": os.environ["FROM"], "to": [os.environ["TO"]],
                  "subject": os.environ["SUBJ"], "text": os.environ["BODY"]}))')
  # Status-checked, not exit-checked: curl exits 0 on HTTP 4xx, so an exit-only
  # test would call a rejected send a success.
  # The API key goes in through a config on STDIN, never as an argument.
  # Anything in argv is world-readable in the process table for the life of the
  # process, and this runs from cron on an internet-facing host every time an
  # alert fires -- so an argv header would publish the key to every local
  # account, repeatedly, forever. Demonstrated rather than assumed: with the key
  # as `-H "Authorization: Bearer ..."`, `ps -o args=` shows it; with this form,
  # curl's argv is just `curl -sS --config -`.
  #
  # `printf` is a shell BUILTIN, so it forks no process and has no argv of its
  # own -- the key never exists as an argument to anything. The payload stays in
  # argv deliberately: it is the alert text, which is not secret.
  resp=$(printf 'header = "Authorization: Bearer %s"\n' "${RESEND_API_KEY}" \
         | curl -sS --max-time 20 -w '\n%{http_code}' --config - \
                -X POST https://api.resend.com/emails \
                -H "Content-Type: application/json" -d "${payload}" 2>&1) || true
  code=$(printf '%s' "${resp}" | tail -n1)
  case "${code}" in
    2*) echo "alert accepted by Resend (HTTP ${code})" >&2 ;;
    *)  echo "ALERT NOT DELIVERED (HTTP ${code:-none}): $(printf '%s' "${resp}" | head -c 300)" >&2 ;;
  esac
}

# `makrai-*.sql.gz*`, matching the prune in makrai-backup.sh, so this covers
# both the encrypted files written today and any plaintext ones predating
# encryption. This glob said `makrai-*.sql.gz` for one day after encryption
# landed: it matched nothing, and at 06:00 UTC the next morning this script
# reported NO BACKUPS AT ALL and emailed the owner while nine good encrypted
# backups sat in the directory. A false alarm is the specific way a dead-man's
# switch dies -- its value is that a message means something.
# __tests__/lint/backup-glob-agreement.test.ts now fails if these two drift.
NEWEST=$(find "${BACKUP_DIR}" -maxdepth 1 -name 'makrai-*.sql.gz*' -printf '%T@ %p\n' 2>/dev/null \
         | sort -n | tail -1 | cut -d' ' -f2-)
NEWEST=${NEWEST:-}

if [ -z "${NEWEST}" ]; then
  alert "NO BACKUPS AT ALL on $(hostname)" \
"There is no backup file in ${BACKUP_DIR} on $(hostname).

Either the backup has never run here, or every file has been removed. This is
not a warning -- there is currently nothing to restore from."
  exit 1
fi

AGE_H=$(( ( $(date +%s) - $(stat -c %Y "${NEWEST}") ) / 3600 ))
BYTES=$(stat -c %s "${NEWEST}")

if [ "${AGE_H}" -gt "${MAX_AGE_HOURS}" ] || [ "${BYTES}" -lt "${MIN_BYTES}" ]; then
  alert "BACKUP IS STALE on $(hostname)" \
"The newest backup on $(hostname) is not healthy.

file:  ${NEWEST}
age:   ${AGE_H}h (limit ${MAX_AGE_HOURS}h)
size:  ${BYTES} bytes (floor ${MIN_BYTES})

The backup job has not produced a usable file recently, and did not report a
failure itself -- so it probably did not run. Check the crontab, then
/srv/makrai/backup.log."
  exit 1
fi

# The database's size (NFR-REL-03, SRS 7.5.8): one SELECT that returns one number, as the restore
# test's rule for the live database is (makrai-restore-test.sh: "only ever READ, with a SELECT that
# returns one count"). The alert carries that number and the limit and nothing else. A size that
# cannot be read is its own alert and a failure: a check that goes quiet when the query fails would
# let the database pass the limit unseen.
DB_BYTES=$(timeout 30 docker exec docker-postgres-1 psql -U "${DB_USER}" -d "${DB_NAME}" -Atc "SELECT pg_database_size(current_database())") || DB_BYTES=
if ! [[ "${DB_BYTES}" =~ ^[0-9]+$ ]]; then
  # A mail can fail to send; journald keeps a line either way (the fixed words only, no name).
  logger -p user.err -t makrai-backup-check "DATABASE SIZE UNREADABLE: the 2 GB limit was not checked" || true
  alert "DATABASE SIZE UNREADABLE on $(hostname)" \
"The size of the database on $(hostname) could not be read, so the 2 GB limit
was not checked. Check that the database container is running, then run this
script by hand."
  exit 1
fi
if [ "${DB_BYTES}" -gt "${MAX_DB_BYTES}" ]; then
  logger -p user.err -t makrai-backup-check "DATABASE ABOVE 2 GB size=${DB_BYTES} limit=${MAX_DB_BYTES}" || true
  alert "DATABASE ABOVE 2 GB on $(hostname)" \
"The database on $(hostname) is above its size limit.

size:  ${DB_BYTES} bytes
limit: ${MAX_DB_BYTES} bytes

Plan the move to a larger plan or an archive before the disk fills."
  exit 1
fi

exit 0   # healthy: say nothing
