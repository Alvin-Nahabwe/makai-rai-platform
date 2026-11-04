/** The text of the reminder-emails setting on the account page (S-21; 7.4.2 row S-21, SRS line 2389; W-12, SRS line 2269). */
export const REMINDER_SETTING_COPY = {
  label: 'Email me when a mitigation I own is due',
  note: 'The lists on the dashboard and project pages do not change.',
  saving: 'Saving...',
  turnedOff: 'Reminder emails turned off.',
  turnedOn: 'Saved.',
  failed: 'Not saved. Try again.',
} as const;

/** What the status line says once the change is saved: the SRS gives text for turning them off only. */
export function reminderSettingSaved(enabled: boolean): string {
  return enabled ? REMINDER_SETTING_COPY.turnedOn : REMINDER_SETTING_COPY.turnedOff;
}

/** The status word of an open mitigation on S-10; kept here with the other follow-up copy (UX-06 says it in words). */
export const MITIGATION_STATUS_WORD = { planned: 'Planned', in_progress: 'In progress' } as const;
