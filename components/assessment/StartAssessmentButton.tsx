'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface StartAssessmentButtonProps {
  orgSlug: string;
  projectId: string;
}

/**
 * D-012/D-131: this used to offer two entry points — "Start Full
 * Assessment" and "Quick Check (5 min)" (`mode: 'quick'`). Quick Check's
 * flow was retired and deleted (`components/assessment/QuickAssessment.tsx`
 * no longer exists), so offering its entry point here would create a new
 * assessment with nowhere live to answer it. `mode` is no longer a
 * parameter — this always starts a full assessment.
 */
export default function StartAssessmentButton({ orgSlug, projectId }: StartAssessmentButtonProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function start() {
    setError('');
    setLoading(true);
    try {
      const res = await fetch(`/api/v1/orgs/${orgSlug}/assessments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, mode: 'full' }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to create assessment');
        return;
      }
      router.push(`/orgs/${orgSlug}/assessment/${data.id}`);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      {error && (
        <div className="form-error" role="alert" style={{ marginBottom: 8 }}>
          {error}
        </div>
      )}
      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <button
          className="btn btn--primary btn--arrow"
          onClick={() => start()}
          disabled={loading}
        >
          {loading ? 'Starting…' : 'Start Full Assessment'}
        </button>
      </div>
    </div>
  );
}
