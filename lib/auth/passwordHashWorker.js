/* eslint-disable @typescript-eslint/no-require-imports -- a worker started by path runs untranspiled, and the package is CommonJS, so it requires. */
// One worker thread of lib/auth/passwordHash.ts's pool. Plain CommonJS JavaScript, so it runs as-is from the source
// tree under the tests and from .next/standalone in the image (next.config.ts traces it; scripts/check-standalone.mjs
// checks it is there). It answers one job at a time: { id, op: 'compare' | 'hash', a, b } -> { id, value } or { id, error }.
// The work is bcryptjs's own synchronous code, so every hash it makes is the same cost-12 bcrypt the database holds.
const { parentPort } = require('node:worker_threads');
const bcrypt = require('bcryptjs');

parentPort.on('message', ({ id, op, a, b }) => {
  try {
    parentPort.postMessage({ id, value: op === 'compare' ? bcrypt.compareSync(a, b) : bcrypt.hashSync(a, b) });
  } catch (e) {
    parentPort.postMessage({ id, error: e instanceof Error ? e.message : String(e) });
  }
});
