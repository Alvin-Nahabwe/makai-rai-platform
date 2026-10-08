#!/usr/bin/env bash
# /usr/local/bin/makrai-backup.sh
# Automated PostgreSQL backup for the RAI Toolkit Platform.
#
# Rewritten 2026-08-29 after an adversarial review executed five distinct ways
# the previous version failed silently. Each guard below names the failure it
# closes; do not remove one without reproducing that failure first.

set -Eeuo pipefail
# -E matters on its own. Without `errtrace` the trap is NOT inherited by shell
# functions, so a failing `log()` -- the very thing meant to record failures --
# killed the script from inside the function with the trap never entered.

BACKUP_DIR="/srv/makrai/backups"
RETENTION_DAYS=30
APP_DIR="/srv/makrai/app"
POSTGRES_CONTAINER="docker-postgres-1"
# Not /var/log: that is root:syslog, and 1.3 installs a USER crontab. Every run
# would have died on its first write having logged nothing. Keep the log where
# the cron user owns the directory.
LOG_FILE="/srv/makrai/backup.log"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
PLAIN_FILE="${BACKUP_DIR}/.makrai-${TIMESTAMP}.sql.gz.tmp"
BACKUP_FILE="${BACKUP_DIR}/makrai-${TIMESTAMP}.sql.gz.gpg"
VERIFIED=0

# Second-resolution names collide, and `flock` below does not help: it stops
# CONCURRENT runs, not a second run started within the same second. Observed
# while testing this very script -- the second run silently overwrote the first
# good backup and then, on failing, deleted it. Refuse rather than clobber.
[ -e "${BACKUP_FILE}" ] && { echo "[$(date -Is)] ERROR: ${BACKUP_FILE} already exists; refusing to overwrite." >&2; exit 1; }

# Send everything -- including stderr -- to the log. Without this, "No such
# container" and "permission denied on the docker socket" went to cron's
# stderr, which on a box with no MTA is discarded, leaving an error line with
# no cause attached.
exec >>"${LOG_FILE}" 2>&1 || { echo "FATAL: cannot write ${LOG_FILE}" >&2; exit 1; }
log() { echo "[$(date -Is)] $*"; }

# Alerting. The platform already has a verified sending domain and a send-only
# Resend key, so a failure can reach a human without adding a dependency.
#
# Never let alerting failure mask the failure being alerted about: this is the
# one place in this script where a non-zero exit is deliberately swallowed. If
# the alert cannot be sent, that fact is logged and the original error still
# propagates.
alert() { # $1 = subject, $2 = body
  if [ -z "${RESEND_API_KEY:-}" ] || [ -z "${ALERT_TO:-}" ]; then
    log "WARNING: RESEND_API_KEY or ALERT_TO unset -- no alert sent. This failure is in the log only."
    return 0
  fi
  local payload
  payload=$(FROM="${ALERT_FROM}" TO="${ALERT_TO}" SUBJ="$1" BODY="$2" python3 -c '
import json, os
print(json.dumps({"from": os.environ["FROM"], "to": [os.environ["TO"]],
                  "subject": os.environ["SUBJ"], "text": os.environ["BODY"]}))') || {
    log "WARNING: could not build the alert payload"; return 0; }
  # `curl -sS` exits 0 on an HTTP 4xx/5xx. Checking only its exit status would
  # log "alert sent" for a rejected key, an unverified sending domain or a
  # malformed address -- an alerting mechanism that reports success while
  # delivering nothing, which is the exact failure it exists to prevent.
  local resp code
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
    2*) log "alert accepted by Resend (HTTP ${code}) for ${ALERT_TO}" ;;
    *)  log "WARNING: alert NOT delivered (HTTP ${code:-none}): $(printf '%s' "${resp}" | head -c 300)" ;;
  esac
  return 0
}

# cron and `sudo -u` both leave the working directory set to something the
# running user may not be able to read -- /root, in the case that found this.
# GNU find then fails with "Failed to restore initial working directory:
# Permission denied" AFTER producing correct output, so the size check and the
# prune below both broke while the dump itself was fine. Every path here is
# absolute, so the working directory has no other job.
cd /

