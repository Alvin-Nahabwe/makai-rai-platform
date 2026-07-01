import { NextRequest, NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { checkRateLimit } from '@/lib/rate-limit';

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const method = request.method;

  // Only rate-limit API routes
  if (!pathname.startsWith('/api/')) {
    return NextResponse.next();
  }

  // Extract IP
  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    '127.0.0.1';

  // Extract userId from JWT (if authenticated)
  let userId: string | null = null;
  try {
    const token = await getToken({ req: request });
    if (token?.id) {
      userId = token.id as string;
    }
  } catch {
    // Pre-auth request — no token available, use IP-based limiting
  }

  const result = checkRateLimit(method, pathname, ip, userId);

  if (!result.success) {
    const retryAfter = Math.ceil((result.resetAt.getTime() - Date.now()) / 1000);
    return new NextResponse(
      JSON.stringify({ error: 'Too many requests. Please try again later.' }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': String(retryAfter),
          'X-RateLimit-Limit': String(result.limit),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': result.resetAt.toISOString(),
        },
      },
    );
  }

  const response = NextResponse.next();
  response.headers.set('X-RateLimit-Limit', String(result.limit));
  response.headers.set('X-RateLimit-Remaining', String(result.remaining));
  response.headers.set('X-RateLimit-Reset', result.resetAt.toISOString());
  return response;
}

export const config = {
  matcher: ['/api/:path*'],
};
