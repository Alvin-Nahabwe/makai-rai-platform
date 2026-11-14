'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import type { OrgRole } from '@prisma/client';
import { can } from '@/lib/authz/policy';
import { ALL_ORG_ROLES } from '@/lib/authz/roles';
import { validateEmail } from '@/lib/validate';
import { formatDay } from '@/lib/format/dates';
import { useHydrated } from '@/lib/client/useHydrated';
import { requestIdFor, sendWrite, type RetryState, type SendOutcome } from '@/lib/client/retrySafeWrite';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Definition, Term } from '@/components/ui/Definition';
import { Icon } from '@/components/ui/Icon';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { NEAREST_INSTANT } from '@/components/ui/revealInView';
import { Select } from '@/components/ui/Select';
import { Table } from '@/components/ui/Table';
import { TextInput } from '@/components/ui/TextInput';
import { CopyLinkFallback } from '@/components/invitations/CopyLinkFallback';
import { COPY_LINK_COPY } from '@/lib/invitations/link/copy';
import { MEMBERS_COPY, type MemberRoleWords } from '@/lib/org/members/copy';
import type { InvitationView, InviteMemberResponse, MemberView } from '@/types/api';
import './MembersManager.css';
// The kit's styles entries for the native elements below that wear kit classes (rulings X-6, X-7).
import '@/components/ui/formStyles';
import '@/components/ui/selectStyles';
import '@/components/ui/buttonStyles';

const C = MEMBERS_COPY;

interface Props {
  slug: string;
  currentUserId: string;
  currentRole: OrgRole;
  members: MemberView[];
  /** Pending invitations; the page gives an empty list to a role without `member:invite` (obligation M10). */
  invitations: InvitationView[];
  /** The five roles' words, from the server's one map (ruling L5-9): words only, never a decision. */
  roleWords: MemberRoleWords;
}

/** What the person is being asked to confirm, if anything: one inline confirmation open at a time. */
type Confirming = { kind: 'remove' | 'revoke' | 'leave'; id: string } | null;
/** The last invitation created or resent, with what the server returned for it (a replay shows no box). */
type Issued = { response: InviteMemberResponse } | null;
/** The six writes, each with its own sentence when the reply is lost (defect 39; answer Q1). */
type Action = 'invite' | 'resend' | 'cancel' | 'role' | 'remove' | 'leave';

// The classes of the kit's parts on native elements that need an attribute the kit's component does not take (ruling
// T19-j): their rules arrive with the kit modules this file imports (Button, Select, Checkbox; ruling X-6).
const ROW_BUTTON = 'ui-button ui-button--secondary ui-button--compact';

/**
 * The sentence after an invite or a resend went through (201): sent, or the email-failed sentence true of the screen
 * (answer Q21): with the link shown, send it another way; with none, the copy-link box's button, by its name.
 */
export function invitedWords(response: InviteMemberResponse): string {
  if (response.emailSent) return C.sent(response.invitation.email);
  return response.acceptUrl !== null ? COPY_LINK_COPY.emailFailed : COPY_LINK_COPY.emailFailedNoLink;
}

/**
 * S-22, Members (FR-MEM-01 to FR-MEM-05). Every write goes through `sendWrite` with a request id from
 * `requestIdFor`, one `RetryState` per action and target: a retry of an unchanged request sends the same id, a
 * changed one a new id (UX-27, NFR-INT-02). Hiding a control a role may not use is a courtesy; each route checks
 * the role again (lib/authz/policy.ts).
 *
 * Focus (ruling X-4, register D-398 items 3 and 9): a confirmation opens on its first button (Cancel, or "Keep
 * invitation"); cancelling gives focus back to the control that opened it; its confirm button is the kit's
 * destructive one and is busy, keeping focus, while its own request is sent. After a result the status line takes
 * focus. The in-flight guard (`idle`) stays as the second line of defence against a second press.
 */