# EXIT, not ERR. `.` (source) is a POSIX SPECIAL BUILTIN: its failure terminates
# a non-interactive shell immediately and bypasses an ERR trap entirely. A
# missing or unreadable .env -- the likeliest failure on a fresh box -- produced
# no log line at all under an ERR trap. An EXIT trap catches it, and catches
# `set -u` violations too.
cleanup() {
  rc=$?
  if [ "$rc" -ne 0 ]; then
    log "ERROR: backup FAILED (exit ${rc})."
    if [ "$VERIFIED" -eq 1 ]; then
      # The previous version deleted unconditionally, so a failure in the prune
      # -- after a good dump had been written and verified -- destroyed it and
      # then logged that no backup was produced. Self-inflicted data loss.
      log "NOTE: ${BACKUP_FILE} is complete and verified; KEEPING it."
    else
      rm -f "${BACKUP_FILE}"
    fi
    rm -f "${PLAIN_FILE}"
    # Tell the watchdog immediately rather than letting it infer failure from a
    # missing ping hours later.
    [ -n "${HC_URL}" ] && curl -fsS -m 10 --retry 3 -o /dev/null "${HC_URL}/fail" || true
    alert "[makrai] BACKUP FAILED on $(hostname)" \
"The nightly database backup failed.

host:   $(hostname)
exit:   ${rc}
when:   $(date -Is)

Last lines of ${LOG_FILE}:
$(tail -n 15 "${LOG_FILE}" 2>/dev/null)

Nothing is broken in the running application by this -- it means there is no
backup from this run. Check the log above, then run
/usr/local/bin/makrai-backup.sh by hand once the cause is fixed."
  fi
  exit "$rc"
}
trap cleanup EXIT

# Second-resolution timestamps collide, and a hand-run during an incident is
# exactly when a second copy gets started. Two concurrent runs silently produced
# one file.
exec 9>/var/lock/makrai-backup.lock
flock -n 9 || { log "ERROR: another backup is already running."; exit 1; }

log "Starting backup..."

# Read only the two values needed, in a subshell. Sourcing .env directly at this
# point let it silently redefine BACKUP_DIR, RETENTION_DAYS and LOG_FILE -- a
# RETENTION_DAYS=0 in .env made the prune delete everything while the log
# reported normal operation.
[ -r "${APP_DIR}/.env" ] || { log "ERROR: ${APP_DIR}/.env missing or unreadable."; exit 1; }
POSTGRES_USER=$(set -a; . "${APP_DIR}/.env" >/dev/null 2>&1; echo "${POSTGRES_USER:-}")
POSTGRES_DB=$(set -a;   . "${APP_DIR}/.env" >/dev/null 2>&1; echo "${POSTGRES_DB:-}")
RESEND_API_KEY=$(set -a; . "${APP_DIR}/.env" >/dev/null 2>&1; echo "${RESEND_API_KEY:-}")
ALERT_TO=$(set -a;      . "${APP_DIR}/.env" >/dev/null 2>&1; echo "${ADMIN_EMAIL:-}")
ALERT_FROM=$(set -a;    . "${APP_DIR}/.env" >/dev/null 2>&1; echo "${EMAIL_FROM_ADDRESS:-}")
# Dead-man's switch. Treated as a credential and kept in .env, never in the
# repository: anyone holding this URL can send a success ping and suppress a
# real alarm, which is the one failure mode this mechanism exists to prevent.
HC_URL=$(set -a;        . "${APP_DIR}/.env" >/dev/null 2>&1; echo "${HEALTHCHECK_PING_URL:-}")
BACKUP_PASSPHRASE=$(set -a; . "${APP_DIR}/.env" >/dev/null 2>&1; echo "${BACKUP_PASSPHRASE:-}")
[ -n "${POSTGRES_USER}" ] && [ -n "${POSTGRES_DB}" ] \
  || { log "ERROR: POSTGRES_USER/POSTGRES_DB are not set in ${APP_DIR}/.env."; exit 1; }

# `timeout` because a container that accepts the exec and never streams leaves
# cron holding an open process and a zero-byte .sql.gz that looks like a backup.
# `pipefail` because without it the pipeline reports gzip's status, so a dead
# pg_dump still produced a well-formed gzip of nothing.
timeout 3600 docker exec "${POSTGRES_CONTAINER}" \
  pg_dump -U "${POSTGRES_USER}" "${POSTGRES_DB}" | gzip > "${PLAIN_FILE}"

gunzip -t "${PLAIN_FILE}"

# THE CHECK THAT MATTERS MOST. `gunzip -t` validates the gzip CONTAINER, not the
# SQL inside it. A dump truncated mid-stream while docker exec still exits 0
# closes as a perfectly valid gzip. Under the previous script that passed every
# check and logged "Backup complete." -- and because the prune runs on success,
# 31 consecutive truncated runs deleted all 35 good backups with a clean log.
# This marker is pg_dump's own statement that it finished.
# A 20-line window, not 5. The marker is the last thing pg_dump's own output
# contains, but it is no longer the last line of the FILE: pg_dump 17 appends
# `\unrestrict <token>` afterwards, which already put the marker at position 5
# of the last 5 on this server. One more trailing line in a future pg_dump and a
# 5-line window would fail on a PERFECTLY GOOD backup -- discarding it and
# raising an alert, which is the expensive direction of a wrong answer.
#
# Still a bounded window rather than a whole-file grep: the string could in
# principle occur inside dumped text data, and a truncated dump that happened to
# contain it would then pass. Twenty lines is far from any plausible drift and
# still cannot reach mid-file content.
gunzip -c "${PLAIN_FILE}" | tail -20 | grep -q 'PostgreSQL database dump complete' \
  || { log "ERROR: dump has no completion marker -- TRUNCATED. Discarding."; exit 1; }

