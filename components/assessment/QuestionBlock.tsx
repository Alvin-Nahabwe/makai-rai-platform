'use client';

import type { Question, ResponseValue } from '@/types/domain';

interface QuestionBlockProps {
  q: Question;
  qIdx: number;
  responses: Record<string, ResponseValue>;
  validationErrors: Record<string, string>;
  onResponseChange: (qId: string, value: ResponseValue) => void;
  onChecklistChange: (qId: string, option: string) => void;
  /**
   * D-129: a role without `assessment:respond` must not be handed a live
   * input — an answer it submits would 403 on the autosave PATCH, silently
   * (the existing autosave `catch` swallows failures; see the assessment
   * page's own module doc). Defaults to `false` (enabled); the one caller
   * (`assessment/[id]/page.tsx`'s client component, `AssessmentPageClient.tsx`)
   * passes it explicitly, derived server-side from the membership row.
   * D-012/D-131: `QuickAssessment.tsx`, formerly a second caller, was
   * retired and deleted — see AssessmentPageClient.tsx's `mode === 'quick'`
   * branch for what existing `mode: 'quick'` rows now render instead.
   */
  disabled?: boolean;
}

/**
 * QuestionBlock — renders a single assessment question.
 *
 * Handles gate (Yes/No), likert-5 scale, and checklist question types.
 * Shows a conditional-question indicator when the question was unlocked
 * by a cross-stage condition.
 */
export function QuestionBlock({
  q,
  qIdx,
  responses,
  validationErrors,
  onResponseChange,
  onChecklistChange,
  disabled = false,
}: QuestionBlockProps) {
  const isConditional = !!q.crossStageCondition;

  return (
    <div
      key={q.id}
      className={`question-block ${validationErrors[q.id] ? 'question-block--error' : ''} ${isConditional ? 'question-block--conditional' : ''}`}
      id={`question-${q.id}`}
      role="group"
      aria-labelledby={`question-label-${q.id}`}
    >
      {/* Conditional question indicator */}
      {isConditional && (
        <div className="question-block__conditional-label">
          <span className="question-block__conditional-icon">↗</span>
          {q.crossStageCondition!.label}
        </div>
      )}

      <div className="question-block__header">
        <span className="question-block__num">Q{qIdx + 1}</span>
        <span className="question-block__principle badge badge--low">{q.principle}</span>
      </div>
      <p className="question-block__text" id={`question-label-${q.id}`}>{q.text}</p>
      {q.helpText && <p className="question-block__help">{q.helpText}</p>}
      {q.example && <p className="question-block__example"><em>{q.example}</em></p>}

      {/* Gate question (Yes/No) */}
      {q.type === 'gate' && (
        <div className="gate-group" role="radiogroup" aria-labelledby={`question-label-${q.id}`}>
          {q.options!.map(opt => (
            <label key={opt} className={`gate-option ${responses[q.id] === opt ? 'gate-option--selected' : ''}`}>
              <input type="radio" name={q.id} checked={responses[q.id] === opt} onChange={() => onResponseChange(q.id, opt)} disabled={disabled} />
              <span className="gate-option__radio"></span>
              <span>{opt}</span>
            </label>
          ))}
        </div>
      )}

      {/* Likert-5 */}
      {q.type === 'likert-5' && (
        <div className="likert-group" role="radiogroup" aria-labelledby={`question-label-${q.id}`}>
          {q.scale!.map((label, i) => (
            <label key={i} className={`likert-option ${responses[q.id] === i ? 'likert-option--selected' : ''}`}>
              <input type="radio" name={q.id} value={i} checked={responses[q.id] === i} onChange={() => onResponseChange(q.id, i)} disabled={disabled} />
              <span className="likert-option__radio"></span>
              <span className="likert-option__label">{label}</span>
            </label>
          ))}
        </div>
      )}

      {/* Checklist */}
      {q.type === 'checklist' && (
        <div className="checklist-group" role="group" aria-label={q.text}>
          {q.options!.map(opt => (
            <label key={opt} className={`checklist-option ${(Array.isArray(responses[q.id]) ? (responses[q.id] as string[]) : []).includes(opt) ? 'checklist-option--checked' : ''}`}>
              <input type="checkbox" checked={(Array.isArray(responses[q.id]) ? (responses[q.id] as string[]) : []).includes(opt)} onChange={() => onChecklistChange(q.id, opt)} disabled={disabled} />
              <span className="checklist-option__box"></span>
              <span>{opt}</span>
            </label>
          ))}
        </div>
      )}

      {validationErrors[q.id] && <p className="question-block__error-msg">{validationErrors[q.id]}</p>}
    </div>
  );
}
