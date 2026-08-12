import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Opened at the Phase 1d-i C6 register review, 2026-08-10.
 *
 * `docs/DEFERRED_REGISTER.md` is this project's entire memory of every
 * deliberate not-doing: 203 rows, three phases, and the artefact AGENTS.md
 * §6 leans on to stop a deferral becoming a silent gap. Until this file it
 * had **no automated check of any kind**. Every audit was an `awk` command
 * retyped by hand at each phase exit.
 *
 * WHAT THAT COST, and why this file exists rather than a rule saying "audit
 * the register carefully". At the Phase 1d-i C6 exit the controller ran the
 * mandated gate -- "no phase exits with an open row targeted at that phase"
 * -- as `tolower(status) == "open"`. That is an exact match. Two earlier
 * phase-exit reconciliations had written their closure NARRATIVE into the
 * status column, so 84 of 203 rows carry a status field of up to 3,798
 * characters. None of them equals "open", so the gate SKIPPED them silently
 * and reported a pass it had no power to establish. Worse, two rows
 * (D-144, D-146) displayed `Open` while their own text said `Closed-done`
 * -- work that was finished, verified, and still counted as outstanding.
 *
 * The structural audit that did exist (`awk -F'|' NF!=10`) passed on all
 * 203 rows throughout, because it checks the row's SHAPE and never its
 * CONTENT. That is D-191's own class -- a check that confirms a mechanism
 * while the property it stands for is violated -- committed against the
 * register that records D-191.
 *
 * NON-VACUITY, proven by hand rather than asserted: each assertion below
 * was run against a deliberately corrupted copy of the register (a
 * duplicated ID, a removed pipe, a status reverted to the contradictory
 * `Open **Closed-done ...` form) and observed to fail for the right reason
 * before being committed. See the commit message for the recorded output.
 */

const REGISTER = join(__dirname, '../../docs/DEFERRED_REGISTER.md');

/**
 * The status vocabulary is deliberately HAND-WRITTEN, not derived from the
 * file. Deriving it would make any typo self-legitimising -- a row reading
 * `Closd-done` would define itself as valid and the check would pass. This
 * is the same reasoning as `e2e/security.spec.ts`'s EXPECTED_CAP: the
 * property being pinned is *deliberateness*, not completeness, so a new
 * status value must be a conscious edit to this list rather than something
 * the register can grant itself.
 */
const KNOWN_STATUSES = [
  'Open',
  'Closed-done',
  'Closed-superseded',
  'Closed-changed',
  'REOPENED',
] as const;

type Row = { id: string; num: number; fields: string[]; status: string; line: number };

function rows(): Row[] {
  const out: Row[] = [];
  readFileSync(REGISTER, 'utf8').split('\n').forEach((text, i) => {
    const fields = text.split('|');
    if (fields.length !== 10) return;
    const id = fields[1].replace(/[*\s]/g, '');
    if (!/^D-\d+$/.test(id)) return;
    out.push({
      id,
      num: Number(id.slice(2)),
      fields,
      status: fields[8].trim(),
      line: i + 1,
    });
  });
  return out;
}

describe('docs/DEFERRED_REGISTER.md integrity', () => {
  it('parses a plausible number of rows (guards against a broken parser passing vacuously)', () => {
    // Every assertion below is a `for` over `rows()`. A parser that returns
    // [] satisfies all of them. This is the floor that stops that.
    expect(rows().length).toBeGreaterThan(150);
  });

  it('every data row has exactly 10 pipe-delimited fields', () => {
    // A literal `|` inside a cell splits the row and silently shifts every
    // field after it -- the failure this register has actually suffered
    // three times, each time from a scripted append.
    readFileSync(REGISTER, 'utf8').split('\n').forEach((text, i) => {
      const fields = text.split('|');
      if (fields.length < 2) return;
      const id = fields[1]?.replace(/[*\s]/g, '') ?? '';
      if (!/^D-\d+$/.test(id)) return;
      expect(fields.length, `${id} at line ${i + 1} has ${fields.length} fields, not 10`).toBe(10);
    });
  });

  it('has no duplicate IDs', () => {
    const seen = new Map<string, number>();
    for (const r of rows()) {
      expect(seen.has(r.id), `${r.id} appears at lines ${seen.get(r.id)} and ${r.line}`).toBe(false);
      seen.set(r.id, r.line);
    }
  });

  it('has a contiguous ID sequence with no gaps', () => {
    // A gap means a row was lost -- most plausibly by two agents appending
    // concurrently, which happened during this phase and survived only
    // because IDs are allocated by reading the current maximum.
    const nums = rows().map((r) => r.num).sort((a, b) => a - b);
    for (let i = 1; i < nums.length; i++) {
      expect(nums[i], `gap in the ID sequence: D-${nums[i - 1]} is followed by D-${nums[i]}`)
        .toBe(nums[i - 1] + 1);
    }
  });

  it('every status field begins with a known status value', () => {
    for (const r of rows()) {
      const leading = r.status.replace(/^\*+/, '').split(/[^A-Za-z-]/)[0];
      expect(
        KNOWN_STATUSES as readonly string[],
        `${r.id} (line ${r.line}) has status beginning "${leading}", which is not a known value`,
      ).toContain(leading);
    }
  });

  it('no row displays Open while its own status text says it is closed', () => {
    // THE ONE THAT MATTERS. D-144 and D-146 sat in exactly this state --
    // reading `Open`, saying `Closed-done` -- through a whole phase exit,
    // because the audit compared the status to the literal "open" and a
    // status of `Open **Closed-done ...` matches neither branch. Finished
    // work counted as outstanding, and an exact-match gate could not see it.
    for (const r of rows()) {
      const displaysOpen = /^\*{0,2}Open\b/.test(r.status);
      const claimsClosed = /Closed-(done|superseded|changed)/.test(r.status);
      expect(
        displaysOpen && claimsClosed,
        `${r.id} (line ${r.line}) displays Open but its status text says it is closed: "${r.status.slice(0, 120)}..."`,
      ).toBe(false);
    }
  });
});
