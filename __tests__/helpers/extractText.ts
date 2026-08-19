import type { ReactElement, ReactNode } from 'react';

/**
 * Flattens an unrendered React element tree to its text.
 *
 * This repo runs vitest under `environment: 'node'` with no jsdom, no
 * `@testing-library/react` and no `react-test-renderer` (D-169), so a
 * component is tested by CALLING it -- JSX compiles to plain `{type, props}`
 * construction, which needs no DOM and no reconciler. Only hook-free
 * components can be exercised this way.
 *
 * Deliberately never inspects `.type`, only `.props.children`, which makes it
 * renderer-agnostic: it walks a `<div>` tree and a @react-pdf/renderer
 * `<Document>` tree identically.
 */
export function extractText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (typeof node === 'object' && 'props' in node) {
    return extractText((node as ReactElement<{ children?: ReactNode }>).props?.children ?? null);
  }
  return '';
}
