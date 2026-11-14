import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { REMINDER_SETTING_COPY, reminderSettingSaved } from '@/lib/followup/copy';
import { ReminderEmailsSetting, ReminderEmailsSettingView, settingReducer, initialSetting } from '@/components/followup/ReminderEmailsSetting';
import { StageFollowUp, STATUS_WORD } from '@/components/followup/StageFollowUp';
import { readFileSync } from 'node:fs';
import { StageFollowUpCounts } from '@/components/followup/StageFollowUpCounts';
import { PROJECT_COPY } from '@/lib/project/copy';
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
    expect(reminderSettingSaved(true)).toBe('Reminder emails turned on.');
    expect(REMINDER_SETTING_COPY.turnedOff).toBe('Reminder emails turned off.');
  });

  it('FR-FUP-06 NFR-A11Y-02: the setting is a labelled checkbox with its note', () => {
    const html = renderToStaticMarkup(<ReminderEmailsSetting enabled />);
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*checked/);
    expect(html).toMatch(/<label[^>]*>[^<]*Email me when a mitigation assigned to me is due or overdue/);
    expect(html).toContain('This only turns the emails on or off. Your mitigations still show on Home.');
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
    const F = PROJECT_COPY.followUp;
    const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(html).toContain(F.heading);
    expect(html.indexOf(`>${F.overdue}<`)).toBeLessThan(html.indexOf(F.due('12 Nov 2026')));
    expect(html.indexOf(F.due('12 Nov 2026'))).toBeLessThan(html.indexOf(F.due('20 Nov 2026')));
    // spec 7.1 (plan 1A Task 15 carry): the word Overdue alone is red, outside any status label; the date follows as plain text.
    expect(html).toContain(`<span class="followup-overdue">${F.overdue}</span>${F.wasDue('28 Oct 2026')}`);
    expect(html.match(/class="followup-overdue"/g)).toHaveLength(1);
    // the owner who cannot act: a sentence naming them, then what to do, both plain text (ruling L5-5 amended: a sentence is
    // not a status label)
    expect(html).toContain(`<span>${F.cannotAct('Ada Owner')} ${F.reassign}</span>`);
    expect(html).not.toMatch(new RegExp(`class="status-label"[^>]*>[^<]*${esc(F.cannotAct('Ada Owner'))}`));
    expect(html).toContain('href="/orgs/o/projects/p/findings/');
    expect(html.match(new RegExp(`>${esc(F.view)}</a>`, 'g'))).toHaveLength(3);
    expect(html).toContain('<span class="status-label">In progress</span>');
    expect(html).toContain('<span class="status-label">Planned</span>');
    expect(html).not.toMatch(/badge--moderate|data-status-label|status-label--warning/);
    expect(html).toContain(F.assignedTo('Ada Owner'));
  });

  it('FR-FUP-01: an item in both lists is shown once', () => {
    const html = renderToStaticMarkup(<StageFollowUp orgSlug="o" projectId="p" stage="pre-processing" items={[CANNOT_20_NOV]} cannotAct={[CANNOT_20_NOV]} />);
    expect(html.match(/Do m-cannot/g)).toHaveLength(1);
  });

  it('FR-FUP-01: a mitigation whose text was erased says so', () => {
    const html = renderToStaticMarkup(<StageFollowUp orgSlug="o" projectId="p" stage="pre-processing" items={[{ ...DUE_12_NOV, what: null }]} cannotAct={[]} />);
    expect(html).toContain(`<span>${PROJECT_COPY.followUp.erased.replaceAll("'", '&#x27;')}</span>`);
  });

  it('FR-FUP-01: StageFollowUpCounts links open findings and overdue mitigations', () => {
    const html = renderToStaticMarkup(<StageFollowUpCounts orgSlug="o" projectId="p" stage="in-processing" counts={{ openFindings: 1, overdueMitigations: 2 }} />);
    expect(html).toContain('href="/orgs/o/projects/p/findings"'); expect(html).toMatch(/>1 open finding<\/a>/);
    expect(html).toContain('href="/orgs/o/projects/p#in-processing"'); expect(html).toMatch(/>2 overdue mitigations<\/a>/);
  });

  it('FR-FUP-01: StageFollowUp says "None open." for an empty stage', () => {
    expect(renderToStaticMarkup(<StageFollowUp orgSlug="o" projectId="p" stage="post-processing" items={[]} cannotAct={[]} />)).toContain(`<p>${PROJECT_COPY.followUp.none}</p>`);
  });

  it('FR-FUP-01 FR-PUB-01: the claims crawl exempts exactly the status words StageFollowUp renders', () => {
    const crawl = readFileSync('e2e/claims-crawl.spec.ts', 'utf8');
    const declared = /MITIGATION_STATUS_WORDS: ReadonlySet<string> = new Set\(\[([^\]]*)\]\)/.exec(crawl);
    expect(declared, 'MITIGATION_STATUS_WORDS not found in e2e/claims-crawl.spec.ts').not.toBeNull();
    const words = [...declared![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(words.sort()).toEqual(Object.values(STATUS_WORD).sort());
  });
});
