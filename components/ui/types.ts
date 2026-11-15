/** Shared types of the components/ui kit (plan 1A, "Components"). */

export type StatusMarkKind = 'done' | 'partly' | 'not_yet' | 'not_applicable' | 'does_not_apply' | 'scope_answered' | 'no_decision';

/** The 28 icons of plan B7. Later stages add icons to the same registry (components/ui/icons.tsx), from the same set. */
export type IconName = 'home' | 'folder' | 'flag' | 'book-open' | 'circle-help' | 'users' | 'building-2' | 'user' | 'log-out'
  | 'sun' | 'moon' | 'menu' | 'x' | 'chevron-left' | 'chevron-right' | 'chevron-down' | 'chevrons-up-down' | 'arrow-up'
  | 'paperclip' | 'download' | 'plus' | 'info' | 'triangle-alert' | 'wifi-off' | 'archive' | 'clock' | 'external-link' | 'circle-check'
  | 'pencil';

export type { ScopeAnswer } from '@/types/record';

/** The last item is the current page. */
export type BreadcrumbItem = { label: string; href?: string };
export type FieldOption = { value: string; label: string; hint?: string };
export type DateParts = { day: string; month: string; year: string };

/** A table column's sort direction: aria-sort's two values. */
export type SortDirection = 'ascending' | 'descending';
/**
 * The two phrases a sortable column is announced with, keyed by aria-sort's two values: the owner's decision of 13
 * November 2026, "Words that fit the column". The common pairs are `SORT_WORDS` in lib/ui/copy.ts.
 */
export type SortWords = { readonly ascending: string; readonly descending: string };
