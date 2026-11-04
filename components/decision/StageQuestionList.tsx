'use client';

import { useEffect, useState, type ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import { ListLink } from '@/components/ui/ListLink';
import { openDraftStore, type DraftStore } from '@/lib/client/drafts';
import { requestIdFor, sendWrite } from '@/lib/client/retrySafeWrite';
import { formatDay, formatDeclaredDate, formatTime } from '@/lib/format/dates';
import { toSaveBody, type DecisionDraft } from '@/lib/question/draft';
import type { QuestionPanelData } from '@/lib/question/panel';
import { statusForOutcome } from '@/lib/question/saveOutcome';
import { rowMatches, type StageFilter, type StageRow } from '@/lib/question/stageList';
import type { DecisionVersionView } from '@/types/api';
import type { CalendarDate, Stage } from '@/types/record';

export type StageQuestionListProps = {
  orgSlug: string; orgId: string; projectId: string; stage: Stage; viewerId: string;
  rows: StageRow[]; show: StageFilter; counts: Record<StageFilter, number>;
  filters: Array<{ key: StageFilter; label: string }>; total: number;
  /** The seal the "changed since seal N" markers name (REV-b's changedSinceSeal), or null with no seal. */
  sealNumber: number | null;
};

type DeviceDraft = { keptUntil: CalendarDate; pressed: boolean; value: DecisionDraft; base: number | null; retry: { requestId: string | null; sentBody: string | null } };

const questionHref = (p: StageQuestionListProps, questionId: string) => `/orgs/${p.orgSlug}/projects/${p.projectId}/stages/${p.stage}/questions/${questionId}`;

/**
 * S-11's filter group and question list (W-2 notes 2 to 5; UX-26; 7.4.1 "Offline or slow"). The server renders the rows
 * of the chosen filter, so the page works without scripts; here the filter changes without a page load, and this
 * account's drafts on this device are read from storage to mark their rows ("Draft on this device", "kept until
 * <date>"), to fill the "Drafts on this device" filter and, for drafts whose Save was pressed, to offer "Retry all",
 * which re-sends each draft with its own stored request id (UX-27) and shows each result. Filter addresses carry only
 * the filter key (NFR-PRIV-04). Status words are text in `.status-label`, never colour alone (UX-06).
 */
export function StageQuestionList(p: StageQuestionListProps): ReactElement {
  const router = useRouter();
  const [show, setShow] = useState<StageFilter>(p.show);
  const [drafts, setDrafts] = useState<Map<string, DeviceDraft> | null>(null);
  const [results, setResults] = useState<Map<string, string>>(new Map());
  const [retrying, setRetrying] = useState(false);
  const [store, setStore] = useState<DraftStore | null>(null);

  useEffect(() => {
    const s = openDraftStore();
    const now = new Date();
    const found = new Map<string, DeviceDraft>();
    if (s !== null) {
      s.purgeExpired(now);
      for (const d of s.list(p.viewerId, now, { orgId: p.orgId, projectId: p.projectId })) {
        if (d.key.target.kind !== 'question') continue;
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

  const draftIds = new Set(drafts?.keys() ?? []);
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
    for (const [questionId, d] of pressed) {
      const row = p.rows.find((r) => r.questionId === questionId);
      if (row === undefined) continue;
      const data = { stage: p.stage, question: { id: questionId, type: row.questionType } } as unknown as QuestionPanelData;
      const body = toSaveBody(d.value, data, d.base) as unknown as Record<string, unknown>;
      const id = requestIdFor(d.retry, body);
      const outcome = await sendWrite<DecisionVersionView>(
        `/api/v1/orgs/${p.orgSlug}/projects/${p.projectId}/decisions`, 'POST', { ...body, requestId: id.requestId }, { onSlow: () => {} },
      );
      const status = statusForOutcome(outcome, { viewerId: p.viewerId, timeText: formatTime });
      next.set(questionId, status.text);
      if (status.id === 'M-03' || status.id === 'M-04') {
        store?.remove({ userId: p.viewerId, orgId: p.orgId, projectId: p.projectId, target: { kind: 'question', questionId } });
        setDrafts((m) => { const c = new Map(m ?? []); c.delete(questionId); return c; });
      }
      setResults(new Map(next));
    }
    setRetrying(false);
    router.refresh();
  }

  const activeLabel = p.filters.find((f) => f.key === show)?.label ?? 'All';
  return (
    <div className="stage-question-list">
      <form method="get" aria-label="Show questions">
        <fieldset className="form-group">
          <legend>Show</legend>
          {p.filters.map((f) => (
            <label key={f.key} className="checkbox-label" style={{ marginInlineEnd: '1rem' }}>
              <input type="radio" name="show" value={f.key} checked={show === f.key} onChange={() => choose(f.key)} />
              {` ${f.label} ${f.key === 'drafts' && drafts === null ? '' : counts[f.key]}`}
            </label>
          ))}
        </fieldset>
        <noscript><button type="submit" className="btn btn--secondary btn--small">Show</button></noscript>
      </form>

      {pressed.length > 0 ? (
        <div className="card" data-retry-all>
          <p>{`${pressed.length} answers saved on this device have not reached the server.`}</p>
          <button type="button" className="btn btn--primary" disabled={retrying} onClick={() => { void retryAll(); }}>{`Retry all ${pressed.length}`}</button>
        </div>
      ) : null}
      <div role="status">{results.size > 0 && !retrying ? `${results.size} answers sent.` : ''}</div>

      {visible.length === 0 ? (
        <p>
          {`No questions match '${activeLabel}'. `}
          <a href="?show=all" onClick={(e) => { e.preventDefault(); choose('all'); }}>{`Show all ${p.total}`}</a>
        </p>
      ) : (
        <ul className="stage-rows" style={{ listStyle: 'none', padding: 0 }}>
          {visible.map((r) => {
            const d = drafts?.get(r.questionId);
            const result = results.get(r.questionId);
            return (
              <li key={r.questionId} data-question-id={r.questionId} className="card" style={{ marginBottom: '0.5rem' }}>
                <p style={{ margin: 0 }}>
                  <ListLink href={questionHref(p, r.questionId)}>{r.questionId}</ListLink>{' '}
                  <span className="text-muted">{r.moduleTitle}</span>
                </p>
                <p style={{ margin: '0.25rem 0' }}>{r.text}</p>
                <p style={{ margin: 0 }}>
                  <span className="status-label" style={{ color: 'var(--text-body)' }}>{r.statusText}</span>
                  {r.versionNumber !== null ? ` · v${r.versionNumber}` : ''}
                  {r.declaredDate !== null ? ` · ${formatDeclaredDate(r.declaredDate)}` : ''}
                  {r.inPlace !== null ? ` · ${r.inPlace.n} of ${r.inPlace.of} in place` : ''}
                  {r.openFindings > 0 ? ` · ${r.openFindings} open ${r.openFindings === 1 ? 'finding' : 'findings'}` : ''}
                  {r.changedSinceSeal ? ` · changed since seal ${p.sealNumber ?? ''}` : ''}
                  {r.reworded ? ' · expected practice reworded since the decision' : ''}
                  {d !== undefined ? ` · Draft on this device, kept until ${formatDay(d.keptUntil)}` : ''}
                </p>
                {result !== undefined ? <p>{result}</p> : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
