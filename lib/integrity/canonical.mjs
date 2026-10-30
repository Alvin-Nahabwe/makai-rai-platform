/**
 * The one canonical JSON writer (SRS 5.4, ADR-C3, NFR-MNT-05): RFC 8785
 * restricted to strings, integers, booleans, null, arrays and plain objects.
 * Strings, and object keys, are written in Unicode NFC. Object keys are
 * sorted by UTF-16 code unit. Arrays keep the order they are given.
 *
 * It throws a TypeError, and never skips or rounds, on anything else: a
 * non-integer number, `undefined` (also as a property value or an array
 * element), a bigint, a function, a symbol, a Date or any object that is not a
 * plain object, and two keys that are equal once written in NFC. Nothing here
 * imports anything, so the seal check can run it outside Next.js.
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
