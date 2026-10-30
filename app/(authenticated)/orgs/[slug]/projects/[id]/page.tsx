import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireIdentity } from '@/lib/auth/identity';
import { requireOrgContextFor } from '@/lib/auth/context';
import { withOrg } from '@/lib/data/tenant';
import { lookupUserNames } from '@/lib/data/identity';

function formatAiType(type: string | null | undefined): string {
  if (!type) return 'Not specified';
  return type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

interface PageProps {
  params: Promise<{ slug: string; id: string }>;
}

/**
 * No `createdById` ownership check — every org member with `project:read`
 * may view every project in the org (ADR-0001; lib/authz.ts's deletion
 * rationale). RLS, via `withOrg`'s GUC, is what confines `id` to this org;
 * a project belonging to another org reads back `null`, indistinguishable
 * from one that never existed — `notFound()` either way, never a redirect
 * that would imply "you don't own this" (a fact this app no longer checks).
 */
export default async function ProjectDetailPage({ params }: PageProps) {
  const { slug, id } = await params;
  const identity = await requireIdentity();
  const ctx = await requireOrgContextFor(identity.userId, slug, 'project:read');

  // No `user`/`createdBy` relation `include` — `makrai_app` has no grant on
  // `users` (lib/data/identity.ts#lookupUserNames). The scalar
  // `createdById` column is read directly and the name attached afterwards.
  const project = await withOrg(ctx, (tx) =>
    tx.project.findUnique({
      where: { id },
      include: { metadata: true },
    }),
  );

  if (!project) notFound();

  const names = await lookupUserNames([project.createdById]);
  const creatorName = names.get(project.createdById)?.name ?? 'Unknown';

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <Link href={`/orgs/${slug}/projects`} className="back-link">
            ← Back to Projects
          </Link>
          <h1 style={{ marginTop: 4 }}>{project.name}</h1>
          {project.description && (
            <p className="text-muted">{project.description}</p>
          )}
        </div>
      </div>

      {/* Metadata Card */}
      <section
        className="card"
        style={{ padding: 24, marginBottom: 32 }}
      >
        <h2 style={{ fontSize: 18, marginBottom: 16, fontWeight: 600 }}>
          Project Details
        </h2>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
            gap: '16px 32px',
          }}
        >
          <div>
            <span
              className="text-muted"
              style={{ fontSize: 'var(--font-size-xs)', display: 'block' }}
            >
              AI System Type
            </span>
            <span>{formatAiType(project.metadata?.aiSystemType)}</span>
          </div>
          {project.metadata?.institution && (
            <div>
              <span
                className="text-muted"
                style={{ fontSize: 'var(--font-size-xs)', display: 'block' }}
              >
                Institution
              </span>
              <span>{project.metadata.institution}</span>
            </div>
          )}
          {project.metadata?.department && (
            <div>
              <span
                className="text-muted"
                style={{ fontSize: 'var(--font-size-xs)', display: 'block' }}
              >
                Department
              </span>
              <span>{project.metadata.department}</span>
            </div>
          )}
          {project.metadata?.country && (
            <div>
              <span
                className="text-muted"
                style={{ fontSize: 'var(--font-size-xs)', display: 'block' }}
              >
                Country
              </span>
              <span>{project.metadata.country}</span>
            </div>
          )}
          {project.metadata?.deploymentSector && (
            <div>
              <span
                className="text-muted"
                style={{ fontSize: 'var(--font-size-xs)', display: 'block' }}
              >
                Deployment Sector
              </span>
              <span>{project.metadata.deploymentSector}</span>
            </div>
          )}
          {project.metadata?.targetPopulation && (
            <div>
              <span
                className="text-muted"
                style={{ fontSize: 'var(--font-size-xs)', display: 'block' }}
              >
                Target Population
              </span>
              <span>{project.metadata.targetPopulation}</span>
            </div>
          )}
          {project.metadata?.developmentStage && (
            <div>
              <span
                className="text-muted"
                style={{ fontSize: 'var(--font-size-xs)', display: 'block' }}
              >
                Development Stage
              </span>
              <span>
                {project.metadata.developmentStage
                  .replace(/_/g, ' ')
                  .replace(/\b\w/g, (c) => c.toUpperCase())}
              </span>
            </div>
          )}
          {project.metadata?.teamSize && (
            <div>
              <span
                className="text-muted"
                style={{ fontSize: 'var(--font-size-xs)', display: 'block' }}
              >
                Team Size
              </span>
              <span>{project.metadata.teamSize}</span>
            </div>
          )}
          <div>
            <span
              className="text-muted"
              style={{ fontSize: 'var(--font-size-xs)', display: 'block' }}
            >
              Created By
            </span>
            <span>{creatorName}</span>
          </div>
          <div>
            <span
              className="text-muted"
              style={{ fontSize: 'var(--font-size-xs)', display: 'block' }}
            >
              Last Updated
            </span>
            <span>{new Date(project.updatedAt).toLocaleDateString()}</span>
          </div>
        </div>
      </section>
    </div>
  );
}
