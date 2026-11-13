import { describe, expect, it } from 'vitest';
import { validateEmail } from '../../lib/validate';
import { redactText } from '../../lib/redact';
import { VALIDATION_COPY } from '../../lib/http/copy';

/**
 * RL 2.3 / 7.12: an address the platform will hold is an address the log redactor must catch.
 * `validateEmail` used to follow a loose RFC 5322 reading; the redactor (and the scan) follow
 * `ops/host/email-shape.regex`. Where the two disagreed, an account could be created whose
 * address the redactor leaves in a log line, in whole or in part, and only the account scan
 * (which looks for the exact address) would notice. `validateEmail` now also requires the
 * whole address to match the shape, so nothing it accepts is outside the redactor's reach.
 *
 * Every address here uses a reserved example domain.
 */

/** The rule as it was before this change, kept here so the test shows the difference it makes. */
const OLD_RULE =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

describe('validateEmail', () => {
  it.each([
    'owner@example.org',
    'First.Last+tag@Sub.Example.ORG',
    'a_b-c%d@example.test',
    '  padded@example.org  ',
  ])('accepts %j', (email) => {
    expect(validateEmail(email)).toBeNull();
  });

  it.each([
    ['a dotless domain', 'user@intranet'],
    ['an IP-literal-looking domain', 'user@1.2.3.4'],
    ['a TLD with a digit', 'user@example.c0m'],
    ['a one-letter TLD', 'user@example.x'],
    ['an apostrophe in the local part', "o'brien@example.org"],
    ['a slash in the local part', 'first/last@example.org'],
    ['an exclamation mark in the local part', 'a!b@example.org'],
    ['an equals sign in the local part', 'a=b@example.org'],
    ['a brace in the local part', '{x}@example.org'],
  ])('rejects %s, which the old rule accepted and the shape does not cover: %j', (_why, email) => {
    // The point of the test: these passed before.
    expect(OLD_RULE.test(email.trim().toLowerCase()), 'the old rule no longer accepts it, so this proves nothing').toBe(true);
    expect(validateEmail(email)).toEqual({ field: 'email', message: VALIDATION_COPY.emailShape });
  });

  it('keeps the other refusals: empty, not a string, too long, no at sign', () => {
    expect(validateEmail('')?.message).toBe(VALIDATION_COPY.emailRequired);
    expect(validateEmail(undefined)?.message).toBe(VALIDATION_COPY.emailRequired);
    expect(validateEmail(`${'a'.repeat(250)}@example.org`)?.message).toBe(VALIDATION_COPY.tooLong(254));
    expect(validateEmail('not-an-address')?.message).toBe(VALIDATION_COPY.emailShape);
  });

  it('accepts nothing the redactor would leave any of behind', () => {
    // The property, on a deterministic corpus: whenever validateEmail accepts a string, the
    // redactor replaces the whole of it. A third of the local parts carry one character the
    // old rule allowed and the shape does not, and some domains have no usable TLD, so the
    // corpus reaches both kinds of disagreement.
    const safe = ['a', 'B', '0', '.', '-', '_', '%', '+'];
    const odd = ['!', '#', '$', '&', "'", '*', '/', '=', '?', '^', '`', '{', '|', '}', '~'];
    const letters = ['a', 'z', 'Q'];
    const alnum = ['a', 'Z', '9', 'x'];
    let seed = 987654321;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    const pick = (alphabet: string[], min: number, max: number): string => {
      let s = '';
      for (let i = 0, n = min + (next() % (max - min + 1)); i < n; i += 1) s += alphabet[next() % alphabet.length];
      return s;
    };
    let accepted = 0;
    let rejected = 0;
    for (let i = 0; i < 20000; i += 1) {
      let local = pick(safe, 1, 6);
      if (next() % 3 === 0) {
        const at = next() % (local.length + 1);
        local = local.slice(0, at) + odd[next() % odd.length] + local.slice(at);
      }
      const tld = next() % 5 === 0 ? pick(alnum, 1, 3) : pick(letters, 2, 5);
      const domain = `${pick(alnum, 1, 5)}${next() % 2 === 0 ? `.${pick(alnum, 1, 4)}` : ''}.${tld}`;
      const candidate = `${local}@${domain}`;
      if (validateEmail(candidate) === null) {
        accepted += 1;
        expect(redactText(candidate), candidate).toBe('[email-redacted]');
      } else {
        rejected += 1;
      }
    }
    expect(accepted, 'the corpus accepted almost nothing, so the property was not exercised').toBeGreaterThan(5000);
    expect(rejected, 'the corpus rejected almost nothing, so the shape rule was not exercised').toBeGreaterThan(2000);
  });
});
