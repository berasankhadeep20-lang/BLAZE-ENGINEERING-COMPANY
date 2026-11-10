/** A generic printable table report (statements, stock lists, movement and dues reports). Same rules as the invoice: one self-contained HTML document, nothing external. */
import { escapeHtml } from '../../shared/format';

export interface ReportColumn {
  header: string;
  align?: 'left' | 'right' | 'center';
  width?: string; // e.g. "12%"
}

export interface ReportInput {
  businessName: string;
  title: string;
  subtitleLines?: string[];
  columns: ReportColumn[];
  rows: string[][];
  emphasisRows?: number[]; // indexes into rows to print in bold (opening/closing/total rows)
  footerLines?: string[];
  generatedAt: string; // already formatted for display
  landscape?: boolean;
}

const esc = escapeHtml;

export function renderReportHtml(r: ReportInput): string {
  const bold = new Set(r.emphasisRows ?? []);
  const align = (c: ReportColumn): string => `text-align:${c.align ?? 'left'};`;
  const head = r.columns.map((c) => `<th style="${align(c)}${c.width ? `width:${c.width};` : ''}">${esc(c.header)}</th>`).join('');
  const body = r.rows
    .map((row, i) => `<tr${bold.has(i) ? ' class="em"' : ''}>${row.map((cell, j) => `<td style="${r.columns[j] ? align(r.columns[j] as ReportColumn) : ''}">${esc(cell)}</td>`).join('')}</tr>`)
    .join('');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${esc(r.title)}</title>
<style>
@page { size: A4 ${r.landscape ? 'landscape' : 'portrait'}; margin: 9mm; }
* { box-sizing: border-box; }
body { font-family: Arial, Helvetica, "DejaVu Sans", sans-serif; font-size: 8.5pt; color: #000; margin: 0; }
h1 { font-size: 13pt; margin: 0; } h2 { font-size: 11pt; margin: 1mm 0 2mm; }
.sub { font-size: 8.5pt; margin: 0.6mm 0; }
table { border-collapse: collapse; width: 100%; margin-top: 3mm; }
thead { display: table-header-group; } tr { page-break-inside: avoid; }
th, td { border: 0.6pt solid #000; padding: 1.2mm 1.6mm; vertical-align: top; }
th { background: #eeeeee; font-size: 8pt; }
tr.em td { font-weight: bold; background: #f6f6f6; }
.foot { margin-top: 3mm; font-size: 8pt; } .gen { margin-top: 2mm; font-size: 7.5pt; color: #444; }
</style></head><body>
<h1>${esc(r.businessName)}</h1><h2>${esc(r.title)}</h2>
${(r.subtitleLines ?? []).map((l) => `<div class="sub">${esc(l)}</div>`).join('')}
<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
${(r.footerLines ?? []).map((l) => `<div class="foot">${esc(l)}</div>`).join('')}
<div class="gen">Generated ${esc(r.generatedAt)}</div>
</body></html>`;
}
