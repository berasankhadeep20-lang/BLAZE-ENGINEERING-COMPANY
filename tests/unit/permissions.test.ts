import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, DEFAULT_EMPLOYEE_PERMISSIONS, OWNER_ONLY, isGrantable, isPermission } from '../../src/domain/permissions';
import { passwordProblems, usernameProblems } from '../../src/domain/password';

describe('permissions', () => {
  it('defaults are real, grantable permissions', () => {
    for (const p of DEFAULT_EMPLOYEE_PERMISSIONS) {
      expect(ALL_PERMISSIONS).toContain(p);
      expect(isGrantable(p)).toBe(true);
    }
  });
  it('sensitive actions are not part of the employee defaults', () => {
    for (const p of ['price.edit', 'stock.adjust', 'bill.cancel', 'backup.restore', 'user.manage', 'settings.edit'] as const) {
      expect(DEFAULT_EMPLOYEE_PERMISSIONS).not.toContain(p);
    }
  });
  it('changing the rate on a bill is a default employee permission; paying suppliers and changing item prices are not', () => {
    expect(DEFAULT_EMPLOYEE_PERMISSIONS).toContain('sale.edit_rate');
    expect(isGrantable('sale.edit_rate')).toBe(true);
    expect(DEFAULT_EMPLOYEE_PERMISSIONS).not.toContain('supplier.pay');
    expect(DEFAULT_EMPLOYEE_PERMISSIONS).not.toContain('price.edit');
  });
  it('owner-only permissions are not grantable', () => {
    expect(OWNER_ONLY).toEqual(expect.arrayContaining(['user.manage', 'customer.approve', 'settings.edit']));
    for (const p of OWNER_ONLY) expect(isGrantable(p)).toBe(false);
    expect(isGrantable('price.edit')).toBe(true);
  });
  it('recognises only known permission names', () => {
    expect(isPermission('sale.create')).toBe(true);
    expect(isPermission('toString')).toBe(false);
    expect(isPermission('nonsense')).toBe(false);
  });
});

describe('password and username rules', () => {
  it('accepts a reasonable password', () => {
    expect(passwordProblems('milk-can-42', 'ravi')).toEqual([]);
  });
  it('rejects short, common, repetitive and username-equal passwords', () => {
    expect(passwordProblems('abc')).toContain('must be at least 8 characters');
    expect(passwordProblems('password123')).toContain('is too common');
    expect(passwordProblems('aaaaaaaaaa')).toContain('must use at least 3 different characters');
    expect(passwordProblems('RaviKumar', 'ravikumar')).toContain('must not be the same as the username');
    expect(passwordProblems('x'.repeat(129))).toContain('must be at most 128 characters');
  });
  it('validates usernames', () => {
    expect(usernameProblems('ravi.k')).toEqual([]);
    expect(usernameProblems('ab')).not.toEqual([]);
    expect(usernameProblems('has space')).not.toEqual([]);
  });
});
