import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The Help and contact address, from `data/help-contact.json`: `{ "email": string | null }`.
 * It is null until the owner names the monitored address (13.8 step 4d), and only an
 * explicit null shows the pending sentence. A missing key, an extra key, a value that is
 * not an address, or a file that is not JSON throws: that stops the build of About, which is
 * prerendered, and is the error page on Help, which is rendered per request. A wrong or absent
 * address must not pass for the placeholder. The literal `data` prefix keeps the build's file
 * tracing static.
 */
const HELP_FILE = 'data/help-contact.json';
const EMAIL_SHAPE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

export function readHelpEmail(): string | null {
  const text = readFileSync(join(process.cwd(), 'data', 'help-contact.json'), 'utf8');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new Error(`${HELP_FILE}: not valid JSON`, { cause });
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${HELP_FILE}: expected an object with one key, "email"`);
  }
  if (Object.keys(raw).join() !== 'email') {
    throw new Error(`${HELP_FILE}: the only key allowed is "email"`);
  }
  const email: unknown = (raw as { email: unknown }).email;
  if (email === null) return null;
  if (typeof email !== 'string' || !EMAIL_SHAPE.test(email) || /^mailto:/i.test(email)) {
    throw new Error(`${HELP_FILE}: "email" must be an address such as name@host.tld, or null`);
  }
  return email;
}
