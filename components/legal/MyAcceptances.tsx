import type { ReactElement } from 'react';

export type MyAcceptancesProps = { userId: string };

/**
 * The legal texts the account has accepted, on the account page. An async server component that ACC-a fills by calling its own services, so ACC-b imports nothing from ACC-a. A slot of its screen (contract "Screens and slots"): the screen's owner renders it, ACC-a fills it.
 */
// SLOT_STUB: ACC-a
export async function MyAcceptances(_props: MyAcceptancesProps): Promise<ReactElement | null> {
  return null;
}
