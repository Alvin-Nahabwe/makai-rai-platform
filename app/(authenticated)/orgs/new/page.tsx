'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function NewOrgPage() {
  const router = useRouter();
  const [orgName, setOrgName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!orgName.trim()) {
      setError('Organization name is required');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/v1/orgs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgName: orgName.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Could not create organization');
        return;
      }
      router.push(`/orgs/${data.slug}/dashboard`);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page-content">
      <div className="auth-card" style={{ maxWidth: 460, margin: '3rem auto' }}>
        <h1>Create a new organization</h1>
        <p className="text-muted" style={{ marginBottom: 'var(--space-4)' }}>
          You&apos;ll be its owner. You can switch between organizations you belong to at any
          time.
        </p>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="orgName">Organization name</label>
            <input
              id="orgName"
              name="orgName"
              type="text"
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              maxLength={100}
              required
              autoFocus
            />
          </div>
          {error && <p className="form-error">{error}</p>}
          <button type="submit" className="btn btn--primary" disabled={loading}>
            {loading ? 'Creating…' : 'Create organization'}
          </button>
        </form>
      </div>
    </div>
  );
}
