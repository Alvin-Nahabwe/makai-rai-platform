import { StyleSheet, Text, View } from '@react-pdf/renderer';
import type { ReactElement } from 'react';
import type { Stage } from '@/types/record';
import { CONTROLS_AFTER_APPROVAL, STAGE_TERMS, WORKING_REPORT_PAGE as W, WORKING_REPORT_TITLE } from '../copy';
import type { OpenItem, WorkingReportSummary } from '../workingReport';
import { UNPRINTABLE_NOTE, printable } from './font';
import { footerLinesOf, framedPage, styles } from './frame';

/**
 * Page 1 of the working report, "Where this project stands" (path to outputs, Task 8; design G1). It is the same page the three documents
 * share (fixed header and footer, title, organisation and project, then sections), laid out as they are: the section is the 14 pt heading,
 * a risk area the 11.5 pt line under it, an item a label with its facts under it in the body size, and the item's place in the 8.5 pt gray
 * line the other documents give provenance. No new type size, colour or rule. Team text reaches the PDF only through `<Text>` children.
 *
 * The page is built as blocks and drawn twice from them, as elements and as plain text, so the two hold the same words.
 */

const local = StyleSheet.create({
  group: { fontSize: 11.5, lineHeight: 1.35, marginTop: 8, marginBottom: 4 },
  item: { marginBottom: 7 },
  fact: { fontSize: 10, marginTop: 1 },
  entry: { fontSize: 10, marginBottom: 3 },
});

type Block =
  | { kind: 'section' | 'group' | 'note' | 'line'; text: string }
  | { kind: 'item'; label: string; facts: string[]; place: string }
  | { kind: 'entry'; text: string };

const stageName = (st: Stage): string => STAGE_TERMS[st].term;
const place = (st: Stage, questionId: string | null): string => (questionId === null ? stageName(st) : `${stageName(st)} · question ${questionId}`);

function factsOf(i: OpenItem, controlsShown: boolean): string[] {
  const facts: string[] = [];
  // A shortfall's title already holds the question's words; the question is a line of its own only when the title says something else.
  if (i.questionText !== null && !i.title.includes(i.questionText)) facts.push(`${W.question}: ${i.questionText}`);
  if (i.answer !== null) facts.push(`${W.answer}: ${i.answer}`);
  if (i.alsoAreas.length > 0) facts.push(`${W.alsoTouches}: ${i.alsoAreas.join(', ')}`);
  if (controlsShown && i.controls.length > 0) {
    facts.push(`${W.controls}: ${i.controls.map((c) => `${c.name} (${c.id})${c.notebookHref === null ? '' : `, ${W.hasNotebook}`}`).join('; ')}`);
  }
  return facts;
}

function blocksOf(s: WorkingReportSummary): Block[] {
  const blocks: Block[] = [];
  if (s.omittedAnswers > 0) blocks.push({ kind: 'note', text: W.omitted(s.omittedAnswers) });

  blocks.push({ kind: 'section', text: W.nextSteps });
  if (s.nextSteps.length === 0) blocks.push({ kind: 'line', text: W.nothingOpen });
  else if (!s.controlsShown) blocks.push({ kind: 'line', text: CONTROLS_AFTER_APPROVAL });
  for (const g of s.nextSteps) {
    blocks.push({ kind: 'group', text: g.areaName });
    for (const i of g.items) blocks.push({ kind: 'item', label: i.title, facts: factsOf(i, s.controlsShown), place: place(i.stage, i.questionId) });
  }

  if (s.riskAccepted.length > 0) {
    blocks.push({ kind: 'section', text: W.riskAccepted });
    for (const a of s.riskAccepted) {
      blocks.push({ kind: 'item', label: a.title, facts: [`${W.reason}: ${a.reason}`], place: a.areaName ?? '' });
    }
  }

  blocks.push({ kind: 'section', text: W.inPlace });
  if (s.inPlace.length === 0) blocks.push({ kind: 'line', text: W.nothingInPlace });
  let last: Stage | null = null;
  for (const q of s.inPlace) {
    if (q.stage !== last) { blocks.push({ kind: 'group', text: stageName(q.stage) }); last = q.stage; }
    blocks.push({ kind: 'entry', text: `${q.questionId} ${q.questionText}` });
  }

  blocks.push({ kind: 'section', text: W.doesNotApply });
  if (s.doesNotApply.length === 0) blocks.push({ kind: 'line', text: W.nothingNotApplicable });
  last = null;
  for (const q of s.doesNotApply) {
    if (q.stage !== last) { blocks.push({ kind: 'group', text: stageName(q.stage) }); last = q.stage; }
    blocks.push({ kind: 'item', label: `${q.questionId} ${q.questionText}`, facts: [q.why], place: '' });
  }
  return blocks;
}

/** Page 1 as a page and its plain-text copy. Always a draft: its footer and header read the time its answers were read. */
export function summaryPage(s: WorkingReportSummary, meta: { organisationName: string; projectName: string }): { page: ReactElement; plainText: string } {
  let replaced = false;
  const print = (text: string): string => {
    const p = printable(text);
    replaced ||= p.replaced;
    return p.text;
  };
  const blocks = blocksOf(s);
  const stamp = { kind: 'draft', takenAt: s.takenAt } as const;

  const body = blocks.map((b, n): ReactElement => {
    switch (b.kind) {
      case 'section': return <Text key={n} style={styles.section}>{print(b.text)}</Text>;
      case 'group': return <Text key={n} style={local.group}>{print(b.text)}</Text>;
      case 'note': return <Text key={n} style={styles.note}>{print(b.text)}</Text>;
      case 'line': return <Text key={n} style={styles.text}>{print(b.text)}</Text>;
      case 'entry': return <Text key={n} style={local.entry}>{print(b.text)}</Text>;
      case 'item': return (
        <View key={n} style={local.item} wrap={false}>
          <Text style={styles.label}>{print(b.label)}</Text>
          {b.facts.map((f, k) => <Text key={k} style={local.fact}>{print(f)}</Text>)}
          {b.place === '' ? null : <Text style={styles.provenance}>{print(b.place)}</Text>}
        </View>
      );
    }
  });
  const organisation = print(meta.organisationName);
  const project = print(meta.projectName);
  const { page, header } = framedPage(stamp, WORKING_REPORT_TITLE, [
    <Text key="title" style={styles.title}>{W.title}</Text>,
    <Text key="org" style={styles.meta}>{`Organisation: ${organisation}`}</Text>,
    <Text key="project" style={styles.meta}>{`Project: ${project}`}</Text>,
    ...(replaced ? [<Text key="unprintable" style={styles.note}>{UNPRINTABLE_NOTE}</Text>] : []),
    ...body,
  ]);

  const lines: string[] = [header ?? '', W.title, `Organisation: ${meta.organisationName}`, `Project: ${meta.projectName}`];
  for (const b of blocks) {
    switch (b.kind) {
      case 'section': case 'group': lines.push('', b.text); break;
      case 'note': case 'line': case 'entry': lines.push(b.text); break;
      case 'item': lines.push('', b.label, ...b.facts, ...(b.place === '' ? [] : [b.place])); break;
    }
  }
  lines.push('', ...footerLinesOf(stamp, WORKING_REPORT_TITLE));
  return { page, plainText: `${lines.join('\n')}\n` };
}
