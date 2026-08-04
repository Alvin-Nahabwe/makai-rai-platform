import { NextRequest, NextResponse } from 'next/server';
import { requireIdentityForApi, UnauthenticatedError } from '@/lib/auth/identity';
import { createOrgForUser } from '@/lib/data/preauth';
import { requireNonBlank, validateString } from '@/lib/validate';

/**
 * The second entry point into org creation (ADR-0002 step 6). Registration
 * (`app/api/auth/register/route.ts`) creates the first org a user belongs
 * to; invitations join one; this is the only way an already-authenticated
 * user creates an additional one — without it the org switcher (Task 6) has
 * nothing to switch to.
 *
 * `requireIdentityForApi()`, NOT `requireIdentity()`: this is a route
 * handler, not a page. `requireIdentity()` redirects unauthenticated callers
 * to `/login` with a 30x — correct for a page, wrong for `fetch()`, which
 * follows the redirect, gets the login page's `200 text/html` back, and
 * throws in `res.json()` instead of surfacing "please log in". This route's
 * `orgs/new` page client already expects a JSON body and a status code (see
 * `app/(authenticated)/orgs/new/page.tsx`), so an unauthenticated caller
 * must get `401 { error }`, not a redirect it cannot follow usefully.
 *
 * `requireIdentityForApi()` is the ONLY source of `userId` here —
 * `createOrgForUser` documents that its `input.userId` is trusted as given,
 * with no ownership check of its own, so this route is the caller
 * obligation it names: the id passed MUST be the currently authenticated
 * session's, never a client-supplied value. There is no `userId` field read
 * from the request body.
 */
export async function POST(req: NextRequest) {
  let identity, body;
  try {
    // Independent reads — identity resolution (a DB round trip) does not
    // need the parsed body, and the body doesn't need identity — run them
    // together rather than serializing two awaits on the request's hot path.
    [identity, body] = await Promise.all([requireIdentityForApi(), req.json()]);
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    throw e;
  }

  const result = validateString(body.orgName, 'organization name', 100);
  const validationError = requireNonBlank(result, 'organization name');
  if (validationError) {
    return NextResponse.json({ error: validationError.message }, { status: 400 });
  }

  const { slug } = await createOrgForUser({ userId: identity.userId, orgName: result.value });
  return NextResponse.json({ slug }, { status: 201 });
}
