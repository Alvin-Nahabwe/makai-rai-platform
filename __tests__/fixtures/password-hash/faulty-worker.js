// A test worker for __tests__/unit/password-hash-pool.test.ts. It speaks lib/auth/passwordHashWorker.js's protocol, but
// the password `crash` ends the thread and `hang` is never answered, so the pool's restart and timeout run for real;
// `answer-a-string` and `answer-a-boolean` answer with the other job kind's type.
const { parentPort } = require('node:worker_threads');
const bcrypt = require('bcryptjs');

parentPort.on('message', ({ id, op, a, b }) => {
  if (a === 'crash') process.exit(1);
  if (a === 'hang') return;
  if (a === 'answer-a-string') return parentPort.postMessage({ id, value: 'true' });
  if (a === 'answer-a-boolean') return parentPort.postMessage({ id, value: true });
  try {
    parentPort.postMessage({ id, value: op === 'compare' ? bcrypt.compareSync(a, b) : bcrypt.hashSync(a, b) });
  } catch (e) {
    parentPort.postMessage({ id, error: e instanceof Error ? e.message : String(e) });
  }
});
