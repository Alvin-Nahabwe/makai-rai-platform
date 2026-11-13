/** Shared types of the components/ui kit (plan 1A, "Components"). */

export type StatusMarkKind = 'done' | 'partly' | 'not_yet' | 'not_applicable' | 'does_not_apply' | 'scope_answered' | 'no_decision';

/** The 28 icons of plan B7. Later stages add icons to the same registry (components/ui/icons.tsx), from the same set. */
export type IconName = 'home' | 'folder' | 'flag' | 'book-open' | 'circle-help' | 'users' | 'building-2' | 'user' | 'log-out'
  | 'sun' | 'moon' | 'menu' | 'x' | 'chevron-left' | 'chevron-right' | 'chevron-down' | 'chevrons-up-down' | 'arrow-up'
  | 'paperclip' | 'download' | 'plus' | 'info' | 'triangle-alert' | 'wifi-off' | 'archive' | 'clock' | 'external-link' | 'circle-check';

export type { ScopeAnswer } from '@/types/record';

/** The last item is the current page. */
export type BreadcrumbItem = { label: string; href?: string };
export type FieldOption = { value: string; label: string; hint?: string };
export type DateParts = { day: string; month: string; year: string };
