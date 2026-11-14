'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { DateBoxes, ErrorSummary, FailureText, Field, StatusLine, useFindingWrite } from '@/components/findings/FindingActions';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { FINDINGS_COPY } from '@/lib/findings/copy';
import {
  acceptedWho, acceptRiskFormErrors, characterCount, charCount, dueDateOf, KEPT_IN_FORM, TEXT_MAX,
} from '@/lib/findings/formRules';
import { OUTSIDE_ROLE_LABELS } from '@/lib/findings/labels';
import { OUTSIDE_ROLES, type Decider, type FieldError, type OutsideRole } from '@/types/record';
import type { UserRef } from '@/types/api';
import './Findings.css';

const AR = FINDINGS_COPY.acceptRisk;

export type AcceptRiskFormProps = {
  orgSlug: string; projectId: string; findingId: string; members: UserRef[]; viewer: { userId: string; name: string };
  mode: 'accept' | 'keep_accepted';
  /** Where the saved line goes, when the parent keeps it (it survives the form being remounted by the refresh). */
  onAccepted?: (text: ReactNode) => void;
};

/** UX-17: the label the finding will show, said above the button, with the accepter inside <bdi>; nothing while nothing is chosen. */
export function AcceptedSentence({ choice, names }: { choice: Decider | null; names: ReadonlyMap<string, string> }): ReactElement | null {
  return choice === null ? null : <>{AR.willShowStart}<bdi>{acceptedWho(choice, names)}</bdi>{AR.willShowEnd}</>;
}

/** 7.4.2 S-15 row with C#411's label: "Closed by an accepted risk (<who>)." with the accepter inside <bdi>. */
export function AcceptedSaved({ choice, names }: { choice: Decider; names: ReadonlyMap<string, string> }): ReactElement {
  return <>{AR.savedStart}<bdi>{acceptedWho(choice, names)}</bdi>{AR.savedEnd}</>;
}

const encode = (d: Decider): string => (d.kind === 'member' ? `member:${d.userId}` : `outside:${d.role}`);
const decode = (v: string): Decider | null => {
  if (v.startsWith('member:')) return { kind: 'member', userId: v.slice(7) };
  const role = v.slice(8);
  return v.startsWith('outside:') && (OUTSIDE_ROLES as readonly string[]).includes(role) ? { kind: 'outside_role', role: role as OutsideRole } : null;
};

/**
 * "Accept the risk" (W-6; FR-FND-05, UX-17): who accepted it and why, with an optional date to look at it again, and the
 * sentence the finding will show, above the buttons. Only Owners and Admins are given this form (the page does not render it
 * for anyone else; the route re-checks). `mode: 'keep_accepted'` is "Keep the risk accepted" for an accepted risk whose
 * date has come: it also asks what was checked. Posts route 8 with a request id kept for Retry. The summary is the legacy
 * one (`ErrorSummary` of FindingActions.tsx): a server answer can name a field this form does not show.
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
  const [done, setDone] = useState<ReactNode>('');
  const [open, setOpen] = useState(p.mode === 'accept');
  const keep = p.mode === 'keep_accepted';
  const trigger = useRef<HTMLButtonElement>(null);
  const pressed = useRef(false);
  // The form replaces "Keep the risk accepted": a press puts focus on its first field, "Accepted by" (ruling X-4).
  useEffect(() => {
    if (!open || !pressed.current) return;
    pressed.current = false;
    document.getElementById(`${id}-acceptedBy`)?.focus();
  }, [open, id]);
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
    const saved = <AcceptedSaved choice={decider} names={names} />;
    if (p.onAccepted) p.onAccepted(saved); else setDone(saved);
    router.refresh();
  };

  const reasonError = err('reason');
  const noteError = err('lookAgainNote');
  if (!open) return <Button variant="secondary" ref={trigger} onClick={() => { pressed.current = true; setOpen(true); }}>{AR.keepTrigger}</Button>;
  return (
    <form method="post" className="finding-form" onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate aria-labelledby={`${id}-h`}>
      <h3 id={`${id}-h`}>{keep ? AR.keepHeading : AR.heading}</h3>
      <p>{AR.intro}</p>
      <ErrorSummary summary={AR.summary(all.length)} errors={all} focusKey={attempt} prefix={`${id}-`} />
      <Select id={`${id}-acceptedBy`} name="acceptedBy" label={AR.acceptedBy} error={err('acceptedBy') ?? undefined} value={choice} placeholder={AR.choose}
        onChange={(e) => edit(() => setChoice(e.target.value))}
        options={[
          { value: encode({ kind: 'member', userId: p.viewer.userId }), label: AR.you(p.viewer.name) },
          ...p.members.filter((m) => m.userId !== p.viewer.userId).map((m) => ({ value: encode({ kind: 'member', userId: m.userId }), label: m.name })),
        ]}
        groups={[{ label: AR.outsideGroup, options: OUTSIDE_ROLES.map((r) => ({ value: encode({ kind: 'outside_role', role: r }), label: AR.outsideWho(OUTSIDE_ROLE_LABELS[r]) })) }]} />
      <Field id={`${id}-reason`} label={keep ? AR.reasonKeep : AR.reason} error={reasonError} help={AR.reasonHelp}
        render={(a) => <textarea {...a} className={reasonError ? 'ui-textarea ui-textarea--invalid' : 'ui-textarea'} name="reason" rows={4} value={reason} onChange={(e) => edit(() => setReason(e.target.value))} />}
        after={<p className="ui-count">{characterCount(charCount(reason), TEXT_MAX)}</p>} />
      {keep ? (
        <Field id={`${id}-lookAgainNote`} label={AR.note} error={noteError}
          render={(a) => <textarea {...a} className={noteError ? 'ui-textarea ui-textarea--invalid' : 'ui-textarea'} name="lookAgainNote" rows={2} value={note} onChange={(e) => edit(() => setNote(e.target.value))} />} />
      ) : null}
      <DateBoxes id={`${id}-lookAgainOn`} boxId={(part) => `${id}-${part}`} legend={AR.dateLegend} value={again}
        onChange={(part, v) => edit(() => setAgain({ ...again, [part]: v }))} error={err('lookAgainOn')} errorId={`${id}-date-error`} />
      <p><AcceptedSentence choice={decider} names={names} /></p>
      <div className="finding-actions">
        <Button variant="primary" type="submit" busy={w.phase !== 'idle'}>{keep ? AR.submitKeep : AR.submit}</Button>
        <Button variant="secondary" onClick={() => { if (keep) { setOpen(false); requestAnimationFrame(() => trigger.current?.focus()); } setChoice(''); setReason(''); setNote(''); setAgain({ day: '', month: '', year: '' }); setErrors([]); w.clearFailure(); }}>{AR.cancel}</Button>
      </div>
      {w.failure !== null && w.failure.fields.length === 0 ? <p role="alert" className="finding-alert"><FailureText text={w.failure.text} name={w.failure.nameInText} /></p> : null}
      <StatusLine>{w.phase === 'saving' ? AR.saving : w.phase === 'slow' ? AR.slow : done}</StatusLine>
    </form>
  );
}
