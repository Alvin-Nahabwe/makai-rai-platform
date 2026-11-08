#!/usr/bin/env node
// A local stand-in for Resend's API, for live runs and the nginx spec (SRS 12.2 step 9; contract "Further cross-unit
// symbols", gap G102). The app's Resend SDK sends to it when RESEND_BASE_URL names it (node_modules/resend/dist/index.mjs,
// getDefaultBaseUrl), with RESEND_API_KEY=re_test_local; no real mailbox or key is involved. Usage:
//
//   node scripts/mail-catcher/catcher.mjs --host <127.0.0.1|172.17.0.1> --port <n> --out <file.jsonl>
//
// Prints `listening <port>` once bound (so --port 0 works). POST /emails answers 200 {"id":"<uuid>"} and appends
// {"kind":"email","receivedAt","from","to","subject","html","text"} to the out file; any method on /hc/<rest> answers
// 200 and appends {"kind":"ping","receivedAt","path"}; anything else is 404. The out file holds reset links, so it is
// created mode 600, and the catcher binds the loopback or the Docker bridge only: any other host exits 2.
// Node built-ins only.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, fchmodSync, openSync } from 'node:fs';

const ALLOWED_HOSTS = ['127.0.0.1', '172.17.0.1'];

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

const host = arg('--host');
const port = Number(arg('--port'));
const out = arg('--out');
if (!ALLOWED_HOSTS.includes(host)) {
  process.stderr.write(`catcher.mjs: --host must be one of ${ALLOWED_HOSTS.join(', ')}, got ${JSON.stringify(host)}\n`);
  process.exit(2);
}
if (!Number.isInteger(port) || port < 0 || port > 65535 || !out) {
  process.stderr.write('catcher.mjs: usage: --host <127.0.0.1|172.17.0.1> --port <n> --out <file.jsonl>\n');
  process.exit(1);
}

// Created (or truncated) with mode 600 before anything is written to it; an existing file is set to 600 as well, since
// open() applies the mode only when it creates the file.
const fd = openSync(out, 'w', 0o600);
fchmodSync(fd, 0o600);
closeSync(fd);
const record = (entry) => appendFileSync(out, `${JSON.stringify({ ...entry, receivedAt: new Date().toISOString() })}\n`, { mode: 0o600 });

const server = createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://catcher').pathname;
  const chunks = [];
  // A client that drops the connection must not take the catcher down with it.
  req.on('error', () => res.destroy());
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    if (path.startsWith('/hc/')) {
      record({ kind: 'ping', path });
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('OK');
      return;
    }
    if (req.method === 'POST' && path === '/emails') {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        res.writeHead(422, { 'Content-Type': 'application/json' }).end(JSON.stringify({ name: 'validation_error', message: 'body is not JSON', statusCode: 422 }));
        return;
      }
      // Resend refuses a message without a sender, a recipient or a subject; so does this stand-in, so a caller's bug shows.
      if (typeof body.from !== 'string' || (typeof body.to !== 'string' && !Array.isArray(body.to)) || typeof body.subject !== 'string') {
        res.writeHead(422, { 'Content-Type': 'application/json' }).end(JSON.stringify({ name: 'validation_error', message: 'from, to and subject are required', statusCode: 422 }));
        return;
      }
      record({ kind: 'email', from: body.from, to: body.to, subject: body.subject, html: body.html, text: body.text });
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: randomUUID() }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ name: 'not_found', message: 'Not found', statusCode: 404 }));
  });
});

server.listen(port, host, () => {
  process.stdout.write(`listening ${server.address().port}\n`);
});
const stop = () => {
  server.close(() => process.exit(0));
  server.closeAllConnections();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
