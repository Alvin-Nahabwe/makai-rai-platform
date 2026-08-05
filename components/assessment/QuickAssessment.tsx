'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getQuickQuestions, getQuickScore } from '@/lib/engine/QuickAssessment.js';
import { QuestionBlock } from './QuestionBlock';
import type { ResponseValue } from '@/types/domain';
import './AssessmentPage.css';

interface QuickAssessmentProps {
  orgSlug: string;
  assessmentId: string;
  projectId: string;
  initialResponses: Record<string, number>;
  completed: boolean;
  completedScore: number | null;
  /** D-129 round 2: this component was reachable and fully interactive
   * for every role — found live, D-131 (register: its RETIRE disposition,
   * D-012, was never carried out; this gate is the safe minimum
   * regardless of how that's resolved). Server-derived
   * (`can(ctx.role, 'assessment:respond')`, computed in
   * app/(authenticated)/orgs/[slug]/assessment/[id]/page.tsx from the
   * membership row) and threaded down through AssessmentPageClient.tsx —
   * never re-derived here. Gates every response input AND the submit
   * button; does not touch server-side authorization on the PATCH/complete
   * routes this component calls, which already enforce it independently. */
  canRespond: boolean;
}

function tierFor(score: number): { label: string; color: string } {
  if (score >= 75) return { label: 'Strong', color: 'var(--color-risk-low)' };
  if (score >= 50) return { label: 'Developing', color: 'var(--color-risk-moderate)' };
  if (score >= 25) return { label: 'Needs work', color: 'var(--color-risk-high)' };
  return { label: 'Critical', color: 'var(--color-risk-critical)' };
}

export default function QuickAssessment({
  orgSlug,
  assessmentId,
  projectId,
  initialResponses,
  completed,
  completedScore,
  canRespond,
}: QuickAssessmentProps) {
  const router = useRouter();
  const apiBase = `/api/v1/orgs/${orgSlug}/assessments/${assessmentId}`;
  const questions = useMemo(() => getQuickQuestions(), []);
  const [responses, setResponses] = useState<Record<string, number>>(initialResponses);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<number | null>(completed ? completedScore : null);

  const answeredCount = questions.filter((q) => responses[q.id] !== undefined).length;

  function handleChange(qId: string, value: ResponseValue) {
    if (typeof value !== 'number') return;
    setResponses((prev) => ({ ...prev, [qId]: value }));
    setErrors((prev) => {
      const next = { ...prev };
      delete next[qId];
      return next;
    });
  }

  async function handleSubmit() {
    const missing: Record<string, string> = {};
    for (const q of questions) {
      if (responses[q.id] === undefined) missing[q.id] = 'Please answer this question.';
    }
    if (Object.keys(missing).length > 0) {
      setErrors(missing);
      const first = document.getElementById(`question-${Object.keys(missing)[0]}`);
      first?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    setSubmitting(true);
    try {
      await fetch(apiBase, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ engineState: { mode: 'quick', quick: { responses } } }),
      });
      const res = await fetch(`${apiBase}/complete`, { method: 'POST' });
      if (res.ok) {
        setResult(getQuickScore(responses));
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (result !== null) {
    const tier = tierFor(result);
    return (
      <div className="assessment-page" id="assessment-page">
        <section className="section">
          <div className="container container--narrow" style={{ textAlign: 'center', padding: '3rem 0' }}>
            <span className="text-accent">Quick Check Result</span>
            <h1 style={{ marginTop: 'var(--space-2)' }}>Readiness snapshot</h1>
            <div style={{ fontSize: 'var(--font-size-6xl)', fontWeight: 700, color: tier.color, lineHeight: 1.1, marginTop: 'var(--space-4)' }}>
              {result}%
            </div>
            <p style={{ color: tier.color, fontWeight: 600, fontSize: 'var(--font-size-lg)' }}>{tier.label}</p>
            <p className="text-muted" style={{ maxWidth: 520, margin: 'var(--space-4) auto 0' }}>
              This is a fast pre-processing snapshot based on 10 high-signal questions. For a full
              lifecycle assessment with gap analysis, controls, and a downloadable report, run the
              full assessment.
            </p>
            <div style={{ display: 'flex', gap: 'var(--space-3)', justifyContent: 'center', marginTop: 'var(--space-6)', flexWrap: 'wrap' }}>
              <button className="btn btn--primary btn--arrow" onClick={() => router.push(`/orgs/${orgSlug}/projects/${projectId}`)}>
                Back to project
              </button>
            </div>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="assessment-page" id="assessment-page">
      <section className="assessment-header" style={{ '--stage-color': 'var(--color-primary)' } as React.CSSProperties}>
        <div className="container">
          <div className="assessment-header__top">
            <button onClick={() => router.push(`/orgs/${orgSlug}/projects/${projectId}`)} className="assessment-header__back">
              ← Back to project
            </button>
            <div className="assessment-header__progress-info">
              <span>{answeredCount} / {questions.length} answered</span>
            </div>
          </div>
          <div className="assessment-header__title-row">
            <h2>Quick Readiness Check</h2>
          </div>
          <p className="text-muted">Ten high-signal questions for a fast readiness snapshot (~5 minutes).</p>
        </div>
      </section>

      <section className="section assessment-content">
        <div className="container container--narrow">
          <div className="questions-list">
            {questions.map((q, i) => (
              <QuestionBlock
                key={q.id}
                q={q}
                qIdx={i}
                responses={responses}
                validationErrors={errors}
                onResponseChange={handleChange}
                onChecklistChange={() => {}}
                disabled={!canRespond}
              />
            ))}
          </div>
          <div className="assessment-nav">
            {canRespond && (
              <button
                className="btn btn--green btn--large btn--arrow"
                onClick={handleSubmit}
                disabled={submitting}
                style={{ marginLeft: 'auto' }}
              >
                {submitting ? 'Scoring…' : 'See my result'}
              </button>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
