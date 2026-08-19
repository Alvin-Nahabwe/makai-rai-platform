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
import { QuestionBlock } from '@/components/assessment/QuestionBlock';
import { CompletionModal } from '@/components/assessment/CompletionModal';
import { ResetModal } from '@/components/assessment/ResetModal';
import type { EvidenceAttachItem } from '@/components/evidence/EvidenceAttach';
import { mutateThenConfirm } from '@/lib/evidence/mutateThenConfirm';
import type { EngineState, QuestionBank, QuestionModule, QuestionCondition, ResponseValue } from '@/types/domain';
import '@/components/assessment/AssessmentPage.css';

const questionBank = questionBankRaw as unknown as QuestionBank;

/**
 * Task 10. The shape `GET .../evidence` actually returns (Task 6's
 * `listEvidenceForAssessment`) is a superset of what `EvidenceAttach`
 * needs to render — this repo's `Evidence` Prisma model also carries
 * `mimeType`, `sha256`, `remediationItemId`, `uploadedById`, etc.
 * `questionId` is the one extra field THIS component needs, to group the
 * flat list by question; nothing here reads any of the others, so they are
 * left untyped rather than hand-copying the full row shape.
 */
type EvidenceRow = EvidenceAttachItem & { questionId: string | null };

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
   * D-129: server-derived (`can(ctx.role, 'assessment:respond'/
   * 'assessment:complete')`, computed in this directory's `page.tsx` from
   * the membership row, never from client input) — the ONLY thing these
   * props are allowed to change is whether respond/complete-shaped
   * controls RENDER as usable. They do not, and must not, weaken the
   * server-side authorization on the PATCH/complete routes this page
   * calls — those already independently enforce `assessment:respond`/
   * `assessment:complete` (verified live, Task 12) and are untouched by
   * this fix.
   */
  canRespond: boolean;
  /** Round 2: "Complete {stage}" is a distinct action from responding —
   * gated on its own grant rather than reusing `canRespond`, per the
   * coordinator's explicit instruction. Today's `lib/authz/policy.ts`
   * GRANTS table happens to give every role `assessment:respond` and
   * `assessment:complete` together, so this is not independently provable
   * by any CURRENT role's behaviour — using the semantically correct
   * action for the actual action being performed is still the right
   * thing to do, and stops being redundant the moment the grant table
   * ever separates the two. */
  canComplete: boolean;
  /** Task 10: same posture as `canComplete` above — `evidence:create`/
   * `evidence:delete` are their OWN actions in `lib/authz/policy.ts`, never
   * reused from `canRespond`, even though owner/admin/assessor hold all
   * three together today. Derived server-side in `page.tsx` via `can()`. */
  canCreateEvidence: boolean;
  canDeleteEvidence: boolean;
}

