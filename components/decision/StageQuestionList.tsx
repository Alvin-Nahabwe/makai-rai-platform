'use client';

import { useEffect, useState, type ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { ItemPlate } from '@/components/ui/ItemPlate';
import { Select } from '@/components/ui/Select';
import type { ScopeAnswer, StatusMarkKind } from '@/components/ui/types';
import { openDraftStore, type DraftStore } from '@/lib/client/drafts';
import { requestIdFor, sendWrite } from '@/lib/client/retrySafeWrite';
import { formatDay, formatDeclaredDate, formatTime } from '@/lib/format/dates';
import { isDraftValue, questionHref, toSaveBody, type DecisionDraft } from '@/lib/question/draft';
import { statusForOutcome } from '@/lib/question/saveOutcome';
import { STAGE_LIST_COPY as L } from '@/lib/question/list/copy';
import { moduleGroups, retryAllSummary, rowMatches, stageDraftIds, type StageFilter, type StageRow } from '@/lib/question/stageList';
import type { DecisionVersionView } from '@/types/api';
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
  /** 'page' (the default): the stage page's list. 'column': the question page's column (the filter as a select, topics as disclosures). */
  variant?: 'page' | 'column';
  /** The question open on the question page: its plate is "You are here" and its topic's disclosure is open. */
  currentQuestionId?: string;
  /** The column's closed topics: each topic's tally in words, by module id, shaped on the server (lib/question/route.ts). */
  topicTallies?: Record<string, string>;
};

type DeviceDraft = { keptUntil: CalendarDate; pressed: boolean; value: DecisionDraft; base: number | null; retry: { requestId: string | null; sentBody: string | null } };


/**
 * S-11's filter group and question list (W-2 notes 2 to 5; UX-26; 7.4.1 "Offline or slow"). The server renders the rows
 * of the chosen filter, so the page works without scripts; here the filter changes without a page load, and this
 * account's drafts in this browser are read from storage to mark their rows ("not saved yet", "kept in this browser
 * until <date>"), to fill the "Not saved yet" filter and, for drafts whose Save was pressed, to offer "Save all n now",
 * which re-sends each draft with its own stored request id (UX-27) and shows each result. Filter addresses carry only
 * the filter key (NFR-PRIV-04). Each question is the kit's ItemPlate with its StatusMark in words, never colour alone
 * (UX-06, spec 7.2); each filter is a native radio styled as a chip (components/question/stage-route.css).
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
  // Display only: a filter's count, or none on "Not saved yet" until storage is read or where there is none (part 1's rule).
  const countOf = (f: StageFilter): string => (f === 'drafts' && (drafts === null || noStorage) ? '' : String(counts[f]));

  // One question's plate, as each variant lists it (markup only). In the column, the open question's plate is "You are here".
  const plateOf = (r: StageRow): ReactElement => {
    const d = drafts?.get(r.questionId);
    const result = results.get(r.questionId);
    const mark = p.marks[r.questionId];
    // The one line of state (spec 8): each part only when it holds, joined, with no separator before the first.
    const state = [
      r.declaredDate !== null ? formatDeclaredDate(r.declaredDate) : null,
      r.inPlace !== null ? L.row.inPlace(r.inPlace.n, r.inPlace.of) : null,
      r.openFindings > 0 ? L.row.openFindings(r.openFindings) : null,
      r.changedSinceSeal ? L.row.changedSinceSeal(p.sealNumber) : null,
      r.reworded ? L.row.reworded : null,
      d !== undefined ? L.row.notSaved(formatDay(d.keptUntil)) : null,
    ].filter((part) => part !== null).join(L.row.separator);
    return (
      <li key={r.questionId} data-question-id={r.questionId}>
        <ItemPlate
          title={r.text} code={r.questionId} href={questionHref(p, r.questionId)} mark={mark}
          noEvidence={mark === 'done' && r.evidenceCount === 0}
          scopeAnswer={mark === 'scope_answered' && p.scopeAnswer !== null ? p.scopeAnswer : undefined}
          state={state === '' ? null : state}
          current={p.variant === 'column' && r.questionId === p.currentQuestionId}
        />
        {result !== undefined ? <p className="stage-route__result">{result.text}</p> : null}
      </li>
    );
  };

  const noMatch = (
    <p>
      {L.noMatch(activeLabel)}
      <a href="?show=all" onClick={(e) => { e.preventDefault(); choose('all'); }}>{L.showAll(p.total)}</a>
    </p>
  );

  if (p.variant === 'column') {
    // The question page's column (plan C2): the filter as the kit's Select, then with "All" one disclosure per topic (the
    // open question's topic open, from props), with a filter one flat list. No "Save all" card and no results here.
    const currentModuleId = p.rows.find((r) => r.questionId === p.currentQuestionId)?.moduleId;
    return (
      <div className="stage-question-list stage-question-list--column">
        <form method="get" aria-label={L.form.label} className="route-column__filter">
          <Select
            id="route-column-show" name="show" label={L.form.legend} value={show}
            hint={noStorage ? L.noStorage : undefined} onChange={(e) => choose(e.target.value as StageFilter)}
            options={p.filters.map((f) => ({ value: f.key, label: `${f.label} ${countOf(f.key)}`.trimEnd() }))}
          />
          <noscript><button type="submit" className="btn btn--secondary btn--small">{L.form.submit}</button></noscript>
        </form>
        {visible.length === 0 ? noMatch : show === 'all' ? (
          moduleGroups(p.rows).map((g) => (
            <details key={g.moduleId} className="route-column__topic" open={g.moduleId === currentModuleId}>
              <summary>
                <span className="route-column__topic-name">{g.moduleTitle}</span>{' '}
                <span className="route-column__topic-tally">{p.topicTallies?.[g.moduleId] ?? ''}</span>
              </summary>
              <ul className="stage-route__plates">{g.rows.map(plateOf)}</ul>
            </details>
          ))
        ) : (
          <ul className="stage-route__plates">{visible.map(plateOf)}</ul>
        )}
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
        <div className="card" data-retry-all>
          <p>{L.unsent(pressed.length)}</p>
          {/* Busy, never disabled: the button keeps its place and the focus of the person who pressed it (kit Button). */}
          <Button variant="primary" busy={retrying} onClick={() => { void retryAll(); }}>{L.saveAll(pressed.length)}</Button>
        </div>
      ) : null}
      <div role="status">{results.size > 0 && !retrying ? retryAllSummary([...results.values()].map((r) => r.id)) : ''}</div>

      {visible.length === 0 ? noMatch : (
        moduleGroups(p.rows).filter((g) => g.rows.some((r) => visible.includes(r))).map((g) => (
        <section key={g.moduleId} aria-labelledby={`module-${g.moduleId}`}>
          <h2 id={`module-${g.moduleId}`} className="stage-route__topic">{g.moduleTitle}</h2>
          <p className="text-muted stage-route__topic-count">{L.summary(g.rows.length, g.noDecision)}</p>
        <ul className="stage-route__plates">
          {g.rows.filter((r) => visible.includes(r)).map(plateOf)}
        </ul>
        </section>
        ))
      )}
    </div>
  );
}
