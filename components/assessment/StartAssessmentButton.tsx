'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface StartAssessmentButtonProps {
  projectId: string;
}

export default function StartAssessmentButton({ projectId }: StartAssessmentButtonProps) {
  const router = useRouter();
  const [loading, setLoading] = useState<'full' | 'quick' | null>(null);
  const [error, setError] = useState('');

  async function start(mode: 'full' | 'quick') {
    setError('');
    setLoading(mode);
    try {
      const res = await fetch('/api/assessments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, mode }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to create assessment');
        return;
      }
      router.push(`/assessment/${data.id}`);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setLoading(null);
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
          onClick={() => start('full')}
          disabled={loading !== null}
        >
          {loading === 'full' ? 'Starting…' : 'Start Full Assessment'}
        </button>
        <button
          className="btn btn--secondary"
          onClick={() => start('quick')}
          disabled={loading !== null}
          title="A 10-question readiness check (~5 min)"
        >
          {loading === 'quick' ? 'Starting…' : 'Quick Check (5 min)'}
        </button>
      </div>
    </div>
  );
}
