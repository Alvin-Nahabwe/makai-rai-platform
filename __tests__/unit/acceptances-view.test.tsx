import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createHash } from 'node:crypto';
import type { AcceptedKind, LegalTextVersion } from '@/types/legal';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
// The shipped registry (versions 1 and 2 of each accepted kind), with one kind's history replaced where a case says so.
const history = vi.hoisted(() => ({ override: null as null | { kind: string; versions: string[] } }));
vi.mock('@/lib/legal/registry', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/legal/registry')>();
  return {
    ...real,
    legalTextHistory: (k: Parameters<typeof real.legalTextHistory>[0]) => (history.override?.kind === k
      ? history.override.versions.map((version) => ({ ...real.legalTextHistory(k)[0], version }))
      : real.legalTextHistory(k)),
  };
});
const summaries = vi.hoisted(() => ({ extra: {} as Record<string, Record<string, string>> }));
vi.mock('@/lib/legal/copy', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/legal/copy')>();
  const merged = Object.fromEntries(Object.entries(real.LEGAL_CHANGE_SUMMARIES).map(([k, v]) => [k, new Proxy(v, {
    get: (target, version: string) => summaries.extra[k]?.[version] ?? (target as Record<string, string>)[version],
  })]));
  return { ...real, LEGAL_CHANGE_SUMMARIES: merged };
});
vi.mock('next-auth/react', () => ({ signOut: vi.fn() }));

import { AcceptancesView } from '@/components/legal/AcceptancesView';
import { ACCEPT_LABEL, ACCEPTANCES_COPY } from '@/lib/legal/acceptances/copy';
import { AcceptancesFormView } from '@/components/legal/AcceptancesForm';
import { LEGAL_CHANGE_SUMMARIES, LEGAL_COPY } from '@/lib/legal/copy';
import { LEGAL_KIND_NAMES } from '@/lib/legal/kinds';
import { textOf } from '@/__tests__/helpers/markup';

/**
 * Plan 1B Task 7 (spec 9.8): S-05 shows, for each text it asks the person to accept, which text changed, from which
 * version to which, and the plain summary of what changed, before that text's box; a first acceptance shows none of it.
 */
const text = (kind: AcceptedKind, version: string): LegalTextVersion => {
  const words = `Secret words of ${kind} ${version}`;
  return { kind, version, publishedOn: '2026-11-12', acceptance: 'required', sha256: createHash('sha256').update(words).digest('hex'), text: words };
};
type Item = { kind: AcceptedKind; current: LegalTextVersion; lastAccepted: string | null; state: 'missing' | 'offered' };
const changed = (kind: AcceptedKind): Item => ({ kind, current: text(kind, '2'), lastAccepted: '1', state: 'missing' });
const first = (kind: AcceptedKind): Item => ({ kind, current: text(kind, '2'), lastAccepted: null, state: 'missing' });
const html = (items: Item[], mode: 'required' | 'offer' = 'required') => renderToStaticMarkup(<AcceptancesView items={items} mode={mode} userId="u1" />);

