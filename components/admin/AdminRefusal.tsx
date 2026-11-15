import type { ReactElement } from 'react';
import { ListLink } from '@/components/ui/ListLink';
import { ADMIN_COPY } from '@/lib/admin/copy';

/**
 * What a signed-in account without the platform role gets on each of the four administrator pages (owner default B21:
 * status 200, the one line, nothing read): the refusal line, with a link to the person's own organisations (copy audit
 * D rows AD6, AD19, AD29, AD32). The link never prefetches (ListLink): Accounts is a long-list page, and its import
 * closure may hold no prefetching link (UX-37). A server component; the line does not depend on what was asked for.
 */
export function AdminRefusal(): ReactElement {
  return (
    <div className="page-content">
      <p>{ADMIN_COPY.refusal.line} <ListLink href="/">{ADMIN_COPY.refusal.link}</ListLink></p>
    </div>
  );
}
