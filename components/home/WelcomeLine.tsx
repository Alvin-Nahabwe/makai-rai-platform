import type { OrgRole } from '@prisma/client';
import type { ReactElement } from 'react';
import { roleTerm, roleWithArticle, welcomeLine } from '@/lib/org/copy';

/**
 * The top of Home after joining (`?welcome=1`, written by the invitation's acceptance; plan 1B Task 10): "Welcome to
 * <organisation>. You are <a/an> <Role>." as the page's h1, then what the role can do, the vocabulary's sentence for it as
 * plain text (C10: not the Definition component, since the role is told here, not used).
 */
export function WelcomeLine({ orgName, role }: { orgName: string; role: OrgRole }): ReactElement {
  return (
    <>
      <h1 className="home-hello__title">{welcomeLine(orgName, roleWithArticle(role))}</h1>
      <p className="home-hello__lead">{roleTerm(role).definition}</p>
    </>
  );
}
