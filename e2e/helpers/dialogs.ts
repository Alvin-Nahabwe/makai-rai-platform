import { expect, type Page } from '@playwright/test';

/**
 * NFR-SEC-11 (harness): any dialog the page opens (alert, confirm, prompt, beforeunload) fails the
 * test. The hostile-text check types `<script>alert(1)</script>` and its kin into every field and
 * loads every page that shows them back; none may execute, so a dialog is the failure.
 *
 * A listener is required to settle a dialog (Playwright leaves it open, and the page blocked, when
 * one listens and does nothing), so the listener dismisses it and then records the failure with a
 * soft assertion: the test fails at its end and runs on until then, so one run shows every dialog.
 * The failure names the kind and the message of the dialog. Call it once per page, before the
 * first navigation.
 */
export function failOnDialog(page: Page): void {
  page.on('dialog', async (dialog) => {
    const what = `${dialog.type()} dialog opened on ${page.url()}: ${JSON.stringify(dialog.message())}`;
    await dialog.dismiss();
    expect.soft(false, what).toBe(true);
  });
}
