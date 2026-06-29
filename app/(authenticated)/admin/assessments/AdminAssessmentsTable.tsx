'use client';

import { useState, useMemo } from 'react';

interface AssessmentRow {
  id: string;
  projectName: string;
  userName: string;
  userEmail: string;
  mode: string;
  overallScore: number | null;
  status: string;
  startedAt: string;
}

type SortKey = 'projectName' | 'userName' | 'mode' | 'overallScore' | 'status' | 'startedAt';
type SortDir = 'asc' | 'desc';

export default function AdminAssessmentsTable({
  assessments,
}: {
  assessments: AssessmentRow[];
}) {
  const [sortKey, setSortKey] = useState<SortKey>('startedAt');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const sorted = useMemo(() => {
    return [...assessments].sort((a, b) => {
      let aVal: string | number = '';
      let bVal: string | number = '';

      switch (sortKey) {
        case 'projectName':
          aVal = a.projectName.toLowerCase();
          bVal = b.projectName.toLowerCase();
          break;
        case 'userName':
          aVal = a.userName.toLowerCase();
          bVal = b.userName.toLowerCase();
          break;
        case 'mode':
          aVal = a.mode;
          bVal = b.mode;
          break;
        case 'overallScore':
          aVal = a.overallScore ?? -1;
          bVal = b.overallScore ?? -1;
          break;
        case 'status':
          aVal = a.status;
          bVal = b.status;
          break;
        case 'startedAt':
          aVal = a.startedAt;
          bVal = b.startedAt;
          break;
      }

      if (aVal < bVal) return sortDir === 'asc' ? -1 : 1;
      if (aVal > bVal) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
  }, [assessments, sortKey, sortDir]);

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

  function sortIndicator(key: SortKey) {
    if (sortKey !== key) return '';
    return sortDir === 'asc' ? ' ▲' : ' ▼';
  }

  return (
    <div className="admin-table-wrapper card">
      <table className="admin-table">
        <thead>
          <tr>
            <th className="admin-table__sortable" onClick={() => handleSort('projectName')}>
              Project{sortIndicator('projectName')}
            </th>
            <th className="admin-table__sortable" onClick={() => handleSort('userName')}>
              User{sortIndicator('userName')}
            </th>
            <th className="admin-table__sortable" onClick={() => handleSort('mode')}>
              Mode{sortIndicator('mode')}
            </th>
            <th className="admin-table__sortable" onClick={() => handleSort('overallScore')}>
              Score{sortIndicator('overallScore')}
            </th>
            <th className="admin-table__sortable" onClick={() => handleSort('status')}>
              Status{sortIndicator('status')}
            </th>
            <th className="admin-table__sortable" onClick={() => handleSort('startedAt')}>
              Date{sortIndicator('startedAt')}
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((a) => (
            <tr key={a.id}>
              <td className="admin-table__name">{a.projectName}</td>
              <td>
                <div className="admin-table__user-cell">
                  <span className="admin-table__user-name">{a.userName}</span>
                  <span className="admin-table__user-email">{a.userEmail}</span>
                </div>
              </td>
              <td>
                <span className={`badge badge--${a.mode}`}>{a.mode}</span>
              </td>
              <td className="admin-table__count">
                {a.overallScore !== null ? a.overallScore : '—'}
              </td>
              <td>
                <span
                  className={`badge ${
                    a.status === 'completed'
                      ? 'badge--completed'
                      : 'badge--in-progress'
                  }`}
                >
                  {a.status === 'in_progress' ? 'In Progress' : 'Completed'}
                </span>
              </td>
              <td className="admin-table__date">
                {new Date(a.startedAt).toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                })}
              </td>
            </tr>
          ))}

          {sorted.length === 0 && (
            <tr>
              <td colSpan={6} className="admin-table__empty">
                No assessments found.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
