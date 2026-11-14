'use client';

import { useEffect } from 'react';
import { rememberLastProject } from '@/lib/client/lastProject';

/**
 * Remembers, on this device, the project whose page is open, so the rail's Findings link goes to its findings (plan 1A
 * Task 12, L2-64). Rendered only by a project page after the person's read of that project succeeded, with the ids that
 * page holds (S9). Renders nothing; a storage that refuses the write leaves the plain Findings link.
 */
export default function RememberProject({ userId, orgSlug, projectId }: { userId: string; orgSlug: string; projectId: string }) {
  useEffect(() => {
    if (userId !== '' && orgSlug !== '' && projectId !== '') rememberLastProject(userId, orgSlug, projectId);
  }, [userId, orgSlug, projectId]);
  return null;
}
