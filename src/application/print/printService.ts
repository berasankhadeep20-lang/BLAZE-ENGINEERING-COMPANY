import { formatINR, formatQty } from '../../domain/money';
import { displayDate, displayDateTime, safeFileName } from '../../shared/format';
import { systemClock, toLocalDateTime, type Clock } from '../../shared/clock';
import type { Db } from '../../infrastructure/db/connection';
import { recordAudit } from '../../infrastructure/db/audit';
import { UnitOfWork } from '../../infrastructure/db/unitOfWork';
import type { AuthService } from '../auth/authService';
import type { ItemFilters, ItemService } from '../inventory/itemService';
import type { MovementFilters, StockService } from '../inventory/stockService';
import type { CustomerService } from '../parties/customerService';
import type { SaleService } from '../sales/saleService';
import { readLogo, readSettings, type AppSettings } from '../settings/settingsService';
import { renderInvoiceHtml, type InvoiceBusiness } from './invoiceHtml';
import { renderReportHtml, type ReportColumn } from './reportHtml';

/** What the preview window, the printer and the PDF exporter all receive: the same HTML, a suggested file name, and anything the user should know first. */
export interface PrintResult {
  html: string;
  title: string;
  fileName: string; // suggested name for a PDF, without folders
  warnings: string[];
  copies: string[]; // the copy labels that were rendered (empty = a single unlabelled copy)
}

export interface PrintServices {
  sales: SaleService;
  customers: CustomerService;
  items: ItemService;
  stock: StockService;
}

const BUSINESS_FALLBACK = '(business name not set in Settings)';
const dt = (iso: string): string => displayDateTime(toLocalDateTime(iso));

function businessOf(s: AppSettings, logo: string | null): InvoiceBusiness {
  return {
    name: s.businessName ?? BUSINESS_FALLBACK, address: s.businessAddress, phone: s.businessPhone, email: s.businessEmail, gstin: s.businessGstin,
    title: s.invoiceTitle, terms: s.invoiceTerms, declaration: s.invoiceDeclaration, bankName: s.bankName, bankBranch: s.bankBranch,
    bankAccountNo: s.bankAccountNo, bankIfsc: s.bankIfsc, logoDataUri: logo,
  };
}

function setupWarnings(s: AppSettings): string[] {
  const w: string[] = [];
  if (!s.businessName) w.push('Your business name is not set in Settings.');
  if (!s.businessAddress) w.push('Your business address is not set in Settings.');
  if (!s.businessGstin) w.push('Your business GSTIN is not set in Settings.');
  if (!s.bankAccountNo || !s.bankIfsc) w.push('Your bank details are not (fully) set in Settings.');
  return w;
}

export class PrintService {
  private readonly uow: UnitOfWork;

  constructor(
    private readonly db: Db,
    private readonly auth: AuthService,
    private readonly svc: PrintServices,
    private readonly clock: Clock = systemClock,
  ) {
    this.uow = new UnitOfWork(db, clock);
  }

  /**
   * The A4 invoice for a bill. Confirmed bills print one page set per configured copy label (default Original / Duplicate / Triplicate; change in Settings).
   * A draft prints once, with a "DRAFT - NOT A TAX INVOICE" watermark; a cancelled bill is watermarked "CANCELLED". Showing it is the preview; printing and PDF
   * export use exactly the same HTML. `copy` picks one label (by position) instead of all of them.
   */
  invoice(token: string, billId: number, opts: { copy?: number } = {}): PrintResult {
    const bill = this.svc.sales.get(token, billId); // checks the permission to see bills
    const settings = readSettings(this.db);
    let labels = settings.invoiceCopies;
    if (opts.copy !== undefined && labels.length) labels = labels[opts.copy] ? [labels[opts.copy] as string] : labels.slice(0, 1);
    if (bill.status === 'DRAFT') labels = []; // a draft is not an original, duplicate or triplicate of anything
    const html = renderInvoiceHtml({ bill, business: businessOf(settings, readLogo(this.db)), copyLabels: labels });

    const warnings = setupWarnings(settings);
    if (bill.status === 'DRAFT') warnings.unshift('This is a draft: it is not a tax invoice and has no invoice number yet.');
    if (bill.status === 'CANCELLED') warnings.unshift('This bill is cancelled; the printout is watermarked CANCELLED.');
    const name = bill.billNo ?? `DRAFT-${String(bill.id)}`;
    return { html, title: `${settings.invoiceTitle} ${name}`, fileName: `${safeFileName(`Invoice-${name}`)}.pdf`, warnings, copies: labels };
  }

  /** Call after the invoice was really printed or saved as a PDF, so reprints are on the audit trail. */
  recordPrint(token: string, billId: number, kind: 'PRINT' | 'PDF', copies?: string[]): void {
    const bill = this.svc.sales.get(token, billId);
    const user = this.auth.requireSignedIn(token);
    this.uow.run(this.auth.actorFor(user), (ctx) => {
      recordAudit(ctx, { action: 'INVOICE_PRINT', entityType: 'sale_bill', entityId: billId, detail: { billNo: bill.billNo, status: bill.status, kind, copies: copies ?? [] } });
    });
  }

