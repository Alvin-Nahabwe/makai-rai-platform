'use client';

import Link from 'next/link';
import type { StageConfig } from '@/data/constants';
import type { Control } from '@/types/domain';

interface TierConfig {
  modifier: string;
  idStyle: React.CSSProperties | null;
  badgeStyle: React.CSSProperties;
  badgeText: string | null;
  evidenceHeader?: string;
  expandable: boolean;
  evidenceBadgeStyle?: React.CSSProperties | null;
  collapsedLabel?: string;
  expandedLabel?: string;
}

/**
 * Tier-specific configuration for card styling, badge text, and behavior.
 */
const TIER_CONFIG: Record<Tier, TierConfig> = {
  strength: {
    modifier: 'gap-card--strength',
    idStyle: { color: '#16A34A', background: '#DCFCE7' } as React.CSSProperties,
    badgeStyle: { background: '#DCFCE7', color: '#15803D' } as React.CSSProperties,
    badgeText: 'Strong',
    evidenceHeader: 'Maintain these practices',
    expandable: true,
    evidenceBadgeStyle: { background: '#DCFCE7', color: '#15803D', border: '1px solid #86EFAC' } as React.CSSProperties,
    collapsedLabel: '▼ Show evidence',
    expandedLabel: '▲ Hide evidence',
  },
  attention: {
    modifier: 'gap-card--attention',
    idStyle: null as React.CSSProperties | null,
    badgeStyle: { background: '#FBBF24', color: '#78350F' } as React.CSSProperties,
    badgeText: 'Attention',
    evidenceHeader: 'Suggested improvements',
    expandable: true,
    evidenceBadgeStyle: { background: '#FEF3C7', color: '#92400E', border: '1px solid #F59E0B' } as React.CSSProperties,
    collapsedLabel: '▼ Show evidence & suggested actions',
    expandedLabel: '▲ Hide details',
  },
  gap: {
    modifier: '',
    idStyle: null as React.CSSProperties | null,
    badgeStyle: {} as React.CSSProperties,
    badgeText: null as string | null,
    evidenceHeader: 'Suggested mitigations',
    expandable: true,
    evidenceBadgeStyle: null as React.CSSProperties | null,
    collapsedLabel: '▼ Show evidence & mitigations',
    expandedLabel: '▲ Hide details',
  },
  'not-assessed': {
    modifier: 'gap-card--not-assessed',
    idStyle: { color: '#6B7280', background: '#F3F4F6' } as React.CSSProperties,
    badgeStyle: { background: '#F3F4F6', color: '#6B7280' } as React.CSSProperties,
    badgeText: null as string | null,
    expandable: false,
  },
};

type Tier = 'strength' | 'attention' | 'gap' | 'not-assessed';

interface EvidenceItemData {
  questionId: string;
  questionText: string;
  stage: string;
  reason: string;
  detail?: string;
  tier: string;
}

interface EvidenceItemsProps {
  evidence: EvidenceItemData[];
  stageLabels: Record<string, StageConfig>;
  badgeStyle?: React.CSSProperties | null;
}

/**
 * Renders the evidence item list shared across all expandable tiers.
 */
function EvidenceItems({ evidence, stageLabels, badgeStyle }: EvidenceItemsProps) {
  return (evidence || []).map((ev, idx) => (
    <div key={idx} className="gap-evidence-item">
      <div className="gap-evidence-item__question">
        <span className="gap-evidence-item__qid">{ev.questionId}</span>
        <span className="gap-evidence-item__stage-tag">{stageLabels[ev.stage]?.label}</span>
        <span>{ev.questionText}</span>
      </div>
      <div className="gap-evidence-item__response">
        <span className="gap-evidence-item__badge" style={badgeStyle || undefined}>{ev.reason}</span>
        {ev.detail && ev.detail !== ev.reason && (
          <p className="gap-evidence-item__detail">{ev.detail}</p>
        )}
      </div>
    </div>
  ));
}

interface ControlsListProps {
  controls: string[];
  controlsMap: Record<string, Control>;
  header?: string;
}

/**
 * Renders the controls/mitigations list shared by gap and attention tiers.
 */
