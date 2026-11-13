import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * Static markup as a reader hears it, for the components/ui tests (plan 1A): tags dropped and React's entity escapes
 * decoded. React escapes exactly these five characters in text and attributes (react-dom/server `escapeTextForBrowser`).
 */
const ENTITIES: Readonly<Record<string, string>> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'" };

/** Decodes React's five entity escapes. `&amp;` is matched as a whole entity, so "&amp;lt;" becomes "&lt;", not "<". */
export function decode(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|#x27);/g, (entity) => ENTITIES[entity]);
}

/** The text of a markup string: every tag removed, entities decoded. */
export function textOf(html: string): string {
  return decode(html.replace(/<[^>]*>/g, ''));
}

/** The text an element renders to on the server. */
export function text(el: ReactElement): string {
  return textOf(renderToStaticMarkup(el));
}