describe('AcceptancesView', () => {
  it('9.8: a changed text shows which text, old and new version, and its summary before its box', () => {
    const out = html([changed('terms'), changed('privacy')]);
    expect(out).toContain(`<h1 style="margin:0">${LEGAL_COPY.changes.heading}</h1>`);
    for (const kind of ['terms', 'privacy'] as const) {
      const title = LEGAL_COPY.changes.title(LEGAL_KIND_NAMES[kind], '1', '2');
      const summary = LEGAL_CHANGE_SUMMARIES[kind]['2'];
      expect(textOf(out)).toContain(title);
      expect(textOf(out)).toContain(summary);
      const box = out.indexOf(`id="accept-${kind}"`);
      expect(out.indexOf(summary.slice(0, 40))).toBeLessThan(box);
      expect(out.indexOf(summary.slice(0, 40))).toBeGreaterThan(out.indexOf(title.slice(0, 20)));
    }
    expect(textOf(out)).toContain(LEGAL_COPY.changes.title('terms of service', '1', '2'));
    expect(LEGAL_COPY.changes.title('terms of service', '1', '2')).toBe('Terms of service: version 1 is now version 2');
    expect(out.match(new RegExp(`>${LEGAL_COPY.changes.whatChanged}<`, 'g'))).toHaveLength(2);
    // Its box keeps its own sentence (ACCEPT_LABEL) and each changed text has one link to its full words, in a new tab.
    expect(textOf(out)).toContain(ACCEPT_LABEL.terms);
    expect(out.match(/target="_blank"/g)).toHaveLength(2);
    expect(textOf(out)).toContain(`${LEGAL_COPY.changes.readFull(LEGAL_KIND_NAMES.terms)} ${ACCEPTANCES_COPY.opensInNewTab}`);
    expect(out).toContain('href="/legal/terms/2"');
  });

  it('a first acceptance shows no "What changed", and keeps the first-time heading and lead', () => {
    const out = html([first('terms'), first('privacy'), first('cross-border-consent')]);
    expect(out).not.toContain(LEGAL_COPY.changes.whatChanged);
    expect(out).toContain(`<h1 style="margin:0">${ACCEPTANCES_COPY.legend}</h1>`);
    expect(textOf(out)).toContain(ACCEPTANCES_COPY.lead);
    expect(out.match(/target="_blank"/g)).toHaveLength(3);
  });

  it('required: the alternatives line stays; offer: Not now stays, with the offer heading', () => {
    expect(textOf(html([changed('terms')]))).toContain('If you do not want to accept, you can delete your account or sign out.');
    const offer = html([{ ...changed('privacy'), state: 'offered' }], 'offer');
    expect(textOf(offer)).toContain(ACCEPTANCES_COPY.notNow);
    expect(offer).toContain(ACCEPTANCES_COPY.offerLegend([LEGAL_KIND_NAMES.privacy]));
    expect(textOf(offer)).toContain(LEGAL_CHANGE_SUMMARIES.privacy['2']);
  });

  it('SFH F2: an account two versions behind sees what changed in each version after the one it accepted, in order', () => {
    history.override = { kind: 'privacy', versions: ['1', '2', '3'] };
    summaries.extra = { privacy: { '3': 'Fixture summary of version 3.' } };
    try {
      const out = html([{ kind: 'privacy', current: text('privacy', '3'), lastAccepted: '1', state: 'missing' }]);
      expect(textOf(out)).toContain(LEGAL_COPY.changes.title(LEGAL_KIND_NAMES.privacy, '1', '3'));
      const v2 = out.indexOf(LEGAL_CHANGE_SUMMARIES.privacy['2'].slice(0, 40));
      const v3 = out.indexOf('Fixture summary of version 3.');
      expect(v2).toBeGreaterThan(-1);
      expect(v3).toBeGreaterThan(v2);
    } finally {
      history.override = null;
      summaries.extra = {};
    }
  });

  it('SFH F1: a version with no summary still names the text and links its words, and says so on the server', () => {
    history.override = { kind: 'terms', versions: ['1', '2', '3'] };
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const out = html([{ kind: 'terms', current: text('terms', '3'), lastAccepted: '2', state: 'missing' }]);
      expect(textOf(out)).toContain(LEGAL_COPY.changes.title(LEGAL_KIND_NAMES.terms, '2', '3'));
      expect(out).toContain('href="/legal/terms/3"');
      expect(out).not.toContain(LEGAL_COPY.changes.whatChanged);
      expect(error.mock.calls).toEqual([['legal_change_summary_missing', 'terms', '3']]);
    } finally {
      history.override = null;
      error.mockRestore();
    }
  });

  it('review A-3: a null before-node counts as none, so its box keeps its own link to the words', () => {
    const t = { ...text('terms', '2'), text: '' };
    const out = renderToStaticMarkup(<AcceptancesFormView texts={[t]} mode="required" userId="u1" submitLabel="Accept" before={{ terms: null }}
      ticked={new Set()} errors={[]} onToggle={() => {}} onSubmit={() => {}} />);
    expect(out.match(/target="_blank"/g)).toHaveLength(1);
    expect(textOf(out)).toContain(ACCEPTANCES_COPY.readLink(LEGAL_KIND_NAMES.terms));
  });

  it('T7.3: no legal words reach the markup or the client props; only kind and version', () => {
    const out = html([changed('terms'), first('privacy')]);
    expect(out).not.toMatch(/Secret words/);
  });
});