function ControlsList({ controls, controlsMap, header }: ControlsListProps) {
  return (
    <div className="gap-card__mitigations">
      <h5>{header}</h5>
      {controls.map(cId => {
        const ctrl = controlsMap[cId];
        if (!ctrl) return null;
        return (
          <div key={cId} className="mitigation-item">
            <span className={`mitigation-item__type mitigation-item__type--${ctrl.type}`}>{ctrl.type}</span>
            <div>
              <Link href={`/controls#${cId}`} style={{ color: 'var(--color-primary)', textDecoration: 'none', fontWeight: 600 }}>
                {ctrl.name}
              </Link>
              <p>{ctrl.description}</p>
            </div>
            {ctrl.notebook && <span className="badge badge--coming-soon">Coming Soon</span>}
            {ctrl.template && <span className="badge badge--low">Template</span>}
          </div>
        );
      })}
    </div>
  );
}

interface Area {
  id: string;
  name: string;
  description?: string;
  principle?: string;
  stage?: string;
  controls?: string[];
}

interface AreaCardProps {
  area: Area;
  tier: Tier;
  evidence: EvidenceItemData[];
  controlsMap: Record<string, Control>;
  stageLabels: Record<string, StageConfig>;
  expanded?: boolean;
  onToggle: () => void;
}

/**
 * A unified card component for gap, attention, strength, and not-assessed areas.
 * The `tier` prop determines styling, badge content, evidence display, and whether
 * controls/mitigations are shown.
 */
export function AreaCard({ area, tier, evidence, controlsMap, stageLabels, expanded, onToggle }: AreaCardProps) {
  const cfg = TIER_CONFIG[tier];
  const cardClass = `gap-card card${cfg.modifier ? ` ${cfg.modifier}` : ''}`;
  const cardId = `${tier === 'not-assessed' ? 'na' : tier}-${area.id}`;
  const badgeText = cfg.badgeText ?? stageLabels[area.stage || '']?.label;

  return (
    <div className={cardClass} id={cardId}>
      <div className="gap-card__header" onClick={cfg.expandable ? onToggle : undefined} style={cfg.expandable ? { cursor: 'pointer' } : undefined}>
        <span className="gap-card__id" style={cfg.idStyle || undefined}>{area.id}</span>
        <h4>{area.name}</h4>
        <span className="gap-card__stage-badge" style={cfg.badgeStyle}>{badgeText}</span>
        <span className="gap-card__principle-badge">{area.principle}</span>
      </div>
      <p className="gap-card__desc">{area.description}</p>

      {cfg.expandable && (
        <>
          <button className="evidence-toggle-btn" onClick={onToggle} aria-expanded={!!expanded}>
            {expanded ? cfg.expandedLabel : cfg.collapsedLabel}
          </button>

          {/* Strength: single evidence div, no mitigations */}
          {expanded && tier === 'strength' && (
            <div className="gap-card__evidence">
              <h5>Assessment evidence</h5>
              <h5>{cfg.evidenceHeader}</h5>
              <div className="gap-card__questions">
                <EvidenceItems evidence={evidence} stageLabels={stageLabels} badgeStyle={cfg.evidenceBadgeStyle} />
              </div>
            </div>
          )}

          {/* Attention: single evidence div with mitigations inside (guarded) */}
          {expanded && tier === 'attention' && (
            <div className="gap-card__evidence">
              <h5>Assessment evidence</h5>
              <div className="gap-card__questions">
                <EvidenceItems evidence={evidence} stageLabels={stageLabels} badgeStyle={cfg.evidenceBadgeStyle} />
              </div>
              {area.controls && area.controls.length > 0 && (
                <ControlsList controls={area.controls} controlsMap={controlsMap} header={cfg.evidenceHeader} />
              )}
            </div>
          )}

          {/* Gap: Fragment with evidence div + mitigations div as siblings */}
          {expanded && tier === 'gap' && (
            <>
              <div className="gap-card__evidence">
                <h5>Assessment evidence</h5>
                <div className="gap-card__questions">
                  <EvidenceItems evidence={evidence} stageLabels={stageLabels} badgeStyle={cfg.evidenceBadgeStyle} />
                </div>
              </div>
              <ControlsList controls={area.controls || []} controlsMap={controlsMap} header={cfg.evidenceHeader} />
            </>
          )}
        </>
      )}
    </div>
  );
}
