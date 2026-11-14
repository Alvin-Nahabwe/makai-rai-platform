/** The text of the reminder-emails setting on the account page (S-21; 7.4.2 row S-21, SRS line 2389; W-12, SRS line 2269). */
export const REMINDER_SETTING_COPY = {
  label: 'Email me when a mitigation assigned to me is due or overdue',
  note: 'This only turns the emails on or off. Your mitigations still show on Home.',
  saving: 'Saving...',
  turnedOff: 'Reminder emails turned off.',
  turnedOn: 'Reminder emails turned on.',
  failed: 'Not saved. Try again.',
} as const;

/** What the status line says once the change is saved: the SRS gives text for turning them off only. */
export function reminderSettingSaved(enabled: boolean): string {
  return enabled ? REMINDER_SETTING_COPY.turnedOn : REMINDER_SETTING_COPY.turnedOff;
}
