import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readUncstTable, type UncstTable as UncstTableData } from '@/lib/help/uncst';
import './UncstTable.css';

/**
 * The table of which data card and mitigation plan fields answer Uganda's six
 * AI protocol issues (UNCST 16.6, owner answer A2). A server component with no
 * props: S-28 and, through DOC-a, S-18 render it. Every value is a React text
 * child, never markup (NFR-SEC-11).
 */
const CAPTION =
  "Which fields answer Uganda's six AI protocol issues (UNCST guidelines 2025, section 16.6)";

/** The labels of one field map, keyed by field id. The paths are literal so the build traces them. */
function readLabels(map: 'data_card' | 'mitigation_plan'): Record<string, string> {
  const file = `data/fieldmaps/${map}.json`;
  const text =
    map === 'data_card'
      ? readFileSync(join(process.cwd(), 'data', 'fieldmaps', 'data_card.json'), 'utf8')
      : readFileSync(join(process.cwd(), 'data', 'fieldmaps', 'mitigation_plan.json'), 'utf8');
  let raw: { fields?: unknown };
  try {
    raw = JSON.parse(text) as { fields?: unknown };
  } catch (cause) {
    throw new Error(`${file}: not valid JSON`, { cause });
  }
  if (!Array.isArray(raw?.fields)) throw new Error(`${file}: "fields" must be an array`);
  const labels: Record<string, string> = {};
  for (const f of raw.fields as Array<{ fieldId?: unknown; label?: unknown }>) {
    if (typeof f?.fieldId !== 'string' || f.fieldId.trim() === '') {
      throw new Error(`${file}: every field needs a non-empty fieldId`);
    }
    if (Object.hasOwn(labels, f.fieldId)) {
      throw new Error(`${file}: fieldId ${f.fieldId} appears more than once`);
    }
    if (typeof f?.label !== 'string' || f.label.trim() === '') {
      throw new Error(`${file}: field ${String(f?.fieldId)} needs a non-empty label`);
    }
    labels[f.fieldId] = f.label;
  }
  return labels;
}

/** Each id as its label. Throws naming the first id the map lacks. */
export function fieldLabels(ids: string[], labels: Record<string, string>): string[] {
  return ids.map((id) => {
    if (!Object.hasOwn(labels, id)) throw new Error(`field map has no field "${id}"`);
    return labels[id];
  });
}

function Cell({ ids, labels }: { ids: string[]; labels: Record<string, string> }) {
  if (ids.length === 0) return <td role="cell">None</td>;
  return (
    <td role="cell">
      <ul className="uncst-table__list">
        {fieldLabels(ids, labels).map((label, k) => (
          <li key={ids[k]}>{label}</li>
        ))}
      </ul>
    </td>
  );
}

export function UncstTable() {
  const table: UncstTableData = readUncstTable();
  const dataCard = readLabels('data_card');
  const mitigation = readLabels('mitigation_plan');

  return (
    <div className="uncst-table-wrap">
      <table className="uncst-table" role="table">
        <caption>{CAPTION}</caption>
        <thead role="rowgroup">
          <tr role="row">
            <th scope="col" role="columnheader">Issue</th>
            <th scope="col" role="columnheader">Data card fields</th>
            <th scope="col" role="columnheader">Mitigation plan fields</th>
            <th scope="col" role="columnheader">Note</th>
          </tr>
        </thead>
        <tbody role="rowgroup">
          {table.issues.map((issue) => (
            <tr key={issue.id} role="row">
              <th scope="row" role="rowheader">{issue.title}</th>
              <Cell ids={issue.dataCardFields} labels={dataCard} />
              <Cell ids={issue.mitigationPlanFields} labels={mitigation} />
              <td role="cell">{issue.note ?? 'None'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
