import { Document, Page, renderToBuffer, StyleSheet, Text, View } from '@react-pdf/renderer';
import type { ReactElement } from 'react';
import { NOT_RECORDED, STATEMENT, utcSecond } from '../resolve';
import { draftLine, sealedNote } from '../copy';
import { PDF_FONT_FAMILY, UNPRINTABLE_NOTE, printable, registerPdfFont } from './font';
import type { RenderInput, ResolvedField } from './index';

/**
 * The page layout the three documents share (FR-DOC-02, D8): a fixed footer on every page with the document type, the issue
 * time to the second in UTC, the statement and the sealed note; then the fields in map order, each as label, text and
 * provenance. Team text reaches the PDF only through `<Text>` children, never as markup (NFR-SEC-11), and `Document.title`
 * holds the document type alone.
 */

export const styles = StyleSheet.create({
  page: { fontFamily: PDF_FONT_FAMILY, fontSize: 10, lineHeight: 1.35, paddingTop: 40, paddingHorizontal: 44, paddingBottom: 96, color: '#111111' },
  // react-pdf turns the page's unitless 1.35 into 13.5 pt (times the page's own 10 pt) and the title inherits that
  // fixed height, shorter than its 20 pt text, so "Organisation:" printed through it. Its own ratio gives 27 pt.
  title: { fontSize: 20, lineHeight: 1.35, marginBottom: 4 },
  meta: { fontSize: 10, marginBottom: 2 },
  note: { fontSize: 9, marginTop: 6, marginBottom: 2 },
  section: { fontSize: 14, marginTop: 16, marginBottom: 6 },
  field: { marginBottom: 9 },
  label: { fontSize: 10.5, marginBottom: 2 },
  text: { fontSize: 10 },
  provenance: { fontSize: 8.5, color: '#333333', marginTop: 2 },
  footer: { position: 'absolute', left: 44, right: 44, bottom: 28, borderTopWidth: 0.5, borderTopColor: '#555555', paddingTop: 6 },
  footerLine: { fontSize: 8, lineHeight: 1.3 },
  // A draft's line is boxed and repeats at the top of every page, so one page printed or photographed alone still reads as a draft (anti-goal 1).
  draftHeader: { position: 'absolute', left: 44, right: 44, top: 16, borderWidth: 0.75, borderColor: '#333333', paddingVertical: 3, paddingHorizontal: 6 },
  draftHeaderLine: { fontSize: 9, lineHeight: 1.3 },
});

/** What stands in the footer of a document: issued with the time of issue and the seals it drew on, or a draft with when its answers were read. */
export type Stamp = RenderInput['stamp'];

/** The footer lines, top to bottom, with no sealed note in a draft and no fingerprint anywhere in one. */
export function footerLinesOf(stamp: Stamp, title: string): string[] {
  switch (stamp.kind) {
    // The sealed note names as many seals as the document drew on (lane 6 row D18): `stamp.seals` are the seals its fields used.
    case 'issued': return [`${title}, issued ${utcSecond(stamp.issuedAt)}`, STATEMENT, sealedNote(stamp.seals.length)];
    case 'draft': return [`${title} \u00b7 ${draftLine(stamp.takenAt)}`, STATEMENT];
  }
}

/** The line a draft prints at the top of every page; null for an issued document, which has no header. */
export const headerLineOf = (stamp: Stamp): string | null => (stamp.kind === 'draft' ? draftLine(stamp.takenAt) : null);

/**
 * The page every document of the platform shares, around `content`: the fixed footer on each page, and for a draft the fixed header. The
 * footer lines come from `footerLinesOf` and are returned beside the element so the plain-text copy holds the same words.
 */
export function framedPage(stamp: Stamp, title: string, content: ReactElement[]): { page: ReactElement; footer: string[]; header: string | null } {
  const footer = footerLinesOf(stamp, title).map((l) => printable(l).text);
  const header = headerLineOf(stamp);
  const shownHeader = header === null ? null : printable(header).text;
  const page = (
    <Page size="A4" style={styles.page}>
      {shownHeader === null ? null : (
        <View style={styles.draftHeader} fixed><Text style={styles.draftHeaderLine}>{shownHeader}</Text></View>
      )}
      {content}
      <View style={styles.footer} fixed>
        {footer.map((line) => <Text key={line} style={styles.footerLine}>{line}</Text>)}
      </View>
    </Page>
  );
  return { page, footer, header };
}

/** One field document as a page and its plain-text copy; the Document around it is made by the caller (`renderFieldDocument`, or the working report's). */
export function fieldDocumentPage(input: RenderInput, title: string): { page: ReactElement; plainText: string } {
  let replaced = false;
  const print = (text: string): string => {
    const p = printable(text);
    replaced ||= p.replaced;
    return p.text;
  };
  const shown = input.fields.map((f): ResolvedField => ({
    ...f, label: print(f.label), text: f.text === null ? null : print(f.text), provenance: print(f.provenance),
  }));
  const organisation = print(input.organisationName);
  const project = print(input.projectName);

  const body: ReactElement[] = [];
  shown.forEach((f, i) => {
    if (i === 0 || shown[i - 1].section !== f.section) body.push(<Text key={`s-${f.fieldId}`} style={styles.section}>{f.section}</Text>);
    body.push(
      <View key={f.fieldId} style={styles.field}>
        <Text style={styles.label}>{`${f.fieldId} ${f.label}`}</Text>
        <Text style={styles.text}>{f.text ?? NOT_RECORDED}</Text>
        {f.provenance === '' ? null : <Text style={styles.provenance}>{f.provenance}</Text>}
      </View>,
    );
  });

  const { page, footer, header } = framedPage(input.stamp, title, [
    <Text key="title" style={styles.title}>{title}</Text>,
    <Text key="org" style={styles.meta}>{`Organisation: ${organisation}`}</Text>,
    <Text key="project" style={styles.meta}>{`Project: ${project}`}</Text>,
    ...(replaced ? [<Text key="note" style={styles.note}>{UNPRINTABLE_NOTE}</Text>] : []),
    ...body,
  ]);

  // The plain-text copy keeps every character as typed and holds the footer once, at the end; a draft's line also opens it.
  const lines: string[] = [...(header === null ? [] : [header]), title, `Organisation: ${input.organisationName}`, `Project: ${input.projectName}`];
  input.fields.forEach((f, i) => {
    if (i === 0 || input.fields[i - 1].section !== f.section) lines.push('', f.section);
    lines.push('', `${f.fieldId} ${f.label}`, f.text ?? NOT_RECORDED);
    if (f.provenance !== '') lines.push(f.provenance);
  });
  lines.push('', ...footerLinesOf(input.stamp, title));
  return { page, plainText: `${lines.join('\n')}\n` };
}

export async function renderFieldDocument(input: RenderInput, title: string): Promise<{ pdf: Buffer; plainText: string }> {
  registerPdfFont();
  const { page, plainText } = fieldDocumentPage(input, title);
  const pdf = await renderToBuffer(<Document title={title} language="en">{page}</Document>);
  return { pdf, plainText };
}
