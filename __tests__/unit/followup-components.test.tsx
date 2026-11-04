import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { REMINDER_SETTING_COPY, reminderSettingSaved } from '@/lib/followup/copy';
import { ReminderEmailsSetting, ReminderEmailsSettingView, settingReducer, initialSetting } from '@/components/followup/ReminderEmailsSetting';
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

describe('reminder emails setting view (S-21)', () => {
  const view = (pending: boolean, onChange = () => undefined) =>
    renderToStaticMarkup(<ReminderEmailsSettingView id="x" state={{ ...initialSetting(true), pending }} onChange={onChange} />);

  it('FR-FUP-06 NFR-A11Y-02: while a save is in flight the box is aria-disabled and looks disabled, and it keeps focus (not the disabled attribute)', () => {
    const html = view(true);
    expect(html).toMatch(/<input[^>]*aria-disabled="true"/);
    expect(html).not.toMatch(/<input[^>]*\sdisabled(=|\s|>)/);
    expect(html).toMatch(/<input[^>]*style="[^"]*opacity:0\.5/);
  });

  it('FR-FUP-06: with no save in flight the box is not marked disabled', () => {
    const html = view(false);
    expect(html).not.toMatch(/aria-disabled="true"/);
    expect(html).not.toMatch(/opacity/);
  });

  it('FR-FUP-06: a change made while a save is in flight is ignored', () => {
    type Node = { type?: string; props?: { onChange?: (e: { target: { checked: boolean } }) => void } };
    const changeOf = (el: unknown) => ((el as { props: { children: Node[] } }).props.children.find((c) => c && c.type === 'input') as Node).props!.onChange!;
    const calls: boolean[] = [];
    changeOf(ReminderEmailsSettingView({ id: 'x', state: { ...initialSetting(true), pending: true }, onChange: (next) => calls.push(next) }))({ target: { checked: false } });
    expect(calls).toEqual([]);
    changeOf(ReminderEmailsSettingView({ id: 'x', state: initialSetting(true), onChange: (next) => calls.push(next) }))({ target: { checked: false } });
    expect(calls).toEqual([false]);
  });
});

describe('reminder emails setting state (S-21)', () => {
  it('FR-FUP-06 NFR-A11Y-02: the box is disabled while a save is in flight and is enabled again after the answer', () => {
    const saving = settingReducer(initialSetting(true), { type: 'start', next: false });
    expect(saving).toMatchObject({ checked: false, pending: true, status: 'Saving...' });
    expect(settingReducer(saving, { type: 'saved' })).toMatchObject({ checked: false, confirmed: false, pending: false, status: 'Reminder emails turned off.', failed: false });
  });

  it('FR-FUP-06: a save that fails puts back the value the server last confirmed, not the one before the click', () => {
    const first = settingReducer(initialSetting(true), { type: 'start', next: false });
    const confirmedOff = settingReducer(first, { type: 'saved' });
    const second = settingReducer(confirmedOff, { type: 'start', next: true });
    const failed = settingReducer(second, { type: 'unsaved' });
    expect(failed).toMatchObject({ checked: false, confirmed: false, pending: false, failed: true, status: '' });
    expect(settingReducer(initialSetting(true), { type: 'start', next: false })).toMatchObject({ confirmed: true });   // confirmed moves only on 'saved'
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
