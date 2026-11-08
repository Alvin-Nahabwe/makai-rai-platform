/**
 * Checks the frozen makrai.seal/1 test vectors (SRS 5.4) in the ops-script runtime: plain `node`, no TypeScript,
 * no package, the shared modules by relative path (ADR-C3, NFR-INT-05). For each vector file beside this script
 * it builds the manifest from the vector's rows and plan, and prints `ok <name>` when the bytes and the
 * fingerprint are the frozen ones and the seal check reads the frozen bytes as valid against the vector's rows.
 * On any difference, or a vector that throws, it prints `differs <name>: <what>` to stderr, goes on with the
 * next vector, and exits 1 at the end; it also exits 1 when it finds no vector at all.
 *
 *   TZ=Africa/Nairobi node docs/formats/seal-1-vectors/verify.mjs
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalManifestBytes, fingerprintHex } from '../../../lib/integrity/canonical.mjs';
import { manifestFromRows, checkSealRows } from '../../../lib/integrity/sealCheck.mjs';

const DIR = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();
let failed = files.length === 0;
if (failed) process.stderr.write(`no vector files in ${DIR}\n`);

/** The problems of one vector; an exception is one of them, so the next vector is still checked. */
function problemsOf(name, v) {
  try {
    const problems = [];
    if (v.name !== name) problems.push(`name is ${JSON.stringify(v.name)}`);
    const bytes = canonicalManifestBytes(manifestFromRows(v.rows, v.plan));
    if (Buffer.from(bytes).toString('base64') !== v.manifestBase64) problems.push('manifest bytes');
    if (fingerprintHex(bytes) !== v.fingerprint) problems.push('fingerprint');
    const frozen = new Uint8Array(Buffer.from(v.manifestBase64, 'base64'));
    const result = checkSealRows({ sealId: v.plan.sealId, manifestBytes: frozen, fingerprint: v.fingerprint, rows: v.rows, tombstones: [] });
    if (result.kind !== 'valid') problems.push(`check reads ${JSON.stringify(result)}`);
    return problems;
  } catch (e) {
    return [`threw ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`];
  }
}

for (const file of files) {
  const name = file.replace(/\.json$/, '');
  const problems = problemsOf(name, JSON.parse(readFileSync(join(DIR, file), 'utf8')));
  if (problems.length > 0) {
    failed = true;
    process.stderr.write(`differs ${name}: ${problems.join(', ')}\n`);
  } else {
    process.stdout.write(`ok ${name}\n`);
  }
}
process.exitCode = failed ? 1 : 0;
