import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { REMINDER_SETTING_COPY, reminderSettingSaved } from '@/lib/followup/copy';
import { ReminderEmailsSetting } from '@/components/followup/ReminderEmailsSetting';

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
