// A test worker for __tests__/integration/working-report-worker-failure.test.ts: every render throws, and the answer carries this
// file's stack as lib/documents/render/pdfWorker.mjs's does ({ id, error, stack }), so a case can find this file in the log line.
import { parentPort } from 'node:worker_threads';

function renderThatThrows() {
  throw new Error('render threw in the fixture');
}

parentPort.on('message', ({ id }) => {
  try {
    renderThatThrows();
  } catch (e) {
    parentPort.postMessage({ id, error: e.message, stack: e.stack });
  }
});
