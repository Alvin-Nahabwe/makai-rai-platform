#!/usr/bin/env bash
# Stand-in for /usr/local/bin/makrai-backup.sh: the log lines and the exit status the chain reads,
# in the real script's form (ops/host/makrai-backup.sh), and a file "encrypted" with the .env passphrase.
printf 'makrai-backup.sh %s\n' "$*" >> "$REC/argv"
R=$MAKRAI_ROTATE_ROOT
LOG=$R/srv/makrai/backup.log
ts() { printf '[%s]' "$(/usr/bin/date -u -d "$(<"$WORLD/now")" +%Y-%m-%dT%H:%M:%S+00:00)"; }
now=$(<"$WORLD/now")
stamp=$(/usr/bin/date -u -d "$now" +%Y%m%d-%H%M%S)
file=$R/srv/makrai/backups/makrai-$stamp.sql.gz.gpg
echo "$(ts) Starting backup..." >> "$LOG"
if [ -e "$WORLD/backup-fail" ]; then echo "$(ts) ERROR: backup FAILED (exit 1)." >> "$LOG"; exit 1; fi
pass=
while IFS= read -r l || [ -n "$l" ]; do [[ $l == BACKUP_PASSPHRASE=* ]] && pass=${l#*=}; done < "$R/srv/makrai/app/.env"
{ printf 'GPGSTUB %s\n' "$pass"; /usr/bin/gzip -c < "$WORLD/dump.sql"; } > "$file"
echo "$(ts) Backup verified and encrypted: $file (4096 bytes before encryption)" >> "$LOG"
echo "$(ts) Pruned backups older than 30 days." >> "$LOG"
if [ -e "$WORLD/backup-pingfail" ]; then
  echo "$(ts) WARNING: watchdog ping failed -- the backup is fine, but an absent ping will raise a false alarm." >> "$LOG"
else
  echo "$(ts) watchdog pinged" >> "$LOG"
fi
echo "$(ts) Backup complete." >> "$LOG"
