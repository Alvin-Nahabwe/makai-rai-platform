/**
 * The seal check over rows (FR-REV-06, ADR-C3), shared by the application and
 * the restore-test script: from rows exactly as PostgreSQL's `row_to_json`
 * writes them in a session whose TimeZone is UTC, build the `makrai.seal/1`
 * manifest (SRS 5.4) of the rows a plan names, and check a stored seal by
 * rebuilding its manifest from the rows it names.
 *
 * It imports only `./canonical.mjs` and `../findings/state.mjs`, which have no
 * static import at all, so it runs under plain `node` in the restore-test image
 * with no TypeScript and no package (obligation A10).
 *
 * Every function here throws a TypeError, naming the table and column, on a row
 * that lacks a column it reads or holds a value of the wrong type: a missing
 * column is a schema or caller defect, and writing a default instead would
 * seal, or pass, a value the database never held. A value PostgreSQL can hold
 * once a constraint is dropped, or that the format cannot write, throws in the
 * builder and, in the check, reads as a mismatch at its path, since only
 * tampering puts it in a sealed row (threat A7): a text whose salt is gone; a
 * NULL in a NOT NULL column or in a text array; an instant or date text that
 * does not parse to a year from 1 to 9999 (`infinity`, BC, a five-digit year);
 * a declared date without a known precision; a second row with a named id.
 */
import { saltedDigestHex, fingerprintHex, canonicalManifestBytes } from './canonical.mjs';
import { deriveFindingState } from '../findings/state.mjs';

export const SEAL_SOURCE_TABLES = Object.freeze(/** @type {const} */ ([
  'seals', 'stage_reviews', 'framework_versions', 'decision_versions', 'decision_evidence', 'evidence',
  'findings', 'finding_events', 'mitigation_versions', 'mitigation_evidence', 'accepted_risks',
]));

/**
 * One query per source table and for `tombstones`, `$1` the organisation id.
 * `framework_versions` has no organisation column; its `$1::text` keeps the
 * parameter typed so the statement prepares (contract row). Both callers run
 * these after `SET LOCAL TIME ZONE 'UTC'` in the same transaction.
 */
export const SEAL_SOURCE_SQL = Object.freeze(Object.fromEntries(
  [...SEAL_SOURCE_TABLES, 'tombstones'].map((t) => [
    t,
    t === 'framework_versions'
      ? 'SELECT row_to_json(t) AS r FROM framework_versions t WHERE $1::text IS NOT NULL'
      : `SELECT row_to_json(t) AS r FROM ${t} t WHERE t."orgId" = $1`,
  ]),
));

const FORMAT = 'makrai.seal/1';

// ---------------------------------------------------------------------------
// Column readers.

function col(table, row, name) {
  if (row === null || typeof row !== 'object' || !Object.prototype.hasOwnProperty.call(row, name)) {
    throw new TypeError(`sealCheck: a row of ${table} has no column "${name}"`);
  }
  return row[name];
}

/** A text column that may be null. */
function textOrNull(table, row, name) {
  const v = col(table, row, name);
  if (v !== null && typeof v !== 'string') throw new TypeError(`sealCheck: ${table}.${name} is not text`);
  return v;
}

function int(table, row, name) {
  const v = col(table, row, name);
  if (!Number.isInteger(v)) throw new TypeError(`sealCheck: ${table}.${name} is not an integer`);
  return v;
}

const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::\d{2}(?::\d{2})?)?)$/;

/**
 * Milliseconds since the epoch of a `timestamptz` as `row_to_json` writes it
 * (`2026-11-02T09:00:00.12+00:00`, any offset), or undefined for a text the
 * format cannot write. Parsed here rather than by `Date`, whose reading of a
 * form outside ECMAScript's own is implementation-defined. Undefined: a text
 * that names no real instant (30 February, hour 25, an offset past 15:59),
 * `infinity`, a BC instant, a year past 9999, and a fraction finer than
 * milliseconds that is not zeros (the columns are `timestamptz(3)`).
 */
function parseInstantMs(v) {
  const m = INSTANT.exec(v);
  if (!m) return undefined;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  const frac = m[7] ?? '';
  const zone = m[8];
  if (/[1-9]/.test(frac.slice(3)) || !realDay(y, mo, d) || h > 23 || mi > 59 || s > 59) return undefined;
  let offset = 0;
  if (zone !== 'Z') {
    const [oh, om, os] = [...zone.slice(1).split(':').map(Number), 0, 0];
    if (oh > 15 || om > 59 || os > 59) return undefined;
    offset = (zone[0] === '-' ? -1 : 1) * ((oh * 60 + om) * 60 + os) * 1000;
  }
  // setUTCFullYear, not Date.UTC, which reads years 0 to 99 as 1900 to 1999.
  const t = new Date(0);
  t.setUTCFullYear(y, mo - 1, d);
  t.setUTCHours(h, mi, s, Number(frac.slice(0, 3).padEnd(3, '0')));
  const ms = t.getTime() - offset;
  // The format writes four-digit years only (YYYY-MM-DDTHH:MM:SS.sssZ); an offset can move an instant past either end.
  const year = new Date(ms).getUTCFullYear();
  return year >= 1 && year <= 9999 ? ms : undefined;
}

