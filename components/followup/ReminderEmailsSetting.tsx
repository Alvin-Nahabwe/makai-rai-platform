'use client';

import { useId, useReducer, type ReactElement } from 'react';
import { sendWrite } from '@/lib/client/retrySafeWrite';
import { REMINDER_SETTING_COPY, reminderSettingSaved } from '@/lib/followup/copy';
import type { PreferencesRequest } from '@/types/api';

export type ReminderEmailsSettingProps = { enabled: boolean };

export type SettingState = { checked: boolean; confirmed: boolean; pending: boolean; status: string; failed: boolean };
export type SettingAction = { type: 'start'; next: boolean } | { type: 'saved' } | { type: 'unsaved' };

export const initialSetting = (enabled: boolean): SettingState => ({ checked: enabled, confirmed: enabled, pending: false, status: '', failed: false });

/** `confirmed` is what the server last answered 204 for; a failed save puts that back, whatever was clicked since. */
export function settingReducer(s: SettingState, a: SettingAction): SettingState {
  switch (a.type) {
    case 'start': return { ...s, checked: a.next, pending: true, status: REMINDER_SETTING_COPY.saving, failed: false };
    case 'saved': return { ...s, confirmed: s.checked, pending: false, status: reminderSettingSaved(s.checked), failed: false };
    case 'unsaved': return { ...s, checked: s.confirmed, pending: false, status: '', failed: true };
  }
}

/**
 * The reminder-emails setting on the account page (S-21; FR-FUP-06). A slot of its screen: the
 * screen's owner renders it. A change is sent at once and the box is disabled until the answer,
 * so two saves are never in flight; the status line says what became of it.
 */
export function ReminderEmailsSetting({ enabled }: ReminderEmailsSettingProps): ReactElement {
  const id = useId();
  const [s, dispatch] = useReducer(settingReducer, enabled, initialSetting);

  async function change(next: boolean) {
    dispatch({ type: 'start', next });
    const out = await sendWrite('/api/users/me/preferences', 'PATCH', { reminderEmails: next } satisfies PreferencesRequest, { onSlow: () => undefined });
    dispatch({ type: out.kind === 'saved' ? 'saved' : 'unsaved' });
  }

  return (
    <div>
      <input id={id} type="checkbox" checked={s.checked} disabled={s.pending} onChange={(e) => void change(e.target.checked)} />{' '}
      <label htmlFor={id}>{REMINDER_SETTING_COPY.label}</label>
      <p>{REMINDER_SETTING_COPY.note}</p>
      <p role="status">{s.status}</p>
      {s.failed ? <p role="alert">{REMINDER_SETTING_COPY.failed}</p> : null}
    </div>
  );
}
