import { NextRequest, NextResponse } from 'next/server';
import { hash } from 'bcryptjs';
import { prisma } from '@/lib/db';
import { validateEmail, validatePassword, validateString, collectErrors } from '@/lib/validate';
import { logSecurityEvent } from '@/lib/security-logger';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { password, termsAccepted, researchConsent } = body;

    // Validate and sanitize inputs
    const nameResult = validateString(body.name, 'name', 100);
    const emailError = validateEmail(body.email);
    const passwordError = validatePassword(password);

    const errors = collectErrors([nameResult.error, emailError, passwordError]);
    if (errors.length > 0) {
      return NextResponse.json({ error: errors[0].message, errors }, { status: 400 });
    }

    const name = nameResult.value;
    const email = (body.email as string).trim().toLowerCase();

    if (!termsAccepted) {
      return NextResponse.json({ error: 'Terms of Service must be accepted' }, { status: 400 });
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return NextResponse.json({ error: 'An account with this email already exists' }, { status: 409 });
    }

    const passwordHash = await hash(password, 12);
    const user = await prisma.user.create({
      data: {
        email, name, passwordHash,
        termsAccepted: true,
        termsAcceptedAt: new Date(),
        researchConsent: researchConsent || false,
      },
    });

    logSecurityEvent('AUTH_REGISTER', 'info', {
      userId: user.id,
      details: { email },
    });

    const ip = request.headers.get('x-forwarded-for') || 'unknown';
    await prisma.consentRecord.createMany({
      data: [
        { userId: user.id, consentType: 'terms_of_service', granted: true, ipAddress: ip },
        { userId: user.id, consentType: 'privacy_policy', granted: true, ipAddress: ip },
        ...(researchConsent
          ? [{ userId: user.id, consentType: 'research_data_usage' as const, granted: true, ipAddress: ip }]
          : []),
      ],
    });

    return NextResponse.json({ success: true, userId: user.id }, { status: 201 });
  } catch (error) {
    console.error('Registration error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
