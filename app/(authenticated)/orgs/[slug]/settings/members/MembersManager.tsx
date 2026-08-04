'use client';

import { useState } from 'react';
import type { OrgRole } from '@prisma/client';
import { can } from '@/lib/authz/policy';
import { ALL_ORG_ROLES } from '@/lib/authz/roles';

type MemberRow = { userId: string; role: OrgRole; name: string };

interface Props {
  slug: string;
  currentUserId: string;
  currentRole: OrgRole;
  initialMembers: MemberRow[];
}

/**
 * All mutation here is server-enforced independently — every button below
 * corresponds to an action already gated by `requireOrgContext`/`assertCan`
 * in the route it calls (lib/authz/policy.ts). Hiding a button when
 * `can(currentRole, action)` is false is a UX nicety, not the security
 * boundary; a hidden button reachable via devtools still 403s server-side.
 */
export default function MembersManager({ slug, currentUserId, currentRole, initialMembers }: Props) {
  const [members, setMembers] = useState(initialMembers);
  const [error, setError] = useState('');
  const [busyUserId, setBusyUserId] = useState<string | null>(null);

  /**
   * Called only AFTER a mutation's own response already reported success —
   * every caller below checks `res.ok` on the mutation itself first. So a
   * failure here means the write already landed server-side and only the
   * DISPLAY is stale; `setError` still reports it (rather than the earlier
   * silent no-op `silent-failure-hunter` flagged) because leaving the user
   * with no signal at all is indistinguishable from "nothing happened",
   * which is false and could prompt a confused retry of an action that
   * already succeeded.
   */
  async function refresh() {
    try {
      const res = await fetch(`/api/v1/orgs/${slug}/members`);
      if (!res.ok) {
        setError('Your last action was applied, but the list could not be refreshed. Reload the page to see the latest state.');
        return;
      }
      const data: { userId: string; role: OrgRole; user: { name: string } }[] = await res.json();
      setMembers(data.map((m) => ({ userId: m.userId, role: m.role, name: m.user.name })));
    } catch {
      setError('Your last action was applied, but the list could not be refreshed. Reload the page to see the latest state.');
    }
  }

  async function handleRemove(userId: string) {
    setError('');
    setBusyUserId(userId);
    try {
      const res = await fetch(`/api/v1/orgs/${slug}/members/${userId}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || 'Could not remove this member.');
        return;
      }
      await refresh();
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setBusyUserId(null);
    }
  }

  async function handleGrantOwner(userId: string) {
    setError('');
    setBusyUserId(userId);
    try {
      const res = await fetch(`/api/v1/orgs/${slug}/members/${userId}`, { method: 'PATCH' });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || 'Could not grant owner.');
        return;
      }
      await refresh();
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setBusyUserId(null);
    }
  }

  async function handleLeave() {
    setError('');
    setBusyUserId(currentUserId);
    try {
      const res = await fetch(`/api/v1/orgs/${slug}/members/leave`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Could not leave this organization.');
        return;
      }
      window.location.href = '/'; // membership just changed; re-derive via a full navigation
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setBusyUserId(null);
    }
  }

  return (
    <div>
      {error && <p className="form-error" role="alert">{error}</p>}

      <div className="admin-table-wrapper card" style={{ marginBottom: 'var(--space-4)' }}>
        <table className="admin-table">
          <thead>
            <tr><th>Name</th><th>Role</th><th></th></tr>
          </thead>
          <tbody>
            {members.map((m) => {
              const isSelf = m.userId === currentUserId;
              const busy = busyUserId === m.userId;
              const mayRemove =
                can(currentRole, 'member:remove') && (m.role !== 'owner' || can(currentRole, 'member:revoke_owner'));
              const mayGrantOwner = m.role !== 'owner' && can(currentRole, 'member:grant_owner');
              return (
                <tr key={m.userId}>
                  <td>{m.name}{isSelf ? ' (you)' : ''}</td>
                  <td><span className="badge">{m.role}</span></td>
                  <td style={{ display: 'flex', gap: 'var(--space-2)' }}>
                    {isSelf && (
                      <button type="button" className="btn btn--secondary" disabled={busy} onClick={handleLeave}>
                        Leave
                      </button>
                    )}
                    {!isSelf && mayGrantOwner && (
                      <button type="button" className="btn btn--secondary" disabled={busy}
                        onClick={() => handleGrantOwner(m.userId)}>
                        Make owner
                      </button>
                    )}
                    {!isSelf && mayRemove && (
                      <button type="button" className="btn btn--secondary" disabled={busy}
                        onClick={() => handleRemove(m.userId)}>
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {can(currentRole, 'member:invite') && (
        <InviteForm slug={slug} currentRole={currentRole} onInvited={refresh} />
      )}
    </div>
  );
}

function InviteForm({
  slug, currentRole, onInvited,
}: { slug: string; currentRole: OrgRole; onInvited: () => void }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<OrgRole>('assessor');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [acceptUrl, setAcceptUrl] = useState('');
  const [emailSent, setEmailSent] = useState(false);
  const [emailError, setEmailError] = useState('');

  // Property 3 mirrored client-side: an `admin` never even sees `owner` as
  // a selectable option. The server enforces this independently
  // (`createInvitation`, lib/data/members.ts) regardless of what this list
  // contains.
  const selectableRoles = ALL_ORG_ROLES.filter((r) => r !== 'owner' || can(currentRole, 'member:grant_owner'));

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setAcceptUrl('');
    setEmailSent(false);
    setEmailError('');
    setLoading(true);
    try {
      const res = await fetch(`/api/v1/orgs/${slug}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, role }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Could not send this invitation.');
        return;
      }
      setAcceptUrl(data.acceptUrl);
      // `emailSent`/`emailError` come straight from the route's own
      // best-knowledge report (app/api/v1/orgs/[slug]/members/route.ts) —
      // this is not a second attempt to detect delivery, only a display of
      // what the server already determined server-side.
      setEmailSent(Boolean(data.emailSent));
      setEmailError(data.emailSent ? '' : (data.emailError || 'The invitation email could not be sent.'));
      setEmail('');
      onInvited();
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card">
      <h2>Invite someone</h2>
      {error && <p className="form-error" role="alert">{error}</p>}
      {acceptUrl && emailSent && (
        <p className="auth-success" role="status">
          Invitation sent by email. If it does not arrive, or you need to share it another way,
          this one-time link also works:{' '}
          <a href={acceptUrl}>{acceptUrl}</a>
        </p>
      )}
      {acceptUrl && !emailSent && (
        <p className="form-error" role="alert">
          Invitation created, but the email could not be sent{emailError ? `: ${emailError}` : ''}.
          Share this one-time link directly instead:{' '}
          <a href={acceptUrl}>{acceptUrl}</a>
        </p>
      )}
      <form onSubmit={handleSubmit} style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'flex-end' }}>
        <div className="form-group">
          <label htmlFor="invite-email">Email</label>
          <input id="invite-email" type="email" required value={email}
            onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="form-group">
          <label htmlFor="invite-role">Role</label>
          <select id="invite-role" value={role} onChange={(e) => setRole(e.target.value as OrgRole)}>
            {selectableRoles.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <button type="submit" className="btn btn--primary" disabled={loading}>
          {loading ? 'Sending…' : 'Invite'}
        </button>
      </form>
    </div>
  );
}
