import { describe, it, expect } from 'vitest';
import { exportRefusalLocation } from '@/lib/http/exportRefusal';

/** Route 20's 303 target, built here once for the proxy and for EXP's handler (contract Services, lib/http/exportRefusal.ts). */
const PID = '3f2b8c1e-5a47-4d0b-9e61-7c2d4a9b0f13';

describe('exportRefusalLocation', () => {
  it('owner question B4: the target has two shapes, one for the organisation and one for a project, for both reasons', () => {
    expect(exportRefusalLocation('acme-health', null, 'export_busy')).toBe('/orgs/acme-health/export?refused=export_busy');
    expect(exportRefusalLocation('acme-health', null, 'rate_limited')).toBe('/orgs/acme-health/export?refused=rate_limited');
    expect(exportRefusalLocation('acme-health', PID, 'export_busy')).toBe(`/orgs/acme-health/projects/${PID}/export?refused=export_busy`);
    expect(exportRefusalLocation('a1', PID, 'rate_limited')).toBe(`/orgs/a1/projects/${PID}/export?refused=rate_limited`);
  });

  it('owner question B4: a slug that fails ^[a-z0-9]+(?:-[a-z0-9]+)*$ gives null, a slug that passes does not', () => {
    for (const bad of ['', 'Bad_Slug', 'UPPER', '-lead', 'trail-', 'a--b', 'a/b', 'a b', 'a?x=1', '../x', 'ünï', 'a\n', 'a%2Fb', 'a\\b', 'a#b'])
      expect(exportRefusalLocation(bad, null, 'export_busy'), JSON.stringify(bad)).toBeNull();
    for (const good of ['a', 'a-b-1', '9']) expect(exportRefusalLocation(good, null, 'export_busy'), good).not.toBeNull();
  });

  it('owner question B4: a project id that fails the lower-case 8-4-4-4-12 pattern gives null, also when the slug is fine', () => {
    for (const bad of ['', 'not-a-uuid', PID.toUpperCase(), `${PID}/../x`, `${PID}?refused=1`, PID.slice(1), ` ${PID}`, `${PID}\n`, '../x?refused=1'])
      expect(exportRefusalLocation('acme-health', bad, 'rate_limited'), JSON.stringify(bad)).toBeNull();
  });

  it('owner question B4: the slug is checked even when the id is fine, and the result holds nothing but the checked parts', () => {
    expect(exportRefusalLocation('Bad_Slug', PID, 'export_busy')).toBeNull();
    expect(exportRefusalLocation('acme-health', PID, 'export_busy')).toMatch(/^\/orgs\/acme-health\/projects\/[0-9a-f-]{36}\/export\?refused=export_busy$/);
  });

  it('owner question B4: the result is a path on this site, never an absolute URL or a protocol-relative one', () => {
    for (const slug of ['a', 'acme-health', 'x9-y']) {
      for (const id of [null, PID]) {
        const loc = exportRefusalLocation(slug, id, 'rate_limited');
        expect(loc, `${slug} ${id}`).toMatch(/^\/orgs\/[a-z0-9-]+\//);
        expect(loc).not.toMatch(/^\/\/|:\/\//);
      }
    }
  });
});
