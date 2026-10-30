import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import Link from 'next/link';
import { formatSize } from '@/lib/format/size';
import { DownloadLink } from '@/components/ui/DownloadLink';
import { ListLink } from '@/components/ui/ListLink';
import { ShowMoreLink } from '@/components/ui/ShowMoreLink';
import { pageOf, LIST_PAGE_SIZE, HISTORY_PAGE_SIZE } from '@/lib/ui/showMore';
import { orgRoleLabel } from '@/lib/authz/roleLabel';

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

describe('sizes and downloads', () => {
  it('UX-39: sizes are written as 7.5.8 says', () => {
    expect([formatSize(84_000), formatSize(2_400_000), formatSize(500), formatSize(999_499), formatSize(999_500)]).toEqual(['84 KB', '2.4 MB', '1 KB', '999 KB', '1.0 MB']);
    expect(renderToStaticMarkup(<DownloadLink href="/t/c-17.html" label="Model card template" kind="HTML" bytes={12_000} />))
      .toBe('<a href="/t/c-17.html" download="">Model card template (HTML, 12 KB)</a>');
  });

  it('UX-39: an empty file is 1 KB, a megabyte has one decimal, and a size that is not a size is a RangeError', () => {
    expect([formatSize(0), formatSize(1), formatSize(1_000_000), formatSize(12_345_678), formatSize(10_000_000)]).toEqual(['1 KB', '1 KB', '1.0 MB', '12.3 MB', '10.0 MB']);
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5e300 * 1e10]) expect(() => formatSize(bad), String(bad)).toThrow(RangeError);
  });

  it('UX-39: the link text states the kind and the size, as one string', () => {
    const html = renderToStaticMarkup(<DownloadLink href="/api/v1/orgs/a/documents/d/pdf" label="Data card v1" kind="PDF" bytes={84_000} />);
    expect(html).toContain('>Data card v1 (PDF, 84 KB)</a>');
    expect(html).not.toContain('<!--');
  });
});

describe('paging', () => {
  it('UX-40: 60 items show 50 and Show more; a history shows 20', () => {
    expect(pageOf(range(60), null, LIST_PAGE_SIZE)).toEqual({ items: range(50), hasMore: true, nextShown: 100 });
    expect(pageOf(range(60), '100', LIST_PAGE_SIZE)).toEqual({ items: range(60), hasMore: false, nextShown: 100 });
    expect(pageOf(range(30), null, HISTORY_PAGE_SIZE).items).toHaveLength(20);
    expect([LIST_PAGE_SIZE, HISTORY_PAGE_SIZE]).toEqual([50, 20]);
  });

  it('UX-40: pageOf clamps a malformed or huge shown value', () => {
    for (const s of ['-5', 'x', '1e9', '99999999']) expect(pageOf(range(60), s, 50).items.length).toBeLessThanOrEqual(60);
    expect(pageOf(range(60), 'x', 50).items).toHaveLength(50);
  });

  it('UX-40: shown below a page, empty, fractional or with other characters is the first page; a list shorter than a page has no more', () => {
    for (const s of ['', '0', '10', '-5', '50.5', ' 100', '100 ', '+100', '0x64', '1e2', '١٠٠', '1234567890123']) {
      expect(pageOf(range(120), s, 50), JSON.stringify(s)).toEqual({ items: range(50), hasMore: true, nextShown: 100 });
    }
    expect(pageOf(range(10), null, 50)).toEqual({ items: range(10), hasMore: false, nextShown: 50 });
    expect(pageOf([], null, 50)).toEqual({ items: [], hasMore: false, nextShown: 50 });
  });

  it('UX-40: each Show more asks for one more page, and shown is kept while it still fits', () => {
    expect(pageOf(range(120), '100', 50)).toEqual({ items: range(100), hasMore: true, nextShown: 150 });
    expect(pageOf(range(120), '150', 50)).toEqual({ items: range(120), hasMore: false, nextShown: 150 });
    expect(pageOf(range(25), '20', 20)).toEqual({ items: range(20), hasMore: true, nextShown: 40 });
  });

  it('UX-40: a page size that is not a positive whole number is a RangeError, and the list is not changed', () => {
    for (const size of [0, -1, 1.5, Number.NaN]) expect(() => pageOf(range(3), null, size), String(size)).toThrow(RangeError);
    const items = range(60);
    pageOf(items, null, 50);
    expect(items).toEqual(range(60));
  });
});

describe('links', () => {
  it('UX-37: ListLink never prefetches', () => {
    const el = ListLink({ href: '/x', children: 'a' });
    expect(el.type).toBe(Link);
    expect(el.props).toMatchObject({ href: '/x', prefetch: false, children: 'a' });
  });

  it('UX-37: a caller cannot switch prefetching back on, and the other props pass through', () => {
    const el = ListLink({ href: '/x', prefetch: true, className: 'row', children: 'a', scroll: false });
    expect(el.props).toMatchObject({ prefetch: false, className: 'row', scroll: false });
  });

  it('UX-40: ShowMoreLink renders a non-prefetching link with the given words', () => {
    expect(renderToStaticMarkup(<ShowMoreLink href="?shown=100" label="Show more" />)).toMatch(/^<a [^>]*href="\?shown=100"[^>]*>Show more<\/a>$/);
    expect(renderToStaticMarkup(<ShowMoreLink href="?shown=40" label="Show older" />)).toMatch(/>Show older<\/a>$/);
    const el = ShowMoreLink({ href: '?shown=100', label: 'Show more' });
    expect(el.type).toBe(ListLink);
    expect(el.props).toMatchObject({ href: '?shown=100', children: 'Show more' });
  });
});

describe('role label', () => {
  it('UX-02 (helper): the role-label stub is a function of an identity and a slug', () => {
    // the signature only: a test that pinned the null body would turn red when AUTHZ fills it (REG-EVD-K0B-STUBTEST); the marker is guarded by no-contract-stubs.test.ts
    expect(typeof orgRoleLabel).toBe('function'); expect(orgRoleLabel.length).toBe(2);
  });
});
