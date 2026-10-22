#!/usr/bin/env bash
# Stand-in for /usr/local/bin/makrai-restore-test.sh: fetches the newest nightly from the box, opens
# it with the .env passphrase, prints one line, and ends its log as the real script does.
printf 'makrai-restore-test.sh %s\n' "$*" >> "$REC/argv"
R=$MAKRAI_ROTATE_ROOT
LOG=$R/srv/makrai/restore-test.log
ts() { printf '[%s]' "$(/usr/bin/date -u -d "$(<"$WORLD/now")" +%Y-%m-%dT%H:%M:%S+00:00)"; }
fail() { echo "$(ts) Restore test FAILED: $1" >> "$LOG"; echo "RESTORE MISMATCH $1"; exit 1; }
echo "$(ts) Starting restore test..." >> "$LOG"
forced=; [ ! -e "$WORLD/restore-field" ] || forced=$(cat "$WORLD/restore-field")
[ "$forced" != fetch ] || fail fetch
# restore-fetch-other: fetches the oldest file in the box, not the newest
pick=tail; [ ! -e "$WORLD/restore-fetch-other" ] || pick=head
newest=$(/usr/bin/ls "$WORLD/box" | /usr/bin/grep -E '^makrai-[0-9]{8}-[0-9]{6}\.sql\.gz\.gpg$' | /usr/bin/sort | /usr/bin/$pick -n 1)
[ -n "$newest" ] || fail fetch
echo "$(ts) fetched=$newest age_min=3" >> "$LOG"
[ -z "$forced" ] || fail "$forced"
pass=
while IFS= read -r l || [ -n "$l" ]; do [[ $l == BACKUP_PASSPHRASE=* ]] && pass=${l#*=}; done < "$R/srv/makrai/app/.env"
first=$(/usr/bin/head -n 1 "$WORLD/box/$newest")
# restore-ignore-pass: a restore that succeeds whatever it fetched (to prove the chain checks fetched= itself)
[ "$first" = "GPGSTUB $pass" ] || [ -e "$WORLD/restore-ignore-pass" ] || fail restore
echo "$(ts) Restore test PASSED" >> "$LOG"
echo "RESTORE MATCH"
