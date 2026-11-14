import type { ReactElement } from 'react';
import { ArchivedBanner } from '@/components/project/ArchivedBanner';
import { CloseByDecisionButton } from '@/components/findings/CloseByDecisionButton';
import { FindingActions } from '@/components/findings/FindingActions';
import { AcceptRiskForm } from '@/components/findings/AcceptRiskForm';
import { LocalTime } from '@/components/ui/LocalTime';
import { MitigationFormToggle, MitigationStatusWord } from '@/components/findings/MitigationForm';
import { VersionEvidenceList } from '@/components/evidence/VersionEvidenceList';
import { FindingSuggestions, findingSuggestionCount } from '@/components/suggestions/FindingSuggestions';
import { SealMarker } from '@/components/review/SealMarker';
import { ListLink } from '@/components/ui/ListLink';
import { onlyRolesCanText } from '@/lib/findings/messages';
import { deciderLabel } from '@/lib/decision/copy';
import { formatDay } from '@/lib/format/dates';
import { overdueLabel, STAGE_NAMES } from '@/lib/findings/labels';
import { FINDINGS_COPY } from '@/lib/findings/copy';
import type { FindingPageData, MitigationOnPage } from '@/lib/findings/pageData';
import '@/components/ui/pageHeaderStyles';
import './Findings.css';

/**
 * S-15, one finding (W-5, W-6; SRS 7.4.2 S-15 row; FR-FND-01, 03 to 07, FR-FUP-05). No hooks: the page loads `FindingPageData`
 * and this renders it, so a unit test renders the markup without the loader. Regions in W-5's order: the archived banner,
 * the header, the "decision now done" box, the mitigations, the ways to address it, the ways to close it, the history.
 * Every name and text a team typed is rendered as text (NFR-SEC-11). The words are `FINDINGS_COPY`'s (lib/findings/copy.ts).
 * "Overdue" is the one red word (spec 7.1): its own span, never inside a status label; a finding's state and a mitigation's
 * status stay text in `.status-label` (register D-385: no kit mark exists for them).
 */

/** Between the parts of a line: a middle dot with a space each side, as the account pages write it. */
const SEP = FINDINGS_COPY.separator;
const F = FINDINGS_COPY.finding;
const M = FINDINGS_COPY.mitigation;

/** "<name> (<id>)", or the id alone when the content has no name for it. */
const named = (id: string, name: string | null): string => (name === null || name === '' ? id : F.namedId(name, id));

/** What every mitigation form needs from the page (the draft key's account and organisation, the owners who can act, the controls). */
function formProps(d: FindingPageData) {
  return {
    orgSlug: d.orgSlug, projectId: d.projectId, findingId: d.detail.id, owners: d.owners, controls: d.controls, userId: d.viewer.userId, orgId: d.orgId,
  };
}

function Mitigation({ d, m, controlName }: { d: FindingPageData; m: MitigationOnPage; controlName: (id: string) => string }): ReactElement {
  const v = m.current;
  const overdue = overdueLabel(v.dueDate);
  return (
    <li data-mitigation-id={v.mitigationId} className="finding-card">
      <p>{v.what === null ? null : <bdi>{v.what}</bdi>}</p>
      <p className="finding-card__line">
        {M.assignedTo} <bdi>{v.owner.name}</bdi>{v.owner.formerMember ? M.formerMember : ''}{SEP}{M.due(formatDay(v.dueDate))}{SEP}
        {m.overdue ? <><span className="finding-overdue">{overdue.label}</span>{overdue.rest}{SEP}</> : null}
        <MitigationStatusWord status={v.status} noArtefactNote={v.evidence.length === 0 ? v.closureNote : null} />{SEP}{M.version(v.versionNumber)}
      </p>
      {d.ownerCannotAct.includes(v.mitigationId) ? <p>{M.cannotAct}</p> : null}
      {v.followsControl === null ? null : <p>{M.controlUsed} <bdi>{named(v.followsControl, controlName(v.followsControl))}</bdi></p>}
      {v.cancelReason === null ? null : <p>{M.cancelReason} <bdi>{v.cancelReason}</bdi></p>}
      <VersionEvidenceList orgSlug={d.orgSlug} items={v.evidence} />
      {d.canMitigate && d.detail.state === 'open' && v.status !== 'cancelled' ? (
        <MitigationFormToggle label={F.updateMitigation} {...formProps(d)} base={v} />
      ) : null}
      <details className="finding-history">
        <summary>{M.historySummary(m.versions)}</summary>
        <ol>
          {m.history.map((h) => (
            <li key={h.id}>
              {M.historyVersion(h.versionNumber)} <LocalTime at={h.receivedAt} /> {M.by} <bdi>{h.enteredBy.name}</bdi>{M.assignedToClause} <bdi>{h.owner.name}</bdi>{M.dueClause(formatDay(h.dueDate))}
              {h.changeNote === null ? null : <> {M.changeNote} <bdi>{h.changeNote}</bdi></>}
            </li>
          ))}
        </ol>
      </details>
    </li>
  );
}

