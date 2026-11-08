/**
 * The one canonical JSON writer (SRS 5.4, ADR-C3, NFR-MNT-05): RFC 8785
 * restricted to strings, integers, booleans, null, arrays and plain objects.
 * Strings, and object keys, are written in Unicode NFC. Object keys are
 * sorted by UTF-16 code unit. Arrays keep the order they are given.
 *
 * It throws a TypeError, and never skips or rounds, on anything else: a
 * non-integer number, `undefined` (also as a property value or an array
 * element), a bigint, a function, a symbol, a Date or any object that is not a
 * plain object, an object with an own symbol key (enumerable or not, so no
 * property can be left out of a digest unseen), and two keys that are equal
 * once written in NFC. The module has no static import: `lib/client/
 * retrySafeWrite.ts` brings it into client bundles, so the digest functions
 * below take `node:crypto` from `process.getBuiltinModule` when called (Node
 * 22.3 or later), and the seal check runs the same file outside Next.js, in
 * the restore-test image (ADR-C3).
 *
 * Which keys are written: an object's own enumerable string keys, as
 * JSON.stringify writes them (a non-enumerable string key is not written, and
 * a prototype that is not Object.prototype or null is refused above); an array
 * by index only. A cycle is not detected: the recursion overflows the stack
 * and throws a RangeError, so it never returns a string, but the error is not a
 * TypeError and its message does not name the cycle.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value.normalize('NFC'));
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isInteger(value)) {
        throw new TypeError(`canonicalJson: ${String(value)} is not an integer`);
      }
      // The ECMAScript number form is RFC 8785's; -0 is written 0.
      return JSON.stringify(value);
    case 'object':
      return Array.isArray(value) ? writeArray(value) : writeObject(value);
    default:
      throw new TypeError(`canonicalJson: cannot write a value of type ${typeof value}`);
  }
}

function writeArray(items) {
  const parts = [];
  // An index loop, not map: map skips the holes of a sparse array.
  for (let i = 0; i < items.length; i++) parts.push(canonicalJson(items[i]));
  return `[${parts.join(',')}]`;
}

function writeObject(obj) {
  const proto = Object.getPrototypeOf(obj);
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError('canonicalJson: only plain objects can be written');
  }
  if (Object.getOwnPropertySymbols(obj).length > 0) {
    throw new TypeError('canonicalJson: an object with a symbol key cannot be written');
  }
  const byKey = new Map();
  for (const key of Object.keys(obj)) {
    const normalised = key.normalize('NFC');
    if (byKey.has(normalised)) {
      throw new TypeError(`canonicalJson: two keys are equal after NFC: ${JSON.stringify(normalised)}`);
    }
    byKey.set(normalised, obj[key]);
  }
  // The default sort compares UTF-16 code units, which is the order RFC 8785 fixes.
  const keys = [...byKey.keys()].sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(byKey.get(k))}`).join(',')}}`;
}

/**
 * The salted digest of one free-text field (SRS 5.4, line 1292): lower-case hex
 * SHA-256 of `salt ‖ 0x00 ‖ fieldName ‖ 0x00 ‖ UTF-8(NFC(text))`. The field
 * name is the manifest key that carries the digest (contract, "Digest field
 * names"); the erasure functions compute the same value in SQL for the
 * tombstone (contract E-14).
 *
 * @param {Uint8Array} salt
 * @param {string} fieldName
 * @param {string} text
 * @returns {string}
 */
export function saltedDigestHex(salt, fieldName, text) {
  if (!(salt instanceof Uint8Array)) throw new TypeError('saltedDigestHex: the salt must be bytes');
  if (typeof fieldName !== 'string' || typeof text !== 'string') {
    throw new TypeError('saltedDigestHex: the field name and the text must be strings');
  }
  return sha256()
    .update(salt)
    .update(ZERO)
    .update(fieldName, 'utf8')
    .update(ZERO)
    .update(text.normalize('NFC'), 'utf8')
    .digest('hex');
}

