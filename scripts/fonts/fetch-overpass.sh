#!/usr/bin/env bash
# Fetches the two Overpass originals and its licence into fonts/source/ (unit FONTS, stage 1A task 2).
# Overpass replaces Source Sans 3 and DM Serif Display. scripts/fonts/subset.sh cuts the files app/layout.tsx serves
# from these originals. The files are what Google Fonts serves for
#   https://fonts.googleapis.com/css2?family=Overpass:wght@400..700&display=swap
# to a current Chrome user agent (stylesheet read 13 Nov 2026: the /* latin */ and /* latin-ext */ faces, v19).
# Nothing about the project or this machine goes in a URL or header; the only header is the user agent.
#
# Recorded on 13 Nov 2026 (the spec, section 7.4, expected 39,380 B and 46,080 B; both match):
#   latin      https://fonts.gstatic.com/s/overpass/v19/qFdH35WCmI96Ajtm81GlU9s.woff2
#              39,380 B  sha256 29217ef8adef5f6c059feb461bdb029348205fc233dc9b6ca8604b0d068ac086
#   latin-ext  https://fonts.gstatic.com/s/overpass/v19/qFdH35WCmI96Ajtm81GrU9vyww.woff2
#              46,080 B  sha256 0a1c9727f08b91252c19bd4ca36caf98162455f33c0adcac935606b5d8d11938
#   licence    https://github.com/google/fonts/raw/5dac96833c85ada9384fe3e50b11df08091b9246/ofl/overpass/OFL.txt
#              4,392 B   sha256 86e5ff25c701ec446d20b1a85b02ee6d36de8503a7288a4c948f5459809af1f0
#              (github.com redirects that address to GitHub's raw host, raw.githubusercontent.com, for the same pinned
#              file: https://raw.githubusercontent.com/google/fonts/5dac96833c85ada9384fe3e50b11df08091b9246/ofl/overpass/OFL.txt;
#              5dac9683 was the head of google/fonts main that day)
# __tests__/unit/local-fonts.test.ts pins the same sizes and hashes, so a changed upstream file fails there.
#
# Every file goes into a new empty temporary directory first, is checked to be a WOFF2 file (or, for the licence,
# to start with its copyright line), and only then moved into fonts/source/. Run from the repository root:
#   scripts/fonts/fetch-overpass.sh
set -euo pipefail

cd "$(dirname "$0")/../.."

UA='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
LATIN_URL='https://fonts.gstatic.com/s/overpass/v19/qFdH35WCmI96Ajtm81GlU9s.woff2'
LATIN_EXT_URL='https://fonts.gstatic.com/s/overpass/v19/qFdH35WCmI96Ajtm81GrU9vyww.woff2'
OFL_URL='https://github.com/google/fonts/raw/5dac96833c85ada9384fe3e50b11df08091b9246/ofl/overpass/OFL.txt'

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fetch() { # url, name
  echo "$1"
  curl --fail --silent --show-error --location --user-agent "$UA" --output "$tmp/$2" "$1"
  echo "  $2 $(wc -c < "$tmp/$2") bytes, sha256 $(sha256sum "$tmp/$2" | cut -d' ' -f1)"
}

fetch "$LATIN_URL" overpass-latin.woff2
fetch "$LATIN_EXT_URL" overpass-latin-ext.woff2
fetch "$OFL_URL" OFL-Overpass.txt

for f in overpass-latin.woff2 overpass-latin-ext.woff2; do
  [ "$(head -c 4 "$tmp/$f")" = wOF2 ] || { echo "$f is not a WOFF2 file" >&2; exit 1; }
done
head -n 1 "$tmp/OFL-Overpass.txt" | grep -q '^Copyright' || { echo 'OFL-Overpass.txt does not start with a copyright line' >&2; exit 1; }

mkdir -p fonts/source
mv "$tmp"/overpass-latin.woff2 "$tmp"/overpass-latin-ext.woff2 "$tmp"/OFL-Overpass.txt fonts/source/
echo 'moved into fonts/source/'
