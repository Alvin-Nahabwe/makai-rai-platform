import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The framework content files, in a fixed order. Hashing the BYTES on disk
 * rather than a canonicalised parse is deliberate: it removes every JSON
 * canonicalisation subtlety (key order, whitespace, unicode escapes) at the
 * price of treating a reformat as a content change. That price is the right
 * one -- a reformat failing loudly in CI is better than a content change
 * passing silently, and git is the immutability layer here (spec section 1,
 * decision 3).
 *
 * data/constants.ts is deliberately EXCLUDED: it is code (rating labels),
 * not framework content, and including it would couple the content version
 * to unrelated refactors.
 */
export const BUNDLE_FILES = [
  'data/assessmentAreas.json',
  'data/projectConfig.json',
  'data/questionBank.json',
  'data/scoringConfig.json',
] as const;

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * The 4 `readFileSync` calls below are deliberately UNROLLED, each with an
 * all-string-literal path, rather than `BUNDLE_FILES.map((f) =>
 * readFileSync(join(root, f)))`. This is a build-tracing constraint, not a
 * style preference -- found live, not reasoned, across several rebuilds:
 *
 * `output: 'standalone'` (next.config.ts) relies on Turbopack's file tracer
 * to populate `.next/standalone`. The tracer CAN statically resolve a
 * `readFileSync(join(root, 'data/assessmentAreas.json'))` call (all literal
 * segments) but CANNOT resolve `join(root, f)` where `f` is a loop variable.
 * With the loop form, three of the four files were silently absent from
 * `.next/standalone/data/`, and Turbopack additionally emitted a build
 * warning ("whole project traced unintentionally") and copied a much wider,
 * unpredictable slice of the repo into `.next/standalone` as a defensive
 * fallback -- unrolling to all-literal paths (this form) resolved BOTH: the
 * warning is gone and `.next/standalone` now holds exactly the expected
 * minimal set plus `data/`'s four files.
 *
 * Unrolling did NOT, on its own, stop a SEPARATE issue: with any
 * `readFileSync` of these files present in this route's module graph (loop
 * form, scoped form, or this literal form -- and regardless of whether the
 * hash is computed eagerly at module load or lazily on first call),
 * Turbopack also copied `.next/standalone/.env` -- byte-identical to this
 * repo's real `.env`, which contains a live-looking `RESEND_API_KEY`. That
 * file never appears in any generated `.nft.json` trace list (checked
 * directly), so it is not going through the same include/exclude glob
 * machinery `outputFileTracingIncludes`/`-Excludes` govern -- confirmed by
 * verifying an `outputFileTracingExcludes` rule for `.env*` had no effect,
 * twice, under two different implementations of this function. `.env` was
 * confirmed ABSENT from a clean build of this branch's parent commit (Task 1
 * HEAD, which has no `computeBundleHash` at all), so this is a regression
 * this feature introduces, not a pre-existing condition. `docker/Dockerfile`
 * copies `.next/standalone` wholesale into the shipped image, so left
 * unfixed this reaches production. Fixed at `package.json`'s `postbuild`
 * script (`rm -rf .next/standalone/.env*`), which runs after every
 * `next build` including the one `docker/Dockerfile` runs via `npm run
 * build` -- a blunt but verifiable backstop that does not depend on
 * understanding Turbopack's internal fallback heuristic, which is not this
 * task's to chase further. See register row D-149
 * (`docs/DEFERRED_REGISTER.md`) for the full investigation and what is
 * deliberately still NOT built: a general guard against the same class of
 * leak for some other, not-yet-encountered file.
 *
 * Kept in sync with `BUNDLE_FILES` by construction, not by convention:
 * `BUNDLE_FILES[n]` supplies the hash LABEL for the same file whose literal
 * path is read on the same line, and any drift between the two (wrong file
 * read for a label, wrong order) changes the combined hash, which the first
 * two tests in `framework-hash.test.ts` (the `BUNDLE_FILES` shape and the
 * registry-hash match) would catch immediately.
 */
export function computeBundleHash(root = process.cwd()): string {
  const parts = [
    `${BUNDLE_FILES[0]}:${sha256Hex(readFileSync(join(root, 'data/assessmentAreas.json')))}`,
    `${BUNDLE_FILES[1]}:${sha256Hex(readFileSync(join(root, 'data/projectConfig.json')))}`,
    `${BUNDLE_FILES[2]}:${sha256Hex(readFileSync(join(root, 'data/questionBank.json')))}`,
    `${BUNDLE_FILES[3]}:${sha256Hex(readFileSync(join(root, 'data/scoringConfig.json')))}`,
  ];
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}
