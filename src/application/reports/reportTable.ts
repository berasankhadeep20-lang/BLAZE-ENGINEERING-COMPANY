/**
 * Every report produces a ReportTable. The screen, the CSV export and the printout are all made from that one table, so they can never disagree.
 * Money cells hold paise and quantity cells hold thousandths (never floats); each output converts them for its own purpose.
 */
import { formatINR, formatQty } from '../../domain/money';
import { toCsv, type Cell } from '../../shared/csv';
import { displayDate } from '../../shared/format';
import type { ReportColumn, ReportInput } from '../print/reportHtml';

export type ColumnKind = 'text' | 'money' | 'qty' | 'int' | 'date';

export interface TableColumn {
  header: string;
  kind: ColumnKind;
}

export interface ReportTable {
  title: string;
  subtitle: string[];
  columns: TableColumn[];
  rows: Cell[][];
  totalsRow: Cell[] | null;
}

/** CSV for a spreadsheet: money as rupees and quantity as units, both as real numbers; dates stay yyyy-mm-dd so they sort. */
export function tableToCsv(t: ReportTable): string {
  const conv = (c: Cell, kind: ColumnKind): Cell => {
    if (typeof c !== 'number') return c;
    if (kind === 'money') return c / 100;
    if (kind === 'qty') return c / 1000;
    return c;
  };
  const row = (r: Cell[]): Cell[] => r.map((c, i) => conv(c, t.columns[i]?.kind ?? 'text'));
  return toCsv(t.columns.map((c) => c.header), [...t.rows.map(row), ...(t.totalsRow ? [row(t.totalsRow)] : [])]);
}

/** The printable version: Indian digit grouping, dd/mm/yyyy dates, numbers right-aligned, totals in bold. */
export function tableToReportInput(t: ReportTable, businessName: string, generatedAt: string): ReportInput {
  const show = (c: Cell, kind: ColumnKind): string => {
    if (c === null || c === undefined || c === '') return '';
    if (typeof c === 'number') return kind === 'money' ? formatINR(c) : kind === 'qty' ? formatQty(c) : String(c);
    return kind === 'date' ? displayDate(c) || c : c; // a date column may also hold words such as "Total" or "never"
  };
  const empty = t.rows.length === 0; // nothing matched: say so instead of printing a row of zeros
  const rows = (empty ? [] : [...t.rows, ...(t.totalsRow ? [t.totalsRow] : [])]).map((r) => r.map((c, i) => show(c, t.columns[i]?.kind ?? 'text')));
  const columns: ReportColumn[] = t.columns.map((c) => ({ header: c.header, align: c.kind === 'money' || c.kind === 'qty' || c.kind === 'int' ? 'right' : 'left' }));
  return {
    businessName, title: t.title, subtitleLines: t.subtitle, columns, rows, emphasisRows: t.totalsRow && !empty ? [rows.length - 1] : [], footerLines: empty ? ['Nothing to show for these filters.'] : [], generatedAt, landscape: t.columns.length > 6,
  };
}
