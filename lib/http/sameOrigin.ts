import { AppError } from '@/lib/http/errors';
import { HTTP_COPY } from '@/lib/http/copy';

/**
 * CSRF defence for every POST, PATCH and DELETE route (NFR-SEC-08): a browser
 * always sends `Origin` on a cross-site write, so a write whose `Origin` is
 * present must name this request's own host.
 *
 * Refused with 403 `cross_origin`: `Origin: null` (a sandboxed or redirected
 * context), an `Origin` that `new URL` cannot parse (the old inline check in
 * app/api/admin/users/[id]/role/route.ts threw a TypeError on both and so
 * answered 500), and an `Origin` that names another host or port. A request
 * with no `Origin` passes: it did not come from a cross-site browser page.
 * A request with an `Origin` but no `Host` header cannot be matched and is
 * refused.
 */
export function assertSameOrigin(req: Request): void {
  const origin = req.headers.get('origin');
  if (origin === null) return;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw crossOrigin();
  }
  if (originHost !== req.headers.get('host')) throw crossOrigin();
}

function crossOrigin(): AppError {
  return new AppError(403, 'cross_origin', HTTP_COPY.outOfDate);
}
