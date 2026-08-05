import { NextRequest, NextResponse } from 'next/server';
import { hash } from 'bcryptjs';
import { identityDb } from '@/lib/data/identity';
import { invitationByToken, createUserFromInvitation } from '@/lib/data/preauth';
import { validateString, validatePassword, collectErrors } from '@/lib/validate';
import { logSecurityEvent } from '@/lib/security-logger';

/**
 * Creates an account for someone who holds a valid invitation but has no
 * User yet — the "new account" branch of the email-binding property (Task 8
 * brief property 5 / D-098 decision 9). Deliberately takes NO `email` field:
 * the email is fixed from the invitation row, read server-side, never from
 * the request body — that is what "not editable on the form" means at the
 * boundary that actually matters. A client that posts an `email` field gets
 * it silently ignored, not honoured; there is no code path here that reads
 * `body.email` at all.
 *
 * Does NOT create an Organization or Membership (unlike
 * `/api/auth/register`, which bootstraps a NEW org) and does NOT sign the
 * new user in — they must log in normally afterward and then call
 * `POST /api/v1/invitations/[token]` to accept, exactly mirroring the
 * existing register -> /login flow. See `createUserFromInvitation`'s module
 * doc (lib/data/preauth.ts) for why the split matters.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  try {
    const invitation = await invitationByToken(token);
    if (!invitation) {
      return NextResponse.json({ error: 'This invitation link is invalid or has expired.' }, { status: 404 });
    }

    const body = await request.json();
    const { password, termsAccepted, researchConsent } = body;

    const nameResult = validateString(body.name, 'name', 100);
    const passwordError = validatePassword(password);
    const errors = collectErrors([nameResult.error, passwordError]);
    if (errors.length > 0) {
      return NextResponse.json({ error: errors[0].message, errors }, { status: 400 });
    }
    if (nameResult.value.length === 0) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }
    if (!termsAccepted) {
      return NextResponse.json({ error: 'Terms of Service must be accepted' }, { status: 400 });
    }

    // Never create a second User for an email that already has one
    // (Task 8 brief / D-098 decision 9). This check is a friendly-error
    // convenience, not the guarantee — the `users.email` UNIQUE constraint,
    // enforced inside `createUserFromInvitation`'s transaction, is the real
    // one (same reliance `/api/auth/register` documents for its own
    // equivalent check).
    const existing = await identityDb.user.findUnique({ where: { email: invitation.email } });
    if (existing) {
      return NextResponse.json(
        { error: 'An account with this email already exists. Please log in instead.' },
        { status: 409 },
      );
    }

    const passwordHash = await hash(password, 12);
    const ip = request.headers.get('x-forwarded-for') || 'unknown';

    const result = await createUserFromInvitation({
      email: invitation.email,
      name: nameResult.value,
      passwordHash,
      researchConsent: researchConsent || false,
      ipAddress: ip,
    });

    logSecurityEvent('AUTH_REGISTER', 'info', {
      userId: result.userId,
      details: { email: invitation.email, viaInvitation: true },
    });

    return NextResponse.json({ success: true, userId: result.userId }, { status: 201 });
  } catch (error) {
    console.error('Invitation registration error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
