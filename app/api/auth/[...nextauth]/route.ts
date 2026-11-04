import type { NextRequest } from 'next/server';
import { handlers } from '@/lib/auth';
import { admitSignIn } from '@/lib/auth/signInAdmission';
import { guardSessionRead } from '@/lib/auth/sessionEndpoint';

/**
 * NextAuth's routes, with two wrappers, each acting on its own path only, so their order does not matter:
 * - the credentials POST goes through the sign-in admission (lib/auth/signInAdmission.ts: four comparisons at once, one
 *   kept for known devices, 300 a minute process-wide; FR-ACC-05);
 * - `GET` and `POST /api/auth/session` answer no session for a session the app refuses (lib/auth/sessionEndpoint.ts;
 *   NFR-SEC-07).
 * A Next route file may export only its methods, so both wrappers live in lib/auth.
 */
const CREDENTIALS_CALLBACK = '/api/auth/callback/credentials';

function signInGuardedPost(req: NextRequest): Promise<Response> {
  if (req.nextUrl.pathname.replace(/\/+$/, '') !== CREDENTIALS_CALLBACK) return handlers.POST(req);
  return admitSignIn(req, () => handlers.POST(req));
}

export function GET(req: NextRequest): Promise<Response> {
  return guardSessionRead(req, handlers.GET);
}

export function POST(req: NextRequest): Promise<Response> {
  return guardSessionRead(req, signInGuardedPost);
}
