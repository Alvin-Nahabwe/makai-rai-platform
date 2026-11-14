'use client';

import { useEffect, useState, type ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import { openDraftStore, type DraftStore } from '@/lib/client/drafts';
import { DRAFTS_COPY } from '@/lib/decision/drafts/copy';
import { formatDay } from '@/lib/format/dates';
import type { CalendarDate } from '@/types/record';

export type DraftsOnThisDeviceProps = { userId: string };

type Listed = { key: string; href: string | null; label: string; keptUntil: CalendarDate };

/** A draft's own address, kept only when it is one of this application's question or finding pages (B10: never a stored `javascript:`). */
export function safeDraftHref(v: unknown): string | null {
  const href = typeof v === 'object' && v !== null ? (v as { href?: unknown }).href : undefined;
  return typeof href === 'string' && /^\/orgs\/[^/?#\s]+\/projects\/[^/?#\s]+\/[A-Za-z0-9/_-]+$/.test(href) ? href : null;
}

/**
 * S-21's "Unsaved changes in this browser" (UX-26, NFR-PRIV-06): how many unsaved changes this account has kept in this
 * browser, each with its link and "kept until <date>", and a Delete that removes them all. Read from storage after mount; with no
 * storage it says there are none it can keep. A slot of S-21: ACC-b renders it.
 */
export function DraftsOnThisDevice({ userId }: DraftsOnThisDeviceProps): ReactElement {
  const [store, setStore] = useState<DraftStore | null>(null);
  const [items, setItems] = useState<Listed[] | null>(null);

  function read(s: DraftStore | null): Listed[] {
    if (s === null) return [];
    return s.list(userId, new Date()).map((d) => ({
      key: `${d.key.orgId}:${d.key.projectId}:${d.key.target.kind === 'question' ? d.key.target.questionId : d.key.target.findingId}`,
      href: safeDraftHref(d.draft.value),
      label: d.key.target.kind === 'question' ? d.key.target.questionId : DRAFTS_COPY.list.mitigation,
      keptUntil: d.keptUntil,
    }));
  }

  useEffect(() => {
    const s = openDraftStore();
    // localStorage exists only in the browser, after hydration: a one-shot read on mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStore(s);
    setItems(read(s));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const n = items?.length ?? 0;
  return (
    <section id="drafts-on-this-device" aria-labelledby="drafts-on-this-device-heading">
      <h2 id="drafts-on-this-device-heading">{DRAFTS_COPY.list.heading}</h2>
      <p role="status">{items === null ? '' : DRAFTS_COPY.list.count(n)}</p>
      {n > 0 ? (
        <>
          <ul>
            {items!.map((d) => (
              <li key={d.key}>
                {d.href !== null ? <a href={d.href}>{d.label}</a> : d.label}
                {DRAFTS_COPY.list.keptUntil(formatDay(d.keptUntil))}
              </li>
            ))}
          </ul>
          <Button variant="secondary" onClick={() => { store?.purgeAccount(userId); setItems(read(store)); }}>{DRAFTS_COPY.list.deleteAll}</Button>
        </>
      ) : null}
    </section>
  );
}
