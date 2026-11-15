import Link from 'next/link';
import type { ReactElement } from 'react';
import { Icon } from '@/components/ui/Icon';
import { StatusMark } from '@/components/ui/StatusMark';
import { SealMarker } from '@/components/review/SealMarker';
import { WITHDRAWAL_CODE_LABELS, deciderLabel } from '@/lib/decision/copy';
import { textErasedLine } from '@/lib/documents/copy';
import { EVIDENCE_COPY } from '@/lib/evidence/copy';
import { stripBidiControls, webLink } from '@/lib/evidence/format';
import { QUESTION_COPY } from '@/lib/question/copy';
import { markKindOf } from '@/lib/ui/marks';
import { formatDay, formatDeclaredDate, formatTime } from '@/lib/format/dates';
import { formatSize } from '@/lib/format/size';
import type { DecisionVersionView, EvidenceItemView } from '@/types/api';
import type { SealRef } from '@/types/seal';
import '@/components/ui/buttonStyles';
import './reading.css';

const C = QUESTION_COPY.current;
const R = QUESTION_COPY.reading;

/**
 * The zone the card writes its instants in: East Africa Time, the zone of the platform's teams, because the card is
 * rendered on the server, whose own zone is the host's (UTC in production). The same helpers and the same zone as the
 * server-rendered organisation events (components/org/OrganisationEventsList.tsx); lib/format/dates.ts formatTime names
 * it ("10:42 EAT"). A calendar date (the declared date, an erasure date) is written from its digits and takes no zone.
 */
const ZONE = 'Africa/Kampala';

/** A separator the eye reads and a screen reader skips: each side is its own text node (spec 9.3 accessibility). */
const DOT = <span aria-hidden="true"> · </span>;

export type ReadingDecisionProps = {
  orgSlug: string; current: DecisionVersionView | null; historyCount: number; historyHref: string; seals: SealRef[];
  /** Whether this is the personal data question itself, whose decision is an answer, not a status. */
  isScopeQuestion: boolean;
};

/**
 * One item of the decision's evidence (directions/surfaces/viewer-reading.png; gap 2 of design-target section 8). A file:
 * its name, "<size> · added <date>", and a secondary Download button whose accessible name carries the file's name; an
 * erased file its erased line and no button. A link: its name (the author's, or else its address), then the host it
 * really goes to and "opens another site" (so a name cannot claim another site: link spoofing), and the external mark, as
 * a plain anchor only when its address is http or https (never next/link, which prefetches: FR-EVD-03), whose href is the
 * same parse the host comes from (lib/evidence/format.ts webLink); never the whole address in brackets. Any other
 * address is its name and the whole cleaned address as text, with no claim to open a site. Every name sits in `<bdi>` with bidi controls removed (E14).
 */
function EvidenceItem({ orgSlug, item }: { orgSlug: string; item: EvidenceItemView }): ReactElement {
  if (item.kind === 'link') {
    if (item.url === null) return <li className="reading-evidence__item">{EVIDENCE_COPY.list.linkAddressErased}</li>;
    const web = webLink(item.url);
    if (web === null) {
      // Not a web address: its name and the whole address, cleaned, as text; no link and no claim to open a site.
      const address = stripBidiControls(item.url);
      return (
        <li className="reading-evidence__item">
          <span>{item.label === null ? <bdi>{address}</bdi>
            : <><bdi>{stripBidiControls(item.label)}</bdi>{R.notWebLink.before}<bdi>{address}</bdi>{R.notWebLink.after}</>}</span>
        </li>
      );
    }
    // Its name (the author's, or else its address), then the host it really goes to: a name cannot claim another site.
    return (
      <li className="reading-evidence__item">
        <a className="reading-evidence__link" href={web.href} rel="noopener noreferrer">
          <bdi>{item.label === null ? stripBidiControls(item.url) : stripBidiControls(item.label)}</bdi>
          {/* The real host in its own quieter element (regular weight, muted ink), so a name that copies this suffix cannot
              pass for it (review M1). An http or https host is plain ASCII (punycode), so it needs no <bdi>, which a browser
              would set apart with spaces in the link's accessible name. */}
          {' '}<span className="reading-evidence__host">{R.linkTo(web.host)}</span><Icon name="external-link" size={18} />
        </a>
      </li>
    );
  }
  const fileName = item.fileName === null ? null : stripBidiControls(item.fileName);
  const label = fileName ?? EVIDENCE_COPY.list.fileNameErased;
  if (item.erased !== null) {
    return (
      <li className="reading-evidence__item">
        <span>{fileName === null ? label : <bdi>{label}</bdi>}{EVIDENCE_COPY.list.fileErased(formatDay(item.erased.erasedOn))}</span>
      </li>
    );
  }
  // A stored file always has a size; were it missing, the line drops it and the Download stays, so the download route's
  // own integrity check is what answers (silent-failure review of c46d69f4, finding 2).
  const added = R.added(formatDay(item.uploadedAt, ZONE));
  return (
    <li className="reading-evidence__item">
      <span className="reading-evidence__file">
        <bdi>{label}</bdi>
        <small>{item.byteSize === null ? added : <>{formatSize(item.byteSize)}{DOT}{added}</>}</small>
      </span>
      <a className="ui-button ui-button--secondary reading-evidence__download"
        href={`/api/v1/orgs/${encodeURIComponent(orgSlug)}/evidence/${encodeURIComponent(item.id)}`} download>
        <span className="ui-button__icon"><Icon name="download" size={18} /></span>
        {R.download}<span className="visually-hidden"> {label}</span>
      </a>
    </li>
  );
}

