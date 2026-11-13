#!/usr/bin/env bash
# Regenerates the four Overpass files that app/layout.tsx loads, from the originals under fonts/source/ (the latin and
# latin-ext files Google serves for Overpass, fetched by scripts/fonts/fetch-overpass.sh; unit FONTS, register row D-279).
# NFR-PERF-02 (SRS line 3195): every public page preloads one file, so the preloaded "core" file holds only printable
# ASCII and the few other characters page copy and typed names use. The rest of the original latin range goes into a
# "rest" file that is not preloaded; a browser fetches it only when a page shows one of its characters. The latin-ext
# file is cut in two the same way: ext-common (the letters names commonly carry) and ext-rest.
#
# The four ranges below are the unicode-range values app/layout.tsx declares; __tests__/unit/font-subsets.test.ts
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
# REST also holds the combining grave, acute, tilde, hook above and dot below (U+0300-0301, U+0303, U+0309, U+0323)
# that the latin file maps and Google's latin range omitted: not in CORE, because a file that held both an ASCII letter
# and one of them would let the browser compose an accented letter from the preloaded file instead of fetching the
# face that declares the designed precomposed glyph, and not in EXT_REST, so a decomposed name fetches the small file.
# The original latin range (U+??,U+131,U+152-153,...) less CORE, less the C0 and C1 controls and DEL, and less the
# dagger U+2020, which the latin file does not map and the latin-ext file does (EXT_REST below).
REST='U+A1-A6,U+A8-B6,U+B8-FF,U+131,U+152-153,U+2BB-2BC,U+2C6,U+2DA,U+2DC,U+300-301,U+303,U+309,U+323,U+2000-2012,U+2015-2017,U+201E-201F,U+2021-2025,U+2027-206F,U+20AC,U+2122,U+2212,U+2215,U+FEFF,U+FFFD'
# The latin-ext cut, made for Source Sans 3 and carried over: OLD_EXT_COMMON is the range its common face declared, the
# latin-ext letters names commonly carry (Luganda's eng; Kikuyu, Kamba and Meru i and u with tilde; Hausa hooked b and d;
# Ewe and Yoruba letters; open e and open o; the macron vowels; Polish, Czech, Slovak, Hungarian, Turkish, Lithuanian and
# Latvian letters), kept in its own small file so a page showing such a name fetches that file and not the whole
# latin-ext file. EXT_COMMON is OLD_EXT_COMMON intersected with the code points Overpass's latin-ext file maps. EXT_REST
# is every other code point that file maps, less the controls and less the code points CORE and REST hold a glyph for in
# the latin file, so the four faces are disjoint and no code point either source file maps is left without a face.
# The "computed" check below recomputes both ranges, prints them, and refuses a script whose literals differ.
OLD_EXT_COMMON='U+100-101,U+104-107,U+10C-10D,U+112-113,U+116-119,U+11E-11F,U+122-123,U+128-12B,U+12E-130,U+136-137,U+13B-13C,U+141-148,U+14A-14D,U+150-151,U+158-15B,U+15E-161,U+168-16B,U+16E-173,U+179-17E,U+181,U+186,U+18A,U+190,U+192,U+194,U+253-254,U+256-257,U+25B,U+263,U+28B,U+1E62-1E63'
EXT_COMMON='U+100-101,U+104-107,U+10C-10D,U+112-113,U+116-119,U+11E-11F,U+122-123,U+128-12B,U+12E-130,U+136-137,U+13B-13C,U+141-148,U+14A-14D,U+150-151,U+158-15B,U+15E-161,U+168-16B,U+16E-173,U+179-17E,U+181,U+186,U+18A,U+190,U+192,U+194,U+253-254,U+256-257,U+25B,U+263,U+28B,U+1E62-1E63'
EXT_REST='U+102-103,U+108-10B,U+10E-111,U+114-115,U+11A-11D,U+120-121,U+124-127,U+12C-12D,U+132-135,U+138-13A,U+13D-140,U+149,U+14E-14F,U+154-157,U+15C-15D,U+162-167,U+16C-16D,U+174-178,U+17F,U+187-189,U+18E-18F,U+191,U+193,U+196-199,U+19D,U+1A0-1A1,U+1A4-1A5,U+1A9,U+1AC-1B4,U+1B7,U+1C0-1F5,U+1F8-21B,U+21E-21F,U+226-233,U+237,U+242-245,U+24B-24C,U+250-252,U+259,U+25F-261,U+265-266,U+268-269,U+26E-26F,U+272,U+279,U+27D-27E,U+283,U+288-28A,U+28C-28E,U+292,U+294-295,U+29E,U+2A1-2A4,U+2A6-2A7,U+2A9-2AC,U+2B0,U+2B2,U+2B7-2BA,U+2C7,U+2C9,U+2D6,U+2DD,U+2E1-2E3,U+1E04-1E05,U+1E0C-1E0F,U+1E12-1E13,U+1E20-1E21,U+1E24-1E25,U+1E2E-1E2F,U+1E36-1E37,U+1E3C-1E3F,U+1E44-1E47,U+1E4A-1E4D,U+1E50-1E53,U+1E6C-1E71,U+1E80-1E85,U+1E92-1E93,U+1E9E,U+1EF2-1EF9,U+2020,U+20A1-20AB,U+20AD-20BF,U+2113,U+2C64,U+2C6D,U+2C72-2C73,U+A78B-A78D,U+A7AA'

