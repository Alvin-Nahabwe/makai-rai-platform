import { permanentRedirect } from 'next/navigation';

/**
 * The privacy notice now lives in the legal text registry (data/legal/privacy) and is shown by S-06 (FR-ACC-02;
 * ACC-a Task 13): this old path answers a permanent redirect, so a bookmark or an old link still reaches the words.
 */
export default function PrivacyPage(): never {
  permanentRedirect('/legal/privacy');
}
