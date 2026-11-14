import { Document, Page, renderToBuffer, StyleSheet, Text, View } from '@react-pdf/renderer';
import type { ReactElement } from 'react';
import { NOT_RECORDED, SEALED_NOTE, STATEMENT, utcSecond } from '../resolve';
import { PDF_FONT_FAMILY, UNPRINTABLE_NOTE, printable, registerPdfFont } from './font';
import type { RenderInput, ResolvedField } from './index';

/**
 * The page layout the three documents share (FR-DOC-02, D8): a fixed footer on every page with the document type, the issue
 * time to the second in UTC, the statement and the sealed note; then the fields in map order, each as label, text and
 * provenance. Team text reaches the PDF only through `<Text>` children, never as markup (NFR-SEC-11), and `Document.title`
 * holds the document type alone.
 */

const styles = StyleSheet.create({
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
});

export async function renderFieldDocument(input: RenderInput, title: string): Promise<{ pdf: Buffer; plainText: string }> {
  registerPdfFont();
  const footer = [`${title}, issued ${utcSecond(input.issuedAt)}`, STATEMENT, SEALED_NOTE];

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

  const doc = (
    <Document title={title} language="en">
      <Page size="A4" style={styles.page}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.meta}>{`Organisation: ${organisation}`}</Text>
        <Text style={styles.meta}>{`Project: ${project}`}</Text>
        {replaced ? <Text style={styles.note}>{UNPRINTABLE_NOTE}</Text> : null}
        {body}
        <View style={styles.footer} fixed>
          {footer.map((line) => <Text key={line} style={styles.footerLine}>{line}</Text>)}
        </View>
      </Page>
    </Document>
  );
  const pdf = await renderToBuffer(doc);

  // The plain-text copy keeps every character as typed and holds the footer once, at the end.
  const lines: string[] = [title, `Organisation: ${input.organisationName}`, `Project: ${input.projectName}`];
  input.fields.forEach((f, i) => {
    if (i === 0 || input.fields[i - 1].section !== f.section) lines.push('', f.section);
    lines.push('', `${f.fieldId} ${f.label}`, f.text ?? NOT_RECORDED);
    if (f.provenance !== '') lines.push(f.provenance);
  });
  lines.push('', ...footer);
  return { pdf, plainText: `${lines.join('\n')}\n` };
}
