#!/usr/bin/env bash
# Stand-in for /usr/local/bin/makrai-offsite-copy.sh: mirrors every file older than 2 minutes to the
# sandbox's box, skips (and names) a fresh one, and logs what the real script logs.
printf 'makrai-offsite-copy.sh %s\n' "$*" >> "$REC/argv"
R=$MAKRAI_ROTATE_ROOT
LOG=$R/srv/makrai/offsite-copy.log
ts() { printf '[%s]' "$(/usr/bin/date -u -d "$(<"$WORLD/now")" +%Y-%m-%dT%H:%M:%S+00:00)"; }
echo "$(ts) Starting off-site copy..." >> "$LOG"
if [ -e "$WORLD/offsite-fail" ]; then echo "$(ts) ERROR: off-site copy FAILED (exit 1)." >> "$LOG"; exit 1; fi
sent=0; newest_fresh=
for f in "$R"/srv/makrai/backups/makrai-*.sql.gz.gpg; do
  n=${f##*/}
  if [ -n "$(/usr/bin/find "$f" -mmin -2)" ]; then
    echo "$(ts) Skipped $n: modified less than 2 minutes ago, it may still be being written." >> "$LOG"
    newest_fresh=$n
  else
    # offsite-lie: report success without copying the newest file (a copy that did not happen)
    if [ -e "$WORLD/offsite-lie" ] && [ "$n" = "$(/usr/bin/ls "$R/srv/makrai/backups" | /usr/bin/sort | /usr/bin/tail -n 1)" ]; then continue; fi
    cp -p "$f" "$WORLD/box/$n"; sent=$((sent + 1))
  fi
done
if [ -n "$newest_fresh" ]; then echo "$(ts) ERROR: newest backup not copied: still being written ($newest_fresh)." >> "$LOG"; exit 1; fi
# offsite-skip-line: names the newest file as skipped although the run goes on to report success
if [ -e "$WORLD/offsite-skip-line" ]; then echo "$(ts) Skipped $(/usr/bin/ls "$R/srv/makrai/backups" | /usr/bin/sort | /usr/bin/tail -n 1): modified less than 2 minutes ago, it may still be being written." >> "$LOG"; fi
echo "$(ts) Off-site copy complete: $sent backup file(s) mirrored." >> "$LOG"
if [ -e "$WORLD/offsite-pingfail" ]; then
  echo "$(ts) WARNING: watchdog ping failed -- the copy is fine, but an absent ping will raise a false alarm." >> "$LOG"
else
  echo "$(ts) watchdog pinged" >> "$LOG"
fi
