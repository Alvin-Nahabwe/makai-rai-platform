import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';

/**
 * One source each for the texts S-04 and S-05 share (C4 SI-1 to SI-3): M-23, M-25, the not-created
 * copy of 7.4.2 row S-04 / S-05, and the guard that reads the acceptances of routes 30 and 31. A
 * copy kept in step by hand is how two pages come to say different things for one SRS row.
 *
 * `git grep` over the tracked files of app, lib and components, run with NO_COLOR=1 and no
 * FORCE_COLOR, escape sequences stripped (as user-insert-sites.test.ts does).
 */
function filesMatching(fixed: string): string[] {
  const { FORCE_COLOR: _force, ...env } = process.env;
  let out = '';
  try {
    out = execFileSync('git', ['grep', '-l', '-I', '-F', fixed, '--', 'app', 'lib', 'components'], { encoding: 'utf8', env: { ...env, NO_COLOR: '1' } });
  } catch (e) {
    if ((e as { status?: number }).status !== 1) throw e;   // 1: no match
  }
  return out.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').split('\n').filter(Boolean).sort();
}

describe('S-04 and S-05 take their shared texts from one place', () => {
  it('M-23: the unusable-invitation text is written in one file', () => {
    expect(filesMatching('This invitation link does not work.')).toEqual(['lib/org/copy.ts']);
  });

  it('M-25: the missing-acceptance text is written in one file', () => {
    // The summary's sentence, written once in the acceptances copy module; acceptanceError (lib/legal/kinds.ts) is the one function that reads it.
    expect(filesMatching('`Tick the box for the ')).toEqual(['lib/legal/acceptances/copy.ts']);
    expect(filesMatching('To continue, accept the')).toEqual([]);
  });

  it('7.4.2 S-04 / S-05: the not-created copy is written in one component', () => {
    // S-24 (ORG) takes its create form's lost-reply sentence from the administrator forms' copy module (plan 1A Task 19,
    // ruling L5-7: the Retry replays the same request id); S-04 and S-05 take theirs from the acceptances copy module,
    // one text per kind of send.
    expect(filesMatching('Not created yet. We did not get a reply, so the organisation may already be created.')).toEqual(['lib/admin/forms/copy.ts']);
    expect(filesMatching('Not created: connection lost. Nothing was created.')).toEqual([]);
    expect(filesMatching('We did not get a reply, so your account may already be created.')).toEqual(['lib/legal/acceptances/copy.ts']);
    expect(filesMatching('Your choice was not saved because of a problem on our side. Try again.')).toEqual(['lib/legal/acceptances/copy.ts']);
  });
});