export default function AssessmentPageClient({
  canRespond,
  canComplete,
  canCreateEvidence,
  canDeleteEvidence,
}: AssessmentPageClientProps) {
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

  // D-012/D-131: Quick Check's interactive flow was retired and deleted
  // (formerly `components/assessment/QuickAssessment.tsx`). `mode` stays a
  // union of `'full' | 'quick'` because the `AssessmentMode.quick` enum
  // value itself was NOT retired — existing rows still carry it (D-012's
  // own disposition) — so this state still has to distinguish them, just
  // to render the retired-flow notice below instead of the old
  // interactive component. `quickScore` is shown INLINE in that notice,
  // not via a link to `/report` — found live while verifying this change:
  // `lib/data/assessments.ts#completeAssessment` always persists a quick
  // assessment's `reportData` with `completedStages: []` (quick mode has
  // no lifecycle stages to report), and `report/page.tsx` treats
  // `completedStages.length === 0` as "No Assessment Data Found" — a
  // pre-existing shape mismatch that predates this change but was never
  // reachable before, since the old `QuickAssessment.tsx` showed its
  // score inline and never linked to `/report`. Linking to it here would
  // have been a NEW broken path this change introduced; showing the score
  // directly (the same data the old component displayed) avoids it
  // without touching the unrelated report page.
  const [mode, setMode] = useState<'full' | 'quick'>('full');
  const [projectId, setProjectId] = useState('');
  const [quickCompleted, setQuickCompleted] = useState(false);
  const [quickScore, setQuickScore] = useState<number | null>(null);

  // Stage selection is in-page state (not URL-based)
  const [selectedStage, setSelectedStage] = useState<string | null>(null);
  const [currentModuleIdx, setCurrentModuleIdx] = useState(0);

  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});
  const [showValidationBanner, setShowValidationBanner] = useState(false);
  const [showCompletionModal, setShowCompletionModal] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);

  // Task 10: evidence attach UI state, owned here — the same "one owner,
  // threaded down as props" shape `engineState`/`responses` already use.
  // `evidence` stays `null` until the first successful fetch (or forever,
  // on repeated failure) rather than defaulting to `[]`. `evidenceLoading`
  // (fix round 1) is the THIRD state that makes that actually true: without
  // it, the window between mount and the fetch resolving had `items: []`
  // with `loadError: false` on every question — indistinguishable from
  // "confirmed empty", which is exactly the case this comment originally
  // claimed could not happen (reviewer finding, fix round 1). `loading`
  // starts `true` and is cleared once the fetch settles, success or not.
  const [evidence, setEvidence] = useState<EvidenceRow[] | null>(null);
  const [evidenceLoading, setEvidenceLoading] = useState(true);
  const [evidenceListError, setEvidenceListError] = useState(false);
  const [evidenceBusy, setEvidenceBusy] = useState<Record<string, boolean>>({});
  const [evidenceErrors, setEvidenceErrors] = useState<Record<string, string>>({});
  /**
   * Fix round 2 (Important, reviewer finding): per-question, distinct from
   * `evidenceListError` above. A mutation for question Q can SUCCEED while
   * the confirmation re-fetch that follows it fails — the write is correct
   * server-side, only the display might not reflect it. Before this round,
   * that combination was completely silent for any question whose list was
   * already non-empty (the common case): the only failure signal
   * (`evidenceListError`) is gated by `EvidenceAttach` behind
   * `items.length === 0`, which a question with existing evidence never
   * satisfies. Set in `handleEvidenceUpload`/`handleEvidenceDelete` via
   * `mutateThenConfirm`'s `confirm-failed` result; cleared for EVERY
   * question at once inside `fetchEvidence`'s own success branch, since a
   * successful full re-fetch re-confirms everything, not just the one
   * question that triggered it.
   *
   * D-170 (conscious scope boundary, not an oversight): only the MUTATED
   * question gets this signal. A sibling question that already had
   * evidence, wasn't just touched, gets nothing even though the same
   * global fetch failure means its display is equally unconfirmed —
   * extending this to every question is the pre-existing shared-flag
   * question (`evidenceListError`/`evidenceLoading`) this round was
   * explicitly told not to restructure.
   */
  const [evidenceStale, setEvidenceStale] = useState<Record<string, boolean>>({});

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
          // D-012/D-131: never load a legacy quick-mode row's
          // `{ mode: 'quick', quick: { responses } }` blob into
          // `engineState` — that shape is not a valid full-lifecycle
          // engine state, and letting the full-assessment flow below
          // write to it (via autoSave) would silently overwrite/corrupt
          // the original quick responses while the DB `mode` column
          // still reads `'quick'`. Only the completion flag and score are
          // needed to render the retired-flow notice.
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

  // Task 10: evidence list. Independent of the main assessment fetch above
  // — `evidence:read` is a separate action from `assessment:read` and this
  // is a genuinely separate resource. Non-fatal on failure, matching
  // `autoSave`'s own established "failures are silent — user can retry"
  // precedent below: the assessment itself stays fully usable, only the
  // evidence section degrades.
  //
  // Fix round 1 (silent-failure-hunter finding, HIGH): extracted from an
  // effect-local function into a stable `useCallback` so `handleEvidence
  // Upload`/`handleEvidenceDelete` below can call it too, on their own
  // success — NOT the optimistic local patch this used to do
  // (`setEvidence(prev => [row, ...(prev ?? [])])`). That patch was a real
  // bug: if the initial fetch had failed (`evidenceListError` true,
  // `evidence` still `null`), a subsequent successful upload replaced
  // `null` with a ONE-ITEM array containing only the just-uploaded file —
  // `items.length` became 1, so `EvidenceAttach` stopped showing the
  // load-failure message for that question and rendered the single new row
  // as though it were that question's complete, confirmed evidence set,
  // silently hiding whatever else may already have existed server-side.
  // Re-fetching the authoritative list after every successful mutation
  // fixes this directly (never present a locally-patched partial view as
  // confirmed-complete) and, as a side effect, self-heals
  // `evidenceListError` the moment any request to this endpoint next
  // succeeds — it used to only ever be set, never cleared.
  //
  // Uses the same `isMountedRef` `fetchAssessment` above already
  // maintains (a single component-lifetime signal) rather than a second,
  // effect-local `cancelled` closure — this function is no longer
  // effect-local, so a per-effect closure variable would not cover the
  // calls made from the mutation handlers.
  //
  // Fix round 2 (Important, reviewer finding): now returns `Promise<boolean>`
  // (success/failure) instead of swallowing the outcome entirely. Round 1
  // made mutation success call this function for its side effects, but gave
  // the caller no way to learn THIS call — as opposed to the mutation
  // itself — failed; `handleEvidenceUpload`/`handleEvidenceDelete` below
  // (via `mutateThenConfirm`) use the return value to distinguish "your
  // change failed" from "your change was saved but could not be confirmed",
  // which they could not do when this returned nothing. The mount effect
  // below still doesn't need the return value and ignores it, exactly as it
  // did before this change — a function's contract can be strengthened for
  // one caller without the other having to consume the addition.
  const fetchEvidence = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch(`${apiBase}/evidence`);
      if (!res.ok) {
        console.error('evidence list fetch failed', res.status);
        if (isMountedRef.current) setEvidenceListError(true);
        return false;
      }
      const data = await res.json();
      if (isMountedRef.current) {
        setEvidence(data);
        setEvidenceListError(false);
        // A successful full re-fetch reconfirms EVERY question's evidence,
        // not just whichever one's mutation triggered this call — so every
        // stale flag is cleared here, in the one place that actually knows
        // the list is fresh again, rather than only the triggering
        // question's flag.
        setEvidenceStale({});
      }
      return true;
    } catch (e) {
      console.error('evidence list fetch failed', e);
      if (isMountedRef.current) setEvidenceListError(true);
      return false;
    } finally {
      if (isMountedRef.current) setEvidenceLoading(false);
    }
  }, [apiBase]);

  // D-184: `fetchEvidence` is a `useCallback` also called directly by
  // `handleEvidenceUpload`/`handleEvidenceDelete` below (via
  // `mutateThenConfirm`), so — unlike `fetchAssessment` above — it cannot be
  // rewritten as a function purely-local to this effect; it has to keep
  // existing outside it. Calling it bare here (`fetchEvidence();`) trips
  // `react-hooks/set-state-in-effect`: the rule's static analysis flags a
  // direct, top-level call from an effect body to an externally-defined
  // function it can prove sets state, but does not follow the same call
  // through a NEW nested function boundary — confirmed empirically (isolated
  // probe file, deleted after use) against `void fn()` and `fn().catch(...)`,
  // both of which stayed flagged, versus a local wrapper, which did not, in
  // every variant tried (sync, async, IIFE, queueMicrotask, setTimeout).
  // Wrapping the call in a local function satisfies the rule; it stays
  // synchronous rather than `async`/`await` because `fetchEvidence`'s own
  // try/catch/finally above never lets its promise reject and this call
  // site discards the return value either way, so `await` here would add a
  // keyword without changing anything observable. `fetchEvidence` itself is
  // unchanged from its contract documented above. Do not "simplify" this
  // back to a bare call — that reintroduces the lint error this comment
  // exists to explain.
  useEffect(() => {
    function run() {
      fetchEvidence();
    }
    run();
  }, [fetchEvidence]);

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

  // Task 10: groups the flat evidence list by questionId so each
  // QuestionBlock/EvidenceAttach only ever sees its OWN slice — neither
  // needs to know about, or filter out, any other question's evidence.
  const evidenceByQuestion = useMemo(() => {
    const map: Record<string, EvidenceRow[]> = {};
    for (const item of evidence ?? []) {
      if (item.questionId) (map[item.questionId] ??= []).push(item);
    }
    return map;
  }, [evidence]);

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

  // Task 10: evidence mutation handlers. Both check `res.ok` BEFORE parsing
  // the body, and wrap the error-branch `res.json()` in `.catch(() => null)`
  // — D-145 is a pre-existing, client-wide bug where calling `res.json()`
  // unconditionally, before checking `res.ok`, throws on a non-JSON error
  // body and a bare `catch` replaces the server's real message with a fixed
  // generic one. That shape is deliberately NOT reproduced here: a failed
  // parse still degrades to a generic message via `data?.error ?? ...`
  // rather than falling through to the outer `catch`. D-145 itself (the 8
  // pre-existing call sites elsewhere in the client tree) is unchanged —
  // fixing those is a client-wide refactor outside this task's named files.
  //
  // Fix round 1 (silent-failure-hunter findings):
  //  - HIGH: on success, both now call `fetchEvidence()` to re-fetch the
  //    authoritative list rather than locally patching `evidence` with just
  //    the one row this request touched — see `fetchEvidence`'s own comment
  //    above for why the old optimistic-patch shape was a real bug.
  //  - MEDIUM: every failure branch now logs via `console.error`, matching
  //    the sibling precedent at `app/(authenticated)/orgs/[slug]/layout.tsx`
  //    (a swallowed non-fatal client failure made observable for exactly
  //    the same reason, per that file's own comment) and this same
  //    feature's server-side routes (both evidence routes already log on
  //    every rejection branch). Previously: zero client-side trace on a
  //    true 500/non-JSON-body path — narrower than D-145 (which is about
  //    the wrong *shape*; this code already had the right shape) but a
  //    real, separate gap on the rarer failure path within it.
  //  - LOW: both now guard every `setState` call with `isMountedRef.current`
  //    for consistency with `fetchAssessment`/`fetchEvidence` above — not
  //    a live bug under React 18+ (post-unmount `setState` is a documented
  //    no-op), but the file's other two fetches already follow this
  //    pattern and these two silently didn't.
  //
  // Fix round 2 (Important, reviewer finding): round 1's `await
  // fetchEvidence();` call ignored its outcome — `fetchEvidence` swallows
  // its own failures internally (logs, sets the global `evidenceListError`
  // flag) and cannot throw, so a re-fetch failure right after a SUCCESSFUL
  // mutation was invisible to these handlers, and `EvidenceAttach` only
  // ever showed `evidenceListError` for a question whose `items` was
  // already empty — never true right after a successful upload/delete on a
  // question that already had evidence. Both handlers now route the
  // mutation through `mutateThenConfirm` (lib/evidence/mutateThenConfirm.ts,
  // extracted specifically so this sequencing is unit-testable — this file
  // has no unit tests of its own, D-169) and branch on its three-way
  // result: `mutate-failed` -> the existing `evidenceErrors` channel
  // (unchanged from round 1); `confirm-failed` -> the NEW `evidenceStale`
  // channel, NEVER `evidenceErrors` — the write genuinely succeeded, so
  // reporting it through the "your action failed" channel would be a
  // different, worse lie; `ok` -> nothing further to do, the list is fresh.
  const handleEvidenceUpload = useCallback(async (qId: string, file: File) => {
    setEvidenceErrors((prev) => { const n = { ...prev }; delete n[qId]; return n; });
    setEvidenceBusy((prev) => ({ ...prev, [qId]: true }));
    try {
      const result = await mutateThenConfirm(async () => {
        const formData = new FormData();
        formData.set('file', file);
        formData.set('questionId', qId);
        const res = await fetch(`${apiBase}/evidence`, { method: 'POST', body: formData });
        if (res.ok) return { ok: true as const };
        const data = await res.json().catch(() => null);
        console.error('evidence upload failed', res.status, data);
        return { ok: false as const, error: data?.error || 'Could not attach this file.' };
      }, fetchEvidence);
      if (!isMountedRef.current) return;
      if (result.kind === 'mutate-failed') {
        setEvidenceErrors((prev) => ({ ...prev, [qId]: result.error }));
      } else if (result.kind === 'confirm-failed') {
        setEvidenceStale((prev) => ({ ...prev, [qId]: true }));
      }
    } catch (e) {
      console.error('evidence upload failed', e);
      if (isMountedRef.current) {
        setEvidenceErrors((prev) => ({ ...prev, [qId]: 'Something went wrong. Please try again.' }));
      }
    } finally {
      if (isMountedRef.current) setEvidenceBusy((prev) => ({ ...prev, [qId]: false }));
    }
  }, [apiBase, fetchEvidence]);

  const handleEvidenceDelete = useCallback(async (qId: string, evidenceId: string) => {
    setEvidenceErrors((prev) => { const n = { ...prev }; delete n[qId]; return n; });
    setEvidenceBusy((prev) => ({ ...prev, [qId]: true }));
    try {
      const result = await mutateThenConfirm(async () => {
        const res = await fetch(`/api/v1/orgs/${orgSlug}/evidence/${evidenceId}`, { method: 'DELETE' });
        if (res.ok) return { ok: true as const };
        const data = await res.json().catch(() => null);
        console.error('evidence delete failed', res.status, data);
        return { ok: false as const, error: data?.error || 'Could not delete this evidence.' };
      }, fetchEvidence);
      if (!isMountedRef.current) return;
      if (result.kind === 'mutate-failed') {
        setEvidenceErrors((prev) => ({ ...prev, [qId]: result.error }));
      } else if (result.kind === 'confirm-failed') {
        setEvidenceStale((prev) => ({ ...prev, [qId]: true }));
      }
    } catch (e) {
      console.error('evidence delete failed', e);
      if (isMountedRef.current) {
        setEvidenceErrors((prev) => ({ ...prev, [qId]: 'Something went wrong. Please try again.' }));
      }
    } finally {
      if (isMountedRef.current) setEvidenceBusy((prev) => ({ ...prev, [qId]: false }));
    }
  }, [orgSlug, fetchEvidence]);

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

  // D-012/D-131: Quick Check's interactive answer/submit flow has been
  // retired and deleted. The `AssessmentMode.quick` enum value was NOT
  // retired — existing rows still carry it — so this branch stays only to
  // give a legacy `mode: 'quick'` row a safe, non-interactive landing
  // spot instead of falling through to the full-lifecycle flow below
  // (which would silently overwrite its quick-shaped `engineState` — see
  // the fetch effect's comment above).
  if (mode === 'quick') {
    return (
      <div className="assessment-page" id="assessment-page">
        <section className="section">
          <div className="container container--narrow" style={{ textAlign: 'center', padding: '4rem 0' }}>
            <span className="text-accent">Quick Check</span>
            <h1 style={{ marginTop: 'var(--space-2)' }}>Quick Check has been retired</h1>
            <p className="text-muted" style={{ maxWidth: 480, margin: 'var(--space-4) auto 0' }}>
              This assessment was started before Quick Check was retired.{' '}
              {quickCompleted
                ? 'Its result is preserved below.'
                : 'It can no longer be answered — start a full assessment instead.'}
            </p>
            {quickCompleted && quickScore !== null && (
              <div style={{ fontSize: 'var(--font-size-6xl)', fontWeight: 700, lineHeight: 1.1, marginTop: 'var(--space-4)' }}>
                {quickScore}%
              </div>
            )}
            <div style={{ display: 'flex', gap: 'var(--space-3)', justifyContent: 'center', marginTop: 'var(--space-6)', flexWrap: 'wrap' }}>
              <button
                className="btn btn--secondary"
                onClick={() => router.push(`/orgs/${orgSlug}/projects/${projectId}`)}
              >
                Back to project
              </button>
            </div>
          </div>
        </section>
      </div>
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
        canRestart={canRespond}
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
                    evidenceItems={evidenceByQuestion[q.id] ?? []}
                    evidenceLoading={evidenceLoading}
                    evidenceLoadError={evidenceListError}
                    evidenceStale={!!evidenceStale[q.id]}
                    canCreateEvidence={canCreateEvidence}
                    canDeleteEvidence={canDeleteEvidence}
                    evidenceBusy={!!evidenceBusy[q.id]}
                    evidenceError={evidenceErrors[q.id] ?? null}
                    orgSlug={orgSlug}
                    onEvidenceUpload={handleEvidenceUpload}
                    onEvidenceDelete={handleEvidenceDelete}
                  />
                ))}
              </div>

              <div className="assessment-nav">
                {currentModuleIdx > 0 && (
                  <button className="btn btn--secondary" onClick={() => { setCurrentModuleIdx(currentModuleIdx - 1); setShowValidationBanner(false); window.scrollTo(0, 0); }}>← Previous Module</button>
                )}
                {currentModuleIdx < modules.length - 1 ? (
                  <button className="btn btn--primary btn--arrow" onClick={handleNextModule} style={{ marginLeft: 'auto' }}>Next Module</button>
                ) : canComplete ? (
                  <button className="btn btn--green btn--large btn--arrow" onClick={handleCompleteStage} style={{ marginLeft: 'auto' }} id="complete-stage-btn">
                    Complete {cfg.label}
                  </button>
                ) : null}
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
        areaScores={calculateAreaScores(engineState, selectedStage)}
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
