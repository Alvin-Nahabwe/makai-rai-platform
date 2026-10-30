import { NextRequest, NextResponse } from 'next/server';
import { hash } from 'bcryptjs';
import { identityDb } from '@/lib/data/identity';
import { hashInvitationToken } from '@/lib/data/invitationToken';
import { invitationByToken, registerFromInvitation } from '@/lib/data/preauth';
import { uniqueViolationIndex } from '@/lib/data/pgErrors';
import { accountCreatedEmail } from '@/lib/email/templates/accountCreated';
import { sendEmail } from '@/lib/email/send';
import { AppError, ValidationFailed } from '@/lib/http/errors';
import { invitationUnusable as unusable } from '@/lib/http/messages';
import { assertSameOrigin } from '@/lib/http/sameOrigin';
import { toResponse } from '@/lib/http/toResponse';
import { acceptanceError as m25, isAcceptancePairs, type AcceptancePair } from '@/lib/legal/kinds';
import { assertCurrentVersions } from '@/lib/data/acceptances';
import { logSecurityEvent } from '@/lib/security-logger';
import { collectErrors, validatePassword, validateString } from '@/lib/validate';
import { ACCEPTED_KINDS } from '@/types/legal';

const accountExists = () => new AppError(409, 'account_exists', 'An account with this email already exists. Sign in to accept.');

/**
 * Contract route row 31 (FR-ACC-01, FR-ACC-03, FR-ACC-10): creates an account for the holder of a
 * pending, unexpired invitation, with its three acceptances and its membership in one transaction
 * (`registerFromInvitation`), then emails E-06 to the invited address. 201 `{ orgSlug }`.
 *
 * Order: the origin check; the invitation by its token (410 M-23 for every unusable case, before
 * any password is hashed, so a bogus token costs no bcrypt work); name and password (422); the
 * three acceptances, `[{ kind, version }]` (422 naming the first missing, M-25); each version the
 * one S-04 showed and still current (409 `legal_text_changed` with M-39, threat A5); an existing
 * account for the email (409 `account_exists`); then the write. The email comes from the
 * invitation row, the role from it through the definer, and each acceptance's version and hash
 * from the registry: the body supplies only `name`, `password` and `acceptances`, and nothing else
 * in it is read. No client address is read or stored (SRS 9.5 step 6).
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

    const accepted = acceptancesOf(body.acceptances);
    const missing = ACCEPTED_KINDS.filter((k) => !accepted.some((a) => a.kind === k));
    if (missing.length > 0) {
      throw new AppError(422, 'validation', m25(missing[0]), {
        fields: missing.map((k) => ({ field: `acceptances.${k}`, message: m25(k) })), missing,
      });
    }
    // Threat A5: each acceptance is of the version S-04 showed; a newer one since is a 409 with M-39.
    assertCurrentVersions(accepted);

    // A friendly 409 before the bcrypt work; the users.email unique index is the guarantee (below).
    if ((await identityDb.user.findUnique({ where: { email: invitation.email }, select: { id: true } })) !== null) {
      throw accountExists();
    }

    let created: { userId: string };
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
      // At error, not warn: a notice FR-ACC-10 requires did not go, and an unset key repeats on every registration (SFH-4).
      logSecurityEvent('AUTH_REGISTER', 'error', { userId: created.userId, details: { noticeSent: false, reason: noticeFailure } });
    }

    // The slug was read with the invitation, before the write: no read after the commit can turn a created account into a 5xx.
    return NextResponse.json({ orgSlug: invitation.org.slug }, { status: 201 });
  } catch (e) {
    return toResponse(e);
  }
}

/**
 * Sends E-06 to the invited address; null when it went, else a fixed code for the log line (ids and
 * codes only, NFR-OBS-01: the error itself can carry the address or the provider's text). The two
 * settings are checked first, so a misconfiguration (`sender_unset`, `api_key_unset`) reads apart
 * from a provider's failure (`send_failed`).
 */
async function sendAccountCreated(to: string, orgName: string): Promise<'sender_unset' | 'api_key_unset' | 'send_failed' | null> {
  const from = process.env.EMAIL_FROM_ADDRESS;
  if (!from) return 'sender_unset';
  if (!process.env.RESEND_API_KEY) return 'api_key_unset';
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

/** The ticked kinds with the versions shown; anything that is not a list of such pairs is a 422. */
function acceptancesOf(value: unknown): AcceptancePair[] {
  if (!isAcceptancePairs(value)) {
    throw new ValidationFailed([{ field: 'acceptances', message: 'Acceptances must list terms, privacy and cross-border-consent, each with the version shown.' }]);
  }
  return value;
}
