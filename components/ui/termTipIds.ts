import type { DefinedEntry } from '@/lib/vocabulary/types';

/**
 * The ids a TermTip (components/ui/TermTip.tsx) gives its popover and its definition. A caller that describes another
 * element by the definition (`aria-describedby`) takes the id from here, so the two cannot drift. It lives in its own
 * module, not in TermTip.tsx, because that file is a client module: a server component cannot call a function exported
 * from one (Next.js: "Attempted to call termTipIds() from the server but termTipIds is on the client").
 */
export function termTipIds(of: Pick<DefinedEntry, 'id'>, id?: string): { tip: string; definition: string } {
  const tip = id ?? `term-tip-${of.id}`;
  return { tip, definition: `${tip}-def` };
}
