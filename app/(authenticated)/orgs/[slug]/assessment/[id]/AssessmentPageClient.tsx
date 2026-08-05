'use client';

import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import questionBankRaw from '@/data/questionBank.json';
import { STAGE_ORDER, stageLabels, type StageName } from '@/data/constants';
import {
  createAssessment,
  setResponse as engineSetResponse,
  getResponses,
  isStageAccessible,
  completeStage,
  getNextStage,
  calculateAreaScores,
  getUnlockedConditionalQuestions,
} from '@/lib/engine/AssessmentEngine.js';
import { StageSelector } from '@/components/assessment/StageSelector';
import QuickAssessment from '@/components/assessment/QuickAssessment';
import { QuestionBlock } from '@/components/assessment/QuestionBlock';
import { CompletionModal } from '@/components/assessment/CompletionModal';
import { ResetModal } from '@/components/assessment/ResetModal';
import type { EngineState, QuestionBank, QuestionModule, QuestionCondition, ResponseValue } from '@/types/domain';
import '@/components/assessment/AssessmentPage.css';

const questionBank = questionBankRaw as unknown as QuestionBank;

function isConditionMet(
  condition: QuestionCondition | undefined,
  responses: Record<string, ResponseValue>,
): boolean {
  if (!condition) return true;
  const resp = responses[condition.questionId];
  if (condition.value !== undefined) return resp === condition.value;
  if (condition.minValue !== undefined) return typeof resp === 'number' && resp >= condition.minValue;
  return true;
}

interface AssessmentPageClientProps {
  /**
   * D-129: server-derived (`can(ctx.role, 'assessment:respond')`,
   * computed in this directory's `page.tsx` from the membership row, never
   * from client input) — the ONLY thing this prop is allowed to change is
   * whether respond-shaped controls RENDER as usable. It does not, and
   * must not, weaken the server-side authorization on the PATCH/complete
   * routes this page calls — those already independently enforce
   * `assessment:respond`/`assessment:complete` (verified live, Task 12)
   * and are untouched by this fix.
   */
  canRespond: boolean;
}