# One interpreter both reports the versions and subsets, so the check is about the code that writes the files.
python3 -c 'import fontTools.subset, brotli' 2>/dev/null || { echo 'python3 cannot import fontTools.subset and brotli' >&2; exit 1; }
versions="$(python3 -c 'import fontTools, brotli; print(fontTools.version, brotli.__version__)')"
echo "fontTools and brotli: $versions"
if [ "$versions" != '4.46.0 1.1.0' ] && [ "${SUBSET_ANY_VERSION:-}" != 1 ]; then
  echo 'the committed files were made with fontTools 4.46.0 and brotli 1.1.0; set SUBSET_ANY_VERSION=1 to go on' >&2
  exit 1
fi

# Recompute the two latin-ext ranges from the old common range and the cmaps, print them, and refuse literals that differ.
OLD_EXT_COMMON="$OLD_EXT_COMMON" CORE="$CORE" REST="$REST" EXT_COMMON="$EXT_COMMON" EXT_REST="$EXT_REST" python3 - <<'PY'
import os, re, sys
from fontTools.ttLib import TTFont

def parse(value):
    out = set()
    for part in value.split(','):
        m = re.fullmatch(r'U\+([0-9A-F]+)(?:-([0-9A-F]+))?', part.strip())
        lo = int(m[1], 16)
        out.update(range(lo, int(m[2], 16) + 1 if m[2] else lo + 1))
    return out

def fmt(points):
    points = sorted(points)
    parts, i = [], 0
    while i < len(points):
        j = i
        while j + 1 < len(points) and points[j + 1] == points[j] + 1:
            j += 1
        parts.append('U+%X' % points[i] if i == j else 'U+%X-%X' % (points[i], points[j]))
        i = j + 1
    return ','.join(parts)

ext = set(TTFont('fonts/source/overpass-latin-ext.woff2').getBestCmap())
latin = set(TTFont('fonts/source/overpass-latin.woff2').getBestCmap())
core_rest = (parse(os.environ['CORE']) | parse(os.environ['REST'])) & latin
common = parse(os.environ['OLD_EXT_COMMON']) & ext
is_control = lambda cp: cp < 0x20 or 0x7F <= cp <= 0x9F
computed = {'COMMON': fmt(common), 'REST': fmt({cp for cp in ext if not is_control(cp)} - common - core_rest)}
bad = False
for name, value in computed.items():
    print(f'computed EXT_{name}={value}')
    if value != os.environ['EXT_' + name]:
        print(f'EXT_{name} in this script differs from the computed range', file=sys.stderr)
        bad = True
sys.exit(1 if bad else 0)
PY

# Every file is written to a temporary directory first, so a failed run replaces none of the committed files.
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
src=fonts/source/overpass-latin.woff2
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
    --output-file="$out/overpass-latin-${part}.woff2"
done
for part in common rest; do
  if [ "$part" = common ]; then range="$EXT_COMMON"; else range="$EXT_REST"; fi
  python3 -m fontTools.subset fonts/source/overpass-latin-ext.woff2 \
    --unicodes="$range" \
    --layout-features='*' \
    --name-IDs='*' \
    --name-languages='*' \
    --notdef-outline \
    --flavor=woff2 \
    --output-file="$out/overpass-latin-ext-${part}.woff2"
done
for f in "$out"/*.woff2; do
  mv "$f" app/fonts/
  echo "app/fonts/$(basename "$f") $(wc -c < "app/fonts/$(basename "$f")") bytes"
done
