# ADR 0003: Accounts, sessions and permissions

**Status:** accepted (M2)

## Decisions
- **Passwords** are stored only as salted **argon2id** hashes (19 MiB, 2 passes, 1 lane; ~20 ms per check). No default or demo passwords exist anywhere:
  the first launch shows a setup screen that creates the owner. Rules: 8 to 128 characters, not a common password, not the username, at least 3 different characters.
- **Sign-in** is generic: wrong password, unknown user and disabled account all return the same `AUTH_FAILED`, and a hash check always runs so timing does not reveal
  which usernames exist. After 5 consecutive failures the account locks (1, then 5, 15, then 60 minutes). A successful sign-in, a password reset or owner recovery clears it.
  Every failure and success is audited; the audit trail never contains passwords.
- **Sessions** live in memory only, so closing the app signs everyone out and the sign-in screen always appears on launch. An optional idle timeout is supported.
  Identity and permissions are re-read from the database on every action, so disabling an account or changing permissions takes effect on the very next click.
- **Forced password change.** Accounts created or reset by the owner carry a temporary password; until it is changed, every action except changing the password is refused (`PASSWORD_CHANGE_REQUIRED`).
- **Roles:** OWNER (holds every permission) and EMPLOYEE (holds only what the owner switches on).
- **Owner-only permissions** that can never be granted: `user.manage`, `customer.approve`, `settings.edit`. Granting them would let an employee escalate their own privileges,
  approve their own customers, or alter tax/bank/invoice details. This is a deliberate narrowing of "owner-configurable" in the spec; all other sensitive actions are grantable.
- **Employee defaults:** `inventory.view`, `customer.view`, `customer.create`, `supplier.view`, `sale.create`, `sale.edit_rate`, `purchase.create`, `payment.record`.
  Off by default: `price.edit` (the item's own price), `item.create/edit`, `supplier.pay`, `stock.adjust`, `customer.edit`, `supplier.edit`, `bill.cancel`, `payment.reverse`, `report.view`, `audit.view`, `backup.create`, `backup.restore`.
- **"Editing confirmed records"** is not an operation in this app (confirmed bills are immutable). The way to correct one is cancel/return (`bill.cancel`) and issue a new bill, so that permission is the control.
- **The owner account** cannot be disabled, reset or have permissions changed through user management. There is exactly one owner in v1.
- **Forgotten owner password:** at first run the app shows a one-time **recovery code** (25 symbols, 125 bits) that the owner must save (print it or write it down; keep it off the shop PC).
  It is stored only as an argon2id hash. Using it sets a new password, clears any lockout, ends all sessions and issues a new code. Without the code, a forgotten owner password cannot be recovered through the app.

## Not in this milestone
- The sign-in, setup and user-management screens (they arrive with the Electron shell). Services are complete and tested; the UI only has to call them.
- Per-feature permission checks: each later module calls `auth.authorize(token, permission)` as its first line.
