'use client';

import { useId, useReducer, type CSSProperties, type ReactElement, type ReactNode } from 'react';
import { sendWrite } from '@/lib/client/retrySafeWrite';
import { REMINDER_SETTING_COPY, reminderSettingSaved } from '@/lib/followup/copy';
import type { PreferencesRequest } from '@/types/api';

/**
 * `label` and `hint` are optional and off by default (lane 6, FX2): the account page, a server component, passes the label
 * with "mitigation" marked as a term and that term's definition as the hint (spec 6), so this client file never imports the
 * vocabulary (ruling X-2). The hint sits right after the label and the checkbox names it with aria-describedby.
 */
export type SettingTerms = { label?: ReactNode; hint?: { id: string; node: ReactNode } };
export type ReminderEmailsSettingProps = { enabled: boolean } & SettingTerms;

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
 * The box and its label are two columns: a label too long for one line wraps beside the box. Wrapped
 * under it, the label's own box covers the checkbox, and the 24 px target check counts that as crowding.
 * The gap is what keeps the label clear of the box's 24 px circle (e2e/helpers/targetSize.ts): do not narrow it.
 */
const BOX_AND_LABEL: CSSProperties = { display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 'var(--space-2)', alignItems: 'baseline' };
/** As wide as its words, up to the column: beside a one-line label, empty space does not tick the box. */
const LABEL: CSSProperties = { justifySelf: 'start' };
const FULL_ROW: CSSProperties = { gridColumn: '1 / -1' };

/** What a person sees: pure, so the pending state can be rendered and asserted without a browser. */
export function ReminderEmailsSettingView({ id, state: s, onChange, label, hint }: { id: string; state: SettingState; onChange: (next: boolean) => void } & SettingTerms): ReactElement {
  return (
    <div style={BOX_AND_LABEL}>
      {/* aria-disabled, not disabled: a disabled control that has focus can drop it, and the next key press then misses the box. */}
      <input
        id={id} type="checkbox" checked={s.checked} aria-disabled={s.pending} aria-describedby={hint?.id}
        style={s.pending ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
        onChange={(e) => { if (!s.pending) onChange(e.target.checked); }}
      />
      <label htmlFor={id} style={LABEL}>{label ?? REMINDER_SETTING_COPY.label}</label>
      {hint === undefined ? null : <p style={FULL_ROW}>{hint.node}</p>}
      <p style={FULL_ROW}>{REMINDER_SETTING_COPY.note}</p>
      <p role="status" style={FULL_ROW}>{s.status}</p>
      {s.failed ? <p role="alert" style={FULL_ROW}>{REMINDER_SETTING_COPY.failed}</p> : null}
    </div>
  );
}

/**
 * The reminder-emails setting on the account page (S-21; FR-FUP-06). A slot of its screen: the
 * screen's owner renders it. A change is sent at once; while it is in flight the box is aria-disabled
 * and further changes are ignored, so two saves are never in flight; the status line says what became of it.
 */
export function ReminderEmailsSetting({ enabled, label, hint }: ReminderEmailsSettingProps): ReactElement {
  const id = useId();
  const [s, dispatch] = useReducer(settingReducer, enabled, initialSetting);

  async function change(next: boolean) {
    dispatch({ type: 'start', next });
    const out = await sendWrite('/api/users/me/preferences', 'PATCH', { reminderEmails: next } satisfies PreferencesRequest, { onSlow: () => undefined });
    dispatch({ type: out.kind === 'saved' ? 'saved' : 'unsaved' });
  }

  return <ReminderEmailsSettingView id={id} state={s} onChange={(next) => void change(next)} label={label} hint={hint} />;
}