const ZERO = new Uint8Array([0]);

/** A SHA-256 hash from `node:crypto`, loaded at call time so no browser bundle resolves it. */
function sha256() {
  const load = globalThis.process?.getBuiltinModule;
  if (typeof load !== 'function') {
    throw new Error('lib/integrity/canonical.mjs needs Node 22.3 or later for its digests (process.getBuiltinModule)');
  }
  return load('node:crypto').createHash('sha256');
}

/**
 * The fingerprint of a seal (SRS 5.4): lower-case hex SHA-256 of the bytes.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function fingerprintHex(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('fingerprintHex: the input must be bytes');
  return sha256().update(bytes).digest('hex');
}

/**
 * The bytes of a `makrai.seal/1` manifest (SRS 5.4, line 1276): every array
 * sorted (decisions by question id; findings, finding events and every
 * evidence list by id; mitigations by mitigation id; options in place by
 * value), then `canonicalJson`, as UTF-8. Sort keys are compared as UTF-16 code
 * units after NFC, the form `canonicalJson` writes them in, so rows read in any
 * order give the same bytes. Two entries of one array with the same sort key
 * are refused with a TypeError, since their order, and so the bytes, would
 * depend on the input. The input is not changed.
 *
 * @param {import('../../types/seal').SealManifestV1} m
 * @returns {Uint8Array}
 */
export function canonicalManifestBytes(m) {
  return new TextEncoder().encode(canonicalJson(sortManifest(m)));
}

/** A copy of `m` with every array in canonical order (see `canonicalManifestBytes`). */
function sortManifest(m) {
  if (m === null || typeof m !== 'object') return m;
  return {
    ...m,
    decisions: Array.isArray(m.decisions) ? sortBy(m.decisions.map(sortDecision), 'question', 'decisions') : m.decisions,
    findings: Array.isArray(m.findings) ? sortBy(m.findings.map(sortFinding), 'id', 'findings') : m.findings,
  };
}

function sortDecision(d) {
  if (d === null || typeof d !== 'object' || !('id' in d)) return d;
  return {
    ...d,
    optionsInPlace: Array.isArray(d.optionsInPlace) ? sortStrings(d.optionsInPlace, 'optionsInPlace') : d.optionsInPlace,
    evidence: sortEvidence(d.evidence),
  };
}

function sortFinding(f) {
  if (f === null || typeof f !== 'object') return f;
  return {
    ...f,
    events: Array.isArray(f.events) ? sortBy(f.events, 'id', 'events') : f.events,
    mitigations: Array.isArray(f.mitigations)
      ? sortBy(f.mitigations.map((x) => (x !== null && typeof x === 'object' ? { ...x, evidence: sortEvidence(x.evidence) } : x)), 'mitigationId', 'mitigations')
      : f.mitigations,
  };
}

function sortEvidence(list) {
  return Array.isArray(list) ? sortBy(list, 'id', 'evidence') : list;
}

function compareUnits(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortKey(value) {
  return typeof value === 'string' ? value.normalize('NFC') : value;
}

function sortBy(items, key, name) {
  const keyed = items.map((item) => ({ k: sortKey(item?.[key]), item }));
  for (const { k } of keyed) {
    if (typeof k !== 'string') throw new TypeError(`canonicalManifestBytes: an entry of ${name} has no string ${key}`);
  }
  keyed.sort((x, y) => compareUnits(x.k, y.k));
  for (let i = 1; i < keyed.length; i++) {
    if (keyed[i].k === keyed[i - 1].k) {
      throw new TypeError(`canonicalManifestBytes: ${name} holds ${JSON.stringify(keyed[i].k)} twice`);
    }
  }
  return keyed.map(({ item }) => item);
}

function sortStrings(items, name) {
  for (const s of items) {
    if (typeof s !== 'string') throw new TypeError(`canonicalManifestBytes: ${name} holds a value that is not a string`);
  }
  return [...items].sort((x, y) => compareUnits(x.normalize('NFC'), y.normalize('NFC')));
}
