'use client';

import { useId, useState, type ReactElement } from 'react';
import { sendWrite } from '@/lib/client/retrySafeWrite';
import { REMINDER_SETTING_COPY, reminderSettingSaved } from '@/lib/followup/copy';
import type { PreferencesRequest } from '@/types/api';

export type ReminderEmailsSettingProps = { enabled: boolean };

/**
 * The reminder-emails setting on the account page (S-21; FR-FUP-06). A slot of its screen: the
 * screen's owner renders it. A change is sent at once; the status line says what became of it,
 * and a change that was not saved puts the box back.
 */
export function ReminderEmailsSetting({ enabled }: ReminderEmailsSettingProps): ReactElement {
  const id = useId();
  const [checked, setChecked] = useState(enabled);
  const [status, setStatus] = useState('');
  const [failed, setFailed] = useState(false);

  async function change(next: boolean) {
    const previous = checked;
    setChecked(next);
    setFailed(false);
    setStatus(REMINDER_SETTING_COPY.saving);
    const out = await sendWrite('/api/users/me/preferences', 'PATCH', { reminderEmails: next } satisfies PreferencesRequest, { onSlow: () => undefined });
    if (out.kind === 'saved') {
      setStatus(reminderSettingSaved(next));
    } else {
      setChecked(previous);
      setStatus('');
      setFailed(true);
    }
  }

  return (
    <div>
      <input id={id} type="checkbox" checked={checked} onChange={(e) => void change(e.target.checked)} />{' '}
      <label htmlFor={id}>{REMINDER_SETTING_COPY.label}</label>
      <p>{REMINDER_SETTING_COPY.note}</p>
      <p role="status">{status}</p>
      {failed ? <p role="alert">{REMINDER_SETTING_COPY.failed}</p> : null}
    </div>
  );
}
