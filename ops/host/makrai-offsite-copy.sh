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

# Why the run failed, when the script knows; it goes into the alert's subject.
NOTE=

# EXIT, not ERR: it also catches `set -u` violations and a failing `.`.
on_exit() {
  local rc=$?
  trap - EXIT
  # A failed log write (a full disk) must not end the handler before it reports.
  set +e
  if [ "$rc" -ne 0 ]; then
    log "ERROR: off-site copy FAILED (exit ${rc})."
    ping_fail HC_OFFSITE_PING_URL || log "WARNING: could not report the failure to the dead-man check."
    alert "off-site copy FAILED${NOTE:+: ${NOTE}}"
  fi
  exit "$rc"
}
trap on_exit EXIT

log "Starting off-site copy..."
[ -n "${OFFSITE_TARGET:-}" ] || { log "ERROR: OFFSITE_TARGET is not set in the server environment file."; exit 1; }
[ -r "$HOME/.ssh/makrai_offsite" ] || { log "ERROR: the off-site key $HOME/.ssh/makrai_offsite is missing or unreadable."; exit 1; }

# makrai-backup.sh writes its .gpg in place and may run for up to an hour, so at
# 00:30 a long run could leave a half-written file that would be mirrored. Wait
# for a running backup, for at most 30 minutes, polling each minute. Still running
# after that is a failure like any other: exit 1 runs on_exit, which sends /fail
# and the alert.
readonly BACKUP_WAIT_MIN=30
waited=0
while pgrep -f 'makrai-backup\.sh' >/dev/null; do
  if [ "$waited" -ge "$BACKUP_WAIT_MIN" ]; then
    log "ERROR: makrai-backup.sh is still running after ${BACKUP_WAIT_MIN} minutes; not copying a backup that may be incomplete."
    exit 1
  fi
  [ "$waited" -gt 0 ] || log "makrai-backup.sh is running; waiting up to ${BACKUP_WAIT_MIN} minutes for it to finish."
  sleep 60
  waited=$((waited + 1))
done

# pgrep sees a backup end within a minute of its last write, and a file written in
# the last 2 minutes is skipped below, so without this the file the copy just
# waited for would always be skipped. After a wait, let it age past the window
# (2 minutes and 5 seconds). Once pgrep has found no writer, the file is complete.
[ "$waited" -eq 0 ] || sleep 125

# What is here, and which of it was written in the last 2 minutes, by name. Taken
# once, so the exclusion, the report and the check below all use the same lists.
# Names sort by time.
mapfile -t all < <(find "$SRC" -maxdepth 1 -name 'makrai-*.sql.gz.gpg' -printf '%f\n' | sort)
mapfile -t fresh < <(find "$SRC" -maxdepth 1 -name 'makrai-*.sql.gz.gpg' -mmin -2 -printf '%f\n' | sort)
excludes=(); for f in "${fresh[@]}"; do excludes+=("--exclude=/$f"); done

# `rsync --delete` makes the far side match this one, so a source with nothing
# usable to send deletes every off-site backup. That is wider than an empty or
# unmounted directory: one holding only a hand-named file sends nothing the
# restore test can use, and one holding only tonight's nightly, still inside the
# 2-minute window, sends nothing at all, because that file is excluded below. So
# refuse to run unless at least one exact-named nightly (the restore test's own
# filter) is listed and is not on the fresh list. This is the last thing before
# rsync, and it reads the list taken after the wait and the settle sleep (up to
# about 32 minutes after the script started), so a directory emptied or unmounted
# in the meantime never reaches `rsync --delete`. Nothing may sit between it and
# rsync; exit 1 runs on_exit, which sends /fail and an alert.
[ "$(printf '%s\n' "${all[@]}" | grep -E '^makrai-[0-9]{8}-[0-9]{6}\.sql\.gz\.gpg$' | grep -cvxF -f <(printf '%s\n' "${fresh[@]}") || true)" -gt 0 ] || { NOTE="no backup to mirror"; log "ERROR: no settled nightly backup in ${SRC}; refusing to run rsync --delete, which would empty the off-site copy."; exit 1; }

# -a keeps modification times, which the restore test reads to judge how old the
# newest copy is. Files on the far side that the filter excludes are untouched by
# --delete, so only backup files are ever removed there: the ones the backup
# script's own prune has already removed here.
#
# A file modified less than 2 minutes ago is left out (the excludes come first,
# ahead of the include): it may still be being written.
#
# --max-delete=3 caps what one run may remove from the box. A normal rotation
# removes one file, two after a night without a copy, so the cap never bites; a
# source that has shrunk without being empty (a mount that dropped, with tonight's
# file written into the bare mount point) passes the guard above, and this stops
# it. rsync then stops deleting, still sends what is new, and exits 25: the run
# fails with its reason in the alert and the box keeps the rest. A deliberate
# larger prune is done by hand with the cap raised for that one run
# (docs/runbooks/backup-restore.md, "Off-site copy"), not by editing this script.
timeout 1800 rsync -a --delete --max-delete=3 "${excludes[@]}" \
  --include='makrai-*.sql.gz.gpg' --exclude='*' \
  -e "$OFFSITE_SSH" "$SRC" "$OFFSITE_TARGET" \
  || { rc=$?; [ "$rc" -ne 25 ] || { NOTE="off-site deletions exceeded limit"; log "ERROR: ${NOTE}: rsync stopped deleting at --max-delete=3 and exited 25."; }; exit "$rc"; }

# A skip is never silent: each file is named in the log.
for f in "${fresh[@]}"; do log "Skipped ${f}: modified less than 2 minutes ago, it may still be being written."; done

# The newest backup is the one tonight's restore test fetches, so it is judged with
# the restore test's own filter: only makrai-YYYYMMDD-HHMMSS.sql.gz.gpg counts. A
# hand-named file (makrai-manual.sql.gz.gpg sorts after every dated name) must not
# be taken as the newest, or a fresh nightly would be skipped and reported as a
# success. If the newest nightly is the one that was skipped, the copy did not do
# its job and must not ping success: exit 1 runs on_exit, which sends /fail and an
# alert whose subject carries NOTE.
newest=$(printf '%s\n' "${all[@]}" | grep -E '^makrai-[0-9]{8}-[0-9]{6}\.sql\.gz\.gpg$' | tail -n 1 || true)
for f in "${fresh[@]}"; do [ "$f" != "$newest" ] || { NOTE="newest backup not copied: still being written"; log "ERROR: ${NOTE} (${f})."; exit 1; }; done

log "Off-site copy complete: $(( ${#all[@]} - ${#fresh[@]} )) backup file(s) mirrored."

# Deliberately the last statement. A ping sent earlier would report success for a
# run that had not finished.
if ping_ok HC_OFFSITE_PING_URL; then
  log "watchdog pinged"
else
  log "WARNING: watchdog ping failed -- the copy is fine, but an absent ping will raise a false alarm."
fi
