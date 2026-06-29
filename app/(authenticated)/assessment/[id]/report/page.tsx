'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  STAGE_ORDER,
  stageLabels,
  levelLabels,
  levelColors,
  levelDescriptions,
} from '@/data/constants';
import {
  generateReportData,
  // @ts-ignore
} from '@/lib/engine/AssessmentEngine.js';
import { useEvidenceData, getLevel } from '@/components/report/useEvidenceData';
import { ReportSummary } from '@/components/report/ReportSummary';
import { InfluenceCard } from '@/components/report/InfluenceCard';
import { PrincipleScorecard } from '@/components/report/PrincipleScorecard';
import { AreaCard } from '@/components/report/AreaCard';
import '@/components/report/ReportPage.css';

export default function ReportPage() {
  const params = useParams();
  const router = useRouter();
  const assessmentId = params.id as string;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [engineState, setEngineState] = useState<any>(null);
  const [report, setReport] = useState<any>(null);
  const [expandedCards, setExpandedCards] = useState<Record<string, boolean>>({});
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});

  // Fetch assessment data from the API on mount
  useEffect(() => {
    async function fetchAssessment() {
      try {
        setLoading(true);
        const res = await fetch(`/api/assessments/${assessmentId}`);
        if (!res.ok) {
          throw new Error(`Failed to fetch assessment: ${res.status}`);
        }
        const assessment = await res.json();

        // If assessment status is not 'completed', redirect back to the assessment page
        if (assessment.status !== 'completed') {
          router.replace(`/assessment/${assessmentId}`);
          return;
        }

        const state = assessment.engineState;
        setEngineState(state);

        // Use cached reportData if available, otherwise generate client-side
        if (assessment.reportData) {
          setReport(assessment.reportData);
        } else if (state) {
          setReport(generateReportData(state));
        }
      } catch (err: any) {
        setError(err.message || 'Failed to load assessment');
      } finally {
        setLoading(false);
      }
    }

    fetchAssessment();
  }, [assessmentId, router]);

  // H-03 fix: Memoize evidence computation — called unconditionally (hooks rules)
  const evidenceData = useEvidenceData(report, engineState);

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
          <Link href={`/assessment/${assessmentId}`} className="btn btn--primary btn--large btn--arrow">Back to Assessment</Link>
        </div></section>
      </div>
    );
  }

  if (!report || report.completedStages.length === 0) {
    return (
      <div className="report-page" id="report-page">
        <section className="page-hero"><div className="container">
          <span className="text-accent">Readiness Report</span>
          <h1>No Assessment Data Found</h1>
          <p className="page-hero__desc">Complete at least one lifecycle stage to see your report.</p>
        </div></section>
        <section className="section"><div className="container" style={{ textAlign: 'center' }}>
          <Link href={`/assessment/${assessmentId}`} className="btn btn--primary btn--large btn--arrow">Back to Assessment</Link>
        </div></section>
      </div>
    );
  }

  const { completedStages, overallScore, stageScores, activeModifiers } = report;
  const overallLevel = getLevel(overallScore);
  const { allPrincipleResults, gaps, attentions, strengths, notAssessed, gapEvidence, attentionEvidence, strengthEvidence, controlsMap } = evidenceData;

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
              const avg = Object.values(scores).length > 0
                ? Math.round((Object.values(scores) as number[]).reduce((s, v) => s + v, 0) / Object.values(scores).length) : 0;
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
                    <strong>{label}</strong> ({key === 'low' ? '75–100%' : key === 'moderate' ? '50–74%' : key === 'high' ? '25–49%' : '0–24%'})
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
                    {activeModifiers.map((mod: any, idx: number) => (
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
                    {results.map((p: any) => (
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
                    {strengths.map((area: any) => (
                      <AreaCard
                        key={area.id}
                        area={area}
                        tier="strength"
                        evidence={strengthEvidence[area.id]}
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
                {attentions.map((area: any) => (
                  <AreaCard
                    key={area.id}
                    area={area}
                    tier="attention"
                    evidence={attentionEvidence[area.id]}
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
                  {gaps.map((gap: any) => (
                    <AreaCard
                      key={gap.id}
                      area={gap}
                      tier="gap"
                      evidence={gapEvidence[gap.id]}
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
                    {notAssessed.map((area: any) => (
                      <AreaCard
                        key={area.id}
                        area={area}
                        tier="not-assessed"
                        evidence={[]}
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
            <Link href={`/assessment/${assessmentId}`} className="btn btn--secondary">← Back to Assessment</Link>
            <a href={`/api/reports/${assessmentId}/pdf`} className="btn btn--primary btn--arrow" target="_blank" rel="noopener noreferrer" id="download-pdf-btn">
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
