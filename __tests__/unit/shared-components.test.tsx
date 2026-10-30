import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { ArchivedBanner } from '@/components/project/ArchivedBanner';

const noop = () => {};

describe('InlineConfirm', () => {
  it('UX-29 (helper): the inline confirmation names object and consequence and its button repeats the action', () => {
    const html = renderToStaticMarkup(<InlineConfirm objectName="Data card v1" consequence="It stays listed as withdrawn." actionLabel="Withdraw document" onConfirm={() => {}} onCancel={() => {}} />);
    expect(html).toContain('Data card v1'); expect(html).toContain('It stays listed as withdrawn.');
    expect(html).toMatch(/<button[^>]*>Withdraw document<\/button>/); expect(html).not.toMatch(/>OK</);
  });

  it('UX-29 (helper): the confirm button is disabled while busy or when canConfirm is false, and the cancel button never is', () => {
    const base = { objectName: 'Maternal-risk triage', consequence: 'Nothing in it can be changed.', actionLabel: 'Archive project', onConfirm: noop, onCancel: noop };
    const confirmOf = (html: string) => /<button[^>]*>Archive project<\/button>/.exec(html)![0];
    const cancelOf = (html: string) => /<button[^>]*>Cancel<\/button>/.exec(html)![0];
    for (const [props, disabled] of [[{}, false], [{ busy: true }, true], [{ canConfirm: false }, true], [{ canConfirm: true }, false]] as const) {
      const html = renderToStaticMarkup(<InlineConfirm {...base} {...props} />);
      expect(/disabled/.test(confirmOf(html)), JSON.stringify(props)).toBe(disabled);
      expect(/disabled/.test(cancelOf(html)), JSON.stringify(props)).toBe(false);
    }
  });

  it('UX-29 (helper): it renders in place, with no dialog, and carries extra fields (account deletion\'s password and phrase) as children', () => {
    const html = renderToStaticMarkup(
      <InlineConfirm objectName="Your account" consequence="It cannot be undone." actionLabel="Delete account" onConfirm={noop} onCancel={noop}>
        <label>Password <input type="password" name="password" /></label>
      </InlineConfirm>,
    );
    expect(html).not.toMatch(/<dialog|aria-modal|role="dialog"|role="alertdialog"/);
    expect(html).toContain('<input type="password" name="password"/>');
    // a confirm button that submits nothing by itself
    expect(html).toMatch(/<button type="button"[^>]*>Delete account<\/button>/);
  });

  it('UX-29 (helper): the group is named by the object, so a screen reader hears what is being confirmed', () => {
    const html = renderToStaticMarkup(<InlineConfirm objectName="Data card v1" consequence="c" actionLabel="Withdraw document" onConfirm={noop} onCancel={noop} />);
    const labelledBy = /aria-labelledby="([^"]+)"/.exec(html)?.[1];
    expect(labelledBy).toBeTruthy();
    expect(html).toMatch(new RegExp(`id="${labelledBy}"[^>]*>(?:<strong>)?Data card v1`));
  });
});

describe('ArchivedBanner', () => {
  it('UX-31 (helper): ArchivedBanner renders nothing for a live project', () => {
    expect(renderToStaticMarkup(<ArchivedBanner archived={false} />)).toBe('');
  });

  it('UX-31 FR-PRJ-03 (helper): an archived project shows the exact sentence in a status region', () => {
    const html = renderToStaticMarkup(<ArchivedBanner archived />);
    expect(html).toMatch(/^<div[^>]*role="status"[^>]*>This project is archived\. Nothing in it can be changed\. Owners and admins can unarchive it from All projects\.<\/div>$/);
  });
});
