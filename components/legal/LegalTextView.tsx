import type { CSSProperties, ReactElement } from 'react';
import type { LegalTextKind, LegalTextVersion } from '@/types/legal';
import { LEGAL_KIND_NAMES } from '@/lib/legal/registry';
import { formatDay } from '@/lib/format/dates';

/**
 * One version of a legal text as S-06 shows it (FR-ACC-02, SRS line 479; screen row line 1677): the kind's
 * name as the page's one heading, "Version <v>, published <date>", the SHA-256 of the version's file, and
 * the text. The text is rendered as React text nodes, one paragraph per block of the file separated by a
 * blank line, so markup in a text is shown, never run (NFR-SEC-11); a single line break inside a block is
 * kept (`white-space: pre-line`), so a list written one item per line reads as the file has it.
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

/** The column every S-06 page sits in: about 75 characters wide (lines stay readable), never wider than the screen. */
export const LEGAL_PAGE_STYLE: CSSProperties = {
  width: '100%',
  maxWidth: '75ch',
  margin: '0 auto',
  padding: 'var(--space-12) var(--space-6)',
};

/** A link on its own line: underlined (7.6.3 D-4, links are not shown by colour alone) and at least 24 pixels tall (UX-34). */
export const LEGAL_LINK_STYLE: CSSProperties = {
  display: 'inline-block',
  minHeight: '1.5rem',
  textDecoration: 'underline',
};

export function LegalTextView({ text }: { text: LegalTextVersion }): ReactElement {
  return (
    <article>
      <h1 style={{ marginBottom: 'var(--space-2)' }}>{legalTextHeading(text.kind)}</h1>
      <p>{versionLine(text)}</p>
      <dl style={{ margin: 'var(--space-3) 0 var(--space-6)' }}>
        <dt style={{ fontWeight: 'var(--font-weight-bold)' }}>SHA-256</dt>
        <dd style={{ margin: 0 }}>
          <code style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', overflowWrap: 'anywhere' }}>
            {groupsOfFour(text.sha256)}
          </code>
        </dd>
      </dl>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-4)',
          lineHeight: 'var(--line-height-relaxed)',
          whiteSpace: 'pre-line',
          overflowWrap: 'break-word',
        }}
      >
        {paragraphsOf(text.text).map((paragraph, i) => (
          <p key={i}>{paragraph}</p>
        ))}
      </div>
    </article>
  );
}
