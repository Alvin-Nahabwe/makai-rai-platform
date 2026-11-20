// One render thread of lib/documents/render/pdfWorkerPool.ts (Task 16 fix; design §5, the workshop). Plain JavaScript, so it runs
// as-is from the source tree under the tests and from .next/standalone in the image (next.config.ts traces it and breakPoints.mjs;
// scripts/check-standalone.mjs checks they are there). It draws a document the main thread composed and wrote out as a tree
// (lib/documents/render/pdfTree.ts), one job at a time: { id, tree } -> { id, pdf } or { id, error }. It reads no record, no file but
// what it was handed, and runs nothing it is sent: the tree is data, and only react-pdf's own primitives are drawn from it. A render
// that throws answers { id, error, frames }: `error` is the thrown error's class name (or `Error`), never its message, and `frames`
// only the V8 frames from after the message (lib/http/stackFrames.mjs). A message can hold the report's text, so neither it nor the
// raw stack ever leaves the thread; the pool puts the frames on the error the request logs.
import { parentPort, workerData } from 'node:worker_threads';
// React's entry files are CommonJS that pick a build by NODE_ENV; the image carries only the production build, so Node cannot list
// their named exports there ("Named export 'jsx' not found", seen from .next/standalone). The default import works everywhere.
import React from 'react';
import jsxRuntime from 'react/jsx-runtime';
import { Font, renderToBuffer } from '@react-pdf/renderer';
import { breakPoints } from './breakPoints.mjs';
import { CLASS_NAME, framesAfterMessage } from '../../http/stackFrames.mjs';

const { Fragment } = React;
const { jsx, jsxs } = jsxRuntime;
// The list in pdfTree.ts (PDF_ELEMENT_TYPES); a type outside it is refused, never drawn.
const TYPES = new Set(['DOCUMENT', 'PAGE', 'VIEW', 'TEXT', 'LINK', '#fragment']);

// The same registration as font.ts's registerPdfFont, from the bytes the pool handed over (pdfFontSource).
Font.register(workerData.font);
Font.registerHyphenationCallback((word) => breakPoints(word));

function build(node) {
  if (Array.isArray(node)) return node.map(build);
  if (node === null || typeof node !== 'object') return node;
  if (!TYPES.has(node.t)) throw new Error(`element type ${String(node.t)} is not one the worker draws`);
  const props = { ...node.p };
  if ('c' in node) props.children = build(node.c);
  // As compiled JSX makes an element: children in props exactly as they were, a list of them through jsxs, the key apart.
  const make = Array.isArray(props.children) ? jsxs : jsx;
  return make(node.t === '#fragment' ? Fragment : node.t, props, node.k === null ? undefined : node.k);
}

parentPort.on('message', async ({ id, tree }) => {
  try {
    const pdf = await renderToBuffer(build(tree));
    const bytes = new Uint8Array(pdf.buffer, pdf.byteOffset, pdf.byteLength).slice();
    parentPort.postMessage({ id, pdf: bytes }, [bytes.buffer]);
  } catch (e) {
    parentPort.postMessage(failure(id, e));
  }
});

/** The answer for a render that threw: its class name and its frames, never its message or raw stack. Never throws. */
function failure(id, e) {
  let name = 'Error';
  try {
    if (e instanceof Error && CLASS_NAME.test(String(e.name))) name = String(e.name);
  } catch {
    // a name getter that throws: the fixed name stands
  }
  return { id, error: name, frames: framesAfterMessage(e) };
}
