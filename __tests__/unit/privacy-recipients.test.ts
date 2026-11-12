import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * NFR-PRIV-10: the privacy page names every place outside the host where
 * personal data goes. The words of the privacy notice are legal's; this list
 * is the part that is ours to supply, and the registry's content check
 * (ACC-a) holds the published text to it. It says only what NFR-PRIV-10
 * says: it claims nothing about how any recipient protects what it receives.
 */
type Recipient = { name: string; receives: string; where: string };

describe('data/privacy-recipients.json', () => {
  const r: Recipient[] = JSON.parse(readFileSync('data/privacy-recipients.json', 'utf8'));

  it('NFR-PRIV-10: the recipient list names Hetzner, Hetzner Storage Box, Cloudflare and Resend with what each receives and where', () => {
    expect(r.map((x) => x.name)).toEqual(['Hetzner', 'Hetzner Storage Box', 'Cloudflare', 'Resend']);
    for (const x of r) {
      expect(x.receives.length).toBeGreaterThan(0);
      expect(x.where.length).toBeGreaterThan(0);
    }
    // SRS line 3065 says Cloudflare sees traffic in clear; version 2 of the notice says it in other words (a register row
    // records the changed phrase): Cloudflare can read the traffic.
    expect(r[2].receives).toMatch(/Cloudflare can read this traffic/);
    expect(r[3].where).toBe('United States');
  });

  it('NFR-PRIV-10: each recipient has exactly the fields name, receives and where, as text', () => {
    for (const x of r) {
      expect(Object.keys(x).sort()).toEqual(['name', 'receives', 'where']);
      for (const v of Object.values(x)) expect(typeof v).toBe('string');
    }
  });

  it('NFR-PRIV-10: the list makes no claim the requirement does not make', () => {
    // No encryption, safety or compliance claim about a recipient (FR-PUB-01).
    expect(JSON.stringify(r)).not.toMatch(/encrypt|secure|safe|complian|certif|protect/i);
  });
});
