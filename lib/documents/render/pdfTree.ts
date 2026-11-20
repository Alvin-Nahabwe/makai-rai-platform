import { isValidElement, type ReactNode } from 'react';

/**
 * A composed document as plain data a worker thread can receive (Task 16 fix; design §5). The pages are built on the main thread
 * by the composer (lib/documents/render/workingReport.tsx); only this tree crosses to the worker (lib/documents/render/pdfWorker.mjs),
 * which rebuilds the same elements and renders them. React elements cannot cross a thread, so they are written out here: each
 * element's type, key, props and children, with the children in the shape they had (one child or a list, a null kept as null).
 *
 * Only the react-pdf primitives the documents use cross, and the worker accepts no others. A component (a function type) or a
 * function in a prop has no plain-data form and would render differently or not at all, so it is refused here, loudly.
 */
export type PdfTree = string | number | boolean | null | undefined | PdfTree[] | PdfElement;
export type PdfElement = { t: PdfElementType; k: string | null; p: Record<string, unknown>; c?: PdfTree };

/** react-pdf's primitives are these strings (`View` is 'VIEW'); a fragment is written '#fragment'. pdfWorker.mjs holds the same list. */
export const PDF_ELEMENT_TYPES = ['DOCUMENT', 'PAGE', 'VIEW', 'TEXT', 'LINK', '#fragment'] as const;
export type PdfElementType = (typeof PDF_ELEMENT_TYPES)[number];

const FRAGMENT = Symbol.for('react.fragment');

function plain(value: unknown, where: string): void {
  if (typeof value === 'function') throw new Error(`toPdfTree: a function in prop ${where} cannot be rendered on the worker`);
  if (Array.isArray(value)) value.forEach((v) => plain(v, where));
  else if (value !== null && typeof value === 'object') for (const v of Object.values(value)) plain(v, where);
}

export function toPdfTree(node: ReactNode): PdfTree {
  if (Array.isArray(node)) return node.map(toPdfTree);
  if (node === null || node === undefined || typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') return node;
  if (!isValidElement(node)) throw new Error(`toPdfTree: ${typeof node} is not an element, a string, a number or a list`);
  const type = (node.type as unknown) === FRAGMENT ? '#fragment' : node.type;
  if (typeof type !== 'string' || !(PDF_ELEMENT_TYPES as readonly string[]).includes(type)) {
    const name = typeof type === 'string' ? type : typeof type === 'function' ? `component ${type.name || '(anonymous)'}` : String(type);
    throw new Error(`toPdfTree: element type ${name} is not one the worker draws`);
  }
  const { children, ...props } = node.props as Record<string, unknown> & { children?: ReactNode };
  for (const [k, v] of Object.entries(props)) plain(v, k);
  const out: PdfElement = { t: type as PdfElementType, k: node.key, p: props };
  if ('children' in (node.props as object)) out.c = toPdfTree(children);
  return out;
}
