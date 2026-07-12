/**
 * Authorization helpers for API routes.
 *
 * Every resource in this platform is owned by a user. Authentication alone
 * (a valid session) is NOT sufficient to access a resource — the caller must
 * either own the resource or be an admin. These helpers centralize that check
 * so individual routes cannot forget it (the class of bug known as IDOR /
 * broken object-level authorization).
 */
import { auth } from './auth';
import { prisma } from './db';

export interface SessionUser {
  id: string;
  role: 'admin' | 'assessor';
}

/** Return the authenticated user, or null if there is no valid session. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await auth();
  if (!session?.user?.id) return null;
  return { id: session.user.id, role: session.user.role };
}

export function isAdmin(user: SessionUser): boolean {
  return user.role === 'admin';
}

/**
 * Load an assessment only if the caller may access it (owner or admin).
 * Returns null when the assessment does not exist OR the caller is not
 * authorized — callers should treat both as 404 to avoid leaking existence.
 */
export async function authorizeAssessment(
  user: SessionUser,
  assessmentId: string,
): Promise<{ id: string; userId: string; projectId: string; status: string } | null> {
  const assessment = await prisma.assessment.findUnique({
    where: { id: assessmentId },
    select: { id: true, userId: true, projectId: true, status: true },
  });
  if (!assessment) return null;
  if (!isAdmin(user) && assessment.userId !== user.id) return null;
  return assessment;
}

/**
 * Load a project only if the caller may access it (creator or admin).
 * Returns null when missing or unauthorized.
 */
export async function authorizeProject(
  user: SessionUser,
  projectId: string,
): Promise<{ id: string; createdById: string } | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, createdById: true },
  });
  if (!project) return null;
  if (!isAdmin(user) && project.createdById !== user.id) return null;
  return project;
}
