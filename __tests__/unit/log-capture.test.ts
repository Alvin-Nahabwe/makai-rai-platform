import { describe, expect, it } from 'vitest';
import { captureLogs, scanLines } from '../helpers/logCapture';
import { markerFor } from '../helpers/markers';

/**
 * `captureLogs` collects what a piece of code prints through `console`, and `scanLines` finds record text
 * (markers) and email addresses in it: the in-process half of NFR-PRIV-03's "no record text and no email
 * address in any log".
 */

describe('captureLogs', () => {
  it('NFR-PRIV-03 (harness): captureLogs collects console lines and restores console; scanLines names each kind', async () => {
    const before = console.error;
    const { lines } = await captureLogs(async () => {
      console.log('ok');
      console.error('to a@b.example ZZMARK-r-1-QX');
    });
    expect(console.error).toBe(before);
    expect(scanLines(lines, { markers: true, emails: true })).toEqual([
      { line: 1, match: 'a@b.example', kind: 'email' },
      { line: 1, match: 'ZZMARK-r-1-QX', kind: 'marker' },
    ]);
  });

  it('NFR-PRIV-03 (harness): captureLogs restores console even when the function rejects, and passes the rejection on', async () => {
    const before = { log: console.log, info: console.info, warn: console.warn, error: console.error };
    await expect(
      captureLogs(async () => {
        console.warn('before the failure');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect({ log: console.log, info: console.info, warn: console.warn, error: console.error }).toEqual(before);
  });

  it('NFR-PRIV-03 (harness): captureLogs returns the result, formats arguments as console does, and splits lines', async () => {
    const { result, lines } = await captureLogs(async () => {
      console.log('count %d of %s', 2, 'three');
      console.info({ id: 'x' });
      console.warn('first\nsecond');
      return 42;
    });
    expect(result).toBe(42);
    expect(lines).toEqual(['count 2 of three', "{ id: 'x' }", 'first', 'second']);
  });

  it('NFR-PRIV-03 (harness): captureLogs keeps nothing from before it started or after it ended', async () => {
    console.log('not captured');
    const { lines } = await captureLogs(async () => {
      console.log('inside');
    });
    expect(lines).toEqual(['inside']);
    const second = await captureLogs(async () => undefined);
    expect(second.lines).toEqual([]);
  });
});

describe('scanLines', () => {
  it('NFR-PRIV-03 (harness): scanLines reports only the kinds asked for, with line numbers from 0', () => {
    const lines = ['clean', `m ${markerFor('a', 1)}`, 'e x@y.example', `${markerFor('b', 2)} z@w.example`];
    expect(scanLines(lines, { markers: true, emails: false })).toEqual([
      { line: 1, match: 'ZZMARK-a-1-QX', kind: 'marker' },
      { line: 3, match: 'ZZMARK-b-2-QX', kind: 'marker' },
    ]);
    expect(scanLines(lines, { markers: false, emails: true })).toEqual([
      { line: 2, match: 'x@y.example', kind: 'email' },
      { line: 3, match: 'z@w.example', kind: 'email' },
    ]);
    expect(scanLines(lines, { markers: true, emails: true }).map((f) => [f.line, f.kind])).toEqual([
      [1, 'marker'],
      [2, 'email'],
      [3, 'marker'],
      [3, 'email'],
    ]);
    expect(scanLines(['clean', 'also clean'], { markers: true, emails: true })).toEqual([]);
  });

  it('NFR-PRIV-03 (harness): scanLines finds every match on a line and uses the nightly scan pattern', () => {
    const found = scanLines(['a@b.example and c.d+e@f-g.example.org'], { markers: false, emails: true });
    expect(found.map((f) => f.match)).toEqual(['a@b.example', 'c.d+e@f-g.example.org']);
    // The pattern is the file the nightly production scan reads, not a copy of it: no address, no match.
    expect(scanLines(['user at example dot org', '@no-local-part.example', 'no-domain@'], { markers: false, emails: true })).toEqual([]);
  });

  it('NFR-PRIV-03 (harness): scanLines gives the same answer on a second call (no pattern state is shared)', () => {
    const lines = [`x ${markerFor('s', 1)} y@z.example`];
    expect(scanLines(lines, { markers: true, emails: true })).toEqual(scanLines(lines, { markers: true, emails: true }));
    expect(scanLines(lines, { markers: true, emails: true })).toHaveLength(2);
  });
});
