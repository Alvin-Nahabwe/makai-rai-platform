import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripAnsi } from '../helpers/spawnText';

/**
 * The nginx render script (SRS 12.2 step 2; contract "Further cross-unit symbols", gap G101): the production
 * docker/nginx/default.conf, changed in exactly three places so it runs in front of a local app (NFR-SEC-06's
 * "Verified by": the production nginx configuration, with a real-address list that admits the test network).
 * The child runs with NO_COLOR=1 and no FORCE_COLOR, and its output is stripped of ANSI codes before matching.
 */
function run(args: string[]) {
  const { FORCE_COLOR: _f, ...env } = process.env;
  const r = spawnSync('node', ['scripts/nginx-test/render.mjs', ...args], { encoding: 'utf8', env: { ...env, NO_COLOR: '1' } });
  return { status: r.status, stdout: stripAnsi(r.stdout), stderr: stripAnsi(r.stderr) };
}

describe('scripts/nginx-test/render.mjs', () => {
  it('NFR-SEC-06 (12.2 step 2): the render changes exactly the Cloudflare list, the certificate pair and the upstream', () => {
    const out = mkdtempSync(join(tmpdir(), 'ngx-'));
    const r = run([out, 'host.docker.internal:3105']);
    expect(r.status).toBe(0);
    const beforeText = readFileSync('docker/nginx/default.conf', 'utf8');
    const afterText = readFileSync(join(out, 'default.conf'), 'utf8');
    const before = beforeText.split('\n');
    const after = afterText.split('\n');
    const changed = after.filter((l) => !before.includes(l));
    expect(changed.some((l) => /proxy_pass http:\/\/host\.docker\.internal:3105;/.test(l))).toBe(true);
    expect(changed.some((l) => /ssl_certificate\s+\/etc\/ssl\/makrai\/cert\.pem;/.test(l))).toBe(true);
    expect(changed.some((l) => /ssl_certificate_key\s+\/etc\/ssl\/makrai\/key\.pem;/.test(l))).toBe(true);
    expect(r.stdout.trim().split('\n')).toHaveLength(3); // one printed line per change
    expect(afterText).not.toMatch(/proxy_pass http:\/\/nextjs:3000/);
    // The geo block admits the loopback and Docker networks only, and still refuses everything else.
    const geo = /geo \$realip_remote_addr \$from_cloudflare \{([\s\S]*?)\n\}/.exec(afterText)![1];
    expect(geo.split('\n').map((l) => l.trim()).filter(Boolean)).toEqual(['default 0;', '127.0.0.0/8 1;', '172.16.0.0/12 1;']);
    // Nothing else changed: with the three replacements undone, the text is the template's.
    const undone = afterText
      .replace(/geo \$realip_remote_addr \$from_cloudflare \{[\s\S]*?\n\}/, /geo \$realip_remote_addr \$from_cloudflare \{[\s\S]*?\n\}/.exec(beforeText)![0])
      .replace('/etc/ssl/makrai/cert.pem', '/etc/ssl/makrai/fullchain.pem')
      .replace('/etc/ssl/makrai/key.pem', '/etc/ssl/makrai/privkey.pem')
      .replaceAll('http://host.docker.internal:3105', 'http://nextjs:3000');
    expect(undone).toBe(beforeText);
  });

  it('NFR-SEC-06: a template without one of the three anchors writes nothing and exits 1', () => {
    const conf = readFileSync('docker/nginx/default.conf', 'utf8');
    const variants = {
      'no geo block': conf.replace(/geo \$realip_remote_addr \$from_cloudflare \{[\s\S]*?\n\}/, ''),
      'no certificate pair': conf.replace(/ssl_certificate\s+\S+;/, ''),
      'no proxy_pass': conf.replaceAll('proxy_pass http://nextjs:3000;', ''),
      'two geo blocks': conf + '\n' + /geo \$realip_remote_addr \$from_cloudflare \{[\s\S]*?\n\}/.exec(conf)![0],
    };
    for (const [name, text] of Object.entries(variants)) {
      const dir = mkdtempSync(join(tmpdir(), 'ngx-bad-'));
      const template = join(dir, 'template.conf');
      writeFileSync(template, text);
      const out = join(dir, 'out');
      const r = run([out, 'host.docker.internal:3105', '--template', template]);
      expect({ name, status: r.status, wrote: existsSync(join(out, 'default.conf')) }).toEqual({ name, status: 1, wrote: false });
    }
  });

  it('NFR-SEC-06: a malformed upstream or missing argument exits 1', () => {
    const out = mkdtempSync(join(tmpdir(), 'ngx-'));
    expect(run([out]).status).toBe(1);
    expect(run([out, 'host;evil']).status).toBe(1);
    expect(existsSync(join(out, 'default.conf'))).toBe(false);
  });
});
