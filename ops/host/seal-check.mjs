// /usr/local/lib/makrai/seal-check.mjs
// The seal check of the nightly restore test (NFR-INT-07, FR-REV-06): every seal of a restored copy
// of the database, checked by the application's own code. Run by node in a throwaway container of
// the live web image (no network, read-only root), from root's installed copies; see
// ops/host/makrai-restore-test.sh. It imports the shared module by a relative path, so the installed
// layout mirrors the repository: this file in /ops/ops/host, the module in /ops/lib/integrity, and
// the one module that imports in /ops/lib/findings (lib/findings/state.mjs).
//
//   node seal-check.mjs plan    stdin: organisation ids, one a line
//                               stdout: a psql script (BEGIN; SET LOCAL TIME ZONE 'UTC'; then, per id
//                               and per source table, the module's own statement with the id bound
//                               by \bind; COMMIT;). Exit 2, printing nothing, on an id that is not an
//                               id or on a statement holding ; or \.
//   node seal-check.mjs check   stdin: that script's output from `psql -X -q -At -v ON_ERROR_STOP=1`
//                               (a `#rows <table> <id>` line, then one JSON line a row)
//                               stdout: one line `seals=<n> valid=<n> mismatched=<n> erased_fields=<n>
//                               erased_files=<n>`, then one line a failed seal. Exit 0 when every seal
//                               is valid, 1 when any is not, 2 on a line it cannot parse.
//
// Nothing that comes out of the database is ever printed: counts, a seal id and a field path
// (checked to be made of id and path characters) are the whole output (NFR-PRIV-03). Each seal is
// checked on its own: one that makes the check throw is reported as failed (`result=error`) and the
// rest are still checked.
import { SEAL_SOURCE_TABLES, SEAL_SOURCE_SQL, checkSealRows } from '../../lib/integrity/sealCheck.mjs';

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const PATH_RE = /^[A-Za-z0-9_.[\]-]{1,200}$/;
const KEYS = [...SEAL_SOURCE_TABLES, 'tombstones'];

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

/** Exits without printing anything of the input. */
function refuse(code, why) {
  process.stderr.write(`seal-check: ${why}\n`);
  process.exit(code);
}

function plan(input) {
  const ids = input.split('\n').filter((l) => l !== '');
  for (const id of ids) if (!ID_RE.test(id)) refuse(2, 'an organisation id is not an id');
  for (const k of KEYS) {
    const sql = SEAL_SOURCE_SQL[k];
    if (typeof sql !== 'string' || sql.includes(';') || sql.includes('\\')) refuse(2, 'a source statement holds ; or \\');
  }
  const out = ['BEGIN;', "SET LOCAL TIME ZONE 'UTC';"];
  for (const id of ids) {
    for (const k of KEYS) {
      out.push(`\\echo '#rows ${k} ${id}'`);
      out.push(`${SEAL_SOURCE_SQL[k]} \\bind '${id}' \\g`);
    }
  }
  out.push('COMMIT;');
  process.stdout.write(`${out.join('\n')}\n`);
}

/** A bytea as PostgreSQL writes it into row JSON: `\x` and hex. */
function bytesOf(text) {
  if (typeof text !== 'string' || !/^\\x([0-9a-f]{2})*$/.test(text)) throw new TypeError('seal-check: a manifest is not bytea hex text');
  return Uint8Array.from(Buffer.from(text.slice(2), 'hex'));
}

function parse(input) {
  /** @type {Map<string, Record<string, unknown[]>>} */
  const orgs = new Map();
  let current = null;
  for (const line of input.split('\n')) {
    if (line === '') continue;
    const head = /^#rows ([a-z_]+) (\S+)$/.exec(line);
    if (head) {
      const [, table, org] = head;
      if (!KEYS.includes(table) || !ID_RE.test(org)) refuse(2, 'a #rows line is not one the plan writes');
      if (!orgs.has(org)) orgs.set(org, Object.fromEntries(KEYS.map((k) => [k, []])));
      current = orgs.get(org)[table];
      continue;
    }
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      refuse(2, 'a line is not JSON');
    }
    if (current === null || row === null || typeof row !== 'object' || Array.isArray(row)) refuse(2, 'a row is not an object under a #rows line');
    current.push(row);
  }
  return orgs;
}

function check(input) {
  const orgs = parse(input);
  let seals = 0;
  let valid = 0;
  let erasedFields = 0;
  let erasedFiles = 0;
  const failures = [];
  for (const [, rowsByTable] of orgs) {
    const tombstones = rowsByTable.tombstones;
    const rows = Object.fromEntries(SEAL_SOURCE_TABLES.map((t) => [t, rowsByTable[t]]));
    for (const row of rowsByTable.seals) {
      seals += 1;
      const rawId = row.id;
      const id = typeof rawId === 'string' && ID_RE.test(rawId) ? rawId : '?';
      try {
        // sealId is the seals row's own id column, never a value read from the manifest.
        const r = checkSealRows({ sealId: rawId, manifestBytes: bytesOf(row.manifest), fingerprint: row.fingerprint, rows, tombstones });
        if (r.kind === 'valid') {
          valid += 1;
          erasedFields += r.erasedFields;
          erasedFiles += r.erasedFiles;
        } else if (r.kind === 'mismatch') {
          failures.push(`seal=${id} result=mismatch first_difference=${PATH_RE.test(r.firstDifference) ? r.firstDifference : '-'}`);
        } else {
          failures.push(`seal=${id} result=${r.kind}`);
        }
      } catch {
        // The message is not printed: a thrown error can name a column of a row.
        failures.push(`seal=${id} result=error`);
      }
    }
  }
  process.stdout.write(
    `${[`seals=${seals} valid=${valid} mismatched=${seals - valid} erased_fields=${erasedFields} erased_files=${erasedFiles}`, ...failures].join('\n')}\n`,
  );
  process.exit(failures.length === 0 ? 0 : 1);
}

const mode = process.argv[2];
if (mode !== 'plan' && mode !== 'check') refuse(2, 'usage: seal-check.mjs plan|check');
const input = await readStdin();
if (mode === 'plan') plan(input);
else check(input);
