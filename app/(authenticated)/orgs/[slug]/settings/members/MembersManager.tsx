'use client';

import { useRef, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import type { OrgRole } from '@prisma/client';
import { can } from '@/lib/authz/policy';
import { ALL_ORG_ROLES } from '@/lib/authz/roles';
import { validateEmail } from '@/lib/validate';
import { formatDay } from '@/lib/format/dates';
import { requestIdFor, sendWrite, type RetryState, type SendOutcome } from '@/lib/client/retrySafeWrite';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { CopyLinkFallback } from '@/components/invitations/CopyLinkFallback';
import type { InvitationView, InviteMemberResponse, MemberView } from '@/types/api';

interface Props {
  slug: string;
  currentUserId: string;
  currentRole: OrgRole;
  members: MemberView[];
  /** Pending invitations; the page gives an empty list to a role without `member:invite` (obligation M10). */
  invitations: InvitationView[];
}

/** What the person is being asked to confirm, if anything: one inline confirmation open at a time. */
type Confirming = { kind: 'remove' | 'revoke' | 'leave'; id: string } | null;
/** The last invitation created or resent, with what the server returned for it (a replay shows no box). */
type Issued = { response: InviteMemberResponse } | null;

const STILL_SAVING = 'Still saving. The connection is slow.';
const NOT_SAVED_NETWORK = 'Not saved: connection lost. It may have arrived. Retry is safe: it will not repeat the action.';
const EMAIL_FAILED = 'The invitation email could not be sent. Send this link another way.';
const NOT_SAVED_TIMEOUT = 'Not saved: no reply from the server after 30 seconds. It may have arrived. Retry is safe: it will not repeat the action.';
const REPLAYED = 'This invitation was already created. If the email did not arrive, use Resend.';

/**
 * S-22, Members (FR-MEM-01 to FR-MEM-05). Every write goes through `sendWrite` with a request id from
 * `requestIdFor`, one `RetryState` per action and target: a retry of an unchanged request sends the same id, a
 * changed one a new id (UX-27, NFR-INT-02). Hiding a control a role may not use is a courtesy; each route checks
 * the role again (lib/authz/policy.ts).
 */
export default function MembersManager({ slug, currentUserId, currentRole, members: initialMembers, invitations: initialInvitations }: Props): ReactElement {
  const [members, setMembers] = useState(initialMembers);
  const [invitations, setInvitations] = useState(initialInvitations);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [issued, setIssued] = useState<Issued>(null);
  const [roleDraft, setRoleDraft] = useState<Record<string, OrgRole>>({});
  const [showLinkFor, setShowLinkFor] = useState<Record<string, boolean>>({});
  const retry = useRef(new Map<string, RetryState>());
  const statusRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const inFlight = useRef(false);

  const base = `/api/v1/orgs/${slug}`;
  const canInvite = can(currentRole, 'member:invite');
  const nameOf = (userId: string) => members.find((m) => m.userId === userId)?.name ?? 'This member';

  /** One write: the same request id for an unchanged retry of `key`, a new one when the body changed, none kept after it was saved. */
  async function write<T>(key: string, url: string, method: 'POST' | 'PATCH' | 'DELETE', body: Record<string, unknown>): Promise<SendOutcome<T>> {
    const { requestId, state } = requestIdFor(retry.current.get(key) ?? { requestId: null, sentBody: null }, body);
    retry.current.set(key, state);
    inFlight.current = true;
    setBusy(true);
    try {
      const out = await sendWrite<T>(url, method, { ...body, requestId }, { onSlow: () => setMessage(STILL_SAVING) });
      if (out.kind === 'saved') retry.current.delete(key);
      return out;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  /** The sentence for a write that did not succeed; the two refusals of the guard and the limit have their own. */
  function refusal(out: Exclude<SendOutcome<unknown>, { kind: 'saved' }>, lastOwnerName: string): string {
    if (out.kind === 'not_saved') return out.reason === 'timeout' ? NOT_SAVED_TIMEOUT : NOT_SAVED_NETWORK;
    switch (out.body.code) {
      case 'last_active_owner': return `${lastOwnerName} is the last owner. Make someone else an owner first.`;
      case 'rate_limited': return 'Too many invitations just now. Try again later.';
      case 'forbidden': return 'Not saved: your role in this organisation no longer allows this. Ask an owner or admin.';
      case 'not_found': return 'That member or invitation is no longer here. Reload the page.';
      case 'invitation_not_pending': return 'That invitation is no longer pending. Reload the page.';
      default: return 'Not saved. Reload the page and try again.';
    }
  }

  /** While a write runs the controls stay focusable (aria-disabled) and a press is ignored, so the pressed control keeps focus (2.4.3). */
  const idle = () => !inFlight.current;
  /** The row or box that held focus is gone: the result takes it. */
  const focusResult = () => { setTimeout(() => statusRef.current?.focus(), 0); };
  /** Opens an inline confirmation, remembering the control to return to on Cancel. */
  function openConfirm(c: NonNullable<Confirming>, opener: HTMLElement): void {
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
    if (out.kind !== 'saved') { setMessage(refusal(out, '')); return false; }
    return received(out.status, out.body);
  }

  /** Shows an invite or resend answer: 201 is new, 200 is a replay (owner default B32). */
  function received(status: number, response: InviteMemberResponse, replacing?: string): boolean {
    setInvitations((list) => [...list.filter((i) => i.id !== replacing && i.id !== response.invitation.id), response.invitation]);
    if (status === 200) {
      setIssued(null);
      setMessage(REPLAYED);
      return true;
    }
    setIssued({ response });
    setMessage(response.emailSent ? `Invitation sent to ${response.invitation.email}.` : EMAIL_FAILED);
    return true;
  }

  async function resend(inv: InvitationView, showLink: boolean): Promise<void> {
    if (!idle()) return;
    setMessage('');
    const out = await write<InviteMemberResponse>(`resend:${inv.id}`, `${base}/invitations/${inv.id}/resend`, 'POST', { showLink });
    if (out.kind !== 'saved') { setMessage(refusal(out, '')); return; }
    received(out.status, out.body, inv.id);
    focusResult();
  }

  async function revoke(inv: InvitationView): Promise<void> {
    if (!idle()) return;
    setMessage('');
    const out = await write<undefined>(`revoke:${inv.id}`, `${base}/invitations/${inv.id}/revoke`, 'POST', {});
    setConfirming(null);
    if (out.kind !== 'saved') { setMessage(refusal(out, '')); return; }
    setInvitations((list) => list.filter((i) => i.id !== inv.id));
    setMessage(`Invitation for ${inv.email} revoked.`);
    focusResult();
  }

  async function changeRole(m: MemberView, role: OrgRole): Promise<void> {
    if (!idle()) return;
    setMessage('');
    const out = await write<undefined>(`role:${m.userId}`, `${base}/members/${m.userId}`, 'PATCH', { role });
    if (out.kind !== 'saved') { setMessage(refusal(out, m.name)); return; }
    setMembers((list) => list.map((x) => (x.userId === m.userId ? { ...x, role } : x)));
    setMessage(`Role changed to ${role}. It applies from their next action.`);
    focusResult();
  }

  async function remove(m: MemberView): Promise<void> {
    if (!idle()) return;
    setMessage('');
    const out = await write<undefined>(`remove:${m.userId}`, `${base}/members/${m.userId}`, 'DELETE', {});
    setConfirming(null);
    if (out.kind !== 'saved') { setMessage(refusal(out, m.name)); return; }
    setMembers((list) => list.filter((x) => x.userId !== m.userId));
    setMessage(`${m.name} was removed.`);
    focusResult();
  }

  async function leave(): Promise<void> {
    if (!idle()) return;
    setMessage('');
    const out = await write<undefined>('leave', `${base}/members/leave`, 'POST', {});
    setConfirming(null);
    if (out.kind !== 'saved') { setMessage(refusal(out, nameOf(currentUserId))); return; }
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

  return (
    <div>
      <div role="status" tabIndex={-1} ref={statusRef} className="form-hint">{message}</div>

      {issued !== null && (
        <CopyLinkFallback
          key={issued.response.invitation.id}
          noticeShownElsewhere
          acceptUrl={issued.response.acceptUrl}
          expiresAt={issued.response.invitation.expiresAt}
          emailSent={issued.response.emailSent}
          onResendWithLink={() => { void resend(issued.response.invitation, true); }}
        />
      )}

      <div className="admin-table-wrapper card" style={{ marginBottom: 'var(--space-4)' }}>
        <table className="admin-table">
          <caption>Members</caption>
          <thead>
            <tr><th scope="col">Name</th><th scope="col">Role</th><th scope="col">Actions</th></tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.userId}>
                <td>
                  {m.name}{m.userId === currentUserId ? ' (you)' : ''}
                  {m.createdFromShownLink && <span className="text-muted"> account created from a copied link</span>}
                </td>
                <td>
                  {mayChangeRole(m) ? (
                    <select
                      aria-label={`Role for ${m.name}`}
                      value={roleDraft[m.userId] ?? m.role}
                      aria-disabled={busy || undefined}
                      onChange={(e) => setRoleDraft((d) => ({ ...d, [m.userId]: e.target.value as OrgRole }))}
                    >
                      {ALL_ORG_ROLES.filter((r) => settableRoles.includes(r) || r === m.role).map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  ) : (
                    <span className="badge">{m.role}</span>
                  )}
                </td>
                <td>
                  <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                    {mayChangeRole(m) && (roleDraft[m.userId] ?? m.role) !== m.role && (
                      <button type="button" className="btn btn--secondary" aria-disabled={busy || undefined} aria-label={`Change role for ${m.name}`}
                        onClick={() => { void changeRole(m, roleDraft[m.userId] ?? m.role); }}>
                        Change role
                      </button>
                    )}
                    {mayRemove(m) && (
                      <button type="button" className="btn btn--secondary" aria-disabled={busy || undefined} aria-label={`Remove ${m.name}`}
                        onClick={(e) => openConfirm({ kind: 'remove', id: m.userId }, e.currentTarget)}>
                        Remove
                      </button>
                    )}
                  </div>
                  {confirming?.kind === 'remove' && confirming.id === m.userId && (
                    <InlineConfirm
                      objectName={m.name}
                      consequence="They lose access to this organisation at once. What they entered stays in its records."
                      actionLabel="Remove member"
                      busy={busy}
                      onConfirm={() => remove(m)}
                      onCancel={cancelConfirm}
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={3}>
                <button type="button" className="btn btn--secondary" aria-disabled={busy || undefined}
                  onClick={(e) => openConfirm({ kind: 'leave', id: currentUserId }, e.currentTarget)}>
                  Leave this organisation
                </button>
                {confirming?.kind === 'leave' && (
                  <InlineConfirm
                    objectName={nameOf(currentUserId)}
                    consequence="You lose access to this organisation. An owner or admin can invite you again."
                    actionLabel="Leave organisation"
                    busy={busy}
                    onConfirm={leave}
                    onCancel={cancelConfirm}
                  />
                )}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      {canInvite && (
        <>
          <div className="admin-table-wrapper card" style={{ marginBottom: 'var(--space-4)' }}>
            <table className="admin-table">
              <caption>Pending invitations</caption>
              <thead>
                <tr><th scope="col">Email</th><th scope="col">Role</th><th scope="col">Expires</th><th scope="col">Actions</th></tr>
              </thead>
              <tbody>
                {invitations.length === 0 && <tr><td colSpan={4}>No pending invitations.</td></tr>}
                {invitations.map((inv) => (
                  <tr key={inv.id}>
                    <td>{inv.email}</td>
                    <td><span className="badge">{inv.role}</span></td>
                    <td>{formatDay(inv.expiresAt)}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
                        {(inv.role !== 'owner' || can(currentRole, 'member:grant_owner')) && (
                          <>
                            <label>
                              <input type="checkbox" aria-label={`Show link when resending to ${inv.email}`} checked={showLinkFor[inv.id] ?? false}
                                onChange={(e) => setShowLinkFor((s) => ({ ...s, [inv.id]: e.target.checked }))} />
                              {' '}Show link
                            </label>
                            <button type="button" className="btn btn--secondary" aria-disabled={busy || undefined} aria-label={`Resend invitation to ${inv.email}`}
                              onClick={() => { void resend(inv, showLinkFor[inv.id] ?? false); }}>
                              Resend
                            </button>
                            <button type="button" className="btn btn--secondary" aria-disabled={busy || undefined} aria-label={`Revoke invitation for ${inv.email}`}
                              onClick={(e) => openConfirm({ kind: 'revoke', id: inv.id }, e.currentTarget)}>
                              Revoke
                            </button>
                          </>
                        )}
                      </div>
                      {confirming?.kind === 'revoke' && confirming.id === inv.id && (
                        <InlineConfirm
                          objectName={`Invitation for ${inv.email}`}
                          consequence="Its link stops working at once."
                          actionLabel="Revoke invitation"
                          busy={busy}
                          onConfirm={() => revoke(inv)}
                          onCancel={cancelConfirm}
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <InviteForm roles={settableRoles} busy={busy} onInvite={invite} />
        </>
      )}
    </div>
  );
}

function InviteForm({ roles, busy, onInvite }: {
  roles: readonly OrgRole[]; busy: boolean; onInvite: (email: string, role: OrgRole, showLink: boolean) => Promise<boolean>;
}): ReactElement {
  // Fixed ids: there is one invite form on the page, and the e2e specs address its fields by them.
  const ids = { email: 'invite-email', role: 'invite-role', emailError: 'invite-email-error', roleError: 'invite-role-error' };
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<OrgRole | ''>('');
  const [showLink, setShowLink] = useState(false);
  const [errors, setErrors] = useState<{ email?: string; role?: string }>({});
  const emailRef = useRef<HTMLInputElement>(null);
  const roleRef = useRef<HTMLSelectElement>(null);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    const next: { email?: string; role?: string } = {};
    const emailProblem = validateEmail(email);
    if (emailProblem) next.email = emailProblem.message;
    if (role === '') next.role = 'Choose a role.';
    setErrors(next);
    if (next.email || next.role || role === '') {
      // A refused submit tells the person where: focus goes to the first field at fault (3.3.1).
      (next.email ? emailRef : roleRef).current?.focus();
      return;
    }
    if (await onInvite(email.trim(), role, showLink)) setEmail('');
  }

  return (
    <form className="card" onSubmit={(e) => { void submit(e); }} noValidate>
      <h2>Invite someone</h2>
      <div className="form-group">
        <label htmlFor={ids.email}>Email</label>
        <input id={ids.email} ref={emailRef} type="email" value={email} onChange={(e) => setEmail(e.target.value)}
          aria-invalid={errors.email ? true : undefined} aria-describedby={errors.email ? ids.emailError : undefined} />
        {errors.email && <p id={ids.emailError} className="form-error">{errors.email}</p>}
      </div>
      <div className="form-group">
        <label htmlFor={ids.role}>Role</label>
        <select id={ids.role} ref={roleRef} value={role} onChange={(e) => setRole(e.target.value as OrgRole | '')}
          aria-invalid={errors.role ? true : undefined} aria-describedby={errors.role ? ids.roleError : undefined}>
          <option value="">Choose a role</option>
          {roles.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        {errors.role && <p id={ids.roleError} className="form-error">{errors.role}</p>}
      </div>
      <div className="form-group">
        <label><input type="checkbox" checked={showLink} onChange={(e) => setShowLink(e.target.checked)} /> Show link</label>
      </div>
      <button type="submit" className="btn btn--primary" aria-disabled={busy || undefined}>Invite</button>
    </form>
  );
}