export default function MembersManager({ slug, currentUserId, currentRole, members: initialMembers, invitations: initialInvitations, roleWords }: Props): ReactElement {
  const [members, setMembers] = useState(initialMembers);
  const [invitations, setInvitations] = useState(initialInvitations);
  const [message, setMessage] = useState('');
  /** The key of the write in flight (see `write`), so only the control that sent it shows busy. */
  const [pressed, setPressed] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [issued, setIssued] = useState<Issued>(null);
  const [roleDraft, setRoleDraft] = useState<Record<string, OrgRole>>({});
  const [showLinkFor, setShowLinkFor] = useState<Record<string, boolean>>({});
  const retry = useRef(new Map<string, RetryState>());
  const statusRef = useRef<HTMLDivElement>(null);
  const linkBoxRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const confirmBox = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);

  const base = `/api/v1/orgs/${slug}`;
  const canInvite = can(currentRole, 'member:invite');
  const busy = pressed !== null;
  const term = (role: OrgRole) => roleWords[role].entry.term;
  const ownName = members.find((m) => m.userId === currentUserId)?.name ?? C.leave.thisMember;

  // X-4: a confirmation has no field, so focus goes to its first button when it opens.
  useEffect(() => {
    if (confirming !== null) confirmBox.current?.querySelector<HTMLButtonElement>('.ui-confirm__actions button')?.focus();
  }, [confirming]);

  /** One write: the same request id for an unchanged retry of `key`, a new one when the body changed, none kept after it was saved. */
  async function write<T>(key: string, url: string, method: 'POST' | 'PATCH' | 'DELETE', body: Record<string, unknown>): Promise<SendOutcome<T>> {
    const { requestId, state } = requestIdFor(retry.current.get(key) ?? { requestId: null, sentBody: null }, body);
    retry.current.set(key, state);
    inFlight.current = true;
    setPressed(key);
    try {
      const out = await sendWrite<T>(url, method, { ...body, requestId }, { onSlow: () => setMessage(C.stillSaving) });
      if (out.kind === 'saved') retry.current.delete(key);
      return out;
    } finally {
      inFlight.current = false;
      setPressed(null);
    }
  }

  /** The sentence for a write that did not succeed. `name` is the member a removal or role change was about. */
  function refusal(out: Exclude<SendOutcome<unknown>, { kind: 'saved' }>, action: Action, name = ''): string {
    if (out.kind === 'not_saved') return action === 'remove' ? C.lostReply.remove(name) : C.lostReply[action];
    if (out.status === 401) return C.refusals.signedOut;                                                      // M-08
    if (out.status >= 500) return C.refusals.serverProblem;                                                   // M-07
    switch (out.body.code) {
      case 'last_active_owner': return action === 'leave' ? C.refusals.lastOwnerLeaving : C.refusals.lastOwner(name);
      case 'rate_limited': return C.refusals.rateLimited;
      case 'forbidden': return C.refusals.forbidden;
      case 'not_found': return C.refusals.notFound;
      case 'already_member': return C.refusals.alreadyMember;
      case 'invitation_not_pending': return C.refusals.notPending;
      default: return C.refusals.other;
    }
  }

  /** While a write runs the row controls stay focusable (aria-disabled) and a press is ignored, so the pressed control keeps focus (2.4.3). */
  const idle = () => !inFlight.current;
  /** The row or box that held focus is gone: the result takes it. */
  const focusResult = () => { setTimeout(() => statusRef.current?.focus(), 0); };
  /**
   * After the answer to Invite or Resend (workshop walk finding S6): the status line takes focus, and it and the copy-link
   * box under it, when one is shown, are brought wholly into view. The form and the invitation rows sit far below them, so a
   * plain focus() left the box off the screen. Focus is moved without the browser's own scroll; then the box and the status
   * line are each brought in by the shortest instant scroll (components/ui/revealInView.ts), the box first, so that both end
   * in view together. It runs in a layout effect of the render that drew the answer, so the box a first invitation brings
   * is already in the page; the count only says that a new answer has arrived.
   */
  const [answers, setAnswers] = useState(0);
  const revealResult = () => setAnswers((n) => n + 1);
  useLayoutEffect(() => {
    const status = statusRef.current;
    if (answers === 0 || status === null) return;   // no answer yet; the status line is always drawn while mounted
    status.focus({ preventScroll: true });
    linkBoxRef.current?.scrollIntoView(NEAREST_INSTANT);
    status.scrollIntoView(NEAREST_INSTANT);
  }, [answers]);
  /** Opens an inline confirmation, remembering the control to return to on Cancel. */
  function openConfirm(c: NonNullable<Confirming>, opener: HTMLElement): void {
    if (!idle()) return;
    openerRef.current = opener;
    setConfirming(c);
  }
  function cancelConfirm(): void {
    setConfirming(null);
    const opener = openerRef.current;
    setTimeout(() => opener?.focus(), 0);
  }

  async function invite(email: string, role: OrgRole, showLink: boolean): Promise<boolean> {
    if (!idle()) return false;
    setMessage('');
    const out = await write<InviteMemberResponse>('invite', `${base}/members`, 'POST', { email, role, showLink });
    revealResult();                                 // the answer, of either kind, is at the top of the page and the form at its foot
    if (out.kind !== 'saved') { setMessage(refusal(out, 'invite')); return false; }
    received('invite', out.status, out.body);
    return true;
  }

  /** Shows an invite or resend answer: 201 is new, 200 is a replay (owner default B32). */
  function received(action: 'invite' | 'resend', status: number, response: InviteMemberResponse, replacing?: string): void {
    // A replay can describe an invitation that has since been cancelled, used or has expired: only a pending one is listed.
    setInvitations((list) => [...list.filter((i) => i.id !== replacing && i.id !== response.invitation.id), ...(response.invitation.state === 'pending' ? [response.invitation] : [])]);
    if (status === 200) {
      setIssued(null);
      setMessage(C.replayed[action]);
      return;
    }
    setIssued({ response });
    setMessage(invitedWords(response));
  }

  async function resend(inv: InvitationView, showLink: boolean): Promise<void> {
    if (!idle()) return;
    setMessage('');
    const out = await write<InviteMemberResponse>(`resend:${inv.id}`, `${base}/invitations/${inv.id}/resend`, 'POST', { showLink });
    if (out.kind !== 'saved') { setMessage(refusal(out, 'resend')); return; }
    received('resend', out.status, out.body, inv.id);
    revealResult();
  }

  async function revoke(inv: InvitationView): Promise<void> {
    if (!idle()) return;
    setMessage('');
    const out = await write<undefined>(`revoke:${inv.id}`, `${base}/invitations/${inv.id}/revoke`, 'POST', {});
    setConfirming(null);
    focusResult();                                  // the confirmation held focus and is gone, saved or not
    if (out.kind !== 'saved') { setMessage(refusal(out, 'cancel')); return; }
    setInvitations((list) => list.filter((i) => i.id !== inv.id));
    setIssued((x) => (x?.response.invitation.id === inv.id ? null : x));   // its link no longer works: do not leave it on show
    setMessage(C.cancelled(inv.email));
  }

  async function changeRole(m: MemberView, role: OrgRole): Promise<void> {
    if (!idle()) return;
    setMessage('');
    const out = await write<undefined>(`role:${m.userId}`, `${base}/members/${m.userId}`, 'PATCH', { role });
    if (out.kind !== 'saved') { setMessage(refusal(out, 'role', m.name)); return; }
    setMembers((list) => list.map((x) => (x.userId === m.userId ? { ...x, role } : x)));
    setMessage(C.roleChanged(m.name, roleWords[role].withArticle));
    focusResult();
  }

  async function remove(m: MemberView): Promise<void> {
    if (!idle()) return;
    setMessage('');
    const out = await write<undefined>(`remove:${m.userId}`, `${base}/members/${m.userId}`, 'DELETE', {});
    setConfirming(null);
    focusResult();                                  // the confirmation held focus and is gone, saved or not
    if (out.kind !== 'saved') { setMessage(refusal(out, 'remove', m.name)); return; }
    setMembers((list) => list.filter((x) => x.userId !== m.userId));
    setMessage(C.removed(m.name));
  }

  async function leave(): Promise<void> {
    if (!idle()) return;
    setMessage('');
    const out = await write<undefined>('leave', `${base}/members/leave`, 'POST', {});
    setConfirming(null);
    focusResult();                                  // the confirmation held focus and is gone, saved or not
    if (out.kind !== 'saved') { setMessage(refusal(out, 'leave')); return; }
    // A full navigation, deliberately, not router.push(): the person's membership set has changed, so the org
    // switcher, the sidebar and the dispatch at '/' must be recomputed, and a client-side push can serve them
    // from the router cache and show an organisation they have left.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign('/');
  }

  const mayChangeRole = (m: MemberView) => can(currentRole, 'member:role') && (m.role !== 'owner' || can(currentRole, 'member:revoke_owner'));
  const mayRemove = (m: MemberView) => can(currentRole, 'member:remove') && m.userId !== currentUserId
    && (m.role !== 'owner' || can(currentRole, 'member:revoke_owner'));
  const settableRoles = ALL_ORG_ROLES.filter((r) => r !== 'owner' || can(currentRole, 'member:grant_owner'));

  const memberRows = members.map((m) => ({
    key: m.userId,
    cells: {
      name: <>{m.name}{m.userId === currentUserId ? C.members.you : ''}{m.createdFromShownLink && <span className="members-muted">{C.members.copiedLink}</span>}</>,
      role: mayChangeRole(m) ? (
        <div className="ui-select__wrap members-role">
          <select
            className="ui-select"
            aria-label={C.members.roleFor(m.name)}
            value={roleDraft[m.userId] ?? m.role}
            aria-disabled={busy || undefined}
            onChange={(e) => setRoleDraft((d) => ({ ...d, [m.userId]: e.target.value as OrgRole }))}
          >
            {ALL_ORG_ROLES.filter((r) => settableRoles.includes(r) || r === m.role).map((r) => <option key={r} value={r}>{term(r)}</option>)}
          </select>
          <span className="ui-select__icon"><Icon name="chevron-down" size={20} /></span>
        </div>
      ) : term(m.role),
      actions: (
        <>
          <div className="members-actions">
            {mayChangeRole(m) && (roleDraft[m.userId] ?? m.role) !== m.role && (
              <button type="button" className={ROW_BUTTON} aria-disabled={busy || undefined}
                aria-label={C.members.changeRoleFor(m.name)} onClick={() => { void changeRole(m, roleDraft[m.userId] ?? m.role); }}>
                {C.members.changeRole}
              </button>
            )}
            {mayRemove(m) && (
              <button type="button" className={ROW_BUTTON} aria-disabled={busy || undefined} aria-label={C.members.removeName(m.name)}
                onClick={(e) => openConfirm({ kind: 'remove', id: m.userId }, e.currentTarget)}>
                {C.members.remove}
              </button>
            )}
          </div>
          {confirming?.kind === 'remove' && confirming.id === m.userId && (
            <div ref={confirmBox}>
              <InlineConfirm
                objectName={m.name}
                consequence={C.members.removeConsequence}
                actionLabel={C.members.removeAction}
                destructive
                busy={pressed === `remove:${m.userId}`}
                onConfirm={() => remove(m)}
                onCancel={cancelConfirm}
              />
            </div>
          )}
        </>
      ),
    },
  }));

  const invitationRows = invitations.map((inv) => ({
    key: inv.id,
    cells: {
      email: <span className="members-email">{inv.email}</span>,
      role: term(inv.role),
      expires: formatDay(inv.expiresAt),
      actions: (
        <>
          <div className="members-actions">
            {(inv.role !== 'owner' || can(currentRole, 'member:grant_owner')) && (
              <>
                <div className="ui-checkbox">
                  <input type="checkbox" className="ui-checkbox__input" id={`show-link-${inv.id}`} aria-label={C.invitations.showLinkFor(inv.email)}
                    checked={showLinkFor[inv.id] ?? false} onChange={(e) => setShowLinkFor((s) => ({ ...s, [inv.id]: e.target.checked }))} />
                  <label className="ui-checkbox__label" htmlFor={`show-link-${inv.id}`}>{C.invitations.showLink}</label>
                </div>
                <button type="button" className={ROW_BUTTON} aria-disabled={busy || undefined}
                  aria-label={C.invitations.resendTo(inv.email)} onClick={() => { void resend(inv, showLinkFor[inv.id] ?? false); }}>
                  {C.invitations.resend}
                </button>
                <button type="button" className={ROW_BUTTON} aria-disabled={busy || undefined} aria-label={C.invitations.cancelTo(inv.email)}
                  onClick={(e) => openConfirm({ kind: 'revoke', id: inv.id }, e.currentTarget)}>
                  {C.invitations.cancel}
                </button>
              </>
            )}
          </div>
          {confirming?.kind === 'revoke' && confirming.id === inv.id && (
            <div ref={confirmBox}>
              <InlineConfirm
                objectName={C.invitations.confirmObject(inv.email)}
                consequence={C.invitations.consequence}
                actionLabel={C.invitations.confirmAction}
                cancelLabel={C.invitations.keep}
                destructive
                busy={pressed === `revoke:${inv.id}`}
                onConfirm={() => revoke(inv)}
                onCancel={cancelConfirm}
              />
            </div>
          )}
        </>
      ),
    },
  }));

  return (
    <div className="members">
      <div role="status" tabIndex={-1} ref={statusRef} className="ui-status">{message}</div>

      {issued !== null && (issued.response.acceptUrl !== null || !issued.response.emailSent) && (
        <CopyLinkFallback
          ref={linkBoxRef}
          key={issued.response.invitation.id}
          noticeShownElsewhere
          acceptUrl={issued.response.acceptUrl}
          expiresAt={issued.response.invitation.expiresAt}
          emailSent={issued.response.emailSent}
          onResendWithLink={() => { void resend(issued.response.invitation, true); }}
        />
      )}

      <Table caption={C.members.caption} rowHeaderKey="name" rows={memberRows}
        columns={[{ key: 'name', label: C.members.columns.name }, { key: 'role', label: C.members.columns.role }, { key: 'actions', label: C.members.columns.actions }]} />

      <div className="members-leave">
        <button type="button" className="ui-button ui-button--secondary" aria-disabled={busy || undefined}
          onClick={(e) => openConfirm({ kind: 'leave', id: currentUserId }, e.currentTarget)}>
          {C.leave.trigger}
        </button>
        {confirming?.kind === 'leave' && (
          <div ref={confirmBox}>
            <InlineConfirm
              objectName={ownName}
              consequence={C.leave.consequence}
              actionLabel={C.leave.action}
              destructive
              busy={pressed === 'leave'}
              onConfirm={leave}
              onCancel={cancelConfirm}
            />
          </div>
        )}
      </div>

      {canInvite && (
        <>
          <Table caption={C.invitations.caption} rowHeaderKey="email" rows={invitationRows} empty={C.invitations.none}
            columns={[
              { key: 'email', label: C.invitations.columns.email }, { key: 'role', label: C.invitations.columns.role },
              { key: 'expires', label: C.invitations.columns.expires }, { key: 'actions', label: C.invitations.columns.actions },
            ]} />
          <InviteForm roles={settableRoles} roleWords={roleWords} busy={pressed === 'invite'} unavailable={busy && pressed !== 'invite'} onInvite={invite} />
        </>
      )}
    </div>
  );
}