/** A `date` as `row_to_json` writes it (`YYYY-MM-DD`), or undefined for `infinity`, a BC date or a year past 9999. */
function parseDate(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  return m && Number(m[1]) >= 1 && realDay(Number(m[1]), Number(m[2]), Number(m[3])) ? v : undefined;
}

/** The text of a time column, which `row_to_json` always writes as a string: anything else is a caller defect. */
function timeText(table, name, v) {
  if (typeof v !== 'string') throw new TypeError(`sealCheck: ${table}.${name} is not a timestamp`);
  return v;
}

function realDay(y, mo, d) {
  const t = new Date(0);
  t.setUTCFullYear(y, mo - 1, d);
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

const DECLARED_LENGTH = { year: 4, month: 7, day: 10 };

/** The bytes of a `bytea` as `row_to_json` writes it: `\x` and lower- or upper-case hex. */
function hexBytes(table, name, v) {
  if (typeof v !== 'string' || !/^\\x(?:[0-9a-fA-F]{2})*$/.test(v)) throw new TypeError(`sealCheck: ${table}.${name} is not bytea hex`);
  const out = new Uint8Array((v.length - 2) / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(v.slice(2 + 2 * i, 4 + 2 * i), 16);
  return out;
}

const own = (o, k) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isStr = (x) => typeof x === 'string';
const isDigest = (x) => isObj(x) && Object.keys(x).length === 1 && isStr(x.d);
const tombKey = (table, id, field) => `${table}\u0000${id}\u0000${field}`;

// ---------------------------------------------------------------------------
// Rows to manifest.

/**
 * The `makrai.seal/1` manifest of the rows `plan` names, in canonical order
 * (the seal builder's call). Only the named rows are read, so any superset of
 * them (every row of the organisation) gives the same manifest.
 *
 * It refuses, with a TypeError, to write an absence it was not asked for: a
 * planned id, the seal, its stage review or a content version with no row, two
 * named versions of one question or two named accepted risks of one finding,
 * and a result that does not name exactly `plan.ids` (`manifestIds`).
 *
 * A field whose text is gone (erased before sealing) is sealed with the digest
 * its tombstone holds, so the seal still covers it and the check reads it as
 * erased (ruling b); with no such tombstone it is sealed as null. Two
 * tombstones with different digests for one field are refused: the builder
 * cannot know which one is true. The caller reads `tombstones` in the same
 * snapshot as `rows`.
 *
 * @param {import('./sealCheck.d.mts').SealSourceRows} rows
 * @param {import('./sealCheck.d.mts').ManifestPlan} plan
 * @param {import('./sealCheck.d.mts').TombstoneRow[]} [tombstones]
 */
export function manifestFromRows(rows, plan, tombstones) {
  const fields = tombstones === undefined ? new Map() : indexTombstones(tombstones).fields;
  const { manifest } = build(rows, plan, null, fields);
  // sameValue, not canonicalJson: canonicalJson writes NFC, so a plan id in another form would compare equal.
  if (!sameValue(manifestIds(manifest), plan.ids)) {
    throw new TypeError(`manifestFromRows: the manifest does not name exactly the plan's ids (${JSON.stringify(manifestIds(manifest))})`);
  }
  return manifest;
}

/**
 * Builds the manifest. `check` is null for the builder, which is strict (see
 * `manifestFromRows`). For the seal check it is `{ stored, fields }`: the
 * stored manifest's values by path and the field tombstones by target. The
 * check is lenient: a missing row is written as its absence, two rows where
 * one is named as an `ambiguous` entry, and a value the format cannot write
 * (see the module comment) as an `unreadable` marker, so each reads as a
 * difference at its path instead of a throw. A free-text field whose text is gone takes the stored
 * manifest's digest at its path only when a tombstone for that table, row and
 * digest field name carries exactly that digest (obligation A8); each such
 * field is recorded in `erased`.
 */
function build(rows, plan, check, builderFields = new Map()) {
  const strict = check === null;
  const lacking = (what) => {
    if (strict) throw new TypeError(`manifestFromRows: ${what}`);
  };
  // Never equal to a sealed value, so the walk names the path; the builder throws instead.
  const unreadable = (what) => {
    if (strict) throw new TypeError(`sealCheck: ${what}`);
    return { unreadable: true };
  };
  // NOT NULL columns: a null is tampering (unreadable); any other non-text value is a caller defect (throw).
  const text = (tbl, row, name) => {
    const v = col(tbl, row, name);
    if (v === null) return unreadable(`${tbl}.${name} is not text`);
    if (typeof v !== 'string') throw new TypeError(`sealCheck: ${tbl}.${name} is not text`);
    return v;
  };
  const int = (tbl, row, name) => {
    const v = col(tbl, row, name);
    if (v === null) return unreadable(`${tbl}.${name} is not an integer`);
    if (!Number.isInteger(v)) throw new TypeError(`sealCheck: ${tbl}.${name} is not an integer`);
    return v;
  };
  const instant = (tbl, row, name) => {
    const v = col(tbl, row, name);
    if (v === null) return unreadable(`${tbl}.${name} is not a timestamp`);
    const ms = parseInstantMs(timeText(tbl, name, v));
    return ms === undefined ? unreadable(`${tbl}.${name} is not a timestamp`) : new Date(ms).toISOString();
  };
  const calendarDate = (tbl, row, name, nullable) => {
    const v = col(tbl, row, name);
    if (v === null) return nullable ? null : unreadable(`${tbl}.${name} is not a date`);
    if (typeof v !== 'string') throw new TypeError(`sealCheck: ${tbl}.${name} is not a date`);
    return parseDate(v) ?? unreadable(`${tbl}.${name} is not a date`);
  };
  /** `declaredOn` cut to 4, 7 or 10 characters by `declaredPrecision`. */
  const declaredDate = (row) => {
    const on = calendarDate('decision_versions', row, 'declaredOn', true);
    const precision = textOrNull('decision_versions', row, 'declaredPrecision');
    if (on === null && precision === null) return null;
    if (isObj(on)) return on;
    const n = Object.prototype.hasOwnProperty.call(DECLARED_LENGTH, precision) ? DECLARED_LENGTH[precision] : undefined;
    if (on === null || n === undefined) return unreadable('decision_versions has a declared date without its precision');
    return on.slice(0, n);
  };
  const table = (name) => {
    const list = rows?.[name];
    if (!Array.isArray(list)) throw new TypeError(`sealCheck: the rows hold no list for ${name}`);
    return list;
  };
  const erased = new Map();
  // Ids with two rows (possible only with a primary key dropped): the builder throws, the check marks the entry.
  const doubled = new Set();
  const byIds = (name, wanted) => {
    const byId = new Map();
    for (const r of table(name)) {
      const id = col(name, r, 'id');
      if (!wanted(id)) continue;
      if (byId.has(id)) {
        lacking(`${name} holds two rows with id ${id}`);
        doubled.add(id);
      }
      byId.set(id, r);
    }
    return byId;
  };
  const named = (name, ids) => {
    const wanted = new Set(ids);
    const byId = byIds(name, (id) => wanted.has(id));
    for (const id of wanted) if (!byId.has(id)) lacking(`the plan names ${name} ${id}, which the rows lack`);
    return byId;
  };
  const twice = (id) => doubled.has(id);
  const ids = plan.ids;
  const decisions = named('decision_versions', ids.decisionVersions);
  const evidence = named('evidence', ids.evidence);
  const findings = named('findings', ids.findings);
  const events = [...named('finding_events', ids.findingEvents).values()];
  const mitigations = [...named('mitigation_versions', ids.mitigationVersions).values()];
  const risks = [...named('accepted_risks', ids.acceptedRisks).values()];
  const frameworks = byIds('framework_versions', () => true);

  const digest = (tbl, row, key, textCol, saltCol, path) => {
    const value = textOrNull(tbl, row, textCol);
    if (value === null) {
      if (strict) {
        const digests = builderFields.get(tombKey(tbl, row.id, key));
        if (digests === undefined) return null;
        if (digests.size > 1) throw new TypeError(`manifestFromRows: two tombstone digests for ${tbl} ${row.id} ${key}`);
        return { d: [...digests.keys()][0] };
      }
      const sealedValue = check.stored.get(path);
      const at = isDigest(sealedValue) ? check.fields.get(tombKey(tbl, row.id, key))?.get(sealedValue.d) : undefined;
      if (at === undefined) return null;
      erased.set(tombKey(tbl, row.id, key), at);
      return { d: sealedValue.d };
    }
    const salt = col(tbl, row, saltCol);
    if (salt === null) return unreadable(`${tbl}.${textCol} of ${row.id} has text but no salt`);
    return { d: saltedDigestHex(hexBytes(tbl, saltCol, salt), key, value) };
  };
  const content = (id) => {
    const r = frameworks.get(id);
    if (r === undefined) {
      lacking(`no framework_versions ${id}`);
      return unreadable(`no framework_versions ${id}`);
    }
    if (twice(id)) return unreadable(`two framework_versions rows ${id}`);
    return { semver: text('framework_versions', r, 'semver'), contentHash: text('framework_versions', r, 'contentHash') };
  };
  const evidenceItem = (r, path) => (twice(r.id) ? { id: r.id, ambiguous: true } : {
    id: r.id,
    kind: text('evidence', r, 'kind'),
    sha256: textOrNull('evidence', r, 'sha256'),
    fileName: digest('evidence', r, 'fileName', 'filename', 'filenameSalt', `${path}.fileName`),
    url: digest('evidence', r, 'url', 'url', 'urlSalt', `${path}.url`),
    label: digest('evidence', r, 'label', 'label', 'labelSalt', `${path}.label`),
  });
  const evidenceOf = (links, versionId, path) => {
    const seen = new Set();
    for (const l of table(links)) {
      if (col(links, l, 'versionId') === versionId && evidence.has(col(links, l, 'evidenceId'))) seen.add(l.evidenceId);
    }
    return [...seen].map((id) => evidenceItem(evidence.get(id), `${path}.evidence[${id}]`));
  };
  const decider = (tbl, row, userCol, roleCol) => ({ userId: textOrNull(tbl, row, userCol), outsideRole: textOrNull(tbl, row, roleCol) });
  const ambiguous = (what, rowsFound) => {
    lacking(`the plan names ${rowsFound.length} ${what}`);
    return { ambiguous: rowsFound.map((r) => r.id).sort() };
  };

  const decisionEntry = ({ question, derivedFrom }) => {
    const t = 'decision_versions';
    if (derivedFrom !== null) {
      const gate = decisions.get(derivedFrom);
      return {
        question, derived: 'not_applicable_gate', from: derivedFrom,
        content: gate === undefined || twice(derivedFrom) ? unreadable(`no single decision_versions ${derivedFrom}`)
          : content(col(t, gate, 'contentVersionId')),
      };
    }
    const matches = [...decisions.values()].filter((r) => col(t, r, 'questionId') === question);
    if (matches.length > 1 || matches.some((r) => twice(r.id))) return { question, ...ambiguous(`versions of ${question}`, matches) };
    if (matches.length === 0) return { question, none: true, withdrawal: null };
    const r = matches[0];
    if (col(t, r, 'status') === 'withdrawn') return { question, none: true, withdrawal: r.id };
    const options = col(t, r, 'optionsInPlace');
    if (options !== null && (!Array.isArray(options) || options.some((o) => o !== null && typeof o !== 'string'))) {
      throw new TypeError(`sealCheck: ${t}.optionsInPlace is not a text array`);
    }
    // NULL for the column, or inside it: only a dropped NOT NULL or tampering puts it there.
    const optionsInPlace = options === null || options.includes(null) ? unreadable(`${t}.optionsInPlace is not a text array`) : [...options];
    const path = `decisions[${question}]`;
    return {
      question,
      id: r.id,
      number: int(t, r, 'versionNumber'),
      content: content(col(t, r, 'contentVersionId')),
      status: textOrNull(t, r, 'status'),
      scopeAnswer: textOrNull(t, r, 'scopeAnswer'),
      optionsInPlace,
      decidedBy: decider(t, r, 'decidedByUserId', 'decidedByRole'),
      declaredDate: declaredDate(r),
      declaredPrecision: textOrNull(t, r, 'declaredPrecision'),
      reasonCode: textOrNull(t, r, 'reasonCode'),
      enteredBy: text(t, r, 'enteredById'),
      enteredByRole: text(t, r, 'enteredByRole'),
      receivedAt: instant(t, r, 'receivedAt'),
      reason: digest(t, r, 'reason', 'reason', 'reasonSalt', `${path}.reason`),
      evidence: evidenceOf('decision_evidence', r.id, path),
    };
  };

  const findingEntry = (f) => {
    if (twice(f.id)) return { id: f.id, ambiguous: true };
    const fp = `findings[${f.id}]`;
    const of = (list, tbl) => list.filter((r) => col(tbl, r, 'findingId') === f.id);
    const ev = of(events, 'finding_events').map((r) => (twice(r.id) ? { id: r.id, ambiguous: true } : {
      id: r.id,
      kind: text('finding_events', r, 'kind'),
      findingSeq: int('finding_events', r, 'findingSeq'),
      by: text('finding_events', r, 'byId'),
      reason: digest('finding_events', r, 'reason', 'reason', 'reasonSalt', `${fp}.events[${r.id}].reason`),
    }));
    const t = 'mitigation_versions';
    const mit = of(mitigations, t).map((r) => {
      if (twice(r.id)) return { versionId: r.id, mitigationId: col(t, r, 'mitigationId'), ambiguous: true };
      const mp = `${fp}.mitigations[${text(t, r, 'mitigationId')}]`;
      return {
        versionId: r.id,
        mitigationId: text(t, r, 'mitigationId'),
        number: int(t, r, 'versionNumber'),
        findingSeq: int(t, r, 'findingSeq'),
        kind: text(t, r, 'kind'),
        status: text(t, r, 'status'),
        owner: text(t, r, 'ownerUserId'),
        dueDate: calendarDate(t, r, 'dueDate', false),
        followsControl: textOrNull(t, r, 'followsControl'),
        what: digest(t, r, 'what', 'what', 'whatSalt', `${mp}.what`),
        changeNote: digest(t, r, 'changeNote', 'changeNote', 'changeNoteSalt', `${mp}.changeNote`),
        closureNote: digest(t, r, 'closureNote', 'closureNote', 'closureNoteSalt', `${mp}.closureNote`),
        cancelReason: digest(t, r, 'cancelReason', 'cancelReason', 'cancelReasonSalt', `${mp}.cancelReason`),
        enteredBy: text(t, r, 'enteredById'),
        enteredByRole: text(t, r, 'enteredByRole'),
        evidence: evidenceOf('mitigation_evidence', r.id, mp),
      };
    });
    // Compared as canonicalManifestBytes sorts them, after NFC, so two that collide there are caught here.
    const nfc = (x) => (typeof x === 'string' ? x.normalize('NFC') : x);
    const sharing = mit.filter((x, i) => mit.some((y, j) => j !== i && nfc(y.mitigationId) === nfc(x.mitigationId)));
    const ar = of(risks, 'accepted_risks');
    const a = 'accepted_risks';
    const ap = `${fp}.acceptedRisk`;
    const acceptedRisk = ar.length > 1 || ar.some((r) => twice(r.id)) ? ambiguous(`accepted risks of finding ${f.id}`, ar) : ar.length === 0 ? null : {
      id: ar[0].id,
      findingSeq: int(a, ar[0], 'findingSeq'),
      acceptedBy: decider(a, ar[0], 'acceptedByUserId', 'acceptedByRole'),
      accepterRole: textOrNull(a, ar[0], 'accepterRole'),
      enteredBy: text(a, ar[0], 'enteredById'),
      enteredByRole: text(a, ar[0], 'enteredByRole'),
      reason: digest(a, ar[0], 'reason', 'reason', 'reasonSalt', `${ap}.reason`),
      lookAgainNote: digest(a, ar[0], 'lookAgainNote', 'lookAgainNote', 'lookAgainNoteSalt', `${ap}.lookAgainNote`),
      lookAgainDate: calendarDate(a, ar[0], 'lookAgainOn', true),
    };
    const source = text('findings', f, 'source');
    return {
      id: f.id,
      source,
      question: textOrNull('findings', f, 'questionId'),
      decisionVersion: textOrNull('findings', f, 'decisionVersionId'),
      riskArea: textOrNull('findings', f, 'riskArea'),
      title: digest('findings', f, 'title', 'title', 'titleSalt', `${fp}.title`),
      description: digest('findings', f, 'description', 'description', 'descriptionSalt', `${fp}.description`),
      // SRS 5.3 item 11: computed from exactly the rows this entry names.
      state: deriveFindingState({ source, events: ev, currentMitigations: mit, acceptedRisks: isObj(acceptedRisk) && own(acceptedRisk, 'id') ? [acceptedRisk] : [] }),
      events: ev,
      mitigations: mit.some((x) => !isStr(x.mitigationId)) ? unreadable(`${t}.mitigationId is not text`)
        : sharing.length > 0 ? ambiguous(`versions of one mitigation of finding ${f.id}`, sharing.map((x) => ({ id: x.versionId }))) : mit,
      acceptedRisk,
    };
  };

  const s = 'seals';
  const sealRow = byIds(s, (id) => id === plan.sealId).get(plan.sealId);
  if (sealRow === undefined) lacking(`no seal ${plan.sealId} in the rows`);
  const reviewId = sealRow === undefined ? undefined : col(s, sealRow, 'stageReviewId');
  const review = reviewId === undefined ? undefined : byIds('stage_reviews', (id) => id === reviewId).get(reviewId);
  if (sealRow !== undefined && review === undefined) lacking(`no stage review ${reviewId} in the rows`);
  const header = sealRow !== undefined && review !== undefined && !twice(plan.sealId) && !twice(reviewId);
  const manifest = {
    format: FORMAT,
    seal: !header ? unreadable(`no single seal ${plan.sealId} with its stage review`) : {
      id: sealRow.id,
      number: int(s, sealRow, 'sealNumber'),
      stageReviewId: text(s, sealRow, 'stageReviewId'),
      stage: text('stage_reviews', review, 'stage'),
      preparedFor: digest('stage_reviews', review, 'preparedFor', 'preparedFor', 'preparedForSalt', 'seal.preparedFor'),
      sealedBy: text(s, sealRow, 'sealedById'),
      sealedByRole: text(s, sealRow, 'sealedByRole'),
      sealedAt: instant(s, sealRow, 'sealedAt'),
    },
    project: !header ? unreadable('no stage review') : text('stage_reviews', review, 'projectId'),
    organisation: !header ? unreadable('no seal') : text(s, sealRow, 'orgId'),
    content: !header ? unreadable('no seal') : content(col(s, sealRow, 'contentVersionId')),
    decisions: plan.questions.map(decisionEntry),
    findings: [...findings.values()].map(findingEntry),
  };
  // Read back from the canonical bytes, so the result is exactly what they encode (sorted, NFC).
  const bytes = canonicalManifestBytes(manifest);
  return { manifest: JSON.parse(new TextDecoder().decode(bytes)), bytes, erased };
}

// ---------------------------------------------------------------------------
// Ids and the plan of a stored manifest.

const sortedUnique = (xs) => [...new Set(xs)].sort();

/**
 * The ids a manifest names (FR-REV-05), each array sorted and free of
 * duplicates. `decisionVersions` holds each entry's id, each withdrawal id and
 * each gate-derived `from` id.
 *
 * @param {import('../../types/seal').SealManifestV1} m
 */
export function manifestIds(m) {
  const dv = [];
  const ev = [];
  for (const d of m.decisions) {
    if ('derived' in d) dv.push(d.from);
    else if ('none' in d) { if (d.withdrawal !== null) dv.push(d.withdrawal); }
    else { dv.push(d.id); for (const e of d.evidence) ev.push(e.id); }
  }
  const fe = [];
  const mv = [];
  const ar = [];
  for (const f of m.findings) {
    for (const e of f.events) fe.push(e.id);
    for (const x of f.mitigations) { mv.push(x.versionId); for (const e of x.evidence) ev.push(e.id); }
    if (f.acceptedRisk !== null) ar.push(f.acceptedRisk.id);
  }
  return {
    decisionVersions: sortedUnique(dv),
    evidence: sortedUnique(ev),
    findings: sortedUnique(m.findings.map((f) => f.id)),
    findingEvents: sortedUnique(fe),
    mitigationVersions: sortedUnique(mv),
    acceptedRisks: sortedUnique(ar),
  };
}

/** The plan that rebuilds `m` from rows: its seal, its questions in order, and the ids it names. */
export function planFromManifest(m) {
  return {
    sealId: m.seal.id,
    questions: m.decisions.map((d) => ({ question: d.question, derivedFrom: 'derived' in d ? d.from : null })),
    ids: manifestIds(m),
  };
}

// ---------------------------------------------------------------------------
// The check.

const unique = (xs) => new Set(xs).size === xs.length;
const hasIds = (list) => Array.isArray(list) && list.every((e) => isObj(e) && isStr(e.id)) && unique(list.map((e) => e.id));

/** The keys of the check's own markers (`build`), which the format never writes. */
const MARKER_KEYS = ['unreadable', 'ambiguous'];
const holdsMarker = (node) => (Array.isArray(node) ? node.some(holdsMarker)
  : isObj(node) && (MARKER_KEYS.some((k) => own(node, k)) || Object.values(node).some(holdsMarker)));

/**
 * Enough of the format's shape for `planFromManifest` and the walk to read
 * without throwing, and none of the check's markers, which would otherwise
 * equal the marker a rebuild writes for the same unreadable row.
 */
function readableManifest(m) {
  if (!isObj(m) || m.format !== FORMAT || !isObj(m.seal) || !isStr(m.seal.id) || holdsMarker(m)) return false;
  // Keys the builder never writes as null, so a forged null cannot equal a rebuilt absence.
  if (!isStr(m.project) || !isStr(m.organisation) || !isObj(m.content)) return false;
  if (!Array.isArray(m.decisions) || !Array.isArray(m.findings)) return false;
  const decisionOk = (d) => isObj(d) && isStr(d.question) && (
    (d.none === true && (d.withdrawal === null || isStr(d.withdrawal)) && !own(d, 'derived') && !own(d, 'id'))
    || (d.derived === 'not_applicable_gate' && isStr(d.from) && isObj(d.content) && !own(d, 'none') && !own(d, 'id'))
    || (isStr(d.id) && isObj(d.content) && hasIds(d.evidence) && !own(d, 'none') && !own(d, 'derived')));
  const findingOk = (f) => isObj(f) && isStr(f.id) && hasIds(f.events)
    && Array.isArray(f.mitigations) && f.mitigations.every((x) => isObj(x) && isStr(x.versionId) && isStr(x.mitigationId) && hasIds(x.evidence))
    && (f.acceptedRisk === null || (isObj(f.acceptedRisk) && isStr(f.acceptedRisk.id)));
  return m.decisions.every(decisionOk) && m.findings.every(findingOk)
    && unique(m.decisions.map((d) => d.question)) && unique(m.findings.map((f) => f.id))
    && m.findings.every((f) => unique(f.mitigations.map((x) => x.mitigationId)));
}

/**
 * The tombstones that can stand for an erasure. Field tombstones (field and
 * digest set) by table, row and digest field name, then by digest, each with
 * the latest `at`; evidence-bytes tombstones (table `evidence`, no field) by
 * evidence id. A field counts as erased only where one of its tombstones
 * carries the sealed digest, so neither the order of the rows nor an extra
 * tombstone with another digest changes the result. A tombstone of any other
 * form, or with an `at` the format cannot write, stands for nothing: the field
 * it names then reads as a mismatch.
 */
function indexTombstones(tombstones) {
  if (!Array.isArray(tombstones)) throw new TypeError('sealCheck: tombstones must be a list');
  const fields = new Map();
  const files = new Map();
  const later = (map, k, at) => { if (!map.has(k) || map.get(k) < at) map.set(k, at); };
  for (const t of tombstones) {
    const table = textOrNull('tombstones', t, 'targetTable');
    const id = textOrNull('tombstones', t, 'targetId');
    const field = textOrNull('tombstones', t, 'field');
    const digest = textOrNull('tombstones', t, 'digest');
    const raw = col('tombstones', t, 'at');
    const at = raw === null ? undefined : parseInstantMs(timeText('tombstones', 'at', raw));
    // A NULL or unwritable time, or no target: the tombstone stands for nothing (the organisation's other checks go on).
    if (at === undefined || table === null || id === null) continue;
    if (field !== null && digest !== null) {
      const k = tombKey(table, id, field);
      if (!fields.has(k)) fields.set(k, new Map());
      later(fields.get(k), digest, at);
    } else if (field === null && table === 'evidence') {
      later(files, id, at);
    }
  }
  return { fields, files };
}

/** Every value of a manifest by its path (the paths `firstDifference` names). */
function valuesByPath(node, path = '', name = '', out = new Map()) {
  out.set(path, node);
  const key = ENTRY_KEY[name];
  if (key !== undefined && Array.isArray(node)) {
    for (const item of node) valuesByPath(item, `${path}[${item?.[key]}]`, '', out);
  } else if (isObj(node) && !isDigest(node)) {
    for (const [k, v] of Object.entries(node)) valuesByPath(v, join(path, k), k, out);
  }
  return out;
}

/** The evidence ids a manifest lists as files. */
function fileEvidence(m) {
  const out = new Set();
  const add = (list) => { for (const e of list) if (e.kind === 'file') out.add(e.id); };
  for (const d of m.decisions) if (Array.isArray(d.evidence)) add(d.evidence);
  for (const f of m.findings) for (const x of f.mitigations) add(x.evidence);
  return out;
}

function sameValue(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameValue(x, b[i]));
  }
  if (!isObj(a) || !isObj(b)) return false;
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return sameValue(ka, kb) && ka.every((k) => sameValue(a[k], b[k]));
}

