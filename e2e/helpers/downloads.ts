import { expect, type Page } from '@playwright/test';

/**
 * UX-39 (SRS 7.6.4 rule 8): every download link shows the file's kind and size in
 * its text, so the person knows what they are about to fetch before they start.
 *
 * Which links are downloads: any `a[download]`, and any link to a template
 * (`/templates/`), a `.pdf` or `.zip` file, a `/pdf` or `/export` address, or an
 * evidence file (`/evidence/`).
 *
 * What the text must hold: a size ("84 KB", "2.4 MB", SRS 7.5.8) and a kind.
 * The kind is a short upper-case name ("PDF", "ZIP", "JSON"), "<word> document"
 * ("Word document"), "web page", ".ipynb" or ".txt" (W-3 and W-3b print them).
 * The usual form is "label (kind, size)", the text K0b's DownloadLink renders;
 * a file whose name already carries its kind may print only the size, as W-3b
 * does for "Download requirements.txt (1 KB)".
 */
const SIZE = String.raw`\d+(?:\.\d)? (?:KB|MB)`;
const KIND = String.raw`(?:[A-Z]{2,5}|[A-Za-z]+ document|web page|\.ipynb|\.txt)`;
export const KIND_AND_SIZE = new RegExp(String.raw`\(${KIND}, ${SIZE}\)`);
export const NAMED_FILE_AND_SIZE = new RegExp(String.raw`\.(?:ipynb|txt) \(${SIZE}\)`);

const DOWNLOAD_LINKS = [
  'a[download]',
  'a[href*="/templates/"]',
  'a[href$=".pdf"]',
  'a[href$=".zip"]',
  'a[href*="/pdf"]',
  'a[href*="/export"]',
  'a[href*="/evidence/"]',
].join(', ');

export function showsKindAndSize(text: string): boolean {
  return KIND_AND_SIZE.test(text) || NAMED_FILE_AND_SIZE.test(text);
}

export async function expectDownloadLinksShowKindAndSize(page: Page): Promise<void> {
  const links = await page.$$eval(DOWNLOAD_LINKS, (anchors) =>
    anchors.map((a) => ({ href: a.getAttribute('href') ?? '', text: (a.textContent ?? '').replace(/\s+/g, ' ').trim() })),
  );
  const missing = links.filter((l) => !showsKindAndSize(l.text));
  expect(
    missing,
    `${page.url()}: ${missing.length} download link(s) without a kind and a size in their text: ${missing.map((l) => `"${l.text}" -> ${l.href}`).join('; ')}`,
  ).toEqual([]);
}
