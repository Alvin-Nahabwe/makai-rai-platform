import { requireIdentity } from '@/lib/auth/identity';
import { ProjectInContext } from '@/components/layout/ProjectInContext';

/**
 * The `@project` slot's page for the working report address: the rail's project block and the narrow top bar's project context, as
 * for the project page (owner ruling R4). requireIdentity() runs here on every navigation (A7); ProjectInContext passes the other gates.
 */
export default async function ProjectSlot({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const identity = await requireIdentity();
  return <ProjectInContext identity={identity} params={await params} />;
}
