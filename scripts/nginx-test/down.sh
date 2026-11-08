#!/bin/sh
# Removes what scripts/nginx-test/up.sh <K> made: the container v060-nginx-b<K> and its temporary directory (the rendered
# configuration and the test certificate). Usage: scripts/nginx-test/down.sh <K>. Touches no other container.
set -u
K="${1:-}"
case "$K" in
  '' | *[!0-9]*) echo "down.sh: usage: down.sh <K>, K the slot number" >&2; exit 2 ;;
esac
# A container that is already gone is the state this script exists to reach.
docker rm -f "v060-nginx-b$K" >/dev/null 2>&1 || true
MARK="${TMPDIR:-/tmp}/makrai-nginx-b$K.dir"
if [ -f "$MARK" ]; then
  DIR=$(cat "$MARK")
  case "$DIR" in
    *..* | "${TMPDIR:-/tmp}"/tmp.*/*) echo "down.sh: $MARK names $DIR, which is not a mktemp directory; left in place" >&2 ;;
    "${TMPDIR:-/tmp}"/tmp.*) rm -rf "$DIR" ;;
    *) echo "down.sh: $MARK names $DIR, which is not a mktemp directory; left in place" >&2 ;;
  esac
  rm -f "$MARK"
fi
