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
  const text =
    map === 'data_card'
      ? readFileSync(join(process.cwd(), 'data', 'fieldmaps', 'data_card.json'), 'utf8')
      : readFileSync(join(process.cwd(), 'data', 'fieldmaps', 'mitigation_plan.json'), 'utf8');
  const raw = JSON.parse(text) as { fields: Array<{ fieldId: string; label: string }> };
  return Object.fromEntries(raw.fields.map((f) => [f.fieldId, f.label]));
}

/** Each id as its label. Throws naming the first id the map lacks. */
export function fieldLabels(ids: string[], labels: Record<string, string>): string[] {
  return ids.map((id) => {
    if (!Object.hasOwn(labels, id)) throw new Error(`field map has no field "${id}"`);
    return labels[id];
  });
}

function Cell({ items }: { items: string[] }) {
  if (items.length === 0) return <td>None</td>;
  return (
    <td>
      <ul className="uncst-table__list">
        {items.map((label) => (
          <li key={label}>{label}</li>
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
    <table className="uncst-table">
      <caption>{CAPTION}</caption>
      <thead>
        <tr>
          <th scope="col">Issue</th>
          <th scope="col">Data card fields</th>
          <th scope="col">Mitigation plan fields</th>
          <th scope="col">Note</th>
        </tr>
      </thead>
      <tbody>
        {table.issues.map((issue) => (
          <tr key={issue.id}>
            <th scope="row">{issue.title}</th>
            <Cell items={fieldLabels(issue.dataCardFields, dataCard)} />
            <Cell items={fieldLabels(issue.mitigationPlanFields, mitigation)} />
            <td>{issue.note ?? 'None'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