/** One line of the history, oldest first (W-5's last region). */
interface HistoryEntry { seq: number; at: string; by: string; text: ReactElement | string }

function historyOf(d: FindingPageData): HistoryEntry[] {
  const f = d.detail;
  const out: HistoryEntry[] = [{
    seq: 0, at: f.raisedAt, by: f.raisedBy.name,
    text: f.source === 'shortfall' && d.version !== null && f.questionId !== null
      ? M.raisedFromDecision(d.version.statusWord) : M.raisedByTeam,
  }];
  for (const e of f.events) out.push({ seq: e.findingSeq, at: e.at, by: e.by.name, text: <>{e.kind === 'reopened' ? M.reopened : M.withdrawn}{e.reason === null ? '.' : <>: <bdi>{e.reason}</bdi></>}</> });
  for (const m of d.mitigations) {
    for (const h of m.history) {
      out.push({ seq: h.findingSeq, at: h.receivedAt, by: h.enteredBy.name,
        text: <>{h.versionNumber === 1 ? M.added : M.updated(h.versionNumber)}{M.assignedToClause} <bdi>{h.owner.name}</bdi>{M.dueClause(formatDay(h.dueDate))}</> });
    }
  }
  for (const r of f.acceptedRisks) {
    out.push({ seq: r.findingSeq, at: r.receivedAt, by: r.enteredBy.name,
      text: <>{M.riskAcceptedBy} <bdi>{deciderLabel(r.acceptedBy, '', 'record')}</bdi>{r.reason === null ? '.' : <>: <bdi>{r.reason}</bdi></>}</> });
  }
  return out.sort((x, y) => x.seq - y.seq);
}