export default function AssessmentPageClient({ canRespond }: AssessmentPageClientProps) {
  const params = useParams();
  const router = useRouter();
  const assessmentId = params.id as string;
  const orgSlug = params.slug as string;
  const apiBase = `/api/v1/orgs/${orgSlug}/assessments/${assessmentId}`;

  // Loading & error state
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Engine state loaded from API
  const [engineState, setEngineState] = useState<EngineState>(() => createAssessment());

  // Quick-check assessments use a separate, single-page flow.
  const [mode, setMode] = useState<'full' | 'quick'>('full');
  const [projectId, setProjectId] = useState('');
  const [quickResponses, setQuickResponses] = useState<Record<string, number>>({});
  const [quickCompleted, setQuickCompleted] = useState(false);
  const [quickScore, setQuickScore] = useState<number | null>(null);

  // Stage selection is in-page state (not URL-based)
  const [selectedStage, setSelectedStage] = useState<string | null>(null);
  const [currentModuleIdx, setCurrentModuleIdx] = useState(0);

  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});
  const [showValidationBanner, setShowValidationBanner] = useState(false);
  const [showCompletionModal, setShowCompletionModal] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);

  // Debounced auto-save ref
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);

  // Fetch assessment on mount
  useEffect(() => {
    isMountedRef.current = true;
    async function fetchAssessment() {
      try {
        const res = await fetch(apiBase);
        if (!res.ok) {
          if (res.status === 404) {
            setError('Assessment not found');
          } else {
            setError('Failed to load assessment');
          }
          return;
        }
        const data = await res.json();
        setMode(data.mode);
        setProjectId(data.project?.id || '');
        if (data.mode === 'quick') {
          setQuickResponses(data.engineState?.quick?.responses || {});
          setQuickCompleted(data.status === 'completed');
          setQuickScore(data.overallScore ?? null);
        } else if (data.engineState) {
          setEngineState(data.engineState);
        }
      } catch {
        setError('Failed to load assessment');
      } finally {
        if (isMountedRef.current) setLoading(false);
      }
    }
    fetchAssessment();
    return () => {
      isMountedRef.current = false;
    };
  }, [assessmentId, apiBase]);

  // Debounced auto-save: PUT engineState to API on change (1s debounce)
  const autoSave = useCallback((state: EngineState) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      try {
        await fetch(apiBase, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ engineState: state }),
        });
      } catch {
        // Auto-save failures are silent — user can retry
      }
    }, 1000);
  }, [apiBase]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  // Navigation guard — warn user before leaving with unsaved assessment
  useEffect(() => {
    const hasResponses = selectedStage && Object.keys(getResponses(engineState, selectedStage)).length > 0;
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (hasResponses) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [engineState, selectedStage]);

  // Get responses for the current stage
  const responses = useMemo(() =>
    selectedStage ? getResponses(engineState, selectedStage) : {},
  [engineState, selectedStage]);

  // Get modules and visible questions using the engine
  const modules: QuestionModule[] = useMemo(
    () => (selectedStage ? questionBank.stages[selectedStage]?.modules || [] : []),
    [selectedStage],
  );
  const currentModule = modules[currentModuleIdx] || null;

  // Get unlocked conditional question IDs for this stage
  const unlockedConditionals = useMemo(() =>
    selectedStage ? new Set(getUnlockedConditionalQuestions(engineState, selectedStage)) : new Set<string>(),
  [engineState, selectedStage]);

  // Filter visible questions: standard + conditionals (from engine) + intra-stage conditions
  const visibleQuestions = useMemo(() => {
    if (!currentModule) return [];
    return currentModule.questions.filter((q) => {
      if (q.crossStageCondition) {
        return unlockedConditionals.has(q.id);
      }
      return isConditionMet(q.condition, responses);
    });
  }, [currentModule, responses, unlockedConditionals]);

  const allVisibleQuestions = useMemo(() => {
    if (!selectedStage) return [];
    return modules.flatMap((m) => m.questions.filter((q) => {
      if (q.crossStageCondition) return unlockedConditionals.has(q.id);
      return isConditionMet(q.condition, responses);
    }));
  }, [selectedStage, modules, responses, unlockedConditionals]);

  const answeredCount = useMemo(() => {
    return allVisibleQuestions.filter((q) => {
      const val = responses[q.id];
      if (val === undefined || val === null) return false;
      if (Array.isArray(val)) return val.length > 0;
      return true;
    }).length;
  }, [allVisibleQuestions, responses]);

  const totalQuestions = allVisibleQuestions.length;
  const progressPct = totalQuestions > 0 ? Math.round((answeredCount / totalQuestions) * 100) : 0;

  // Precompute modal data outside of render
  const { nextStage, isLastStage } = useMemo(() => {
    if (!showCompletionModal || !selectedStage) return { nextStage: null, isLastStage: false };
    const stateAfterComplete = completeStage(engineState, selectedStage);
    return {
      nextStage: getNextStage(stateAfterComplete),
      isLastStage: STAGE_ORDER.indexOf(selectedStage as StageName) === STAGE_ORDER.length - 1,
    };
  }, [showCompletionModal, engineState, selectedStage]);

  // Note: focus trapping and Escape-to-close are handled natively by the
  // <dialog> elements in CompletionModal/ResetModal (opened via showModal()).

  // Response handlers using the engine
  const clearValidationError = useCallback((qId: string) => {
    setValidationErrors(prev => { const n = { ...prev }; delete n[qId]; return n; });
  }, []);

  const handleResponseChange = useCallback((qId: string, value: ResponseValue) => {
    setEngineState((prev) => {
      if (!selectedStage) return prev;
      const next = engineSetResponse(prev, selectedStage, qId, value);
      autoSave(next);
      return next;
    });
    clearValidationError(qId);
  }, [selectedStage, clearValidationError, autoSave]);

  const handleChecklistChange = useCallback((qId: string, option: string) => {
    setEngineState((prev) => {
      if (!selectedStage) return prev;
      const existing = getResponses(prev, selectedStage)[qId];
      const current: string[] = Array.isArray(existing) ? existing : [];
      const nextArr = current.includes(option)
        ? current.filter((o) => o !== option)
        : [...current, option];
      const next = engineSetResponse(prev, selectedStage, qId, nextArr);
      autoSave(next);
      return next;
    });
    clearValidationError(qId);
  }, [selectedStage, clearValidationError, autoSave]);

  const validateCurrentModule = () => {
    const errors: Record<string, string> = {};
    visibleQuestions.forEach((q) => {
      const resp = responses[q.id];
      if (resp === undefined || resp === null) {
        errors[q.id] = 'Please answer this question before proceeding.';
      } else if (q.type === 'checklist' && Array.isArray(resp) && resp.length === 0) {
        errors[q.id] = 'Please select at least one option.';
      }
    });
    setValidationErrors(errors);
    if (Object.keys(errors).length > 0) {
      setShowValidationBanner(true);
      const el = document.getElementById(`question-${Object.keys(errors)[0]}`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return false;
    }
    setShowValidationBanner(false);
    return true;
  };

  const handleNextModule = () => {
    if (!validateCurrentModule()) return;
    setCurrentModuleIdx(currentModuleIdx + 1);
    setShowValidationBanner(false);
    window.scrollTo(0, 0);
  };

  const handleCompleteStage = () => {
    if (!validateCurrentModule()) return;
    setShowCompletionModal(true);
  };

  const handleGenerateReport = async () => {
    if (!selectedStage) return;
    // Complete stage and persist via API
    const updated = completeStage(engineState, selectedStage);
    setEngineState(updated);

    // Save state and mark complete via API
    try {
      await fetch(apiBase, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ engineState: updated }),
      });
      await fetch(`${apiBase}/complete`, {
        method: 'POST',
      });
    } catch {
      // Continue to report even if API call fails
    }

    router.push(`/orgs/${orgSlug}/assessment/${assessmentId}/report`);
  };

  const handleContinueToNext = async () => {
    if (!selectedStage) return;
    // Complete stage and persist via API
    const updated = completeStage(engineState, selectedStage);
    setEngineState(updated);

    try {
      await fetch(apiBase, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ engineState: updated }),
      });
    } catch {
      // Continue even if save fails
    }

    setShowCompletionModal(false);
    const next = getNextStage(updated);
    if (next) {
      setCurrentModuleIdx(0);
      setSelectedStage(next);
      window.scrollTo(0, 0);
    }
  };

  // If the selected stage becomes inaccessible (e.g. after a reset), fall back to
  // the stage selector. Adjusting state during render is React's recommended
  // alternative to a state-syncing effect for this "derived selection" case.
  if (selectedStage && !isStageAccessible(engineState, selectedStage)) {
    setSelectedStage(null);
  }

  // Loading and error states
  if (loading) {
    return (
      <div className="assessment-page" id="assessment-page">
        <section className="section">
          <div className="container" style={{ textAlign: 'center', padding: '4rem 0' }}>
            <p>Loading assessment...</p>
          </div>
        </section>
      </div>
    );
  }

  if (error) {
    return (
      <div className="assessment-page" id="assessment-page">
        <section className="section">
          <div className="container" style={{ textAlign: 'center', padding: '4rem 0' }}>
            <p style={{ color: 'var(--color-risk-critical)' }}>{error}</p>
            <button className="btn btn--secondary" onClick={() => router.push(`/orgs/${orgSlug}/dashboard`)} style={{ marginTop: '1rem' }}>
              Back to Dashboard
            </button>
          </div>
        </section>
      </div>
    );
  }

  // Quick-check assessments use their own single-page flow.
  if (mode === 'quick') {
    return (
      <QuickAssessment
        orgSlug={orgSlug}
        assessmentId={assessmentId}
        projectId={projectId}
        initialResponses={quickResponses}
        completed={quickCompleted}
        completedScore={quickScore}
      />
    );
  }

  // ─────────────────────────────────────────────
  // Stage selector with gating (pipeline view)
  // ─────────────────────────────────────────────
  if (!selectedStage) {
    return (
      <StageSelector
        engineState={engineState}
        onSelectStage={(stage) => {
          setSelectedStage(stage);
          setCurrentModuleIdx(0);
          window.scrollTo(0, 0);
        }}
        onViewReport={() => router.push(`/orgs/${orgSlug}/assessment/${assessmentId}/report`)}
        onRestart={() => {
          if (window.confirm('This will clear all your assessment responses. Are you sure?')) {
            const fresh = createAssessment();
            setEngineState(fresh);
            autoSave(fresh);
          }
        }}
      />
    );
  }

  const cfg = stageLabels[selectedStage as keyof typeof stageLabels];

  /** Arrow-key navigation for module tabs (WAI-ARIA Tabs pattern) */
  const handleTabKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const tabs = e.currentTarget.querySelectorAll('[role="tab"]');
      const currentIndex = Array.from(tabs).indexOf(e.target as Element);
      if (currentIndex === -1) return;
      let nextIndex: number;
      if (e.key === 'ArrowRight') {
        nextIndex = currentIndex < tabs.length - 1 ? currentIndex + 1 : 0;
      } else {
        nextIndex = currentIndex > 0 ? currentIndex - 1 : tabs.length - 1;
      }
      (tabs[nextIndex] as HTMLElement).focus();
      e.preventDefault();
    }
  };

  return (
    <div className="assessment-page" id="assessment-page">
      <section className="assessment-header" style={{ '--stage-color': cfg.color } as React.CSSProperties}>
        <div className="container">
          <div className="assessment-header__top">
            <button onClick={() => setSelectedStage(null)} className="assessment-header__back">← Back to stages</button>
            <div className="assessment-header__progress-info">
              <span>{answeredCount} / {totalQuestions} answered</span>
              <span className="assessment-header__pct">{progressPct}%</span>
            </div>
          </div>
          <div className="progress-bar">
            <div className="progress-bar__fill" style={{ width: `${progressPct}%`, backgroundColor: cfg.color }}></div>
          </div>
          <div className="assessment-header__title-row">
            <span className="assessment-header__icon" style={{width: '8px', height: '8px', borderRadius: '50%', background: cfg.color, display: 'inline-block'}}></span>
            <h2>{cfg.label} Assessment</h2>
          </div>
          <div className="module-tabs" role="tablist" onKeyDown={handleTabKeyDown}>
            {modules.map((mod, idx) => (
              <button key={mod.id}
                className={`module-tab ${idx === currentModuleIdx ? 'module-tab--active' : ''}`}
                onClick={() => { if (idx < currentModuleIdx) { setCurrentModuleIdx(idx); setShowValidationBanner(false); } }}
                role="tab"
                aria-selected={idx === currentModuleIdx}
                tabIndex={idx === currentModuleIdx ? 0 : -1}
              >{mod.title}</button>
            ))}
          </div>
        </div>
      </section>

      {showValidationBanner && (
        <div className="validation-banner">
          <div className="container">Please answer all questions before proceeding. Unanswered questions are highlighted below.</div>
        </div>
      )}

      <section className="section assessment-content">
        <div className="container container--narrow">
          {currentModule && (
            <>
              <h3 className="module-title">{currentModule.title}</h3>
              <p className="module-desc">{currentModule.description}</p>

              <div className="questions-list">
                {visibleQuestions.map((q, qIdx) => (
                  <QuestionBlock
                    key={q.id}
                    q={q}
                    qIdx={qIdx}
                    responses={responses}
                    validationErrors={validationErrors}
                    onResponseChange={handleResponseChange}
                    onChecklistChange={handleChecklistChange}
                    disabled={!canRespond}
                  />
                ))}
              </div>

              <div className="assessment-nav">
                {currentModuleIdx > 0 && (
                  <button className="btn btn--secondary" onClick={() => { setCurrentModuleIdx(currentModuleIdx - 1); setShowValidationBanner(false); window.scrollTo(0, 0); }}>← Previous Module</button>
                )}
                {currentModuleIdx < modules.length - 1 ? (
                  <button className="btn btn--primary btn--arrow" onClick={handleNextModule} style={{ marginLeft: 'auto' }}>Next Module</button>
                ) : (
                  <button className="btn btn--green btn--large btn--arrow" onClick={handleCompleteStage} style={{ marginLeft: 'auto' }} id="complete-stage-btn">
                    Complete {cfg.label}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </section>

      {/* Stage completion modal */}
      <CompletionModal
        show={showCompletionModal}
        onClose={() => setShowCompletionModal(false)}
        stageLabel={cfg.label}
        stageColor={cfg.color}
        areaScores={calculateAreaScores(engineState, selectedStage) as Record<string, number>}
        isLastStage={isLastStage}
        nextStageLabel={stageLabels[nextStage as keyof typeof stageLabels]?.label || 'Next Stage'}
        onViewReport={handleGenerateReport}
        onContinueNext={handleContinueToNext}
      />

      {/* Reset confirmation dialog — D-129: the modal itself is inert
          without a trigger, but gated too (not just its trigger button)
          since `showResetConfirm` can in principle still be set some other
          way in the future; defense at both layers rather than trusting
          the button's absence alone. */}
      {canRespond && (
        <ResetModal
          show={showResetConfirm}
          onClose={() => setShowResetConfirm(false)}
          onConfirm={async () => {
            const fresh = createAssessment();
            setEngineState(fresh);
            autoSave(fresh);
            setShowResetConfirm(false);
            setSelectedStage(null);
          }}
        />
      )}

      {/* Reset button - floating at bottom. D-129: assessment:respond —
          resetting rewrites every response via the same autoSave PATCH
          the response inputs use, so it is gated identically. */}
      {canRespond && (
        <div style={{ textAlign: 'center', padding: '1rem 0 2rem' }}>
          <button className="btn btn--secondary" style={{ fontSize: '0.85rem', opacity: 0.7 }} onClick={() => setShowResetConfirm(true)}>
            Reset Assessment
          </button>
        </div>
      )}
    </div>
  );
}
