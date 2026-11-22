import { notFound, redirect } from 'next/navigation';
import { requireIdentity } from '@/lib/auth/identity';
import { requireOrgContextFor } from '@/lib/auth/context';
import { NotFoundError } from '@/lib/data/tenant';
import { loadNextTarget } from '@/lib/question/nextUnanswered';
import { isUuid } from '@/lib/shell/nav';
import { STAGES, type Stage } from '@/types/record';

type Params = Promise<{ slug: string; id: string; stage: string }>;
type Search = Promise<{ after?: string | string[] }>;

/**
 * Where the form goes after a clean save (answer cost, design 2 item 3): the next question of the stage that has no answer, chosen on
 * the server from what the project holds now, or the stage's end screen when none is left. A page that only redirects: it renders nothing
 * and writes nothing. Gated as the end page is (`record:read`, a stage of the content, a project id, a project the organisation holds,
 * else notFound()). `after` is untrusted: it reaches the address only as a question id of this stage (lib/question/nextUnanswered.ts),
 * and the rest of the address is built there from the project's own organisation slug, the checked project id and the checked stage.
 */
export default async function NextQuestionPage({ params, searchParams }: { params: Params; searchParams: Search }) {
  const { slug, id, stage } = await params;
  const { after } = await searchParams;
  const identity = await requireIdentity();
  const ctx = await requireOrgContextFor(identity.userId, slug, 'record:read');
  if (!(STAGES as readonly string[]).includes(stage) || !isUuid(id)) notFound();
  let target: string;
  try {
    target = await loadNextTarget(ctx, id, stage as Stage, typeof after === 'string' ? after : undefined);
  } catch (e) {
    if (e instanceof NotFoundError) notFound();
    throw e;
  }
  redirect(target);
}
