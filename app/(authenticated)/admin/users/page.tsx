import { requireAdmin } from '@/lib/auth-guard';
import { prisma } from '@/lib/db';

export const metadata = {
  title: 'User Management — Admin',
};

export default async function AdminUsersPage() {
  await requireAdmin();

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

      <div className="admin-table-wrapper card">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Joined</th>
              <th>Assessments</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td className="admin-table__name">{user.name}</td>
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
                <td className="admin-table__date">
                  {new Date(user.createdAt).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                  })}
                </td>
                <td className="admin-table__count">{user._count.assessments}</td>
                <td className="admin-table__actions">
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

                  {/* Deactivate placeholder */}
                  <form
                    action={`/api/admin/users/${user.id}/role`}
                    method="POST"
                  >
                    <input type="hidden" name="action" value="deactivate" />
                    <button
                      type="submit"
                      className="btn btn--small btn--danger-outline"
                      title="Deactivate user"
                    >
                      Deactivate
                    </button>
                  </form>
                </td>
              </tr>
            ))}

            {users.length === 0 && (
              <tr>
                <td colSpan={6} className="admin-table__empty">
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
