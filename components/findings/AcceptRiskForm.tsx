'use client';

import { useRouter } from 'next/navigation';
import { useId, useState, type ReactElement } from 'react';
import { ErrorSummary, Field, StatusLine, useFindingWrite } from '@/components/findings/FindingActions';
import {
  acceptedLabelSentence, acceptedSavedText, acceptRiskFormErrors, characterCount, charCount, dueDateOf, KEPT_IN_FORM, TEXT_MAX,
} from '@/lib/findings/formRules';
import { OUTSIDE_ROLE_LABELS } from '@/lib/findings/labels';
import { OUTSIDE_ROLES, type Decider, type FieldError, type OutsideRole } from '@/types/record';
import type { UserRef } from '@/types/api';

export type AcceptRiskFormProps = {
  orgSlug: string; projectId: string; findingId: string; members: UserRef[]; viewer: { userId: string; name: string };
  mode: 'accept' | 'keep_accepted';
};

const encode = (d: Decider): string => (d.kind === 'member' ? `member:${d.userId}` : `outside:${d.role}`);
const decode = (v: string): Decider | null => {
  if (v.startsWith('member:')) return { kind: 'member', userId: v.slice(7) };
  const role = v.slice(8);
  return v.startsWith('outside:') && (OUTSIDE_ROLES as readonly string[]).includes(role) ? { kind: 'outside_role', role: role as OutsideRole } : null;
};

/**
 * "Accept the risk" (W-6; FR-FND-05, UX-17): who accepted it and why, with an optional date to look at it again, and the
 * sentence the finding will show, above the buttons. Only owners and admins are given this form (the page does not render it
 * for anyone else; the route re-checks). `mode: 'keep_accepted'` is "Looked at again: keep accepted" for an accepted risk whose
 * date has come: it also asks what was looked at. Posts route 8 with a request id kept for Retry.
 */
export function AcceptRiskForm(p: AcceptRiskFormProps): ReactElement {
  const router = useRouter();
  const id = `accept-${useId().replace(/:/g, '')}`;
  const [choice, setChoice] = useState('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [again, setAgain] = useState({ day: '', month: '', year: '' });
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [attempt, setAttempt] = useState(0);
  const [done, setDone] = useState('');
  const [open, setOpen] = useState(p.mode === 'accept');
  const keep = p.mode === 'keep_accepted';
  const w = useFindingWrite(`/api/v1/orgs/${encodeURIComponent(p.orgSlug)}/projects/${encodeURIComponent(p.projectId)}/findings/${encodeURIComponent(p.findingId)}/accepted-risks`, KEPT_IN_FORM);
  const names = new Map([[p.viewer.userId, p.viewer.name], ...p.members.map((m) => [m.userId, m.name] as const)]);
  const decider = decode(choice);
  const err = (f: string) => errors.find((e) => e.field === f)?.message ?? w.failure?.fields.find((e) => e.field === f)?.message ?? null;
  const all = [...errors, ...(w.failure?.fields ?? [])];
  const edit = (fn: () => void) => { fn(); setErrors([]); };

  const submit = async () => {
    const problems = acceptRiskFormErrors({ acceptedBy: decider, reason, lookAgain: again, note, requireNote: keep });
    setErrors(problems); setAttempt((n) => n + 1);
    if (problems.length > 0 || decider === null) return;
    const sent = await w.send({
      mode: p.mode, acceptedBy: decider, reason: reason.trim(), lookAgainOn: dueDateOf(again), lookAgainNote: charCount(note) > 0 ? note.trim() : null,
    });
    if (sent === null) return;
    setDone(acceptedSavedText(decider, names));
    router.refresh();
  };

  if (!open) return <button type="button" className="btn btn--secondary" onClick={() => setOpen(true)}>Looked at again: keep accepted</button>;
  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate aria-labelledby={`${id}-h`}>
      <h3 id={`${id}-h`}>{keep ? 'Looked at again' : 'Accept the risk'}</h3>
      <p>Accepting a risk closes this finding without a mitigation. It records who accepted the risk and why. It can be reopened later.</p>
      <ErrorSummary summary={all.length === 1 ? 'There is a problem with this acceptance. What you typed is kept.' : `There are ${all.length} problems with this acceptance. What you typed is kept.`} errors={all} focusKey={attempt} prefix={`${id}-`} />
      <Field id={`${id}-acceptedBy`} label="Accepted by (required)" error={err('acceptedBy')} render={(a) => (
        <select {...a} name="acceptedBy" value={choice} onChange={(e) => edit(() => setChoice(e.target.value))}>
          <option value="">Choose who accepted the risk</option>
          <option value={encode({ kind: 'member', userId: p.viewer.userId })}>You ({p.viewer.name})</option>
          {p.members.filter((m) => m.userId !== p.viewer.userId).map((m) => <option key={m.userId} value={encode({ kind: 'member', userId: m.userId })}>{m.name}</option>)}
          <optgroup label="Outside roles">
            {OUTSIDE_ROLES.map((r) => <option key={r} value={encode({ kind: 'outside_role', role: r })}>{OUTSIDE_ROLE_LABELS[r]} (outside role)</option>)}
          </optgroup>
        </select>
      )} />
      <Field id={`${id}-reason`} label={keep ? 'Why the risk is still accepted (required)' : 'Why the risk is accepted (required)'} error={err('reason')}
        help="Say why, and where the acceptance is recorded (for example, committee minutes)."
        render={(a) => <textarea {...a} name="reason" rows={4} value={reason} onChange={(e) => edit(() => setReason(e.target.value))} />} />
      <p className="text-muted">{characterCount(charCount(reason), TEXT_MAX)}</p>
      {keep ? (
        <Field id={`${id}-lookAgainNote`} label="What was looked at again (required)" error={err('lookAgainNote')}
          render={(a) => <textarea {...a} name="lookAgainNote" rows={2} value={note} onChange={(e) => edit(() => setNote(e.target.value))} />} />
      ) : null}
      <fieldset id={`${id}-lookAgainOn`} aria-describedby={err('lookAgainOn') ? `${id}-date-error` : undefined}>
        <legend>Look at it again on (optional)</legend>
        {([['day', 'Day', 2], ['month', 'Month', 2], ['year', 'Year', 4]] as const).map(([part, label, size]) => (
          <span key={part}>
            <label htmlFor={`${id}-${part}`}>{label}</label>{' '}
            <input id={`${id}-${part}`} name={part} type="text" inputMode="numeric" size={size + 1} maxLength={size} value={again[part]}
              aria-invalid={err('lookAgainOn') ? true : undefined} onChange={(e) => edit(() => setAgain({ ...again, [part]: e.target.value }))} />{' '}
          </span>
        ))}
        {err('lookAgainOn') ? <p id={`${id}-date-error`} className="form-error">{err('lookAgainOn')}</p> : null}
      </fieldset>
      <p>{acceptedLabelSentence(decider, names)}</p>
      <div className="form-actions">
        <button type="submit" className="btn btn--primary" disabled={w.phase !== 'idle'}>{keep ? 'Looked at again: keep accepted' : 'Accept the risk'}</button>
        {keep ? <button type="button" className="btn btn--secondary" onClick={() => setOpen(false)}>Cancel</button> : null}
      </div>
      {w.failure !== null && w.failure.fields.length === 0 ? <p role="alert">{w.failure.text}</p> : null}
      <StatusLine>{w.phase === 'saving' ? 'Saving...' : w.phase === 'slow' ? 'Still saving. The connection is slow. What you typed is still in the form.' : done}</StatusLine>
    </form>
  );
}