/** The arrays whose entries the paths name by key, and that key (SRS 5.4 sort keys). */
const ENTRY_KEY = { decisions: 'question', findings: 'id', events: 'id', evidence: 'id', mitigations: 'mitigationId' };
const join = (path, key) => (path === '' ? key : `${path}.${key}`);

/**
 * The first difference of `stored` from `rebuilt`, walking `stored` depth
 * first in canonical key order: an entry of a keyed array by its key, a salted
 * digest as one value, and an object whose keys differ as a whole.
 */
function firstDifference(stored, rebuilt, path, name) {
  const key = ENTRY_KEY[name];
  if (key !== undefined && Array.isArray(stored) && Array.isArray(rebuilt)) {
    for (const s of stored) {
      const here = `${path}[${s?.[key]}]`;
      const r = rebuilt.find((x) => x?.[key] === s?.[key]);
      if (r === undefined) return here;
      const d = firstDifference(s, r, here, '');
      if (d !== null) return d;
    }
    return null;
  }
  if (isObj(stored) && isObj(rebuilt) && !isDigest(stored) && !isDigest(rebuilt)) {
    const keys = Object.keys(stored).sort();
    if (!sameValue(keys, Object.keys(rebuilt).sort())) return path;
    for (const k of keys) {
      const d = firstDifference(stored[k], rebuilt[k], join(path, k), k);
      if (d !== null) return d;
    }
    return null;
  }
  return sameValue(stored, rebuilt) ? null : path;
}