# Relative to the last good backup, not an absolute floor. A schema-only dump of
# this database with ZERO rows gzips to ~1.4 KB, which cleared the old 1000-byte
# constant and was logged as success -- so a restore against the wrong database
# looked healthy.
BYTES=$(stat -c %s "${PLAIN_FILE}")
# The default is applied AFTER the pipeline, not with `|| echo 0`. Under
# `pipefail` a failing stage makes the whole pipeline fail even when earlier
# stages printed correct output, so `|| echo 0` APPENDED a zero instead of
# substituting one -- yielding "8075\n0" and `[: integer expression expected`.
PREV=$(find "${BACKUP_DIR}" -maxdepth 1 -name 'makrai-*.sql.gz.gpg' ! -name "*${TIMESTAMP}*" \
       -printf '%s\n' 2>/dev/null | sort -n | tail -1)
PREV=${PREV:-0}
if [ "${PREV}" -ne 0 ] && [ "${BYTES}" -lt $((PREV / 2)) ]; then
  log "ERROR: ${BYTES} bytes is under half the previous backup (${PREV}). Discarding."
  exit 1
fi

# --- Encrypt, then prove the encryption can be undone ---
#
# What this protects, stated honestly: a backup file that LEAVES this machine --
# the off-site copy, a disk snapshot, a stolen image. It does NOT protect against
# an attacker who already holds the server, because the passphrase is in .env on
# the same host. Claiming otherwise would be the kind of assertion this runbook
# keeps having to retract.
#
# It matters because these dumps contain user-uploaded evidence documents in
# readable form -- register row D-142, which stopped being hypothetical the day
# nightly backups started running.
[ -n "${BACKUP_PASSPHRASE}" ] || { log "ERROR: BACKUP_PASSPHRASE unset -- refusing to write an unencrypted backup."; exit 1; }

# --passphrase-fd, never --passphrase: an argument is world-readable in the
# process table (register rows D-091, D-254).
gpg --batch --yes --quiet --symmetric --cipher-algo AES256 \
    --passphrase-fd 3 --output "${BACKUP_FILE}" "${PLAIN_FILE}" 3<<<"${BACKUP_PASSPHRASE}"

# THE STEP THAT MAKES ENCRYPTION SAFE RATHER THAN A NEW RISK. An encrypt whose
# decrypt has never run is how an archive of unrecoverable files accumulates
# while looking healthy the entire time. Decrypt what was just written and
# confirm the dump's own completion marker survives the round trip.
gpg --batch --quiet --decrypt --passphrase-fd 3 "${BACKUP_FILE}" 3<<<"${BACKUP_PASSPHRASE}" \
  | gunzip -c | tail -20 | grep -q 'PostgreSQL database dump complete' \
  || { log "ERROR: the encrypted backup does not decrypt to a complete dump. Discarding."; rm -f "${BACKUP_FILE}"; exit 1; }

rm -f "${PLAIN_FILE}"
VERIFIED=1
log "Backup verified and encrypted: ${BACKUP_FILE} (${BYTES} bytes before encryption)"

# Prune only after a verified success, so a run of failures can never eat the
# archive. Verified: three consecutive failures left all seeded backups intact.
# Matches encrypted files and any plaintext ones predating encryption.
find "${BACKUP_DIR}" -maxdepth 1 -name 'makrai-*.sql.gz*' -mtime "+${RETENTION_DAYS}" -delete
log "Pruned backups older than ${RETENTION_DAYS} days."

# THE ONLY SIGNAL THAT SURVIVES THE MACHINE BEING OFF. Everything else in this
# script runs here, so none of it can report that "here" is gone -- and silence
# is exactly what healthy looks like. An external watchdog inverts that: it
# alerts on the ABSENCE of this ping, so a dead box, a full disk, a hung run and
# a deleted crontab all become visible without anything on this host noticing.
#
# Deliberately the last statement, after the prune. A ping sent earlier would
# report success for a run that had not finished.
if [ -n "${HC_URL}" ]; then
  curl -fsS -m 10 --retry 3 -o /dev/null "${HC_URL}" \
    && log "watchdog pinged" \
    || log "WARNING: watchdog ping failed -- the backup is fine, but an absent ping will raise a false alarm."
else
  log "WARNING: HEALTHCHECK_PING_URL unset -- nothing is watching for this job disappearing."
fi

log "Backup complete."
