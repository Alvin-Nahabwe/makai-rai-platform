#!/usr/bin/env bash
# Stand-in for /usr/local/bin/makrai-backup.sh: the log lines and the exit status the chain reads,
# in the real script's form (ops/host/makrai-backup.sh), and a file "encrypted" with the .env passphrase.
printf 'makrai-backup.sh %s\n' "$*" >> "$REC/argv"
R=$MAKRAI_ROTATE_ROOT
LOG=$R/srv/makrai/backup.log
ts() { printf '[%s]' "$(/usr/bin/date -u -d "$(<"$WORLD/now")" +%Y-%m-%dT%H:%M:%S+00:00)"; }
now=$(<"$WORLD/now")
# backup-old-name: a file named before the cut-over (a clock gone wrong)
stamp=$(/usr/bin/date -u -d "$now" +%Y%m%d-%H%M%S)
[ ! -e "$WORLD/backup-old-name" ] || stamp=$(/usr/bin/date -u -d "$now - 3 days" +%Y%m%d-%H%M%S)
file=$R/srv/makrai/backups/makrai-$stamp.sql.gz.gpg
echo "$(ts) Starting backup..." >> "$LOG"
# backup-slow: the real script takes minutes; a few real seconds are enough for a terminal test
[ ! -e "$WORLD/backup-slow" ] || /usr/bin/sleep 3
if [ -e "$WORLD/backup-fail" ]; then echo "$(ts) ERROR: backup FAILED (exit 1)." >> "$LOG"; exit 1; fi
pass=
while IFS= read -r l || [ -n "$l" ]; do [[ $l == BACKUP_PASSPHRASE=* ]] && pass=${l#*=}; done < "$R/srv/makrai/app/.env"
{ printf 'GPGSTUB %s\n' "$pass"; /usr/bin/gzip -c < "$WORLD/dump.sql"; } > "$file"
echo "$(ts) Backup verified and encrypted: $file (4096 bytes before encryption)" >> "$LOG"
echo "$(ts) Pruned backups older than 30 days." >> "$LOG"
# backup-fail-late: the script fails after it verified and kept the file (backup.sh keeps a verified file)
if [ -e "$WORLD/backup-fail-late" ]; then echo "$(ts) ERROR: backup FAILED (exit 1)." >> "$LOG"; exit 1; fi
if [ -e "$WORLD/backup-pingfail" ]; then
  echo "$(ts) WARNING: watchdog ping failed -- the backup is fine, but an absent ping will raise a false alarm." >> "$LOG"
else
  echo "$(ts) watchdog pinged" >> "$LOG"
fi
# backup-truncated-log: the run ends without its last line
[ -e "$WORLD/backup-truncated-log" ] || echo "$(ts) Backup complete." >> "$LOG"
