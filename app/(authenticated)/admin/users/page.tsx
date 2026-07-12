import { requireAdmin } from '@/lib/auth-guard';
import { prisma } from '@/lib/db';

export const metadata = {
  title: 'User Management — Admin',
};

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await requireAdmin();
  const { error } = await searchParams;

  const users = await prisma.user.findMany({
    include: {
      _count: {
        select: { assessments: true },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>User Management</h1>
          <p className="text-muted">
            {users.length} registered user{users.length !== 1 ? 's' : ''}
          </p>
        </div>
      </div>

      {error === 'self' && (
        <div className="validation-banner" role="alert">
          <div className="container">
            You cannot change your own role or deactivate your own account.
          </div>
        </div>
      )}

      <div className="admin-table-wrapper card">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Status</th>
              <th>Joined</th>
              <th>Assessments</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => {
              const isSelf = user.id === session.user.id;
              return (
              <tr key={user.id}>
                <td className="admin-table__name">
                  {user.name}
                  {isSelf && <span className="text-muted"> (you)</span>}
                </td>
                <td className="admin-table__email">{user.email}</td>
                <td>
                  <span
                    className={`badge ${
                      user.role === 'admin' ? 'badge--admin' : 'badge--assessor'
                    }`}
                  >
                    {user.role}
                  </span>
                </td>
                <td>
                  <span
                    className={`badge ${
                      user.isActive ? 'badge--completed' : 'badge--in-progress'
                    }`}
                  >
                    {user.isActive ? 'Active' : 'Deactivated'}
                  </span>
                </td>
                <td className="admin-table__date">
                  {new Date(user.createdAt).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                  })}
                </td>
                <td className="admin-table__count">{user._count.assessments}</td>
                <td className="admin-table__actions">
                  {isSelf ? (
                    <span className="text-muted" style={{ fontSize: 'var(--font-size-xs)' }}>
                      —
                    </span>
                  ) : (
                    <>
                      {/* Promote / Demote */}
                      <form
                        action={`/api/admin/users/${user.id}/role`}
                        method="POST"
                      >
                        <input
                          type="hidden"
                          name="role"
                          value={user.role === 'admin' ? 'assessor' : 'admin'}
                        />
                        <button
                          type="submit"
                          className="btn btn--small btn--outline"
                          title={
                            user.role === 'admin'
                              ? 'Demote to assessor'
                              : 'Promote to admin'
                          }
                        >
                          {user.role === 'admin' ? '↓ Demote' : '↑ Promote'}
                        </button>
                      </form>

                      {/* Deactivate / Reactivate */}
                      <form
                        action={`/api/admin/users/${user.id}/role`}
                        method="POST"
                      >
                        <input type="hidden" name="action" value="deactivate" />
                        <button
                          type="submit"
                          className={`btn btn--small ${
                            user.isActive ? 'btn--danger-outline' : 'btn--outline'
                          }`}
                          title={user.isActive ? 'Deactivate user' : 'Reactivate user'}
                        >
                          {user.isActive ? 'Deactivate' : 'Reactivate'}
                        </button>
                      </form>
                    </>
                  )}
                </td>
              </tr>
              );
            })}

            {users.length === 0 && (
              <tr>
                <td colSpan={7} className="admin-table__empty">
                  No users found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
