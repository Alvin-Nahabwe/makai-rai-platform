#!/usr/bin/env bash
# Regenerates the two latin files per family that app/layout.tsx loads, from the originals under fonts/source/
# (the latin subsets next/font/google downloaded, unit FONTS, register row D-279). NFR-PERF-02 (SRS line 3195):
# every public page preloads one file of each family, so the preloaded "core" file holds only printable ASCII and
# the few other characters the pages' own copy uses. The rest of the original latin range goes into a "rest" file
# that is not preloaded; a browser fetches it only when a page shows one of its characters.
#
# The two ranges below are the unicode-range values app/layout.tsx declares; __tests__/unit/font-subsets.test.ts
# checks that they split the original range (controls aside) and that every glyph of the original is in the file
# whose range declares it. Change a range here and in the layout together, then run this script and the test.
#
# Needs fontTools with brotli (pyftsubset); 4.46.0 made the committed files. Run from the repository root:
#   scripts/fonts/subset.sh
set -euo pipefail

cd "$(dirname "$0")/../.."

# Printable ASCII, then the middle dot, em dash, ellipsis and the up and down arrows that page copy uses.
CORE='U+20-7E,U+B7,U+2014,U+2026,U+2191,U+2193'
# The original latin range (U+??,U+131,U+152-153,...) less CORE and less the C0 and C1 controls and DEL.
REST='U+A0-B6,U+B8-FF,U+131,U+152-153,U+2BB-2BC,U+2C6,U+2DA,U+2DC,U+304,U+308,U+329,U+2000-2013,U+2015-2025,U+2027-206F,U+20AC,U+2122,U+2212,U+2215,U+FEFF,U+FFFD'

command -v pyftsubset >/dev/null || { echo 'pyftsubset (fontTools) is not on PATH' >&2; exit 1; }

for family in source-sans-3 dm-serif-display; do
  src="fonts/source/${family}-latin.woff2"
  for part in core rest; do
    if [ "$part" = core ]; then range="$CORE"; else range="$REST"; fi
    # Every layout feature and every name record is kept, so the subset shapes and names itself as the original did.
    pyftsubset "$src" \
      --unicodes="$range" \
      --layout-features='*' \
      --name-IDs='*' \
      --name-languages='*' \
      --notdef-outline \
      --flavor=woff2 \
      --output-file="app/fonts/${family}-latin-${part}.woff2"
    echo "app/fonts/${family}-latin-${part}.woff2 $(wc -c < "app/fonts/${family}-latin-${part}.woff2") bytes"
  done
done
