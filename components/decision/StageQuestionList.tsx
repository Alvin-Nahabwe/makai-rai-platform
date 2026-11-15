'use client';

import { useEffect, useState, type ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { RouteLineList, type RouteLineItem } from '@/components/question/RouteLine';
import type { ScopeAnswer, StatusMarkKind } from '@/components/ui/types';
import { openDraftStore, type DraftStore } from '@/lib/client/drafts';
import { requestIdFor, sendWrite } from '@/lib/client/retrySafeWrite';
import { formatDay, formatDeclaredDate, formatTime } from '@/lib/format/dates';
import { isDraftValue, questionHref, toSaveBody, type DecisionDraft } from '@/lib/question/draft';
import { statusForOutcome } from '@/lib/question/saveOutcome';
import { STAGE_LIST_COPY as L } from '@/lib/question/list/copy';
import { moduleGroups, retryAllSummary, rowMatches, stageDraftIds, type StageFilter, type StageRow } from '@/lib/question/stageList';
import { foldRoute } from '@/lib/question/route';
import type { DecisionVersionView } from '@/types/api';
import type { DefinedEntry } from '@/lib/vocabulary/types';
import type { CalendarDate, Stage } from '@/types/record';
import '@/components/question/stage-route.css';

export type StageQuestionListProps = {
  orgSlug: string; orgId: string; projectId: string; stage: Stage; viewerId: string;
  rows: StageRow[]; show: StageFilter; counts: Record<StageFilter, number>;
  filters: Array<{ key: StageFilter; label: string }>; total: number;
  /** The seal the "changed since seal N" markers name (REV-b's changedSinceSeal), or null with no seal. */
  sealNumber: number | null;
  /** Each row's status mark (lib/question/stagePage.ts), by question id. */
  marks: Record<string, StatusMarkKind>;
  /** The personal data question's answer, which its mark's words give ("Answer: Yes"). */
  scopeAnswer: ScopeAnswer | null;
  /** 'page' (the default): the stage page's list. 'column': the question page's column (the filter as a small select, the line folded). */
  variant?: 'page' | 'column';
  /** The question open on the question page: its row is "You are here", in the ring. */
  currentQuestionId?: string;
  /** The next question that applies (lib/question/route.ts, nextApplyingId): its row says "Next question". */
  nextQuestionId?: string | null;
  /** By question id, the defined terms whose first use on the page is that question (fix round 4; shaped on the server). */
  termTips?: Readonly<Record<string, readonly DefinedEntry[]>>;
};

type DeviceDraft = { keptUntil: CalendarDate; pressed: boolean; value: DecisionDraft; base: number | null; retry: { requestId: string | null; sentBody: string | null } };


/**
 * S-11's filter group and question list (W-2 notes 2 to 5; UX-26; 7.4.1 "Offline or slow"), drawn as the route's line
 * (owner's answer R1, 15 November 2026; lane 1 Task 2 changed the markup only). The server renders the rows
 * of the chosen filter, so the page works without scripts; here the filter changes without a page load, and this
 * account's drafts in this browser are read from storage to mark their rows ("not saved yet", "kept in this browser
 * until <date>"), to fill the "Not saved in this browser" filter and, for drafts whose Save was pressed, to offer "Save all n now",
 * which re-sends each draft with its own stored request id (UX-27) and shows each result. Filter addresses carry only
 * the filter key (NFR-PRIV-04). Each question is a row of components/question/RouteLine.tsx, its status in words beside
 * its mark, never colour alone (UX-06, spec 7.2); on the page each filter is a native radio styled as a chip
 * (components/question/stage-route.css), in the column a small select (components/question/route-column.css).
 */
export function StageQuestionList(p: StageQuestionListProps): ReactElement {
  const router = useRouter();
  const [show, setShow] = useState<StageFilter>(p.show);
  const [drafts, setDrafts] = useState<Map<string, DeviceDraft> | null>(null);
  const [results, setResults] = useState<Map<string, { id: string; text: string }>>(new Map());
  const [retrying, setRetrying] = useState(false);
  const [store, setStore] = useState<DraftStore | null>(null);

  useEffect(() => {
    const s = openDraftStore();
    const now = new Date();
    const found = new Map<string, DeviceDraft>();
    if (s !== null) {
      s.purgeExpired(now);
      for (const d of s.list(p.viewerId, now, { orgId: p.orgId, projectId: p.projectId })) {
        // A value without the draft's shape is not offered for Retry all: it could not be sent as it stands (F7).
        if (d.key.target.kind !== 'question' || !isDraftValue(d.draft.value)) continue;
        found.set(d.key.target.questionId, {
          keptUntil: d.keptUntil, pressed: d.draft.savePressedAt !== null, value: d.draft.value as DecisionDraft,
          base: d.draft.baseVersionNumber, retry: d.draft.retry,
        });
      }
    }
    // localStorage exists only in the browser, after hydration: a one-shot read on mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStore(s);
    setDrafts(found);
  }, [p.viewerId, p.orgId, p.projectId]);

  // The device lists this account's drafts for the whole project; S-11 counts this stage's only (F1).
  const draftIds = stageDraftIds([...(drafts?.keys() ?? [])], p.rows);
  // Until storage is read, the drafts filter shows every row, as the server rendered it.
  const visible = p.rows.filter((r) => (show === 'drafts' && drafts === null) || rowMatches(r, show, draftIds));
  const counts = { ...p.counts, drafts: draftIds.size };
  const pressed = [...(drafts?.entries() ?? [])].filter(([qid, d]) => d.pressed && p.rows.some((r) => r.questionId === qid));

  function choose(f: StageFilter): void {
    setShow(f);
    window.history.replaceState(window.history.state, '', `?show=${f}`);
  }

  async function retryAll(): Promise<void> {
    setRetrying(true);
    const next = new Map(results);
    try {
    for (const [questionId, d] of pressed) {
      const row = p.rows.find((r) => r.questionId === questionId);
      if (row === undefined) continue;
      const body = toSaveBody(d.value, { stage: p.stage, question: { id: questionId, type: row.questionType } }, d.base) as unknown as Record<string, unknown>;
      const id = requestIdFor(d.retry, body);
      const outcome = await sendWrite<DecisionVersionView>(
        `/api/v1/orgs/${p.orgSlug}/projects/${p.projectId}/decisions`, 'POST', { ...body, requestId: id.requestId }, { onSlow: () => {} },
      );
      const status = statusForOutcome(outcome, { viewerId: p.viewerId, timeText: formatTime });
      next.set(questionId, { id: status.id, text: status.text });
      if (status.id === 'M-03' || status.id === 'M-04') {
        store?.remove({ userId: p.viewerId, orgId: p.orgId, projectId: p.projectId, target: { kind: 'question', questionId } });
        setDrafts((m) => { const c = new Map(m ?? []); c.delete(questionId); return c; });
      }
      setResults(new Map(next));
    }
    } finally {
      // Whatever happens to one send, the button comes back (F7).
      setRetrying(false);
    }
    router.refresh();
  }

  const activeLabel = p.filters.find((f) => f.key === show)?.label ?? L.filters.all;
  // Display only: storage has been read (drafts is set) and this browser keeps no draft store, so no count is shown.
  const noStorage = drafts !== null && store === null;
  // Display only: a filter's count, or none on "Not saved in this browser" until storage is read or where there is none (part 1's rule).
  const countOf = (f: StageFilter): string => (f === 'drafts' && (drafts === null || noStorage) ? '' : String(counts[f]));

  // One question as the line shows it (markup only). In the column, the open question is "You are here" and the next one
  // that applies says so; only the open question names its version, as the sketch draws it.
  const column = p.variant === 'column';
  const itemOf = (r: StageRow): RouteLineItem => {
    const d = drafts?.get(r.questionId);
    const mark = p.marks[r.questionId];
    const here = column && r.questionId === p.currentQuestionId;
    // The meta line after the code and the status words (spec 8): each part only when it holds. The decided-on date and
    // "n of m in place" are the page's wider rows only.
    const state = [
      !column && r.declaredDate !== null ? formatDeclaredDate(r.declaredDate) : null,
      !column && r.inPlace !== null ? L.row.inPlace(r.inPlace.n, r.inPlace.of) : null,
      r.openFindings > 0 ? L.row.openFindings(r.openFindings) : null,
      r.changedSinceSeal ? L.row.changedSinceSeal(p.sealNumber) : null,
      r.reworded ? L.row.reworded : null,
      d !== undefined ? L.row.notSaved(formatDay(d.keptUntil)) : null,
    ].filter((part) => part !== null);
    return {
      questionId: r.questionId, title: r.text, href: questionHref(p, r.questionId), mark,
      noEvidence: mark === 'done' && r.evidenceCount === 0,
      scopeAnswer: mark === 'scope_answered' && p.scopeAnswer !== null ? p.scopeAnswer : undefined,
      here, next: column && p.nextQuestionId != null && r.questionId === p.nextQuestionId,
      version: here ? r.versionNumber : null, state, result: results.get(r.questionId)?.text ?? null,
      terms: p.termTips?.[r.questionId] ?? [],
    };
  };

  const noMatch = (
    <p className="route-line__none">
      {L.noMatch(activeLabel)}
      <a href="?show=all" onClick={(e) => { e.preventDefault(); choose('all'); }}>{L.showAll(p.total)}</a>
    </p>
  );

  if (column) {
    // The question page's column: the filter as a small select above the line, then the line, folded round the open
    // question while no filter is active (lib/question/route.ts, foldRoute). No "Save all" card and no results here.
    const parts = foldRoute(visible.map(itemOf), { currentId: p.currentQuestionId, nextId: p.nextQuestionId, fold: show === 'all' });
    return (
      <div className="stage-question-list stage-question-list--column">
        <form method="get" aria-label={L.form.label} className="route-filter route-column__filter">
          <label className="route-filter__label" htmlFor="route-column-show">{L.form.legend}</label>
          <span className="route-filter__wrap">
            <select
              className="route-filter__select" id="route-column-show" name="show" value={show}
              aria-describedby={noStorage ? 'route-column-no-storage' : undefined} onChange={(e) => choose(e.target.value as StageFilter)}
            >
              {p.filters.map((f) => <option key={f.key} value={f.key}>{`${f.label} ${countOf(f.key)}`.trimEnd()}</option>)}
            </select>
            <span className="route-filter__icon"><Icon name="chevron-down" size={16} /></span>
          </span>
          <noscript><button type="submit" className="btn btn--secondary btn--small">{L.form.submit}</button></noscript>
        </form>
        {noStorage ? <p id="route-column-no-storage" className="route-filter__note">{L.noStorage}</p> : null}
        {visible.length === 0 ? noMatch : <div className="route-line"><RouteLineList parts={parts} /></div>}
      </div>
    );
  }

  return (
    <div className="stage-question-list">
      <form method="get" aria-label={L.form.label}>
        <fieldset className="stage-route__filters" aria-describedby={noStorage ? 'stage-route-no-storage' : undefined}>
          <legend className="stage-route__legend">{L.form.legend}</legend>
          <div className="stage-route__chips">
            {p.filters.map((f) => (
              <label key={f.key} className="stage-route__chip">
                <input type="radio" name="show" value={f.key} checked={show === f.key} onChange={() => choose(f.key)} />
                {` ${f.label} ${countOf(f.key)}`}
              </label>
            ))}
          </div>
          {noStorage ? <p id="stage-route-no-storage" className="stage-route__note">{L.noStorage}</p> : null}
        </fieldset>
        <noscript><button type="submit" className="btn btn--secondary btn--small">{L.form.submit}</button></noscript>
      </form>

      {pressed.length > 0 ? (
        <div className="stage-route__save-all" data-retry-all>
          <p>{L.unsent(pressed.length)}</p>
          {/* Busy, never disabled: the button keeps its place and the focus of the person who pressed it (kit Button). */}
          <Button variant="primary" busy={retrying} onClick={() => { void retryAll(); }}>{L.saveAll(pressed.length)}</Button>
        </div>
      ) : null}
      <div role="status">{results.size > 0 && !retrying ? retryAllSummary([...results.values()].map((r) => r.id)) : ''}</div>

      {/* Every question on one line, unfolded, with each topic's name and count as a quiet heading along it. */}
      {visible.length === 0 ? noMatch : (
        <div className="route-line route-line--page">
          {moduleGroups(p.rows).filter((g) => g.rows.some((r) => visible.includes(r))).map((g) => (
            <section key={g.moduleId} className="stage-route__section" aria-labelledby={`module-${g.moduleId}`}>
              <h2 id={`module-${g.moduleId}`} className="stage-route__topic">{g.moduleTitle}</h2>
              <p className="text-muted stage-route__topic-count">{L.summary(g.rows.length, g.noDecision)}</p>
              <RouteLineList parts={foldRoute(g.rows.filter((r) => visible.includes(r)).map(itemOf), { fold: false })} />
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
