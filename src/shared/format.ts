/** Escape text for safe use inside HTML (names, addresses and notes are typed by users). */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** yyyy-mm-dd -> dd/mm/yyyy (as printed on the sample bill). Anything else becomes an empty string. */
export function displayDate(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '');
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

/** 1800 -> "18.00" (a GST rate in basis points shown as a percentage). */
export function bpToPercent(bp: number): string {
  return (bp / 100).toFixed(2);
}

/** A string that is safe to use as a file name on Windows and elsewhere. */
export function safeFileName(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '') || 'file';
}

/** "2026-11-07 10:00" (local) -> "07/11/2026 10:00", matching the dd/mm/yyyy dates printed on invoices. */
export function displayDateTime(local: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}:\d{2})$/.exec(local);
  return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}` : local;
}
