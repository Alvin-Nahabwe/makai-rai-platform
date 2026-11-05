import { testDb } from './db';

/**
 * Runs `fn` with the table's own triggers disabled (as `makrai`), and re-enables each with its earlier mode.
 * `only` limits the switch-off to the named triggers (`organisation_events_db_time` for a case that only needs to
 * supply its own time column), leaving the table's other triggers in force.
 */
export async function withTriggersDisabled(table: string, fn: () => Promise<unknown>, only?: readonly string[]): Promise<void> {
  const all = await testDb.$queryRawUnsafe<{ name: string; mode: string }[]>(
    `SELECT tgname AS name, tgenabled::text AS mode FROM pg_trigger WHERE tgrelid = $1::regclass AND NOT tgisinternal`, table);
  const triggers = only === undefined ? all : all.filter((t) => only.includes(t.name));
  if (only !== undefined && triggers.length !== only.length) {
    throw new Error(`withTriggersDisabled: ${table} has no trigger named ${only.filter((n) => !triggers.some((t) => t.name === n)).join(', ')}`);
  }
  if (only === undefined) await testDb.$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE TRIGGER USER`);
  else for (const t of triggers) await testDb.$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE TRIGGER "${t.name}"`);
  try {
    await fn();
  } finally {
    for (const t of triggers) {
      const how = t.mode === 'A' ? 'ENABLE ALWAYS' : t.mode === 'R' ? 'ENABLE REPLICA' : t.mode === 'D' ? 'DISABLE' : 'ENABLE';
      await testDb.$executeRawUnsafe(`ALTER TABLE "${table}" ${how} TRIGGER "${t.name}"`);
    }
  }
}
