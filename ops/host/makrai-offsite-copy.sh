#!/usr/bin/env bash
# /usr/local/bin/makrai-offsite-copy.sh
# Mirror the encrypted database backups to the Hetzner Storage Box.
#
# Runs from the operator's crontab at 00:30 UTC, half an hour after
# makrai-backup.sh, and reports to its own dead-man check
# (HC_OFFSITE_PING_URL): a ping on success, /fail plus a mail on failure, and
# silence if it never runs, which the check turns into an alarm.
#
# What leaves the machine is the .gpg files and nothing else. The plaintext
# temporary the backup script writes is never matched by the include below, and
# the passphrase that opens them stays in the server .env. See
# docs/runbooks/backup-restore.md, "Off-site copy".
set -Eeuo pipefail
# cron and `sudo -u` both leave the working directory somewhere the running user
# may not be able to read; every path below is absolute.
cd /
umask 077

# Fixed before .env is sourced and read-only, so a line in .env cannot redirect
# the source of the mirror or the log. (makrai-backup.sh learned this the hard
# way: RETENTION_DAYS=0 in .env made its prune delete everything.)
readonly SRC=/srv/makrai/backups/
readonly LOG=/srv/makrai/offsite-copy.log
touch "$LOG"
chmod 600 "$LOG"
# Everything, including stderr, goes to the log. Without this rsync's and ssh's
# errors went to cron's stderr, which is discarded, leaving a failure with no
# cause attached.
exec >>"$LOG" 2>&1
log() { echo "[$(date -Is)] $*" >>"$LOG"; }

HERE=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")
# shellcheck source=makrai-lib.sh
. "$HERE/makrai-lib.sh"
load_env

# EXIT, not ERR: it also catches `set -u` violations and a failing `.`.
on_exit() {
  local rc=$?
  trap - EXIT
  if [ "$rc" -ne 0 ]; then
    log "ERROR: off-site copy FAILED (exit ${rc})."
    ping_fail HC_OFFSITE_PING_URL || log "WARNING: could not report the failure to the dead-man check."
    alert "off-site copy FAILED"
  fi
  exit "$rc"
}
trap on_exit EXIT

log "Starting off-site copy..."
[ -n "${OFFSITE_TARGET:-}" ] || { log "ERROR: OFFSITE_TARGET is not set in the server environment file."; exit 1; }
[ -r "$HOME/.ssh/makrai_offsite" ] || { log "ERROR: the off-site key $HOME/.ssh/makrai_offsite is missing or unreadable."; exit 1; }

# `rsync --delete` makes the far side match this one. From an empty or unmounted
# directory that means deleting every off-site backup, so refuse to run unless
# there is at least one backup here to mirror.
[ -n "$(find "$SRC" -maxdepth 1 -name 'makrai-*.sql.gz.gpg' -print -quit)" ] \
  || { log "ERROR: no backup in ${SRC}; refusing to mirror an empty directory over the off-site copy."; exit 1; }

# -a keeps modification times, which the restore test reads to judge how old the
# newest copy is. Files on the far side that the filter excludes are untouched by
# --delete, so only backup files are ever removed there: the ones the backup
# script's own prune has already removed here.
timeout 1800 rsync -a --delete --include='makrai-*.sql.gz.gpg' --exclude='*' \
  -e "$OFFSITE_SSH" "$SRC" "$OFFSITE_TARGET"

log "Off-site copy complete: $(find "$SRC" -maxdepth 1 -name 'makrai-*.sql.gz.gpg' | wc -l) backup files mirrored."

# Deliberately the last statement. A ping sent earlier would report success for a
# run that had not finished.
if ping_ok HC_OFFSITE_PING_URL; then
  log "watchdog pinged"
else
  log "WARNING: watchdog ping failed -- the copy is fine, but an absent ping will raise a false alarm."
fi
