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
import type { FindingPageData, MitigationOnPage } from '@/lib/findings/pageData';

/**
 * S-15, one finding (W-5, W-6; SRS 7.4.2 S-15 row; FR-FND-01, 03 to 07, FR-FUP-05). No hooks: the page loads `FindingPageData`
 * and this renders it, so a unit test renders the markup without the loader. Regions in W-5's order: the archived banner,
 * the header, the "decision now done" box, the mitigations, the ways to address it, the ways to close it, the history.
 * Every name and text a team typed is rendered as text (NFR-SEC-11).
 */

/** Between the parts of a line: a middle dot with a space each side, as the account pages write it. */
const SEP = ' \u00b7 ';

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
    <li data-mitigation-id={v.mitigationId} className="card">
      <p>{v.what === null ? null : <bdi>{v.what}</bdi>}</p>
      <p>
        Owner: <bdi>{v.owner.name}</bdi>{v.owner.formerMember ? ' (former member)' : ''}{SEP}Due {formatDay(v.dueDate)}{SEP}
        {m.overdue ? <><span className="status-label status-label--warning badge--moderate">{overdue.label}</span>{overdue.rest}{SEP}</> : null}
        <MitigationStatusWord status={v.status} noArtefactNote={v.evidence.length === 0 ? v.closureNote : null} />{SEP}version {v.versionNumber}
      </p>
      {d.ownerCannotAct.includes(v.mitigationId) ? <p><span className="status-label status-label--warning badge--moderate">Owner cannot act</span>: reassign</p> : null}
      {v.followsControl === null ? null : <p>Follows: <bdi>{v.followsControl}{' '}{controlName(v.followsControl)}</bdi></p>}
      {v.cancelReason === null ? null : <p>Why it is cancelled: <bdi>{v.cancelReason}</bdi></p>}
      <VersionEvidenceList orgSlug={d.orgSlug} items={v.evidence} />
      {d.canMitigate && d.detail.state === 'open' && v.status !== 'cancelled' ? (
        <MitigationFormToggle label="Update this mitigation" {...formProps(d)} base={v} />
      ) : null}
      <details>
        <summary>History: {m.versions} {m.versions === 1 ? 'version' : 'versions'}</summary>
        <ol>
          {m.history.map((h) => (
            <li key={h.id}>
              Version {h.versionNumber}, saved <LocalTime at={h.receivedAt} /> by <bdi>{h.enteredBy.name}</bdi>: owner <bdi>{h.owner.name}</bdi>, due {formatDay(h.dueDate)}.
              {h.changeNote === null ? null : <> Why the date changed: <bdi>{h.changeNote}</bdi></>}
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
      ? `Raised from ${f.questionId} version ${d.version.versionNumber} (${d.version.statusWord}).` : 'Raised by the team.',
  }];
  for (const e of f.events) out.push({ seq: e.findingSeq, at: e.at, by: e.by.name, text: <>{e.kind === 'reopened' ? 'Reopened' : 'Withdrawn'}{e.reason === null ? '.' : <>: <bdi>{e.reason}</bdi></>}</> });
  for (const m of d.mitigations) {
    for (const h of m.history) {
      out.push({ seq: h.findingSeq, at: h.receivedAt, by: h.enteredBy.name,
        text: <>{h.versionNumber === 1 ? 'Mitigation added' : `Mitigation updated to version ${h.versionNumber}`}: owner <bdi>{h.owner.name}</bdi>, due {formatDay(h.dueDate)}.</> });
    }
  }
  for (const r of f.acceptedRisks) {
    out.push({ seq: r.findingSeq, at: r.receivedAt, by: r.enteredBy.name,
      text: <>Risk accepted by <bdi>{deciderLabel(r.acceptedBy, '', 'record')}</bdi>{r.reason === null ? '.' : <>: <bdi>{r.reason}</bdi></>}</> });
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
    ? <>Closed: risk accepted by <bdi>{deciderLabel(f.acceptedRisk.acceptedBy, '', 'record')}</bdi> on {formatDay(f.acceptedRisk.receivedAt)}.{f.acceptedRisk.lookAgainOn === null ? '' : ` Look at it again on ${formatDay(f.acceptedRisk.lookAgainOn)}.`}</>
    : null;
  return (
    <div className="page-content">
      <ArchivedBanner archived={d.archived} />
      <ListLink href={`${base}/findings`} className="back-link">Back to findings</ListLink>
      <header>
        <h1><bdi>{d.title}</bdi></h1>
        <p><bdi className="status-label">{d.stateLabel}</bdi></p>
        {acceptedLine === null ? null : <p>{acceptedLine}</p>}
        <p>
          {d.sourceLabel}{SEP}{STAGE_NAMES[f.stage]}
          {f.riskArea === null ? null : <>{SEP}Risk area <bdi>{f.riskArea}{d.riskAreaName === null ? '' : ` ${d.riskAreaName}`}</bdi></>}
        </p>
        {f.source === 'team' && f.questionId !== null ? <p>About question <bdi>{f.questionId}</bdi>{d.version === null ? '' : ` (version ${d.version.versionNumber})`}</p> : null}
        {f.source === 'shortfall' && d.version !== null
          ? <p>Raised automatically on <LocalTime at={f.raisedAt} dateOnly /> when &quot;{d.version.statusWord}&quot; was saved by <bdi>{f.raisedBy.name}</bdi>.</p> : null}
        {f.source === 'team' ? <p>Raised by <bdi>{f.raisedBy.name}</bdi> on <LocalTime at={f.raisedAt} dateOnly />.</p> : null}
        {f.description === null ? null : <p><bdi>{f.description}</bdi></p>}
        <SealMarker seals={f.seals} />
      </header>
      {closing === null ? null : (
        <section aria-label="Decision now changed">
          <p>
            {closing.reason === 'decision_withdrawn'
              ? `The decision on ${closing.questionId} was withdrawn (version ${closing.versionNumber}). Close this finding with that decision?`
              : closing.reason === 'gate_no'
                ? `The scope answer on ${closing.questionId} is now No (version ${closing.versionNumber}). Close this finding with that answer?`
                : `The decision on ${closing.questionId} is now ${closing.statusWord} (version ${closing.versionNumber}). Close this finding with that decision?`}
          </p>
          <CloseByDecisionButton orgSlug={d.orgSlug} projectId={d.projectId} findingId={f.id} decisionVersionId={closing.decisionVersionId} reason={closing.reason} findingTitle={d.title} />
        </section>
      )}
      <section aria-labelledby="f-mitigations">
        <h2 id="f-mitigations">Mitigations</h2>
        {d.mitigations.length === 0 ? (
          <p>No mitigations yet. Add one, or an owner or admin can accept the risk.</p>
        ) : (
          <ul>{d.mitigations.map((m) => <Mitigation key={m.current.mitigationId} d={d} m={m} controlName={controlName} />)}</ul>
        )}
        {d.canMitigate && f.state === 'open' ? <MitigationFormToggle label="Add a mitigation" {...formProps(d)} base={null} /> : null}
      </section>
      {waysArea === null ? null : (
        <section aria-labelledby="f-ways">
          <h2 id="f-ways">{`Ways teams address this (for risk area ${waysArea})`}</h2>
          <FindingSuggestions contentSemver={d.contentSemver} riskArea={waysArea} />
        </section>
      )}
      <section aria-labelledby="f-close">
        <h2 id="f-close">Other ways to close this finding</h2>
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
      <section aria-labelledby="f-history">
        <h2 id="f-history">History</h2>
        <ol>
          {historyOf(d).map((h, i) => <li key={i}><LocalTime at={h.at} /> {h.text} <bdi>{h.by}</bdi></li>)}
        </ol>
      </section>
    </div>
  );
}
