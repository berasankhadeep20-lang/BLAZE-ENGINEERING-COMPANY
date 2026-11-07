/**
 * Permission catalogue. The OWNER implicitly holds every permission. An EMPLOYEE holds only the permissions
 * the owner has switched on. A few permissions are owner-only because granting them would let an employee
 * escalate their own privileges (user management, approving customers, business settings).
 */
export const PERMISSIONS = {
  'inventory.view': 'View stock and the item list',
  'item.create': 'Add items',
  'item.edit': 'Edit item details (not prices)',
  'price.edit': 'Change purchase and sale rates',
  'stock.adjust': 'Correct stock (damaged, missing, counted)',
  'customer.view': 'View customers and their dues',
  'customer.create': 'Add customers (they wait for owner approval)',
  'customer.edit': 'Edit customer details',
  'customer.approve': 'Approve or reject new customers',
  'supplier.view': 'View suppliers and purchase history',
  'supplier.edit': 'Add and edit suppliers',
  'sale.create': 'Create and confirm sale bills',
  'purchase.create': 'Create and confirm purchase bills',
  'bill.cancel': 'Cancel or return a confirmed bill (the only way to correct one)',
  'payment.record': 'Record customer payments',
  'payment.reverse': 'Reverse a recorded payment',
  'report.view': 'View reports and statistics',
  'audit.view': 'View the audit history',
  'backup.create': 'Back up now',
  'backup.restore': 'Restore a backup',
  'settings.edit': 'Edit business, tax, bank and invoice settings',
  'user.manage': 'Create, disable and reset accounts, and change permissions',
} as const;

export type Permission = keyof typeof PERMISSIONS;

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

/** Never grantable to an employee. */
export const OWNER_ONLY: readonly Permission[] = ['customer.approve', 'settings.edit', 'user.manage'];

/** Daily-work permissions given to a new employee account. The owner can change them afterwards. */
export const DEFAULT_EMPLOYEE_PERMISSIONS: readonly Permission[] = [
  'inventory.view',
  'customer.view',
  'customer.create',
  'supplier.view',
  'sale.create',
  'purchase.create',
  'payment.record',
];

export function isPermission(value: string): value is Permission {
  return Object.prototype.hasOwnProperty.call(PERMISSIONS, value);
}

export function isOwnerOnly(p: Permission): boolean {
  return OWNER_ONLY.includes(p);
}

export function isGrantable(p: Permission): boolean {
  return !isOwnerOnly(p);
}