export function FindingPageView({ data }: { data: FindingPageData }): ReactElement {
  const d = data;
  const f = d.detail;
  const base = `/orgs/${d.orgSlug}/projects/${d.projectId}`;
  const controlName = (id: string) => d.controls.find((c) => c.id === id)?.name ?? '';
  // The suggestions section exists only for a risk area that has controls (S-12 does the same for its gate question).
  const waysArea = f.riskArea !== null && findingSuggestionCount({ contentSemver: d.contentSemver, riskArea: f.riskArea }) > 0 ? f.riskArea : null;
  const closed = f.state === 'closed_mitigation' || f.state === 'closed_accepted_risk';
  const closing = d.closeByDecision;
  const acceptedLine = f.state === 'closed_accepted_risk' && f.acceptedRisk !== null
    ? <>{F.acceptedHeaderStart}<bdi>{deciderLabel(f.acceptedRisk.acceptedBy, '', 'record')}</bdi>{F.acceptedHeaderOn(formatDay(f.acceptedRisk.receivedAt))}{f.acceptedRisk.lookAgainOn === null ? '' : F.checkAgainOn(formatDay(f.acceptedRisk.lookAgainOn))}</>
    : null;
  return (
    <div className="page-content finding-page">
      <ArchivedBanner archived={d.archived} />
      <ListLink href={`${base}/findings`} className="finding-back">{F.backToFindings}</ListLink>
      <header className="ui-page-header finding-header">
        <h1 className="ui-page-header__title"><bdi>{d.title}</bdi></h1>
        <p><bdi className="status-label">{d.stateLabel}</bdi></p>
        {acceptedLine === null ? null : <p>{acceptedLine}</p>}
        <p>
          {d.sourceLabel}{SEP}{STAGE_NAMES[f.stage]}
          {f.riskArea === null ? null : <>{SEP}{F.riskArea} <bdi>{named(f.riskArea, d.riskAreaName)}</bdi></>}
        </p>
        {d.questionText === null ? null : <p>{F.aboutQuestion} <bdi>{d.questionText}</bdi></p>}
        {f.source === 'shortfall' && d.version !== null
          ? <p>{F.raisedByPlatformOn} <LocalTime at={f.raisedAt} dateOnly />{F.raisedByPlatformWhen} <bdi>{f.raisedBy.name}</bdi> {F.savedDecisionAs(d.version.statusWord)}</p> : null}
        {f.source === 'team' ? <p>{F.raisedBy} <bdi>{f.raisedBy.name}</bdi> {F.on} <LocalTime at={f.raisedAt} dateOnly />.</p> : null}
        {f.description === null ? null : <p className="finding-description"><bdi>{f.description}</bdi></p>}
        <SealMarker seals={f.seals} />
      </header>
      {closing === null ? null : (
        <section aria-label={F.closeSection} className="finding-close-box">
          <p>
            {closing.reason === 'decision_withdrawn' ? F.closeWithdrawn
              : closing.reason === 'gate_no' ? F.closeGate
                : F.closeChanged(closing.statusWord)}
          </p>
          <CloseByDecisionButton orgSlug={d.orgSlug} projectId={d.projectId} findingId={f.id} decisionVersionId={closing.decisionVersionId} reason={closing.reason} findingTitle={d.title} />
        </section>
      )}
      <section aria-labelledby="f-mitigations" className="finding-section">
        <h2 id="f-mitigations">{F.mitigations}</h2>
        {d.mitigations.length === 0 ? (
          <p>{F.noMitigations}</p>
        ) : (
          <ul className="finding-cards">{d.mitigations.map((m) => <Mitigation key={m.current.mitigationId} d={d} m={m} controlName={controlName} />)}</ul>
        )}
        {d.canMitigate && f.state === 'open' ? <MitigationFormToggle label={F.addMitigation} {...formProps(d)} base={null} /> : null}
      </section>
      {waysArea === null ? null : (
        <section aria-labelledby="f-ways" className="finding-section">
          <h2 id="f-ways">{F.ways}</h2>
          <FindingSuggestions contentSemver={d.contentSemver} riskArea={waysArea} />
        </section>
      )}
      <section aria-labelledby="f-close" className="finding-section">
        <h2 id="f-close">{F.otherWays}</h2>
        <FindingActions
          orgSlug={d.orgSlug} projectId={d.projectId} findingId={f.id} findingTitle={d.title}
          closed={closed} withdrawn={f.state === 'withdrawn'} canReopen={d.canReopen} canWithdraw={d.canWithdraw}
          cannotAccept={d.canAccept ? null : d.archived ? null : onlyRolesCanText('risk:accept')}
          cannotReopen={d.archived ? null : onlyRolesCanText('finding:reopen')}
          acceptForm={d.canAccept && (f.state === 'open' || f.state === 'closed_accepted_risk') ? (
            <AcceptRiskForm key={`${f.state}:${f.acceptedRisk?.id ?? 'none'}`} orgSlug={d.orgSlug} projectId={d.projectId} findingId={f.id} members={d.members} viewer={d.viewer}
              mode={f.state === 'open' ? 'accept' : 'keep_accepted'} />
          ) : null}
        />
      </section>
      <section aria-labelledby="f-history" className="finding-section">
        <h2 id="f-history">{F.history}</h2>
        <ol className="finding-timeline">
          {historyOf(d).map((h, i) => <li key={i}><LocalTime at={h.at} /> {h.text} <bdi>{h.by}</bdi></li>)}
        </ol>
      </section>
    </div>
  );
}
