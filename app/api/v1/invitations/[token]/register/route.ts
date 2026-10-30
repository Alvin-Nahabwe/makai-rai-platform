import { NextRequest, NextResponse } from 'next/server';
import { hash } from 'bcryptjs';
import { identityDb } from '@/lib/data/identity';
import { hashInvitationToken } from '@/lib/data/invitationToken';
import { invitationByToken, membershipsForUser, registerFromInvitation } from '@/lib/data/preauth';
import { uniqueViolationIndex } from '@/lib/data/pgErrors';
import { accountCreatedEmail } from '@/lib/email/templates/accountCreated';
import { sendEmail } from '@/lib/email/send';
import { AppError, ValidationFailed } from '@/lib/http/errors';
import { assertSameOrigin } from '@/lib/http/sameOrigin';
import { toResponse } from '@/lib/http/toResponse';
import { LEGAL_KIND_NAMES } from '@/lib/legal/kinds';
import { logSecurityEvent } from '@/lib/security-logger';
import { collectErrors, validatePassword, validateString } from '@/lib/validate';
import { ACCEPTED_KINDS, type AcceptedKind } from '@/types/legal';

/** M-23 (SRS 7.5.7): one text for every unusable invitation, so the answer reveals nothing about the token. */
const M23 = 'This invitation link does not work. It may have expired, been used, or been replaced by a newer one. Ask the person who invited you to send it again.';

const unusable = () => new AppError(410, 'invitation_unusable', M23);
const accountExists = () => new AppError(409, 'account_exists', 'An account with this email already exists. Sign in to accept.');
const m25 = (kind: AcceptedKind) => `To continue, accept the ${LEGAL_KIND_NAMES[kind]}.`;

/**
 * Contract route row 31 (FR-ACC-01, FR-ACC-03, FR-ACC-10): creates an account for the holder of a
 * pending, unexpired invitation, with its three acceptances and its membership in one transaction
 * (`registerFromInvitation`), then emails E-06 to the invited address. 201 `{ orgSlug }`.
 *
 * Order: the origin check; the invitation by its token (410 M-23 for every unusable case, before
 * any password is hashed, so a bogus token costs no bcrypt work); name and password (422); the
 * three acceptances (422 naming the first missing, M-25); an existing account for the email (409
 * `account_exists`); then the write. The email comes from the invitation row, the role from it
 * through the definer, and each acceptance's version and hash from the registry: the body supplies
 * only `name`, `password` and `acceptances`, and nothing else in it is read. No client address is
 * read or stored (SRS 9.5 step 6).
 *
 * Every failure answers through `toResponse`, so an outage is a 503 (NFR-AVL-04). E-06 is sent
 * after the commit: a failed send logs an id-only event and the 201 stands (the account exists).
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  try {
    assertSameOrigin(req);
    const { token } = await ctx.params;
    const invitation = await invitationByToken(token);
    if (invitation === null) throw unusable();

    const body = await bodyOf(req);
    const name = validateString(body.name, 'name', 100);
    // validateString trims: a name of spaces only reads as empty, and S-04 requires a name (7.4.2), in the client's words.
    const blankName = name.error === null && name.value.length === 0 ? { field: 'name', message: 'Name is required' } : null;
    const fieldErrors = collectErrors([name.error ?? blankName, validatePassword(body.password)]);
    if (fieldErrors.length > 0) throw new ValidationFailed(fieldErrors);
    const password = body.password as string;

    const accepted = acceptedKinds(body.acceptances);
    const missing = ACCEPTED_KINDS.filter((k) => !accepted.includes(k));
    if (missing.length > 0) {
      throw new AppError(422, 'validation', m25(missing[0]), {
        fields: missing.map((k) => ({ field: `acceptances.${k}`, message: m25(k) })), missing,
      });
    }

    // A friendly 409 before the bcrypt work; the users.email unique index is the guarantee (below).
    if ((await identityDb.user.findUnique({ where: { email: invitation.email }, select: { id: true } })) !== null) {
      throw accountExists();
    }

    let created: { userId: string; orgId: string };
    try {
      created = await registerFromInvitation({
        tokenHash: hashInvitationToken(token), email: invitation.email, name: name.value,
        passwordHash: await hash(password, 12), kinds: ACCEPTED_KINDS,
      });
    } catch (e) {
      // A concurrent registration for the same email won the unique index: the same answer as the check above.
      if (uniqueViolationIndex(e) === 'users_email_key') throw accountExists();
      // The definer refused (the invitation was used, revoked or replaced after the read above): the same M-23.
      if (e instanceof AppError && e.code === 'invitation_unusable') throw unusable();
      throw e;
    }

    // E-06 first: the account is committed, so nothing after this point may stop the notice going out.
    // The keys name the notice, not the address: no log call may carry an email-named field
    // (__tests__/lint/no-email-in-log-calls.test.ts).
    const noticeFailure = await sendAccountCreated(invitation.email, invitation.org.name);
    if (noticeFailure === null) {
      logSecurityEvent('AUTH_REGISTER', 'info', { userId: created.userId, details: { viaInvitation: true } });
    } else {
      logSecurityEvent('AUTH_REGISTER', 'warn', { userId: created.userId, details: { noticeSent: false, reason: noticeFailure } });
    }

    const membership = (await membershipsForUser(created.userId)).find((m) => m.orgId === created.orgId);
    if (membership === undefined) throw new Error('registration committed without its membership');
    return NextResponse.json({ orgSlug: membership.org.slug }, { status: 201 });
  } catch (e) {
    return toResponse(e);
  }
}

/**
 * Sends E-06 to the invited address; null when it went, else a fixed code for the log line (ids and
 * codes only, NFR-OBS-01: the error itself can carry the address or the provider's text).
 */
async function sendAccountCreated(to: string, orgName: string): Promise<'sender_unset' | 'send_failed' | null> {
  const from = process.env.EMAIL_FROM_ADDRESS;
  if (!from) return 'sender_unset';
  try {
    await sendEmail({ to, from, ...accountCreatedEmail({ orgName, createdAt: new Date() }) });
    return null;
  } catch {
    return 'send_failed';
  }
}

/**
 * The JSON body as an object, so each field fails its own check when absent. A body that is not
 * JSON is a 422 on `body`; any other read failure propagates.
 */
async function bodyOf(req: NextRequest): Promise<Record<string, unknown>> {
  const body: unknown = await req.json().catch((e: unknown) => {
    if (e instanceof SyntaxError) throw new ValidationFailed([{ field: 'body', message: 'The request body is not JSON.' }]);
    throw e;
  });
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

/** The ticked kinds; anything that is not a list of the three accepted kinds is a 422. */
function acceptedKinds(value: unknown): AcceptedKind[] {
  if (!Array.isArray(value) || !value.every((k): k is AcceptedKind => typeof k === 'string' && (ACCEPTED_KINDS as readonly string[]).includes(k))) {
    throw new ValidationFailed([{ field: 'acceptances', message: 'Acceptances must list terms, privacy and cross-border-consent.' }]);
  }
  return value;
}
