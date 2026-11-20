// A test worker for __tests__/unit/working-report-pdf-worker.test.ts and __tests__/integration/working-report-worker-failure.test.ts.
// It speaks lib/documents/render/pdfWorker.mjs's protocol ({ id, tree } -> { id, pdf } or { id, error, frames }), and the document's
// title says what it does, so the pool's handling of each answer runs against a real thread:
// - `crash` ends the thread; `hang` is never answered; `balloon` allocates until the thread's heap limit ends it;
// - `junk` answers four bytes that are not a PDF, `empty` answers no bytes;
// - `leak` answers a failure the pool must not trust: a raw stack, a message, a made-up name, and frames that are mostly not frames;
// - anything else answers a few bytes that begin with the PDF magic, so a case can tell this worker's answer from the real one's.
import { parentPort } from 'node:worker_threads';

parentPort.on('message', ({ id, tree }) => {
  const title = tree?.p?.title;
  if (title === 'crash') process.exit(1);
  if (title === 'hang') return;
  if (title === 'balloon') {
    const kept = [];
    for (;;) kept.push(new Array(1e5).fill(kept.length));
  }
  if (title === 'junk') return parentPort.postMessage({ id, pdf: new Uint8Array([1, 2, 3, 4]) });
  if (title === 'empty') return parentPort.postMessage({ id, pdf: new Uint8Array(0) });
  if (title === 'leak') {
    // A hostile answer: a raw stack, a message, a name that is not a class name, and frames of which only one is a frame.
    return parentPort.postMessage({
      id, error: 'secret answer text', name: 'Secret answer', message: 'secret answer text',
      stack: 'Error: secret answer text\n    at secret (/srv/secret.js:1:2)',
      frames: ['    at failingRender (/srv/fixture.mjs:3:9)', '    at secret answer text', 42, 'Error: secret answer text', { secret: 1 }],
    });
  }
  parentPort.postMessage({ id, pdf: new TextEncoder().encode('%PDF-1.4 fixture') });
});
