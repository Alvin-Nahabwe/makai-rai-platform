import { requireIdentity } from '@/lib/auth/identity';
import { ProjectInContext } from '@/components/layout/ProjectInContext';

/**
 * The `@project` slot's page for this project address (owner ruling R4): the rail's project block and the narrow top bar's
 * project context. requireIdentity() runs here on every navigation, as on every signed-in page (A7); ProjectInContext
 * passes the project page's other gates (components/layout/ProjectInContext.tsx, lib/shell/project.ts).
 */
export default async function ProjectSlot({ params }: { params: Promise<{ slug: string; id: string; stage: string }> }) {
  const identity = await requireIdentity();
  return <ProjectInContext identity={identity} params={await params} />;
}