/** The reason as a quotation of what the team wrote; an erased one is the platform's line, not a quotation. */
function Reason({ current }: { current: DecisionVersionView }): ReactElement | null {
  if (current.reasonErased !== null) return <p>{textErasedLine(current.reasonErased.erasedOn)}</p>;
  if (current.reason === null || current.reason === '') return null;
  return <blockquote className="reading-decision__reason">{current.reason}</blockquote>;
}

/**
 * "What the team decided" on the read-only question page (plan 1C Task 7, decision C12; spec 9.3 lines 379-381;
 * directions/surfaces/viewer-reading.png), as ONE white card: the heading with the status mark and its words in the top
 * right (the personal data question its answer); the reason as a quotation on the paper ground; "Decided by <name> ·
 * <date>"; the version line ("Version n · saved <date> · History: n versions") and, quietly, who entered it (principle 4:
 * both pairs); the seal marker as before; then the evidence under a rule, or "None yet". A withdrawal as the current
 * version is struck through with who withdrew it, when and why (spec 9.7), never removed; with no version the card says
 * "No decision yet." Nothing here is a control but links: no form, no evidence control, no withdraw. A server component:
 * every value is a React child, so it is text, never markup (NFR-SEC-11).
 */
export function ReadingDecision({ orgSlug, current, historyCount, historyHref, seals, isScopeQuestion }: ReadingDecisionProps): ReactElement {
  const head = (state: ReactElement | null) => (
    <div className="reading-decision__head">
      <h2 id="s12-current-decision">{R.title}</h2>
      {state === null ? null : <p className="reading-decision__state">{state}</p>}
    </div>
  );
  const history = <Link href={historyHref}>{R.history(historyCount)}</Link>;

  let body: ReactElement;
  let state: ReactElement | null;
  if (current === null) {
    state = null;
    body = <p>{C.none}</p>;
  } else if (current.status === 'withdrawn') {
    state = <StatusMark kind="no_decision" size={20} />;
    const who = current.enteredBy.formerMember ? C.formerMember(current.enteredBy.name) : current.enteredBy.name;
    const kind = current.withdrawalCode === null ? null : WITHDRAWAL_CODE_LABELS[current.withdrawalCode];
    const day = formatDay(current.receivedAt, ZONE);
    body = (
      <>
        <p className="reading-decision__withdrawn">
          {current.baseVersionNumber === null ? R.withdrawnNoBase(who, day, kind)
            : <><del>{R.withdrawnVersion(current.baseVersionNumber)}</del>{R.withdrawnBy(who, day, kind)}</>}
        </p>
        <Reason current={current} />
        {/* The withdrawal is a version of its own (the history lists it so), and a seal may keep it: the card names it, so
            the aside's sealed copy names no version the card does not show (review M2). */}
        <p className="reading-decision__version">
          <span>{R.version(current.versionNumber)}</span>{DOT}<span>{R.saved(formatDay(current.receivedAt, ZONE))}</span>{DOT}{history}
        </p>
        <SealMarker seals={seals} />
      </>
    );
  } else {
    const kind = markKindOf({ status: current.status, scopeAnswer: current.scopeAnswer, gated: false, isScopeQuestion });
    const enteredBy = current.enteredBy.formerMember ? C.formerMember(current.enteredBy.name) : current.enteredBy.name;
    state = <StatusMark kind={kind} size={20} scopeAnswer={current.scopeAnswer ?? undefined} />;
    const decided = current.decidedBy === null ? null : (
      <figcaption className="reading-decision__decided">
        {R.decidedBy(deciderLabel(current.decidedBy, '', 'record'))}
        {current.declaredDate === null ? null : <>{DOT}{formatDeclaredDate(current.declaredDate)}</>}
      </figcaption>
    );
    const hasReason = current.reasonErased !== null || (current.reason !== null && current.reason !== '');
    body = (
      <>
        {hasReason || decided !== null ? (
          <figure className="reading-decision__figure">
            <Reason current={current} />
            {decided}
          </figure>
        ) : null}
        <p className="reading-decision__version">
          <span>{R.version(current.versionNumber)}</span>{DOT}<span>{R.saved(formatDay(current.receivedAt, ZONE))}</span>{DOT}{history}
        </p>
        <p className="reading-decision__entered">{C.enteredBy(enteredBy, formatDay(current.receivedAt, ZONE), formatTime(current.receivedAt, ZONE))}</p>
        <SealMarker seals={seals} />
        {/* A part of the card, not a landmark of its own (review M7). */}
        <div className="reading-evidence">
          <h3>{R.evidence}</h3>
          {current.evidence.length === 0 ? <p>{R.noEvidence}</p> : (
            <ul>{current.evidence.map((item) => <EvidenceItem key={item.id} orgSlug={orgSlug} item={item} />)}</ul>
          )}
        </div>
      </>
    );
  }
  return (
    <section data-region="current-decision" aria-labelledby="s12-current-decision" className="reading-decision">
      {head(state)}
      {body}
    </section>
  );
}