/**
 * The invite form. Its submit is busy while its own request is in flight, and disabled while another write is (ruling
 * L5-25: it does not look live while a press would be dropped) and until React has hydrated: its fields carry names, so
 * a native submit before then would post the address (fix round 1 of plan 1A Task 19; security review M1).
 */
function InviteForm({ roles, roleWords, busy, unavailable, onInvite }: {
  roles: readonly OrgRole[]; roleWords: MemberRoleWords; busy: boolean; unavailable: boolean;
  onInvite: (email: string, role: OrgRole, showLink: boolean) => Promise<boolean>;
}): ReactElement {
  const hydrated = useHydrated();
  // Fixed ids: there is one invite form on the page, and the e2e specs address its fields by them.
  const ids = { email: 'invite-email', role: 'invite-role', showLink: 'invite-showlink' };
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<OrgRole | ''>('');
  const [showLink, setShowLink] = useState(false);
  const [errors, setErrors] = useState<{ email?: string; role?: string }>({});
  const emailRef = useRef<HTMLInputElement>(null);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    const next: { email?: string; role?: string } = {};
    const emailProblem = validateEmail(email);
    if (emailProblem) next.email = emailProblem.message;
    if (role === '') next.role = C.invite.roleMissing;
    setErrors(next);
    if (next.email || next.role || role === '') {
      // A refused submit tells the person where: focus goes to the first field at fault (3.3.1). The kit's Select takes
      // no ref, so the role field is found by its fixed id.
      if (next.email) emailRef.current?.focus();
      else document.getElementById(ids.role)?.focus();
      return;
    }
    if (await onInvite(email.trim(), role, showLink)) setEmail('');
  }


  return (
    <form method="post" className="card members-invite" onSubmit={(e) => { void submit(e); }} noValidate>
      <h2>{C.invite.heading}</h2>
      <TextInput ref={emailRef} id={ids.email} name="email" type="email" label={C.invite.emailLabel} value={email}
        onChange={(e) => setEmail(e.target.value)} error={errors.email} />
      {/* Under the role select, each role the person can choose there with the vocabulary's definition beside its word
          (audit D OR28, answer Q11, ruling L5-22 as revised). The list is not the select's description (its error is),
          and the wrapper marks the field and the list as a role choice, so the first-use rule reads the role words
          inside it (lib/vocabulary/firstUse.ts). */}
      <div data-role-choice="">
        <Select id={ids.role} name="role" label={C.invite.roleLabel} placeholder={C.invite.rolePlaceholder}
          options={roles.map((r) => ({ value: r, label: roleWords[r].entry.term }))} value={role}
          onChange={(e) => setRole(e.target.value as OrgRole | '')} error={errors.role} />
        <ul className="members-roles">
          {roles.map((r) => (
            <li key={r}><Term of={roleWords[r].entry} /> <Definition of={roleWords[r].entry} /></li>
          ))}
        </ul>
      </div>
      <Checkbox id={ids.showLink} name="showLink" label={C.invite.showLink} hint={C.invite.showLinkHint} checked={showLink}
        onChange={(e) => setShowLink(e.target.checked)} />
      <Button variant="primary" type="submit" busy={busy} disabled={!hydrated || unavailable}>{C.invite.submit}</Button>
    </form>
  );
}
