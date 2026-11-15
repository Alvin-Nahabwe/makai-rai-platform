import type { Identity } from '@/lib/auth/identity';
import { loadShellProject } from '@/lib/shell/project';
import { stageParam } from '@/lib/shell/nav';
import { ShellProjectSlot } from '@/components/layout/ShellProject';

/** The params a project page's `@project` mirror receives: the slug and the id, and the stage on a stage's pages. */
export type ProjectSlotParams = { slug: string; id: string; stage?: string };

/**
 * What the `@project` slot renders on a project's page (owner ruling R4), for the identity the slot page's own
 * requireIdentity() gave: the rail block and the bar context of this organisation's project, or nothing when
 * loadShellProject finds none to show (lib/shell/project.ts: a gated person, a malformed, unknown or foreign id, a slug the
 * person is not in). It renders on the server with the page, so the block is in the first HTML (S1). No try/catch here
 * and no error.js in the slot: an error other than "not found" propagates to the page's error boundary (S2), it is never
 * quietly turned into a rail without its block.
 */
export async function ProjectInContext({ identity, params }: { identity: Identity; params: ProjectSlotParams }) {
  const project = await loadShellProject(identity, { slug: params.slug, id: params.id });
  if (project === null) return null;
  return <ShellProjectSlot project={project} orgSlug={params.slug} currentStage={stageParam(params.stage)} />;
}
