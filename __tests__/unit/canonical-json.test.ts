import { describe, it, expect } from 'vitest';
import { canonicalJson } from '@/lib/integrity/canonical.mjs';

describe('canonicalJson', () => {
  it('FR-REV-03 NFR-MNT-05 (5.4): keys sorted by UTF-16 code units, strings NFC, integers only', () => {
    // 'é' becomes U+00E9 (NFC); key order by UTF-16 units: a, b, U+00E9, U+1F600 (0xD83D...), U+FF5A
    expect(canonicalJson({ b: 1, a: 'é', 'é': true, '\u{1F600}': null, 'ｚ': [] }))
      .toBe('{"a":"é","b":1,"é":true,"\u{1F600}":null,"ｚ":[]}');
    expect(() => canonicalJson({ x: 1.5 })).toThrow(TypeError);
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');   // arrays keep their order
  });

  it('FR-REV-03 NFR-MNT-05 (5.4): a decomposed string and a decomposed key are written composed (NFC)', () => {
    const decomposed = 'é';          // e + combining acute
    expect(canonicalJson({ [decomposed]: decomposed })).toBe('{"é":"é"}');
    expect(canonicalJson({ [decomposed]: decomposed })).toBe(canonicalJson({ 'é': 'é' }));
  });

  it('FR-REV-03 NFR-MNT-05 (5.4): two keys that are equal after NFC are refused, not merged', () => {
    expect(() => canonicalJson({ 'é': 1, 'é': 2 })).toThrow(TypeError);
  });

  it('FR-REV-03 NFR-MNT-05 (5.4): keys sort at every depth, and by code unit, not by locale', () => {
    expect(canonicalJson({ z: { b: [{ y: 1, x: 2 }], a: 0 }, Z: 1, a: null }))
      .toBe('{"Z":1,"a":null,"z":{"a":0,"b":[{"x":2,"y":1}]}}');
  });

  it('FR-REV-03 NFR-MNT-05 (5.4): booleans, null, integers (zero and negative), empty containers and escapes', () => {
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(false)).toBe('false');
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(0)).toBe('0');
    expect(canonicalJson(-0)).toBe('0');
    expect(canonicalJson(-42)).toBe('-42');
    expect(canonicalJson(2 ** 53)).toBe('9007199254740992');
    expect(canonicalJson({})).toBe('{}');
    expect(canonicalJson([])).toBe('[]');
    expect(canonicalJson('a"b\\c\n\u0001')).toBe('"a\\"b\\\\c\\n\\u0001"');
    expect(canonicalJson('')).toBe('""');
  });

  it('FR-REV-03 NFR-MNT-05 (5.4): anything outside strings, integers, booleans, null, arrays and plain objects is a TypeError', () => {
    const refused: Array<[string, unknown]> = [
      ['undefined', undefined], ['NaN', Number.NaN], ['Infinity', Number.POSITIVE_INFINITY], ['float', 0.1],
      ['bigint', BigInt(1)], ['function', () => 1], ['symbol', Symbol('s')], ['Date', new Date(0)],
      ['Map', new Map()], ['Buffer', Buffer.from('a')], ['class instance', new (class X { a = 1; })()],
      ['undefined property', { a: undefined }], ['undefined in array', [1, undefined]],
      ['hole in array', [1, , 3]],
      ['float in array', [1, [2.5]]], ['float in object', { a: { b: 0.5 } }],
    ];
    for (const [name, value] of refused) expect(() => canonicalJson(value), name).toThrow(TypeError);
  });

  it('FR-REV-03 NFR-MNT-05 (5.4): an object without a prototype is a plain object', () => {
    expect(canonicalJson(Object.assign(Object.create(null), { b: 1, a: 2 }))).toBe('{"a":2,"b":1}');
  });

  it('NFR-INT-02 (helper): equal values give one string whatever the key order of the input', () => {
    expect(canonicalJson({ path: { id: 'p', reviewId: 'r' }, body: { requestId: 'q', n: 1 } }))
      .toBe(canonicalJson({ body: { n: 1, requestId: 'q' }, path: { reviewId: 'r', id: 'p' } }));
  });
});