/** The first entry of a keyed array in `rebuilt` that `stored` lacks, in the same walk order. */
function firstAddition(stored, rebuilt, path, name) {
  const key = ENTRY_KEY[name];
  if (key !== undefined && Array.isArray(stored) && Array.isArray(rebuilt)) {
    for (const r of rebuilt) {
      const here = `${path}[${r?.[key]}]`;
      const s = stored.find((x) => x?.[key] === r?.[key]);
      if (s === undefined) return here;
      const d = firstAddition(s, r, here, '');
      if (d !== null) return d;
    }
    return null;
  }
  if (isObj(stored) && isObj(rebuilt)) {
    for (const k of Object.keys(rebuilt).sort()) {
      if (!own(stored, k)) continue;
      const d = firstAddition(stored[k], rebuilt[k], join(path, k), k);
      if (d !== null) return d;
    }
  }
  return null;
}

function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Parses stored manifest bytes, or answers null when they are not UTF-8 JSON.
 * Both decoders throw on bad input, and that throw is the answer: such bytes
 * are a seal that does not match, reported as `format`, never a crash of the
 * check and never "valid".
 */
function parseStored(bytes) {
  try {
    return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) };
  } catch (e) {
    if (e instanceof SyntaxError || e instanceof TypeError) return null;
    throw e;
  }
}

