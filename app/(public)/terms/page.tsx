import { permanentRedirect } from 'next/navigation';

/**
 * The terms now live in the legal text registry (data/legal/terms) and are shown by S-06 (FR-ACC-02; ACC-a
 * Task 13): this old path answers a permanent redirect, so a bookmark or an old link still reaches the words.
 */
export default function TermsPage(): never {
  permanentRedirect('/legal/terms');
}
