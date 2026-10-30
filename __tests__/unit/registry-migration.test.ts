import { describe, expect, it } from 'vitest';
import { contentMigrationDir, registryId, renderRegistryMigration } from '@/lib/content/registryMigration';

/**
 * The text of a content version's framework_versions migration (NFR-MNT-07, SRS 9.5 step 8).
 * Every database runs it as the owner role, so the renderer accepts only values that match
 * fixed patterns and writes nothing but one deprecation and one insert.
 */
const OK = { semver: '5.0.0', contentHash: 'a'.repeat(64), publishedAt: '2026-10-30T20:30:00.000Z', deprecate: ['3.0.0', '3.0.1', '4.0.0'], command: 'npx tsx scripts/content/release-version.ts 5.0.0 20261031230000' };

describe('renderRegistryMigration', () => {
  it('NFR-MNT-07: names follow the existing registry ids and the contract folder', () => {
    expect(registryId('5.0.0')).toBe('fv_5_0_0');
    expect(registryId('0.0.1-fixture')).toBe('fv_0_0_1_fixture');
    expect(contentMigrationDir('20261031230000', '5.0.0')).toBe('prisma/migrations/20261031230000_content_5_0_0');
  });
  it('NFR-MNT-07: one deprecation and one insert, in that order, matching the registry test regex', () => {
    const sql = renderRegistryMigration(OK);
    expect(sql.indexOf('UPDATE "framework_versions" SET "status" = \'deprecated\'')).toBeLessThan(sql.indexOf('INSERT INTO "framework_versions"'));
    expect(/INSERT INTO "framework_versions"[^;]*?VALUES\s*\(\s*'([^']+)'/.exec(sql)?.[1]).toBe('fv_5_0_0');
    expect(sql).toContain(`'${'a'.repeat(64)}'`); expect(sql).not.toMatch(/GRANT|DELETE|ON CONFLICT/i);
    expect(renderRegistryMigration(OK)).toBe(sql);
    // The first version of a registry deprecates nothing: the UPDATE is left out, the INSERT stays.
    const first = renderRegistryMigration({ ...OK, deprecate: [] });
    expect(first).not.toContain('UPDATE'); expect(first).toContain("VALUES ('fv_5_0_0', '5.0.0'");
  });
  it('NFR-MNT-07: the registry migration renderer refuses unsafe values', () => {
    for (const bad of [{ semver: "5.0.0'; DROP TABLE x; --" }, { semver: '../5.0.0' }, { contentHash: 'A'.repeat(64) }, { contentHash: 'a'.repeat(63) },
      { publishedAt: '2026-10-30' }, { deprecate: ["4.0.0'"] }, { deprecate: ['5.0.0'] },
      // The command is written into a "--" comment line: a line break would end the comment.
      { command: 'npx tsx x.ts\nDROP TABLE "framework_versions";' }, { command: 'npx tsx x.ts\r' }, { command: '' },
      // Matches the pattern but is no instant: refused here rather than by the database on deploy day.
      { publishedAt: '2026-13-45T99:99:99.000Z' }, { publishedAt: '2026-02-30T00:00:00.000Z' }, { semver: '5.0.0\n' },
      // A hole in the list is not a version: .map would skip it and render "IN (, '4.0.0')".
      { deprecate: Object.assign(new Array<string>(2), { 1: '4.0.0' }) }, { deprecate: '4.0.0' as unknown as string[] }])
      expect(() => renderRegistryMigration({ ...OK, ...bad })).toThrow();
    for (const s of ['../5.0.0', "5.0.0'", '5.0.0/x', '']) expect(() => registryId(s)).toThrow();
    for (const [stamp, s] of [['../../x', '5.0.0'], ['2026103123000', '5.0.0'], ['20261031230000', '../5.0.0']])
      expect(() => contentMigrationDir(stamp, s)).toThrow();
  });
});