  /** A customer's account statement for a range of local dates. */
  customerStatement(token: string, customerId: number, fromDate?: string, toDate?: string): PrintResult {
    const s = this.svc.customers.statement(token, customerId, fromDate, toDate);
    const c = s.customer;
    const rows: string[][] = [['', 'Opening balance', '', '', '', '', formatINR(s.openingPaise)]];
    for (const e of s.entries) rows.push([dt(e.at), e.label, e.refNo ?? '', e.note ?? '', e.amountPaise > 0 ? formatINR(e.amountPaise) : '', e.amountPaise < 0 ? formatINR(-e.amountPaise) : '', formatINR(e.balanceAfterPaise)]);
    rows.push(['', 'Closing balance', '', '', formatINR(s.increasesPaise), formatINR(s.reducesPaise), formatINR(s.closingPaise)]);
    const settings = readSettings(this.db);
    const period = fromDate || toDate ? `${fromDate ? displayDate(fromDate) : 'the beginning'} to ${toDate ? displayDate(toDate) : 'today'}` : 'All dates';
    const columns: ReportColumn[] = [
      { header: 'Date and time', width: '16%' }, { header: 'Entry', width: '14%' }, { header: 'Reference', width: '13%' }, { header: 'Note', width: '23%' },
      { header: 'Debit (Rs.)', align: 'right', width: '11%' }, { header: 'Credit (Rs.)', align: 'right', width: '11%' }, { header: 'Balance (Rs.)', align: 'right', width: '12%' },
    ];
    return this.report(settings, `Statement of Account - ${c.name}`, [`Customer: ${c.name}`, ...(c.address ? [c.address] : []), `GSTIN: ${c.gstinDisplay}`, `Period: ${period}`], columns, rows, [0, rows.length - 1], [`Balance due: Rs. ${formatINR(s.closingPaise)}`], `Statement-${c.name}`, false);
  }

  /** Customers with a balance due, as at today or the end of a past day. */
  customerDues(token: string, filters: Parameters<CustomerService['dues']>[1] = {}): PrintResult {
    const d = this.svc.customers.dues(token, { ...filters, limit: Number.MAX_SAFE_INTEGER, offset: 0 });
    const settings = readSettings(this.db);
    const rows = d.rows.map((r) => [r.name, r.phone ?? '', formatINR(r.balancePaise), r.lastSaleAt ? dt(r.lastSaleAt) : '', r.lastPaymentAt ? dt(r.lastPaymentAt) : '']);
    return this.report(
      settings, 'Customers with balance due', [filters.asOfDate ? `As at the end of ${displayDate(filters.asOfDate)}` : 'As at today'],
      [{ header: 'Customer', width: '34%' }, { header: 'Phone', width: '16%' }, { header: 'Balance due (Rs.)', align: 'right', width: '18%' }, { header: 'Last sale', width: '16%' }, { header: 'Last payment', width: '16%' }],
      rows, [], [`Total outstanding: Rs. ${formatINR(d.totalOutstandingPaise)} across ${String(d.customerCount)} customer(s)`], 'Customer-dues', false,
    );
  }

  /** The stock list (same filters as the inventory screen). */
  stockList(token: string, filters: ItemFilters = {}): PrintResult {
    const { rows: items } = this.svc.items.list(token, { ...filters, limit: Number.MAX_SAFE_INTEGER, offset: 0 });
    const settings = readSettings(this.db);
    const rows = items.map((i) => [i.code, i.name, i.category ?? '', i.hsn ?? '', i.uomLabel, formatQty(i.qtyMilli), formatQty(i.reorderQtyMilli), formatINR(i.saleRatePaise), i.isActive ? i.stockStatus : 'INACTIVE']);
    return this.report(
      settings, 'Stock list', [`${String(items.length)} item(s)`],
      [{ header: 'Code', width: '9%' }, { header: 'Item', width: '27%' }, { header: 'Category', width: '12%' }, { header: 'HSN', width: '7%' }, { header: 'Unit', width: '10%' },
        { header: 'Qty', align: 'right', width: '7%' }, { header: 'Reorder', align: 'right', width: '7%' }, { header: 'Sale rate (Rs.)', align: 'right', width: '12%' }, { header: 'Status', width: '9%' }],
      rows, [], [], 'Stock-list', true,
    );
  }

  /** The stock movement history (same filters as the inventory movement screen). */
  stockMovements(token: string, filters: MovementFilters = {}): PrintResult {
    const { rows: moves } = this.svc.stock.movements(token, { ...filters, limit: Number.MAX_SAFE_INTEGER, offset: 0 });
    const settings = readSettings(this.db);
    const period = filters.fromDate || filters.toDate ? `${filters.fromDate ? displayDate(filters.fromDate) : 'the beginning'} to ${filters.toDate ? displayDate(filters.toDate) : 'today'}` : 'All dates';
    const rows = moves.map((m) => [dt(m.at), m.itemCode, m.itemName, formatQty(m.qtyDeltaMilli), m.reason, m.refNo ?? '', m.note ?? '', formatQty(m.qtyAfterMilli), m.userName]);
    return this.report(
      settings, 'Stock movements', [`Period: ${period}`, `${String(moves.length)} movement(s)`],
      [{ header: 'Date and time', width: '13%' }, { header: 'Code', width: '8%' }, { header: 'Item', width: '18%' }, { header: 'Change', align: 'right', width: '7%' }, { header: 'Reason', width: '10%' },
        { header: 'Reference', width: '10%' }, { header: 'Note', width: '16%' }, { header: 'Balance', align: 'right', width: '8%' }, { header: 'User', width: '10%' }],
      rows, [], [], 'Stock-movements', true,
    );
  }

  private report(s: AppSettings, title: string, subtitle: string[], columns: ReportColumn[], rows: string[][], emphasis: number[], footer: string[], fileBase: string, landscape: boolean): PrintResult {
    const generatedAt = dt(this.clock.now().toISOString());
    const html = renderReportHtml({ businessName: s.businessName ?? BUSINESS_FALLBACK, title, subtitleLines: subtitle, columns, rows, emphasisRows: emphasis, footerLines: footer, generatedAt, landscape });
    return { html, title, fileName: `${safeFileName(fileBase)}.pdf`, warnings: s.businessName ? [] : ['Your business name is not set in Settings.'], copies: [] };
  }
}
