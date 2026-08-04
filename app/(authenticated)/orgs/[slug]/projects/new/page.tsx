'use client';

import { useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Link from 'next/link';

const AI_SYSTEM_TYPES = [
  { value: '', label: 'Select AI system type...' },
  { value: 'classification', label: 'Classification' },
  { value: 'regression', label: 'Regression' },
  { value: 'nlp', label: 'Natural Language Processing' },
  { value: 'computer_vision', label: 'Computer Vision' },
  { value: 'recommendation', label: 'Recommendation System' },
  { value: 'generative_ai', label: 'Generative AI' },
  { value: 'other', label: 'Other' },
];

export default function NewProjectPage() {
  const router = useRouter();
  const params = useParams();
  const orgSlug = params.slug as string;
  const [form, setForm] = useState({
    name: '',
    aiSystemType: '',
    description: '',
    institution: '',
    department: '',
    country: '',
    deploymentSector: '',
    targetPopulation: '',
    teamSize: '',
  });
  const [showDetails, setShowDetails] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  function updateField(field: string, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!form.name.trim()) {
      setError('Project name is required');
      return;
    }

    setLoading(true);
    try {
      const payload: Record<string, unknown> = {
        name: form.name.trim(),
        aiSystemType: form.aiSystemType || undefined,
        description: form.description.trim() || undefined,
      };

      // Include optional metadata fields only if filled
      if (form.institution.trim()) payload.institution = form.institution.trim();
      if (form.department.trim()) payload.department = form.department.trim();
      if (form.country.trim()) payload.country = form.country.trim();
      if (form.deploymentSector.trim()) payload.deploymentSector = form.deploymentSector.trim();
      if (form.targetPopulation.trim()) payload.targetPopulation = form.targetPopulation.trim();
      if (form.teamSize.trim()) payload.teamSize = parseInt(form.teamSize, 10) || undefined;

      const res = await fetch(`/api/v1/orgs/${orgSlug}/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to create project');
        return;
      }
      router.push(`/orgs/${orgSlug}/projects/${data.id}`);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <Link href={`/orgs/${orgSlug}/projects`} className="back-link">← Back to Projects</Link>
          <h1>New Project</h1>
          <p className="text-muted">Register a new AI system for responsible AI assessment</p>
        </div>
      </div>

      <div className="form-container">
        {error && <div className="form-error" role="alert">{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="name">Project Name <span className="required">*</span></label>
            <input
              id="name"
              type="text"
              required
              placeholder="e.g., Patient Triage ML Model"
              value={form.name}
              onChange={(e) => updateField('name', e.target.value)}
            />
          </div>

          <div className="form-group">
            <label htmlFor="aiSystemType">AI System Type</label>
            <select
              id="aiSystemType"
              value={form.aiSystemType}
              onChange={(e) => updateField('aiSystemType', e.target.value)}
            >
              {AI_SYSTEM_TYPES.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label htmlFor="description">Description</label>
            <textarea
              id="description"
              rows={3}
              placeholder="Brief description of the AI system and its purpose..."
              value={form.description}
              onChange={(e) => updateField('description', e.target.value)}
            />
          </div>

          <div className="form-section-toggle">
            <button
              type="button"
              className="toggle-btn"
              onClick={() => setShowDetails(!showDetails)}
              aria-expanded={showDetails}
            >
              <span className={`toggle-icon ${showDetails ? 'open' : ''}`}>▶</span>
              Show additional details
            </button>
            <span className="text-muted" style={{ fontSize: 'var(--font-size-xs)' }}>
              Optional — can be added later
            </span>
          </div>

          {showDetails && (
            <div className="form-details">
              <div className="form-row">
                <div className="form-group">
                  <label htmlFor="institution">Institution</label>
                  <input
                    id="institution"
                    type="text"
                    placeholder="e.g., Makerere University"
                    value={form.institution}
                    onChange={(e) => updateField('institution', e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="department">Department</label>
                  <input
                    id="department"
                    type="text"
                    placeholder="e.g., Computer Science"
                    value={form.department}
                    onChange={(e) => updateField('department', e.target.value)}
                  />
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label htmlFor="country">Country</label>
                  <input
                    id="country"
                    type="text"
                    placeholder="e.g., Uganda"
                    value={form.country}
                    onChange={(e) => updateField('country', e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="deploymentSector">Deployment Sector</label>
                  <input
                    id="deploymentSector"
                    type="text"
                    placeholder="e.g., Healthcare, Agriculture"
                    value={form.deploymentSector}
                    onChange={(e) => updateField('deploymentSector', e.target.value)}
                  />
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label htmlFor="targetPopulation">Target Population</label>
                  <input
                    id="targetPopulation"
                    type="text"
                    placeholder="e.g., Rural communities in East Africa"
                    value={form.targetPopulation}
                    onChange={(e) => updateField('targetPopulation', e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="teamSize">Team Size</label>
                  <input
                    id="teamSize"
                    type="number"
                    min="1"
                    placeholder="e.g., 5"
                    value={form.teamSize}
                    onChange={(e) => updateField('teamSize', e.target.value)}
                  />
                </div>
              </div>
            </div>
          )}

          <div className="form-actions">
            <Link href={`/orgs/${orgSlug}/projects`} className="btn btn--secondary">Cancel</Link>
            <button type="submit" className="btn btn--primary btn--large" disabled={loading}>
              {loading ? 'Creating...' : 'Create Project'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
