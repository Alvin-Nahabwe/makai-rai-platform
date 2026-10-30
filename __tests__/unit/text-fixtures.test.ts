import { describe, expect, it } from 'vitest';
import { HOSTILE_FILE_NAMES, HOSTILE_STRINGS, hostileText } from '../helpers/hostile';
import { MARKER_PATTERN, markerFor, markerText } from '../helpers/markers';

/**
 * The marker and hostile-text fixtures (unit H0). A marker is a string no real text contains, planted in
 * every free-text field so a log scan can tell record text from anything else (NFR-PRIV-03). The hostile
 * strings are what a team could type to run script in a page (NFR-SEC-11).
 */

describe('markers', () => {
  it('NFR-PRIV-03 (harness): markers have one shape and the pattern finds them', () => {
    expect(markerFor('reason', 7)).toBe('ZZMARK-reason-7-QX');
    expect('x ZZMARK-a.b-12-QX y'.match(MARKER_PATTERN)).toEqual(['ZZMARK-a.b-12-QX']);
    expect(markerText('title', 3)).toContain(markerFor('title', 3));
  });

  it('NFR-PRIV-03 (harness): the pattern finds every marker in a line and no near miss', () => {
    const line = `a ${markerFor('reason', 1)} b ${markerFor('title', 22)} c`;
    expect(line.match(MARKER_PATTERN)).toEqual(['ZZMARK-reason-1-QX', 'ZZMARK-title-22-QX']);
    for (const miss of ['ZZMARK-reason-QX', 'ZZMARK--1-QX', 'ZZMARK-reason-1', 'zzmark-reason-1-qx', 'ZZMARK-rea son-1-QX'])
      expect(miss.match(MARKER_PATTERN), miss).toBeNull();
  });

  it('NFR-PRIV-03 (harness): two fields or two sequence numbers never share a marker', () => {
    const seen = new Set<string>();
    for (const field of ['title', 'reason', 'description'])
      for (const seq of [1, 2, 10, 11]) seen.add(markerFor(field, seq));
    expect(seen.size).toBe(12);
    expect(markerText('title', 1)).not.toBe(markerText('title', 2));
  });
});

describe('hostile text', () => {
  it('NFR-SEC-11 (harness): the hostile strings are the SRS three, and every field holds all three', () => {
    expect(HOSTILE_STRINGS).toEqual(['<script>alert(1)</script>', '"><img src=x onerror=alert(1)>', 'javascript:alert(1)']);
    for (const s of HOSTILE_STRINGS) expect(hostileText('reason', 1)).toContain(s);
    expect(hostileText('reason', 1)).toContain(markerFor('reason', 1));
  });

  it('NFR-SEC-11 (harness): a hostile field is also findable by the marker scan, and differs per field', () => {
    expect(hostileText('reason', 1).match(MARKER_PATTERN)).toEqual([markerFor('reason', 1)]);
    expect(hostileText('reason', 1)).not.toBe(hostileText('title', 1));
  });

  it('FR-EVD-02 NFR-SEC-11 (harness): the five hostile file names of Review Focus 2', () => {
    expect(HOSTILE_FILE_NAMES).toHaveLength(5);
    expect(HOSTILE_FILE_NAMES.slice(0, 4)).toEqual([
      'Résumé – consent "v2".pdf',
      '<img src=x onerror=alert(1)>.png',
      '../../etc/passwd.pdf',
      'invoice‮fdp.exe.pdf',
    ]);
    expect(Buffer.byteLength(HOSTILE_FILE_NAMES[4], 'utf8')).toBe(255);
    expect(HOSTILE_FILE_NAMES[4].endsWith('.pdf')).toBe(true);
  });
});
