#!/usr/bin/env node
// Renders docker/nginx/default.conf for a local run with nginx in front of the app (SRS 12.2 step 2; NFR-SEC-06;
// contract "Further cross-unit symbols", gap G101). Usage:
//
//   node scripts/nginx-test/render.mjs <outDir> <upstream host:port> [--template <file>]
//
// Writes <outDir>/default.conf, changing exactly three things and printing one line for each:
//   1. the body of `geo $realip_remote_addr $from_cloudflare` admits the loopback and Docker networks
//      (127.0.0.0/8, 172.16.0.0/12) instead of Cloudflare's, keeping `default 0`, so everything else is still refused;
//   2. the ssl_certificate pair points at /etc/ssl/makrai/cert.pem and key.pem (the files up.sh makes);
//   3. every `proxy_pass http://nextjs:3000` points at <upstream>.
// Everything else, the security headers and the default_server that refuses unknown names included, is the
// production file's. Exits 1 and writes nothing when an anchor is not found exactly once (any proxy_pass: at least
// once) or an argument is missing or malformed. Node built-ins only.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function fail(message) {
  process.stderr.write(`render.mjs: ${message}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
let template = 'docker/nginx/default.conf';
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--template') {
    template = args[++i];
    if (!template) fail('--template needs a file');
  } else positional.push(args[i]);
}
const [outDir, upstream] = positional;
if (!outDir || !upstream || positional.length !== 2) fail('usage: render.mjs <outDir> <upstream host:port> [--template <file>]');
if (!/^[A-Za-z0-9.-]+:\d{1,5}$/.test(upstream)) fail(`the upstream must be host:port, got ${JSON.stringify(upstream)}`);

let conf;
try {
  conf = readFileSync(template, 'utf8');
} catch (e) {
  fail(`cannot read ${template}: ${e.code ?? e.message}`);
}

const GEO = /^(geo \$realip_remote_addr \$from_cloudflare \{\n)[\s\S]*?(\n\})/gm;
const CERT = /^(\s*)ssl_certificate(\s+)\S+;\n(\s*)ssl_certificate_key(\s+)\S+;/gm;
const UPSTREAM = /proxy_pass http:\/\/nextjs:3000;/g;

const geoCount = conf.match(GEO)?.length ?? 0;
const certCount = conf.match(CERT)?.length ?? 0;
const upstreamCount = conf.match(UPSTREAM)?.length ?? 0;
if (geoCount !== 1) fail(`expected one geo $from_cloudflare block, found ${geoCount}`);
if (certCount !== 1) fail(`expected one ssl_certificate pair, found ${certCount}`);
if (upstreamCount === 0) fail('found no proxy_pass http://nextjs:3000');

const rendered = conf
  .replace(GEO, '$1    default 0;\n\n    127.0.0.0/8 1;\n    172.16.0.0/12 1;$2')
  .replace(CERT, '$1ssl_certificate$2/etc/ssl/makrai/cert.pem;\n$3ssl_certificate_key$4/etc/ssl/makrai/key.pem;')
  .replace(UPSTREAM, `proxy_pass http://${upstream};`);

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'default.conf'), rendered);
process.stdout.write('geo $from_cloudflare: 127.0.0.0/8 and 172.16.0.0/12 admitted, default 0 kept\n');
process.stdout.write('ssl_certificate: /etc/ssl/makrai/cert.pem and /etc/ssl/makrai/key.pem\n');
process.stdout.write(`proxy_pass: http://${upstream} (${upstreamCount} location${upstreamCount === 1 ? '' : 's'})\n`);
