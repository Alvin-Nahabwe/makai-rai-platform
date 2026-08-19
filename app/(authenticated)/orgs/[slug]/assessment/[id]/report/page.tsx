'use client';

import { useState, useEffect, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  STAGE_ORDER,
  stageLabels,
  levelLabels,
  levelColors,
  levelDescriptions,
} from '@/data/constants';
import type { AreaScoreMap, EngineState, EvidenceScore, ReportData, AssessmentArea, WeightExplanation } from '@/types/domain';
import { useFindingsData, getLevel, type PrincipleResult } from '@/components/report/useFindingsData';
import { isFrameworkDrifted } from '@/lib/report/provenance';
import { meanMaturity } from '@/lib/engine/AssessmentEngine.js';
import { ReportSummary } from '@/components/report/ReportSummary';
import { InfluenceCard } from '@/components/report/InfluenceCard';
import { PrincipleScorecard } from '@/components/report/PrincipleScorecard';
import { AreaCard } from '@/components/report/AreaCard';
import '@/components/report/ReportPage.css';

// `report.stageScores` (lib/engine/AssessmentEngine.js#generateReportData)
// is keyed ONLY by completed stages -- an area belonging to a stage the
// user hasn't started yet never gets an entry anywhere in it. The
// "Not yet assessed" section below draws from `assessmentAreas.json`'s
// full 21-area list regardless of completion, so it can and does contain
// areas from incomplete stages (any assessment short of all 3 stages hits
// this on every render). `areaScores[area.id]` is `undefined` for those,
// not an `EvidenceScore` with null fields -- this fallback stands in so
// AreaCard always receives a real (if empty) reading instead of throwing
// on `undefined.maturity`.
const NO_SCORE: EvidenceScore = { maturity: null, practices: null };

