// A test worker for __tests__/unit/working-report-pdf-worker.test.ts. It speaks lib/documents/render/pdfWorker.mjs's protocol, but
// a document titled `crash` ends the thread and one titled `hang` is never answered, so the pool's restart and timeout run for real.
// Any other document is answered with four bytes that are not a PDF, so a case can tell this worker's answer from the real one's.
import { parentPort } from 'node:worker_threads';

parentPort.on('message', ({ id, tree }) => {
  if (tree?.p?.title === 'crash') process.exit(1);
  if (tree?.p?.title === 'hang') return;
  parentPort.postMessage({ id, pdf: new Uint8Array([1, 2, 3, 4]) });
});
