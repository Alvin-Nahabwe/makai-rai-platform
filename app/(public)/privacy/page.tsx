import { permanentRedirect } from 'next/navigation';
import { legalTextHeading } from '@/components/legal/LegalTextView';
import { pageTitle } from '@/lib/ui/title';

/** The title of the page this address redirects to (`/legal/privacy`). */
export const metadata = { title: pageTitle(legalTextHeading('privacy')) };

/**
 * The privacy notice now lives in the legal text registry (data/legal/privacy) and is shown by S-06 (FR-ACC-02;
 * ACC-a Task 13): this old path answers a permanent redirect, so a bookmark or an old link still reaches the words.
 */
export default function PrivacyPage(): never {
  permanentRedirect('/legal/privacy');
}
