export type Cell = string | number | null | undefined;

/**
 * CSV for Excel: UTF-8 with BOM, CRLF line ends, quoted where needed.
 * Text that starts with = + - @ (or a tab/CR) is prefixed with an apostrophe so a spreadsheet can never run it as a formula
 * (item and customer names are typed by users). Real numbers are written as-is.
 */
export function toCsv(headers: readonly string[], rows: readonly (readonly Cell[])[]): string {
  const cell = (c: Cell): string => {
    if (c === null || c === undefined) return '';
    let s = typeof c === 'number' ? String(c) : c;
    if (typeof c === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.map(cell).join(','), ...rows.map((r) => r.map(cell).join(','))];
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
