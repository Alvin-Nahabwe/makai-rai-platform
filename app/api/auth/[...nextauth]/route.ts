import type { NextRequest } from 'next/server';
import { handlers } from '@/lib/auth';
import { admitSignIn } from '@/lib/auth/signInAdmission';

/**
 * NextAuth's routes. The credentials POST goes through the sign-in admission first (lib/auth/signInAdmission.ts: four
 * comparisons at once, one kept for known devices, 300 a minute process-wide; FR-ACC-05). Every other path is NextAuth's
 * own. A Next route file may export only its methods, so the wrapper lives in lib/auth.
 */
const CREDENTIALS_CALLBACK = '/api/auth/callback/credentials';

export const GET = handlers.GET;

export function POST(req: NextRequest): Promise<Response> {
  if (req.nextUrl.pathname.replace(/\/+$/, '') !== CREDENTIALS_CALLBACK) return handlers.POST(req);
  return admitSignIn(req, () => handlers.POST(req));
}
