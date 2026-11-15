'use client';

import { createContext, useContext, type ReactNode } from 'react';

/** Where in the shell a piece of the project slot is being rendered: the rail, or the narrow top bar. */
export type ShellPlaceName = 'rail' | 'bar';

const ShellPlaceContext = createContext<ShellPlaceName | null>(null);

/** Marks its children as rendered in one place of the shell (TopBar and Rail wrap the project slot in it). */
export function ShellPlace({ name, children }: { name: ShellPlaceName; children: ReactNode }) {
  return <ShellPlaceContext value={name}>{children}</ShellPlaceContext>;
}

/**
 * The project slot's one client part (owner ruling R4). The signed-in layout renders the slot's element twice, once in the
 * rail and once in the top bar, and each copy shows the piece made for its place: the rail block in the rail, the bar
 * context in the bar. Both pieces are server-rendered elements; this component only chooses between them, so the project
 * reaches the browser as the markup of those two pieces and nothing else (S5). Outside both places it renders nothing, on
 * purpose: the slot's element has no third place in the shell (__tests__/unit/ui/shell-route.test.tsx pins both places).
 */
export function ShellProjectPlace({ rail, bar }: { rail: ReactNode; bar: ReactNode }) {
  const place = useContext(ShellPlaceContext);
  if (place === 'rail') return rail;
  if (place === 'bar') return bar;
  return null;
}
