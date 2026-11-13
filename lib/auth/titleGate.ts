import { notFound } from 'next/navigation';
import { NotFoundError } from '@/lib/data/tenant';

/**
 * For a page's `generateMetadata` only. A page under `orgs/[slug]` relies on `orgs/[slug]/layout.tsx` to turn the gate's
 * `NotFoundError` (a non-member, an unknown organisation) into `notFound()`, but Next resolves `generateMetadata` apart
 * from the layout, and a raw error there leaves the page with no `<title>` at all. This maps that one error to Next's
 * `notFound()`, so the title is the not-found page's; every other error is rethrown unchanged. It maps any tenant
 * `NotFoundError`, the gate's or a later data read's (a record hidden by row-level security), since both mean not found.
 */
export async function orNotFound<T>(pending: Promise<T>): Promise<T> {
  try {
    return await pending;
  } catch (e) {
    if (e instanceof NotFoundError) notFound();
    throw e;
  }
}
