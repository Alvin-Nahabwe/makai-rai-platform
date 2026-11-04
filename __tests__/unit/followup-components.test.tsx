import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { REMINDER_SETTING_COPY, reminderSettingSaved } from '@/lib/followup/copy';
import { ReminderEmailsSetting } from '@/components/followup/ReminderEmailsSetting';
import { StageFollowUp } from '@/components/followup/StageFollowUp';
import { StageFollowUpCounts } from '@/components/followup/StageFollowUpCounts';
import type { FollowUpItem } from '@/types/api';

const item = (id: string, dueDate: string, over: Partial<FollowUpItem> = {}): FollowUpItem => ({
  mitigationId: id, versionId: `v-${id}`, findingId: `f-${id}`, projectId: 'p', stage: 'pre-processing', what: `Do ${id}`,
  owner: { userId: 'u', name: 'Ada Owner', formerMember: false }, dueDate, status: 'planned', overdue: false, ownerCanAct: true, ...over,
});
const DUE_12_NOV = item('m-due', '2026-11-12');
const OVERDUE_28_OCT = item('m-over', '2026-10-28', { overdue: true, status: 'in_progress' });
const CANNOT_20_NOV = item('m-cannot', '2026-11-20', { ownerCanAct: false });

describe('reminder emails setting (S-21)', () => {
  it('FR-FUP-06: turning reminders off says "Reminder emails turned off."', () => {   // 7.4.2 row S-21, SRS line 2389
    expect(reminderSettingSaved(false)).toBe('Reminder emails turned off.');
    expect(reminderSettingSaved(true)).toBe('Saved.');
    expect(REMINDER_SETTING_COPY.turnedOff).toBe('Reminder emails turned off.');
  });

  it('FR-FUP-06 NFR-A11Y-02: the setting is a labelled checkbox with its note', () => {
    const html = renderToStaticMarkup(<ReminderEmailsSetting enabled />);
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*checked/);
    expect(html).toMatch(/<label[^>]*>[^<]*Email me when a mitigation I own is due/);
    expect(html).toContain('The lists on the dashboard and project pages do not change.');
  });
});

describe('stage follow-up (S-10, S-11)', () => {
  it('FR-FUP-01 FR-FUP-05: StageFollowUp lists overdue first and marks overdue and owner cannot act in words', () => {
    const html = renderToStaticMarkup(<StageFollowUp orgSlug="o" projectId="p" stage="pre-processing" items={[DUE_12_NOV, OVERDUE_28_OCT]} cannotAct={[CANNOT_20_NOV]} />);
    expect(html).toContain('Mitigations to follow up');
    expect(html.indexOf('>Overdue<')).toBeLessThan(html.indexOf('Due 12 Nov 2026'));
    expect(html.indexOf('Due 12 Nov 2026')).toBeLessThan(html.indexOf('Due 20 Nov 2026'));
    // R13-7: the label word carries the class, the rest of the phrase is plain text after it.
    expect(html).toContain('<span class="status-label status-label--warning">Overdue</span>: was due 28 Oct 2026');
    expect(html).toContain('<span class="status-label status-label--warning">Owner cannot act</span>: reassign');
    expect(html).toContain('href="/orgs/o/projects/p/findings/');
    expect(html).toContain('<span class="status-label">In progress</span>');
    expect(html).toContain('<span class="status-label">Planned</span>');
    expect(html).not.toMatch(/badge--moderate|data-status-label/);
    const warnings = [...html.matchAll(/status-label--warning">([^<]*)</g)].map((m) => m[1]);
    expect(warnings.sort()).toEqual(['Overdue', 'Owner cannot act']);                          // the tint is on those two words only
    expect(html).toContain('Ada Owner');
  });

  it('FR-FUP-01: an item in both lists is shown once', () => {
    const html = renderToStaticMarkup(<StageFollowUp orgSlug="o" projectId="p" stage="pre-processing" items={[CANNOT_20_NOV]} cannotAct={[CANNOT_20_NOV]} />);
    expect(html.match(/Do m-cannot/g)).toHaveLength(1);
  });

  it('FR-FUP-01: StageFollowUpCounts links open findings and overdue mitigations', () => {
    const html = renderToStaticMarkup(<StageFollowUpCounts orgSlug="o" projectId="p" stage="in-processing" counts={{ openFindings: 1, overdueMitigations: 2 }} />);
    expect(html).toContain('href="/orgs/o/projects/p/findings"'); expect(html).toContain('1 open finding');
    expect(html).toContain('href="/orgs/o/projects/p#in-processing"'); expect(html).toContain('2 overdue mitigations');
  });

  it('FR-FUP-01: StageFollowUp says "None open." for an empty stage', () => {
    expect(renderToStaticMarkup(<StageFollowUp orgSlug="o" projectId="p" stage="post-processing" items={[]} cannotAct={[]} />)).toContain('None open.');
  });
});