/**
 * Checks a stored seal against rows (FR-REV-06), in this order: the stored
 * fingerprint against SHA-256 of the stored bytes; the bytes parsed as a
 * `makrai.seal/1` manifest (anything else is a mismatch at `format`); the
 * manifest rebuilt from exactly the rows it names, tombstoned fields taken as
 * erased only where the tombstone's digest is the sealed one; then the first
 * difference, and for a match the erasures and clock warnings (NFR-INT-04).
 *
 * `rows` may be every row of the organisation (`SEAL_SOURCE_SQL`); only the
 * named rows, and for clock warnings the version before each named one, are read.
 *
 * @param {{ manifestBytes: Uint8Array, fingerprint: string,
 *   rows: import('./sealCheck.d.mts').SealSourceRows,
 *   tombstones: import('./sealCheck.d.mts').TombstoneRow[] }} input
 * @returns {import('../../types/seal').SealCheckResult}
 */
export function checkSealRows({ manifestBytes, fingerprint, rows, tombstones }) {
  if (fingerprintHex(manifestBytes) !== fingerprint) return { kind: 'fingerprint_mismatch' };

  const parsed = parseStored(manifestBytes);
  if (parsed === null || !readableManifest(parsed.value)) return { kind: 'mismatch', firstDifference: 'format' };
  const stored = parsed.value;

  const plan = planFromManifest(stored);
  const erasures = indexTombstones(tombstones);
  const { manifest: rebuilt, bytes, erased } = build(rows, plan, { stored: valuesByPath(stored), fields: erasures.fields });

  if (!equalBytes(bytes, manifestBytes)) {
    const at = firstDifference(stored, rebuilt, '', '') ?? firstAddition(stored, rebuilt, '', '');
    // Equal content in bytes that are not its canonical form: not a seal this format writes.
    return { kind: 'mismatch', firstDifference: at ?? 'format' };
  }

  const sealedFiles = fileEvidence(stored);
  const files = plan.ids.evidence.filter((id) => sealedFiles.has(id) && erasures.files.has(id));
  const times = [...erased.values(), ...files.map((id) => erasures.files.get(id))];
  return {
    kind: 'valid',
    erasedFields: erased.size,
    erasedFiles: files.length,
    erasedOn: times.length === 0 ? null : new Date(Math.max(...times)).toISOString().slice(0, 10),
    clockWarnings: clockWarnings(rows, plan),
  };
}

/**
 * NFR-INT-04: the entries whose named version was received before the version
 * it follows. Where either time cannot be read, the order cannot be shown, so
 * that entry is warned about too (a warning, never a refusal).
 */
function clockWarnings(rows, plan) {
  const t = 'decision_versions';
  const all = rows[t];
  const named = new Set(plan.ids.decisionVersions);
  const out = new Set();
  for (const r of all) {
    if (!named.has(r.id)) continue;
    const before = all.find((p) => col(t, p, 'orgId') === col(t, r, 'orgId') && col(t, p, 'projectId') === col(t, r, 'projectId')
      && col(t, p, 'questionId') === col(t, r, 'questionId') && col(t, p, 'versionNumber') === int(t, r, 'versionNumber') - 1);
    if (before === undefined) continue;
    const timeOf = (row) => {
      const v = col(t, row, 'receivedAt');
      return v === null ? undefined : parseInstantMs(timeText(t, 'receivedAt', v));
    };
    const at = timeOf(r);
    const prior = timeOf(before);
    if (at === undefined || prior === undefined || at < prior) out.add(`decisions[${r.questionId}]`);
  }
  return [...out].sort();
}
