#!/usr/bin/env bash
# Regenerates the two latin files per family that app/layout.tsx loads, from the originals under fonts/source/
# (the latin subsets next/font/google downloaded, unit FONTS, register row D-279). NFR-PERF-02 (SRS line 3195):
# every public page preloads one file of each family, so the preloaded "core" file holds only printable ASCII and
# the few other characters page copy and typed names use. The rest of the original latin range goes into a "rest"
# file that is not preloaded; a browser fetches it only when a page shows one of its characters.
#
# The two ranges below are the unicode-range values app/layout.tsx declares; __tests__/unit/font-subsets.test.ts
# checks that they split the original range (controls aside), that every glyph of the original is in the file
# whose range declares it, and that this script and the layout agree. Change a range here and in the layout
# together, run this script, and re-pin the four files in __tests__/unit/local-fonts.test.ts.
#
# The WOFF2 bytes depend on fontTools and on the brotli module, so the script refuses other versions than the ones
# that made the committed files (fontTools 4.46.0, brotli 1.1.0) unless SUBSET_ANY_VERSION=1; with other versions
# the fonts are the same but the sha256 pins will differ. Run from the repository root:
#   scripts/fonts/subset.sh
set -euo pipefail

cd "$(dirname "$0")/../.."

# Printable ASCII; the no-break space, en dash and curly quotes that typed names carry; the combining macron,
# diaeresis and dot below that follow an ASCII letter in decomposed (NFD) text; and the section sign, middle dot,
# em dash, ellipsis and up and down arrows that page copy uses.
CORE='U+20-7E,U+A0,U+A7,U+B7,U+304,U+308,U+329,U+2013-2014,U+2018-201D,U+2026,U+2191,U+2193'
# The original latin range (U+??,U+131,U+152-153,...) less CORE and less the C0 and C1 controls and DEL.
REST='U+A1-A6,U+A8-B6,U+B8-FF,U+131,U+152-153,U+2BB-2BC,U+2C6,U+2DA,U+2DC,U+2000-2012,U+2015-2017,U+201E-2025,U+2027-206F,U+20AC,U+2122,U+2212,U+2215,U+FEFF,U+FFFD'

# One interpreter both reports the versions and subsets, so the check is about the code that writes the files.
python3 -c 'import fontTools.subset, brotli' 2>/dev/null || { echo 'python3 cannot import fontTools.subset and brotli' >&2; exit 1; }
versions="$(python3 -c 'import fontTools, brotli; print(fontTools.version, brotli.__version__)')"
echo "fontTools and brotli: $versions"
if [ "$versions" != '4.46.0 1.1.0' ] && [ "${SUBSET_ANY_VERSION:-}" != 1 ]; then
  echo 'the committed files were made with fontTools 4.46.0 and brotli 1.1.0; set SUBSET_ANY_VERSION=1 to go on' >&2
  exit 1
fi

# Every file is written to a temporary directory first, so a failed run replaces none of the committed files.
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
for family in source-sans-3 dm-serif-display; do
  src="fonts/source/${family}-latin.woff2"
  for part in core rest; do
    if [ "$part" = core ]; then range="$CORE"; else range="$REST"; fi
    # Every layout feature and every name record is kept, so the subset shapes and names itself as the original did.
    python3 -m fontTools.subset "$src" \
      --unicodes="$range" \
      --layout-features='*' \
      --name-IDs='*' \
      --name-languages='*' \
      --notdef-outline \
      --flavor=woff2 \
      --output-file="$out/${family}-latin-${part}.woff2"
  done
done
for f in "$out"/*.woff2; do
  mv "$f" app/fonts/
  echo "app/fonts/$(basename "$f") $(wc -c < "app/fonts/$(basename "$f")") bytes"
done
