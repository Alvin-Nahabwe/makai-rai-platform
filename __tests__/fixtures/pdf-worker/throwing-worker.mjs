// A test worker for __tests__/integration/working-report-worker-failure.test.ts: every render throws, and the answer is the one
// lib/documents/render/pdfWorker.mjs sends ({ id, error, frames }: the class name and this file's frames, never the message), so a
// case can find this file in the log line and check the message's text is not there.
import { parentPort } from 'node:worker_threads';
import { framesAfterMessage } from '../../../lib/http/stackFrames.mjs';

function renderThatThrows() {
  throw new TypeError('render threw in the fixture\n    at secret answer text (/srv/secret-answer.js:1:2)');
}

parentPort.on('message', ({ id }) => {
  try {
    renderThatThrows();
  } catch (e) {
    parentPort.postMessage({ id, error: e.name, frames: framesAfterMessage(e) });
  }
});
