import { describe, it, expect, afterAll } from 'vitest';
import { saltedDigestHex } from '@/lib/integrity/canonical.mjs';
import { testDb } from '../helpers/db';

/**
 * The salted digest has two implementations by necessity: `saltedDigestHex` for the seal (Node) and the
 * erasure functions' SQL for the tombstone (contract, "Digest field names"; executed claim E-14). This pins
 * them to each other on the database the migrations built, so they cannot drift (NFR-MNT-05).
 */
describe('saltedDigestHex against the SQL tombstone digest', () => {
  afterAll(async () => { await testDb.$disconnect(); });

  it('NFR-MNT-05 FR-REV-08: saltedDigestHex equals the SQL tombstone digest for the same vector', async () => {
    const salt = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
    for (const [field, text] of [['reason', 'Café ZZ'], ['reason', 'Café ZZ'], ['fileName', 'Résumé – consent "v2".pdf'], ['preparedFor', '']]) {
      const [{ d }] = await testDb.$queryRaw<{ d: string }[]>`SELECT encode(sha256(${salt}::bytea || '\\x00'::bytea || convert_to(${field}, 'UTF8') || '\\x00'::bytea || convert_to(normalize(${text}, NFC), 'UTF8')), 'hex') AS d`;
      expect(saltedDigestHex(salt, field, text), `${field} ${JSON.stringify(text)}`).toBe(d);
    }
    expect(saltedDigestHex(salt, 'reason', 'Café ZZ')).toBe('9e87cc554bffec891093a67095d8f2b7f67d09fc52b9e2350dc6a707ed81b9c5');   // contract E-14
  });

  it('NFR-MNT-05 FR-REV-08: the erasure function computes the same expression (its body holds it verbatim)', async () => {
    const [{ src }] = await testDb.$queryRaw<{ src: string }[]>`SELECT prosrc AS src FROM pg_proc WHERE proname = 'erase_text_field'`;
    expect(src.replace(/\s+/g, ' ')).toContain("encode(sha256(v_salt || '\\x00'::bytea || convert_to(field, 'UTF8') || '\\x00'::bytea || convert_to(normalize(v_text, NFC), 'UTF8')), 'hex')");
  });
});
