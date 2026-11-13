import type { CSSProperties, ReactElement } from 'react';
import type { LegalTextKind, LegalTextVersion } from '@/types/legal';
import { LEGAL_KIND_NAMES } from '@/lib/legal/registry';
import { formatDay } from '@/lib/format/dates';

/**
 * One version of a legal text as S-06 shows it (FR-ACC-02, SRS line 479; screen row line 1677): the kind's name as
 * the page's one heading, "Version <v>, published <date>", the text, then in the article's footer the SHA-256 of the
 * version's file under a plain label. The text is rendered as React text nodes, one paragraph per block of the file
 * separated by a blank line, so markup in a text is shown, never run (NFR-SEC-11); a single line break inside a block
 * is kept (`white-space: pre-line`), so a list written one item per line reads as the file has it. A block that is
 * one line starting with "## " is a section heading (h2, the words after the marker), so the sections keep their
 * structure (WCAG 1.3.1). Links between the texts stay plain words: the format has no link.
 */

/** The kind's 7.5.7 name, written as a heading: "Privacy notice". */
export function legalTextHeading(kind: LegalTextKind): string {
  const name = LEGAL_KIND_NAMES[kind];
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** "Version 2, published 1 Dec 2026" (7.5.8 dates), one string so the markup holds it as one text node. */
export function versionLine(text: Pick<LegalTextVersion, 'version' | 'publishedOn'>): string {
  return `Version ${text.version}, published ${formatDay(text.publishedOn)}`;
}

/** 7.5.8: "lower-case hexadecimal in groups of four, separated by spaces". */
function groupsOfFour(hex: string): string {
  return hex.replace(/(.{4})(?=.)/g, '$1 ');
}

/** The blocks of a text, split on blank lines; a block holding only white space is no paragraph. */
function paragraphsOf(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
}

/** A section heading's words: a block of one line starting with "## "; null for any other block. */
function headingOf(block: string): string | null {
  return !block.includes('\n') && block.startsWith('## ') && block.length > 3 ? block.slice(3).trim() : null;
}

/** The column every S-06 page sits in: about 75 characters wide (lines stay readable), never wider than the screen. */
export const LEGAL_PAGE_STYLE: CSSProperties = {
  // A block takes the full width by default; maxWidth caps it.
  maxWidth: '75ch',
  margin: '0 auto',
  padding: 'var(--space-12) var(--space-6)',
};

/** The tinted band of S-06's notes (the retired agreement's, the earlier version's), above the text and outside its block. */
export const LEGAL_NOTE_STYLE: CSSProperties = {
  marginBottom: 'var(--space-6)',
  padding: 'var(--space-3) var(--space-4)',
  background: 'var(--tint-moderate-bg)',
  color: 'var(--tint-moderate-fg)',
  borderRadius: 'var(--border-radius-sm)',
};

/**
 * A link on its own line: underlined (7.6.3 D-4, links are not shown by colour alone) and at least 24 CSS
 * pixels tall (UX-34, WCAG 2.5.8). Pixels, not rem: the root font is 14 pixels on narrow screens until 7.6.3
 * D-7 is fixed, and 1.5rem there measured 21 pixels.
 */
export const LEGAL_LINK_STYLE: CSSProperties = {
  display: 'inline-block',
  minHeight: '24px',
  textDecoration: 'underline',
};

export function LegalTextView({ text }: { text: LegalTextVersion }): ReactElement {
  return (
    <article>
      <h1 style={{ marginBottom: 'var(--space-2)' }}>{legalTextHeading(text.kind)}</h1>
      <p style={{ marginBottom: 'var(--space-6)' }}>{versionLine(text)}</p>
      {/* data-legal-text: body text inside this block, and only that, is skipped by the claim-word crawl
          (e2e/claims-crawl.spec.ts), and only on S-06's two routes (owner ruling R1, 11 Nov 2026). The heading, version line
          above, the fingerprint below, spoken attributes inside the block and the consent labels stay checked. Nothing else
          reads it: not the unit check (it reads ACCEPT_LABEL, not the texts) and not the no-score check (e2e/helpers/noScore.ts). */}
      <div
        data-legal-text
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-4)',
          lineHeight: 'var(--line-height-relaxed)',
          whiteSpace: 'pre-line',
          overflowWrap: 'break-word',
        }}
      >
        {paragraphsOf(text.text).map((block, i) => {
          const heading = headingOf(block);
          return heading === null ? <p key={i}>{block}</p> : <h2 key={i}>{heading}</h2>;
        })}
      </div>
      {/* The article's footer, so moving by headings does not read the fingerprint as part of the text's last section. */}
      <footer>
        <dl style={{ margin: 'var(--space-6) 0 0' }}>
          <dt style={{ fontWeight: 'var(--font-weight-bold)' }}>File fingerprint, for checking that this text has not changed</dt>
          <dd style={{ margin: 0 }}>
            <code style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', overflowWrap: 'anywhere' }}>
              {groupsOfFour(text.sha256)}
            </code>
          </dd>
        </dl>
      </footer>
    </article>
  );
}