export default function ReportPage() {
  const params = useParams();
  const router = useRouter();
  const assessmentId = params.id as string;
  const orgSlug = params.slug as string;
  const apiBase = `/api/v1/orgs/${orgSlug}/assessments/${assessmentId}`;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [engineState, setEngineState] = useState<EngineState | null>(null);
  const [report, setReport] = useState<ReportData | null>(null);
  // O-15/O-14 (Task 9): the report's provenance -- which framework version
  // this assessment is pinned to, when it was pinned, and whether the
  // deployed content has since drifted from it. Set alongside `report` in
  // the SAME fetch below (both come from the same response, both gated by
  // the same `status === 'completed'` check), so the two are never set on
  // different renders.
  const [framework, setFramework] = useState<{
    semver: string;
    pinnedDate: string;
    contentHash: string;
    drifted: boolean;
  } | null>(null);
  const [expandedCards, setExpandedCards] = useState<Record<string, boolean>>({});
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});

  // Fetch assessment data from the API on mount
  useEffect(() => {
    async function fetchAssessment() {
      try {
        setLoading(true);
        const res = await fetch(apiBase);
        if (!res.ok) {
          throw new Error(`Failed to fetch assessment: ${res.status}`);
        }
        const assessment = await res.json();

        // If assessment status is not 'completed', redirect back to the assessment page
        if (assessment.status !== 'completed') {
          router.replace(`/orgs/${orgSlug}/assessment/${assessmentId}`);
          return;
        }

        const state = assessment.engineState;
        setEngineState(state);

        // C6 whole-branch review, F1 follow-up (found by `code-review` on
        // the F1 fix itself, which had closed this hole on the PDF route
        // and left it open here). This used to fall back to
        // `generateReportData(state)` when `reportData` was absent — and
        // that function scores through `AssessmentEngine.js`'s STATIC
        // imports of `data/questionBank.json` / `data/scoringConfig.json`,
        // i.e. today's deployed content, never the version this assessment
        // is pinned to. The provenance line rendered a few lines below
        // (`ReportSummary`, via `formatProvenanceLine`) would then have
        // asserted the pinned `contentHash` over numbers computed from
        // other content — the exact defect F1 names, on the other surface.
        //
        // No fallback now. `completeAssessment` (lib/data/assessments.ts)
        // is the only writer of `status: 'completed'` and writes
        // `reportData` in the same `tx.assessment.update`, and this effect
        // has already redirected away anything not completed, so a
        // completed assessment with no cached report is not reachable. If
        // one ever is, `report` stays null and the "No Assessment Data
        // Found" branch below renders — an honest empty state instead of
        // fabricated scores under a provenance line that cannot support
        // them.
        if (assessment.reportData) {
          setReport(assessment.reportData);
        }

        // O-15/O-14: `assessment.framework` and `assessment.startedAt` come
        // from the SAME GET this effect already made -- no second request.
        // Pin date is the assessment's own `startedAt` (the pin is written
        // once, at creation -- lib/report/provenance.ts#ProvenanceInfo),
        // not `framework_versions.publishedAt`.
        setFramework({
          semver: assessment.framework.semver,
          pinnedDate: (assessment.startedAt as string).split('T')[0],
          contentHash: assessment.framework.contentHash,
          drifted: isFrameworkDrifted(assessment.status, assessment.framework.matches),
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load assessment');
      } finally {
        setLoading(false);
      }
    }

    fetchAssessment();
  }, [assessmentId, apiBase, orgSlug, router]);

  // H-03 fix: Memoize findings computation — called unconditionally (hooks rules)
  const findingsData = useFindingsData(report, engineState);

  // Flat area id -> EvidenceScore map, so <AreaCard> call sites below (which
  // render cross-stage arrays from findingsData, not the per-stage `scores`
  // used in the lifecycle header) can look a score up by area id. Safe to
  // flatten across stages: area ids are globally unique (21 areas, 21
  // distinct ids, 7 per stage -- verified), unlike principle NAMES, which
  // recur across stages and would silently clobber on the same merge.
  // Computed unconditionally, before the loading/error/empty-report early
  // returns below, so this hook call's position never changes between
  // renders (rules of hooks) -- `report` may still be null here, hence the
  // `?? {}` fallback.
  // Explicit `AreaScoreMap` return type, not the `Object.assign({},
  // ...Object.values(...))` spread this replaced: TypeScript's spread
  // overload types that call as `any`, which silently discarded the
  // `areaScores[area.id]` type-level backstop (Task 5 review Minor). A
  // `reduce` merging each stage's map into an explicitly-typed accumulator
  // keeps `areaScores[area.id]` typed as `EvidenceScore | undefined`, same
  // behaviour: area ids are globally unique across stages (21 areas, 21
  // ids, 7 per stage -- verified), so merging stage maps left-to-right
  // never clobbers one area's score with another's.
  const areaScores = useMemo<AreaScoreMap>(
    () => Object.values(report?.stageScores ?? {}).reduce<AreaScoreMap>(
      (acc, stageScoreMap) => Object.assign(acc, stageScoreMap),
      {},
    ),
    [report],
  );

  if (loading) {
    return (
      <div className="report-page" id="report-page">
        <section className="page-hero"><div className="container">
          <span className="text-accent">Readiness Report</span>
          <h1>Loading Report…</h1>
          <p className="page-hero__desc">Fetching your assessment data.</p>
        </div></section>
      </div>
    );
  }

  if (error) {
    return (
      <div className="report-page" id="report-page">
        <section className="page-hero"><div className="container">
          <span className="text-accent">Readiness Report</span>
          <h1>Error Loading Report</h1>
          <p className="page-hero__desc">{error}</p>
        </div></section>
        <section className="section"><div className="container" style={{ textAlign: 'center' }}>
          <Link href={`/orgs/${orgSlug}/assessment/${assessmentId}`} className="btn btn--primary btn--large btn--arrow">Back to Assessment</Link>
        </div></section>
      </div>
    );
  }

  // `framework` is set in the SAME fetch, gated by the SAME `status ===
  // 'completed'` check, as `report` above -- not believed reachable for one
  // to be set without the other, handled anyway rather than trusting that
  // belief (same posture the two GET routes this page's fetch calls take
  // for their own analogous "not believed reachable" branches).
  if (!report || report.completedStages.length === 0 || !framework) {
    return (
      <div className="report-page" id="report-page">
        <section className="page-hero"><div className="container">
          <span className="text-accent">Readiness Report</span>
          <h1>No Assessment Data Found</h1>
          <p className="page-hero__desc">Complete at least one lifecycle stage to see your report.</p>
        </div></section>
        <section className="section"><div className="container" style={{ textAlign: 'center' }}>
          <Link href={`/orgs/${orgSlug}/assessment/${assessmentId}`} className="btn btn--primary btn--large btn--arrow">Back to Assessment</Link>
        </div></section>
      </div>
    );
  }

  const { completedStages, overallScore, stageScores, activeModifiers } = report;
  const overallLevel = getLevel(overallScore);
  const { allPrincipleResults, gaps, attentions, strengths, notAssessed, gapEvidence, attentionEvidence, strengthEvidence, controlsMap, practiceItems } = findingsData;

  const toggleSection = (name: string) => setCollapsedSections(prev => ({ ...prev, [name]: !prev[name] }));
  const toggleCard = (name: string) => setExpandedCards(prev => ({ ...prev, [name]: !prev[name] }));

  return (
    <div className="report-page" id="report-page">
      <section className="page-hero page-hero--animated">
        <div className="page-hero__bg"></div>
        <div className="page-hero__grid-overlay"></div>
        <div className="page-hero__accent-line"></div>
        <div className="container" style={{ position: 'relative', zIndex: 2 }}>
          <span className="text-accent">Lifecycle Assessment Report</span>
          <h1>AI Readiness Report</h1>
          <p className="page-hero__desc">
            {completedStages.length} of 3 lifecycle stages assessed •
            Generated {new Date(report.generatedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
          </p>
        </div>
      </section>

      <section className="section">
        <div className="container">

          {/* Lifecycle Progress Header */}
          <div className="lifecycle-header" id="lifecycle-header">
            {STAGE_ORDER.map(stage => {
              const isCompleted = completedStages.includes(stage);
              const cfg = stageLabels[stage];
              const scores = stageScores[stage] || {};
              // meanMaturity (lib/engine/AssessmentEngine.js) excludes null
              // maturity readings from the average rather than zeroing them
              // -- the same rule Task 3 applied to the overall score.
              // `scores` is one stage's AreaScoreMap; wrapping it in a
              // single-element array reproduces exactly this one stage's
              // mean, the same shape meanMaturity already averages over for
              // multiple stages. Falls back to 0 only when there is nothing
              // to average at all, matching generateReportData's own
              // null-to-0 boundary coercion for a display context that must
              // stay a plain number.
              const avg = meanMaturity([scores]) ?? 0;
              return (
                <div key={stage} className={`lifecycle-header__stage ${isCompleted ? 'lifecycle-header__stage--done' : 'lifecycle-header__stage--pending'}`}>
                  <span className="lifecycle-header__label" style={{ color: isCompleted ? cfg.color : '#999' }}>{cfg.label}</span>
                  <span className="lifecycle-header__score">{isCompleted ? `${avg}% ✓` : '— Pending'}</span>
                </div>
              );
            })}
            <div className="lifecycle-header__overall">
              <span className="lifecycle-header__overall-label">Overall</span>
              <span className="lifecycle-header__overall-score" style={{ color: levelColors[overallLevel] }}>{overallScore}%</span>
            </div>
          </div>

          {/* Maturity Legend */}
          <div className="maturity-legend" id="maturity-legend">
            <h4>Maturity Levels</h4>
            <div className="maturity-legend__items">
              {Object.entries(levelLabels).map(([key, label]) => (
                <div key={key} className="maturity-legend__item">
                  <span className="maturity-legend__dot" style={{ backgroundColor: levelColors[key] }}></span>
                  <div>
                    <strong>{label}</strong> ({key === 'strong' ? '75–100%' : key === 'developing' ? '50–74%' : key === 'needsWork' ? '25–49%' : '0–24%'})
                    <p>{levelDescriptions[key]}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Executive Summary */}
          <ReportSummary
            overallScore={overallScore}
            overallLevel={overallLevel}
            completedStagesCount={completedStages.length}
            strengthsCount={strengths.length}
            attentionsCount={attentions.length}
            gapsCount={gaps.length}
            activeModifiersCount={activeModifiers.length}
            levelLabels={levelLabels}
            levelColors={levelColors}
            frameworkSemver={framework.semver}
            frameworkPinnedDate={framework.pinnedDate}
            frameworkContentHash={framework.contentHash}
            frameworkDrifted={framework.drifted}
            scoringVersion={report?.scoringVersion}
          />

          {/* Cross-Stage Influence Analysis */}
          {activeModifiers.length > 0 && (
            <div className="report-section" id="cross-stage-influence">
              <h2 className="report-section__heading">
                <button className="section-toggle-btn" onClick={() => toggleSection('cross-stage')} aria-expanded={!collapsedSections['cross-stage']}>
                  Cross-stage influence analysis
                  <span className="report-section__chevron">{collapsedSections['cross-stage'] ? '▶' : '▼'}</span>
                </button>
              </h2>
              {!collapsedSections['cross-stage'] && (
                <>
                  <p className="text-muted">Responses from earlier stages caused these later-stage questions to be weighted more heavily.</p>
                  <div className="influence-cards">
                    {activeModifiers.map((mod: WeightExplanation, idx: number) => (
                      <InfluenceCard key={idx} mod={mod} />
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {/* Per-stage Principle Scorecards */}
          {completedStages.map((stage: string) => {
            const cfg = stageLabels[stage as keyof typeof stageLabels];
            const results = allPrincipleResults[stage] || [];
            return (
              <div key={stage} className="report-section" id={`principles-${stage}`}>
                <h2 className="report-section__heading" style={{ borderLeft: `4px solid ${cfg?.color}`, paddingLeft: '12px' }}>
                  <button className="section-toggle-btn" onClick={() => toggleSection(`principles-${stage}`)} aria-expanded={!collapsedSections[`principles-${stage}`]}>
                    {cfg?.label} — Principle Readiness
                    <span className="report-section__chevron">{collapsedSections[`principles-${stage}`] ? '▶' : '▼'}</span>
                  </button>
                </h2>
                {!collapsedSections[`principles-${stage}`] && (
                  <div className="scorecards-grid">
                    {results.map((p: PrincipleResult) => (
                      <PrincipleScorecard key={p.name} principle={p} />
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          {/* Areas of Strength — green tier */}
          {strengths.length > 0 && (
            <div className="report-section" id="strength-areas">
              <h2 className="report-section__heading">
                <button className="section-toggle-btn" onClick={() => toggleSection('strengths')} aria-expanded={!collapsedSections['strengths']}>
                  Areas of strength <span className="report-section__count">({strengths.length})</span>
                  <span className="report-section__chevron">{collapsedSections['strengths'] ? '▶' : '▼'}</span>
                </button>
              </h2>
              {!collapsedSections['strengths'] && (
                <>
                  <p className="text-muted">
                    These areas are well addressed based on your assessment responses. Keep maintaining these practices.
                  </p>
                  <div className="gaps-list">
                    {strengths.map((area: AssessmentArea) => (
                      <AreaCard
                        key={area.id}
                        area={area}
                        tier="strength"
                        score={areaScores[area.id] ?? NO_SCORE}
                        findings={strengthEvidence[area.id]}
                        practices={practiceItems[area.id]}
                        controlsMap={controlsMap}
                        stageLabels={stageLabels}
                        expanded={expandedCards[`strength-${area.id}`]}
                        onToggle={() => toggleCard(`strength-${area.id}`)}
                      />
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {/* Areas to Strengthen — amber tier */}
          {attentions.length > 0 && (
            <div className="report-section" id="attention-areas">
              <h2 className="report-section__heading">
                <button className="section-toggle-btn" onClick={() => toggleSection('attention')} aria-expanded={!collapsedSections['attention']}>
                  Areas to strengthen <span className="report-section__count">({attentions.length})</span>
                  <span className="report-section__chevron">{collapsedSections['attention'] ? '▶' : '▼'}</span>
                </button>
              </h2>
              {!collapsedSections['attention'] && (
                <>
                  <p className="text-muted">
                    These areas are partially addressed but could be strengthened. They aren&apos;t critical blockers, but reviewing them will improve your overall readiness.
                  </p>
              <div className="gaps-list">
                {attentions.map((area: AssessmentArea) => (
                  <AreaCard
                    key={area.id}
                    area={area}
                    tier="attention"
                    score={areaScores[area.id] ?? NO_SCORE}
                    findings={attentionEvidence[area.id]}
                    practices={practiceItems[area.id]}
                    controlsMap={controlsMap}
                    stageLabels={stageLabels}
                    expanded={expandedCards[`attention-${area.id}`]}
                    onToggle={() => toggleCard(`attention-${area.id}`)}
                  />
                ))}
              </div>
                </>
              )}
            </div>
          )}

          {/* Identified Gaps — red/orange tier */}
          <div className="report-section" id="identified-gaps">
            <h2 className="report-section__heading">
              <button className="section-toggle-btn" onClick={() => toggleSection('gaps')} aria-expanded={!collapsedSections['gaps']}>
                Identified readiness gaps <span className="report-section__count">({gaps.length})</span>
                <span className="report-section__chevron">{collapsedSections['gaps'] ? '▶' : '▼'}</span>
              </button>
            </h2>
            {collapsedSections['gaps'] ? null : (
              gaps.length === 0 ? (
                <div className="report-empty"><p>No gaps found — you&apos;re looking good.</p></div>
              ) : (
                <div className="gaps-list">
                  {gaps.map((gap: AssessmentArea) => (
                    <AreaCard
                      key={gap.id}
                      area={gap}
                      tier="gap"
                      score={areaScores[gap.id] ?? NO_SCORE}
                      findings={gapEvidence[gap.id]}
                      practices={practiceItems[gap.id]}
                      controlsMap={controlsMap}
                      stageLabels={stageLabels}
                      expanded={expandedCards[`gap-${gap.id}`]}
                      onToggle={() => toggleCard(`gap-${gap.id}`)}
                    />
                  ))}
                </div>
              )
            )}
          </div>

          {/* Not Yet Assessed — neutral tier (C1) */}
          {notAssessed.length > 0 && (
            <div className="report-section" id="not-assessed-areas">
              <h2 className="report-section__heading">
                <button className="section-toggle-btn" onClick={() => toggleSection('notAssessed')} aria-expanded={!collapsedSections['notAssessed']}>
                  Not yet assessed <span className="report-section__count">({notAssessed.length})</span>
                  <span className="report-section__chevron">{collapsedSections['notAssessed'] ? '▶' : '▼'}</span>
                </button>
              </h2>
              {!collapsedSections['notAssessed'] && (
                <>
                  <p className="text-muted">
                    These areas have no assessment data yet. Complete additional lifecycle stages to see results.
                  </p>
                  <div className="gaps-list">
                    {notAssessed.map((area: AssessmentArea) => (
                      <AreaCard
                        key={area.id}
                        area={area}
                        tier="not-assessed"
                        score={areaScores[area.id] ?? NO_SCORE}
                        findings={[]}
                        practices={practiceItems[area.id]}
                        controlsMap={controlsMap}
                        stageLabels={stageLabels}
                        expanded={false}
                        onToggle={() => {}}
                      />
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {/* Actions */}
          <div className="report-actions" id="report-actions">
            <Link href={`/orgs/${orgSlug}/assessment/${assessmentId}`} className="btn btn--secondary">← Back to Assessment</Link>
            <a href={`/api/v1/orgs/${orgSlug}/reports/${assessmentId}/pdf`} className="btn btn--primary btn--arrow" target="_blank" rel="noopener noreferrer" id="download-pdf-btn">
              Download PDF
            </a>
            <button className="btn btn--secondary" onClick={() => window.print()} id="print-report-btn">
              Print / Export PDF
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
