'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface StartAssessmentButtonProps {
  projectId: string;
}

export default function StartAssessmentButton({ projectId }: StartAssessmentButtonProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleClick() {
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/assessments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId }),
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
      <button
        className="btn btn--primary btn--arrow"
        onClick={handleClick}
        disabled={loading}
      >
        {loading ? 'Starting…' : 'Start New Assessment'}
      </button>
    </div>
  );
}
