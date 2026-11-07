import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inTransaction, openDatabase, type Db } from '../../src/infrastructure/db/connection';
import { loadMigrations, migrate } from '../../src/infrastructure/db/migrate';

const REAL_DIR = join(__dirname, '../../src/infrastructure/db/migrations');
let db: Db;

beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db, loadMigrations(REAL_DIR));
  db.exec(`
    INSERT INTO user (id, username, display_name, password_hash, role, created_at) VALUES (1,'owner','Owner','x','OWNER','t');
    INSERT INTO customer (id, name, created_at) VALUES (1,'TEST CUSTOMER','t');
    INSERT INTO item (id, code, name, unit, qty_milli, created_at) VALUES (1,'I1','Test item','PCS',10000,'t');
    INSERT INTO sale_bill (id, status, invoice_date, customer_id, cust_name, tax_type, total_paise, created_by, created_at)
      VALUES (1,'DRAFT','2026-10-31',1,'TEST CUSTOMER','INTRA',100,1,'t');
  `);
});
afterEach(() => db.close());

const addLine = (billId: number, lineNo: number): void => {
  db.prepare(
    `INSERT INTO sale_bill_line (bill_id,line_no,item_id,description,qty_milli,uom_label,rate_paise,taxable_paise,gst_rate_bp,total_paise)
     VALUES (?,?,1,'d',1000,'PCS - PCS',100,100,900,100)`,
  ).run(billId, lineNo);
};
const confirm = (): void => {
  db.prepare("UPDATE sale_bill SET status='CONFIRMED', bill_no='BZ260001' WHERE id=1").run();
};

describe('database-enforced rules', () => {
  it('lets a draft be edited and confirmed', () => {
    addLine(1, 1);
    db.prepare('UPDATE sale_bill SET total_paise = 200 WHERE id = 1').run();
    expect(() => confirm()).not.toThrow();
  });

  it('freezes a confirmed bill and its lines', () => {
    addLine(1, 1);
    confirm();
    expect(() => db.prepare('UPDATE sale_bill SET total_paise = 1 WHERE id = 1').run()).toThrow(/cannot be edited/);
    expect(() => db.prepare("UPDATE sale_bill SET cust_name = 'X' WHERE id = 1").run()).toThrow(/cannot be edited/);
    expect(() => addLine(1, 2)).toThrow(/frozen/);
    expect(() => db.prepare('DELETE FROM sale_bill_line WHERE bill_id = 1').run()).toThrow(/frozen/);
    expect(() => db.prepare('DELETE FROM sale_bill WHERE id = 1').run()).toThrow(/only draft/);
  });

  it('allows cancellation only with a reason, and cancelled bills stay cancelled', () => {
    addLine(1, 1);
    confirm();
    expect(() => db.prepare("UPDATE sale_bill SET status='CANCELLED' WHERE id=1").run()).toThrow(/cannot be edited/);
    expect(() => db.prepare("UPDATE sale_bill SET status='CANCELLED', cancel_reason='  ' WHERE id=1").run()).toThrow();
    db.prepare("UPDATE sale_bill SET status='CANCELLED', cancel_reason='wrong quantity' WHERE id=1").run();
    expect(() => db.prepare("UPDATE sale_bill SET status='CONFIRMED' WHERE id=1").run()).toThrow(/cannot be edited/);
  });

  it('refuses negative stock at the database level', () => {
    expect(() => db.prepare('UPDATE item SET qty_milli = -1 WHERE id = 1').run()).toThrow(/CHECK/);
  });

  it('keeps ledgers append-only', () => {
    db.prepare("INSERT INTO audit_log (at, action) VALUES ('t','LOGIN')").run();
    expect(() => db.prepare("UPDATE audit_log SET action='x'").run()).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM audit_log').run()).toThrow(/append-only/);
    db.prepare(
      "INSERT INTO stock_movement (at,item_id,qty_delta_milli,reason,qty_after_milli,user_id) VALUES ('t',1,5,'PURCHASE',5,1)",
    ).run();
    expect(() => db.prepare('DELETE FROM stock_movement').run()).toThrow(/append-only/);
  });

  it('never deletes payments; only a reasoned reversal is allowed', () => {
    db.prepare(
      `INSERT INTO customer_payment (receipt_no,customer_id,paid_on,amount_paise,method,balance_after_paise,created_by,created_at)
       VALUES ('R1',1,'2026-11-01',50,'CASH',0,1,'t')`,
    ).run();
    expect(() => db.prepare('UPDATE customer_payment SET amount_paise = 1').run()).toThrow(/immutable/);
    expect(() => db.prepare('UPDATE customer_payment SET is_reversed = 1').run()).toThrow(/immutable/);
    expect(() => db.prepare('DELETE FROM customer_payment').run()).toThrow(/cannot be deleted/);
    db.prepare("UPDATE customer_payment SET is_reversed = 1, reversal_reason = 'cheque bounced'").run();
  });

  it('blocks a negative customer balance unless advances are allowed', () => {
    expect(() => db.prepare('UPDATE customer SET balance_paise = -100 WHERE id = 1').run()).toThrow(/CHECK/);
    db.prepare('UPDATE customer SET advance_allowed = 1, balance_paise = -100 WHERE id = 1').run();
  });

  it('rolls back every write in a failed transaction (all-or-nothing)', () => {
    expect(() =>
      inTransaction(db, () => {
        db.prepare('UPDATE item SET qty_milli = 5000 WHERE id = 1').run();
        db.prepare('UPDATE customer SET balance_paise = 9999 WHERE id = 1').run();
        db.prepare("INSERT INTO audit_log (at, action) VALUES ('t','SALE_CONFIRM')").run();
        throw new Error('power cut');
      }),
    ).toThrow('power cut');
    expect(db.prepare('SELECT qty_milli FROM item WHERE id = 1').get()).toEqual({ qty_milli: 10000 });
    expect(db.prepare('SELECT balance_paise FROM customer WHERE id = 1').get()).toEqual({ balance_paise: 0 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM audit_log').get()).toEqual({ c: 0 });
  });

  it('enforces the same freeze on purchase bills', () => {
    db.exec(`
      INSERT INTO supplier (id, name, created_at) VALUES (1,'TEST SUPPLIER','t');
      INSERT INTO purchase_bill (id,status,bill_date,supplier_id,supplier_inv_no,supplier_inv_date,sup_name,tax_type,created_by,created_at)
        VALUES (1,'DRAFT','2026-10-01',1,'S-1','2026-10-01','TEST SUPPLIER','INTRA',1,'t');
      INSERT INTO purchase_bill_line (bill_id,line_no,item_id,description,received_qty_milli,uom_label,rate_paise,taxable_paise,gst_rate_bp,total_paise)
        VALUES (1,1,1,'d',1000,'PCS - PCS',100,100,900,100);
      UPDATE purchase_bill SET status='CONFIRMED', bill_no='PB260001' WHERE id=1;
    `);
    expect(() => db.prepare('UPDATE purchase_bill SET total_paise = 5 WHERE id = 1').run()).toThrow(/cannot be edited/);
    expect(() => db.prepare('DELETE FROM purchase_bill_line WHERE bill_id = 1').run()).toThrow(/frozen/);
  });
});
